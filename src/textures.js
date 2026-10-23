/**
 * Monteriggioni · 程序化材质贴图工厂
 * ---------------------------------------------------------------------------
 * 全部用 CanvasTexture 在浏览器里现场烘，不引入任何图片文件或网络请求。
 *
 * 关键约束（来自实测）：GLB 的 2594 个 primitive 全部只有
 * ('NORMAL','POSITION')，没有 TEXCOORD_0 / COLOR_0 / TANGENT。
 * 所以贴图只能走 **三平面（triplanar）世界坐标采样**，
 * 由 materials.js 通过 onBeforeCompile 注入着色器。
 *
 * 产出两类纹理：
 *   - albedo  (512², sRGB)      完整颜色，由贴图本身决定颜色
 *   - detail  (256², 线性灰度)  同时当作 bumpMap 与 roughness 的扰动源
 */

import * as THREE from 'three';

export const ALBEDO_SIZE = 512;
export const DETAIL_SIZE = 256;

/* ======================= 可平铺噪声基元 ======================= */

function hashi(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const wrap = (i, p) => ((i % p) + p) % p;

/** 周期化 value noise：px / py 分别为 x / y 方向的晶格周期（必须是整数）。 */
function vnoise(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const x0 = wrap(xi, px), x1 = wrap(xi + 1, px);
  const y0 = wrap(yi, py), y1 = wrap(yi + 1, py);
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hashi(x0, y0, seed), b = hashi(x1, y0, seed);
  const c = hashi(x0, y1, seed), d = hashi(x1, y1, seed);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** 各向异性 fbm。px/py 不同 → 纹理可以沿某轴拉伸（顺纹木纹、水平层理）。 */
function fbm(u, v, px, py, oct, seed) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(u * px * f, v * py * f, px * f, py * f, seed + i * 131);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return s / norm;
}

/** 周期化 Worley。out = [f1, f2, cellId]，f2-f1 可当细胞边界遮罩。 */
function worley(u, v, cells, jitter, seed, out) {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = wrap(cx, cells), wy = wrap(cy, cells);
      const jx = hashi(wx, wy, seed) - 0.5;
      const jy = hashi(wx, wy, seed + 977) - 0.5;
      const px = cx + 0.5 + jx * 2 * jitter;
      const py = cy + 0.5 + jy * 2 * jitter;
      const ddx = px - x, ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) { f2 = f1; f1 = d; id = wy * cells + wx; }
      else if (d < f2) { f2 = d; }
    }
  }
  out[0] = f1; out[1] = f2; out[2] = id;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function sstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
const lerp = (a, b, t) => a + (b - a) * t;

const _w = [0, 0, 0];
const _w2 = [0, 0, 0];
const _o = [0, 0, 0, 0];

/* ======================= 烘焙 ======================= */

/**
 * 高光软截断（作用在 0..255 字节刻度上）：x ≤ hi 原样通过，之后以指数趋近 255，
 * 永远不越过 255。
 *
 * 为什么必须软截断：石墙的「每块色差 × 大尺度风化 × 细颗粒」叠在一起，
 * 峰值会冲上去。以前直接写进 Uint8ClampedArray 会被**硬夹到纯白**，
 * 于是墙面每隔一块就冒出一个纯白像素点，凑近看就是一层「白麻子」。
 */
const softCap = (x, hi) =>
  (x <= hi ? x : hi + (255 - hi) * (1 - Math.exp(-(x - hi) / (255 - hi))));

/**
 * 逐像素跑一遍 field。
 * channel='rgb' → 取 o[0..2] 的颜色（albedo 贴图）
 * channel='h'   → 取 o[3] 的高度，三通道都写成灰度（detail 贴图，
 *                  同时充当 bumpMap 与 roughness 扰动源，必须线性空间）
 */
function bake(size, fn, channel) {
  const buf = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      _o[0] = 0.5; _o[1] = 0.5; _o[2] = 0.5; _o[3] = 0.5;
      fn(u, v, _o);
      const i = (y * size + x) * 4;
      if (channel === 'h') {
        const h = _o[3] * 255;
        buf[i] = h; buf[i + 1] = h; buf[i + 2] = h;
      } else {
        buf[i] = _o[0] * 255;
        buf[i + 1] = _o[1] * 255;
        buf[i + 2] = _o[2] * 255;
      }
      buf[i + 3] = 255;
    }
  }
  return buf;
}

function toTexture(buf, size, { srgb, aniso, wrapMode }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(buf, size, size), 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = wrapMode || THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/* ======================= 纹理配方（field 函数） =======================
 * 约定：field(u, v, o) 写 o[0..2] = sRGB 0..1 颜色，o[3] = 0..1 高度。
 * u / v 是可平铺的归一化坐标，所有噪声周期都取整数。
 * ===================================================================== */

/* 层高表（一个 tile 内 8 层，归一化后无缝平铺）。
   「分层不等高」是条石墙的关键特征：等高等宽的网格看起来像贴了瓷砖。
   层数刻意取少 —— 12 层 / 4 m 意味着平均层高只有 0.33 m，10 m 高的城墙就有
   30 道横缝，近景直接读成一面马赛克。8 层 → 平均 0.5 m，符合托斯卡纳条石的实际尺度。 */
const COURSE_H = [1.30, 1.00, 1.55, 1.15, 1.40, 1.05, 1.70, 0.90];
const COURSE_SUM = COURSE_H.reduce((a, b) => a + b, 0);
const COURSE_CUM = (() => { const c = [0]; let s = 0; for (const h of COURSE_H) { s += h / COURSE_SUM; c.push(s); } return c; })();
const COURSE_COLS = [3, 3, 4, 3, 4, 3, 3, 4];
/* 错缝偏移，周期 6；6 整除 12 → 上下左右无缝 */
const COURSE_OFF = [0, 0.5, 0.25, 0.75, 1 / 6, 5 / 6];
const TILE_M = 4;                       // 一张贴图覆盖 4 m 世界
const JOINT_M = 0.026;                  // 灰缝过渡带宽（米）。核心缝宽约 JOINT_M*0.5 ≈ 1.3 cm

/**
 * 逐列宽度抖动表（每层一张）。宽度按 hash 抖动 ±COL_JIT 后**重新归一化**，
 * 所以一层的总宽恒为 1，左右仍然无缝；但同层内每块石头宽度不同 ——
 * 这一条是「条石墙」和「方格纸」的分水岭，之前所有列等宽所以整面墙像网格纸。
 */
const COL_JIT = 0.38;
const COL_W = COURSE_COLS.map((cols, row) => {
  const raw = [];
  let sum = 0;
  for (let k = 0; k < cols; k++) {
    const w = 1 + COL_JIT * (hashi(k, row, 431) * 2 - 1);
    raw.push(w); sum += w;
  }
  return raw.map((w) => w / sum);
});

/** 托斯卡纳条石墙：分层不等高、层内块宽不等、浅灰缝、逐块色差与冷暖、大尺度风化、垂流污渍、苔斑。 */
function ashlarField(tint, opt) {
  const contrast = opt.contrast, mossiness = opt.mossiness;
  return (u, v, o) => {
    // 找 v 落在第几层
    const nCourse = COURSE_H.length;
    let row = nCourse - 1;
    for (let i = 0; i < nCourse; i++) { if (v < COURSE_CUM[i + 1]) { row = i; break; } }
    const c0 = COURSE_CUM[row], c1 = COURSE_CUM[row + 1];
    const courseH = (c1 - c0) * TILE_M;
    const ry = (v - c0) / (c1 - c0);

    // 沿 u 走到列边界上；因为列宽逐列不同，得一段段量，不能再 floor(u*cols)
    const cols = COURSE_COLS[row];
    const ws = COL_W[row];
    const colF = u * cols + COURSE_OFF[row % 6];
    const k0 = Math.floor(colF);
    let acc = colF - k0;
    let col = cols - 1, cx = 1, cellW = ws[cols - 1];
    for (let k = 0; k < cols; k++) {
      const w = ws[wrap(k0 + k, cols)];
      if (acc < w) { col = k; cx = acc / w; cellW = w; break; }
      acc -= w;
    }
    const hcol = wrap(k0 + col, cols);       // 跨 tile 周期一致的列号

    // 逐块：明度 + 冷暖（真条石墙的色差不只是亮暗，还有偏黄 / 偏灰）。
    // 幅度刻意压住 —— 灰缝变浅之后，块与块之间如果还差两成，整面墙会读成
    // 一张明暗棋盘，而不是一堵石墙。结构交给缝，明度只做轻微扰动。
    const bv = 0.92 + 0.17 * hashi(hcol, row, 17);
    const hueJ = hashi(hcol, row, 53) * 2 - 1;

    const jxT = JOINT_M / (cellW * TILE_M), jyT = JOINT_M / courseH;
    const jx = Math.min(cx, 1 - cx), jy = Math.min(ry, 1 - ry);
    // joint = 1 表示落在灰缝里（贴着块边缘），0 表示块面。
    // 两个阈值必须**降序**：jx / jy 越靠近 0 才是缝边。
    const jv = sstep(jxT * 1.30, jxT * 0.38, jx);   // 竖缝（丁缝）
    const jh = sstep(jyT * 1.30, jyT * 0.38, jy);   // 横缝（卧缝）
    const joint = Math.max(jv, jh);

    const grain = fbm(u, v, 40, 40, 4, 3);
    const big = fbm(u, v, 3, 3, 4, 21);          // 整面墙级别的色调起伏
    worley(u, v, 34, 0.85, 11, _w);
    const pit = sstep(0.20, 0.02, _w[0]);

    // 渗水：横向的缝下挂痕 + 竖向水渍。
    // 幅度必须小 —— 上一版给到 0.26/0.13，整面墙挂满深色竖条，读成「雨渍窗帘」
    // 而不是被太阳晒过的干砌条石。真实托斯卡纳墙面只有零星几道淡挂痕。
    const below = sstep(0.02, 0.55, 1 - ry);
    const streak = below * sstep(0.52, 0.90, fbm(u, v, 40, 5, 3, 33));
    const drip = sstep(0.42, 0.94, fbm(u, v, 22, 3, 3, 67)) * sstep(0.04, 0.40, 1 - ry);

    // 苔痕：低频斑块 ∩ 灰缝附近，覆盖率约 2%
    worley(u, v, 16, 0.9, 55, _w2);
    const mossPatch = sstep(0.58, 0.80, fbm(u, v, 3, 3, 3, 57));
    const moss = sstep(0.13, 0.02, _w2[0]) * (0.35 + 0.65 * joint) * mossPatch * mossiness;

    let sh = bv * (1 + contrast * (big - 0.5)) * (1 + 0.18 * (grain - 0.5));
    sh *= 1 - 0.15 * streak - 0.08 * drip;

    const pd = 1 - 0.13 * pit;
    let r = tint[0] * sh * pd * (1 + 0.034 * hueJ);
    let g = tint[1] * sh * pd * (1 + 0.008 * hueJ);
    let b = tint[2] * sh * pd * (1 - 0.028 * hueJ);

    // 灰缝：只是**比块面暗一成的浅阴影**，不是黑线。
    // 真实石灰岩墙的缝里是石灰砂浆，被环境光打亮，接近块面而不是黑洞。
    // 卧缝（横）比丁缝（竖）明显 —— 这是砌体真实的读法，也让整面墙不会
    // 因为两边一样重而重新退化成一张方格纸。
    const mv = Math.min(1, jv * 0.72), mh = jh * 0.95;
    r = lerp(r, tint[0] * 0.860 + 0.024, mv);
    g = lerp(g, tint[1] * 0.860 + 0.024, mv);
    b = lerp(b, tint[2] * 0.845 + 0.026, mv);
    r = lerp(r, tint[0] * 0.820 + 0.030, mh);
    g = lerp(g, tint[1] * 0.820 + 0.030, mh);
    b = lerp(b, tint[2] * 0.805 + 0.032, mh);

    const mm = clamp01(moss) * 0.40;
    r = lerp(r, 0.34, mm); g = lerp(g, 0.37, mm); b = lerp(b, 0.25, mm);

    o[0] = r; o[1] = g; o[2] = b;
    // 灰缝的凹陷很浅 —— 缝宽本来就只有 1 cm 出头，再深就成了刻上去的沟槽。
    o[3] = 0.34 + 0.54 * (1 - joint) + 0.10 * (grain - 0.5) - 0.09 * pit - 0.12 * clamp01(moss);
  };
}

/** 不规则毛石（烟囱 / 转角构件）。 */
function rubbleField(tint) {
  return (u, v, o) => {
    worley(u, v, 9, 0.62, 61, _w);
    const edge = sstep(0.0, 0.15, _w[1] - _w[0]);
    const bv = 0.78 + 0.42 * hashi(_w[2], 3, 71);
    const grain = fbm(u, v, 52, 52, 4, 73);
    const big = fbm(u, v, 4, 4, 4, 79);
    worley(u, v, 34, 0.9, 83, _w2);
    const pit = sstep(0.18, 0.02, _w2[0]);
    const moss = sstep(0.09, 0.01, _w2[0]) * sstep(0.62, 0.84, big);

    let sh = bv * (1 + 0.26 * (big - 0.5)) * (1 + 0.20 * (grain - 0.5));
    const pd = 1 - 0.14 * pit;
    let r = tint[0] * sh * pd, g = tint[1] * sh * pd, b = tint[2] * sh * pd;
    const mj = (1 - edge) * 0.88;
    r = lerp(r, tint[0] * 0.60 + 0.07, mj);
    g = lerp(g, tint[1] * 0.60 + 0.07, mj);
    b = lerp(b, tint[2] * 0.58 + 0.08, mj);
    r = lerp(r, 0.29, moss * 0.5); g = lerp(g, 0.33, moss * 0.5); b = lerp(b, 0.20, moss * 0.5);
    o[0] = r; o[1] = g; o[2] = b;
    o[3] = 0.22 + 0.66 * edge + 0.12 * (grain - 0.5) - 0.12 * pit;
  };
}

/** 托斯卡纳石灰抹面：斑驳、局部剥落露砌体、水渍垂流、细裂纹。 */
function plasterField(tint) {
  return (u, v, o) => {
    const mottle = fbm(u, v, 6, 6, 4, 401);
    const fine = fbm(u, v, 40, 40, 3, 409);
    worley(u, v, 5, 0.85, 419, _w);
    const flake = sstep(0.20, 0.03, _w[0]) * sstep(0.30, 0.62, fbm(u, v, 3, 3, 3, 429));
    const streak = fbm(u, v, 28, 4, 3, 439) * sstep(0.15, 0.85, 1 - ((v * 5) % 1));
    worley(u, v, 9, 0.95, 443, _w2);
    const crack = sstep(0.035, 0.0, _w2[1] - _w2[0]);
    const chipEdge = sstep(0.34, 0.20, _w[0]) * (1 - flake);

    let sh = 0.90 + 0.26 * (mottle - 0.5) + 0.12 * (fine - 0.5);
    sh *= 1 - 0.30 * streak;
    let r = tint[0] * sh, g = tint[1] * sh, b = tint[2] * sh;

    // 剥落处露出底下的砌体（更暗更红）
    const fm = clamp01(flake);
    r = lerp(r, tint[0] * 0.58 + 0.045, fm);
    g = lerp(g, tint[1] * 0.54 + 0.035, fm);
    b = lerp(b, tint[2] * 0.52 + 0.030, fm);

    r *= 1 - 0.35 * crack; g *= 1 - 0.35 * crack; b *= 1 - 0.35 * crack;

    o[0] = r; o[1] = g; o[2] = b;
    o[3] = 0.80 - 0.34 * fm - 0.22 * crack + 0.10 * (fine - 0.5) - 0.08 * chipEdge;
  };
}

/** 广场铺石：不规则多边形，暖砂色，勾缝。 */
function flagstoneField(tint) {
  return (u, v, o) => {
    worley(u, v, 6, 0.48, 101, _w);
    const edge = sstep(0.0, 0.14, _w[1] - _w[0]);
    const bv = 0.86 + 0.28 * hashi(_w[2], 7, 113);
    const grain = fbm(u, v, 56, 56, 4, 131);
    const wear = fbm(u, v, 3, 3, 3, 151);
    worley(u, v, 40, 0.9, 161, _w2);
    const speck = sstep(0.10, 0.0, _w2[0]);

    let sh = bv * (1 + 0.18 * (wear - 0.5)) * (1 + 0.16 * (grain - 0.5));
    sh *= 1 + 0.10 * speck;
    let r = tint[0] * sh, g = tint[1] * sh, b = tint[2] * sh;
    const mj = (1 - edge) * 0.80;
    r = lerp(r, tint[0] * 0.64 + 0.07, mj);
    g = lerp(g, tint[1] * 0.64 + 0.07, mj);
    b = lerp(b, tint[2] * 0.62 + 0.08, mj);
    o[0] = r; o[1] = g; o[2] = b;
    o[3] = 0.26 + 0.62 * edge + 0.10 * (grain - 0.5) - 0.10 * speck;
  };
}

/** 碎石路面：颗粒感。 */
function pathField(tint) {
  return (u, v, o) => {
    worley(u, v, 58, 0.95, 211, _w);
    worley(u, v, 20, 0.9, 223, _w2);
    const grain = fbm(u, v, 30, 30, 4, 233);
    const broad = fbm(u, v, 4, 4, 3, 239);
    const chip = sstep(0.16, 0.02, _w[0]);
    const shadeC = sstep(0.28, 0.06, _w2[0]);

    let sh = 0.84 + 0.20 * (broad - 0.5) + 0.18 * (grain - 0.5) + 0.10 * chip - 0.14 * shadeC;
    let r = tint[0] * sh, g = tint[1] * sh, b = tint[2] * sh;
    o[0] = r; o[1] = g; o[2] = b;
    o[3] = 0.52 + 0.22 * chip - 0.26 * shadeC + 0.14 * (grain - 0.5);
  };
}

/** 草地：草簇噪声、明度变化、干枯斑块。dryness 越大越枯黄。
 *  尺度刻意放大 —— 早前用 0.5 cm 级的 tuft / 5 cm 级的干斑，近景就是「满地小米粒」，
 *  读起来像渲染噪点。这里改成 0.3–0.6 m 的大簇 + 2 m 级的枯斑，明度摆幅也压掉一半。 */
function turfField(tint, dryness) {
  return (u, v, o) => {
    const clump = fbm(u, v, 5, 5, 4, 301);        // ≈1.4 m 的草丛团
    const clump2 = fbm(u, v, 3, 3, 3, 303);       // ≈2.3 m 的第二层团，避免只有一种尺度
    const fine = fbm(u, v, 26, 26, 4, 311);       // ≈0.27 m
    const micro = fbm(u, v, 64, 64, 2, 313);      // ≈0.11 m，纯粹的细颗粒（幅度很小）
    const broad = fbm(u, v, 2, 2, 3, 317);        // ≈3.5 m
    worley(u, v, 11, 0.9, 321, _w);
    const tuft = sstep(0.36, 0.06, _w[0]);        // 柔和的大簇
    worley(u, v, 3, 0.9, 331, _w2);               // ≈2.3 m 的枯斑
    const dry = sstep(0.17, 0.04, _w2[0]) * sstep(0.50, 0.80, broad) * dryness;
    const bare = sstep(0.075, 0.012, _w2[0]) * sstep(0.62, 0.88, broad) * dryness;

    let sh = 0.88 + 0.14 * (broad - 0.5) + 0.18 * (clump - 0.5) + 0.15 * (clump2 - 0.5)
      + 0.16 * (fine - 0.5) + 0.07 * tuft + 0.10 * (micro - 0.5);
    let r = tint[0] * sh, g = tint[1] * sh, b = tint[2] * sh;
    r = lerp(r, 0.44, dry * 0.30); g = lerp(g, 0.38, dry * 0.30); b = lerp(b, 0.19, dry * 0.30);
    r = lerp(r, 0.31, bare * 0.28); g = lerp(g, 0.25, bare * 0.28); b = lerp(b, 0.15, bare * 0.28);
    o[0] = r; o[1] = g; o[2] = b;
    o[3] = 0.42 + 0.26 * tuft + 0.14 * (fine - 0.5) + 0.07 * (micro - 0.5) + 0.10 * (clump - 0.5) - 0.10 * bare;
  };
}

/** 耕作土壤：土块 + 垄沟。 */
function soilField(tint) {
  return (u, v, o) => {
    worley(u, v, 22, 0.9, 401, _w);
    const clod = sstep(0.30, 0.02, _w[0]);
    const crack = sstep(0.06, 0.0, _w[1] - _w[0]);
    const fine = fbm(u, v, 60, 60, 3, 409);
    const broad = fbm(u, v, 4, 4, 3, 419);
    const furrow = 0.5 + 0.5 * Math.cos((v * 8) * Math.PI * 2);

    let sh = 0.82 + 0.30 * (broad - 0.5) + 0.22 * clod + 0.14 * (fine - 0.5)
      + 0.10 * (furrow - 0.5);
    const pd = 1 - 0.22 * crack;
    o[0] = tint[0] * sh * pd;
    o[1] = tint[1] * sh * pd * (1 - 0.04 * clod);
    o[2] = tint[2] * sh * pd * (1 - 0.08 * clod);
    o[3] = 0.48 + 0.30 * clod + 0.14 * (fine - 0.5) - 0.28 * crack + 0.10 * (furrow - 0.5);
  };
}

/**
 * 葡萄园垄沟：条纹沿 **世界 Z 方向**延展（= 葡萄行方向），
 * 因此条纹必须在贴图 u 方向变化。与 uv = p.xz 对应。
 */
function vineField(tint) {
  const ROWS = 12;                    // tile 4.8m → 垄距 0.4m
  return (u, v, o) => {
    const rf = u * ROWS;
    const s = rf - Math.floor(rf);
    const trough = sstep(0.34, 0.02, Math.abs(s - 0.5) * 2 - 0.10);
    worley(u, v, 30, 0.9, 501, _w);
    const clod = sstep(0.28, 0.02, _w[0]);
    const fine = fbm(u, v, 56, 56, 3, 509);
    const broad = fbm(u, v, 4, 4, 3, 519);

    let sh = 0.84 + 0.26 * (broad - 0.5) + 0.20 * clod + 0.12 * (fine - 0.5);
    sh *= 1 - 0.42 * trough;
    let r = tint[0] * sh, g = tint[1] * sh, b = tint[2] * sh;
    r = lerp(r, 0.16, trough * 0.5); g = lerp(g, 0.14, trough * 0.5); b = lerp(b, 0.07, trough * 0.5);
    o[0] = r; o[1] = g; o[2] = b;
    o[3] = 0.66 - 0.44 * trough + 0.18 * clod + 0.10 * (fine - 0.5);
  };
}

/**
 * 屋顶风化叠加（**明度调制图**，均值≈1）。
 * 瓦片本身是几何体 —— 这里绝不能再画瓦垄，只做跨片的
 * 风化 / 苔痕 / 明度渐变 / 垂流污渍，让已有的逐片色差连成一体。
 */
function roofWeatherField() {
  return (u, v, o) => {
    const big = fbm(u, v, 4, 4, 4, 501);
    const mid = fbm(u, v, 16, 16, 4, 509);
    worley(u, v, 7, 0.85, 519, _w);
    const lichen = sstep(0.28, 0.06, _w[0]) * (0.28 + 0.72 * fbm(u, v, 3, 3, 3, 529));
    const streak = fbm(u, v, 26, 3, 3, 539) * sstep(0.25, 0.95, 1 - ((v * 3) % 1));
    const m = 1 + 0.30 * (big - 0.5) + 0.18 * (mid - 0.5) - 0.34 * streak;
    const c = clamp01(lichen);
    o[0] = m * (1 - 0.20 * c);
    o[1] = m * (1 + 0.05 * c);
    o[2] = m * (1 - 0.34 * c);
    o[3] = 0.50 + 0.26 * (mid - 0.5) - 0.26 * c + 0.10 * (big - 0.5);
  };
}

/** 叶簇团块噪声 + 缝隙压暗（明度调制图，均值≈1）。 */
function foliageField() {
  return (u, v, o) => {
    const big = fbm(u, v, 5, 5, 4, 601);
    const fine = fbm(u, v, 26, 26, 4, 609);
    worley(u, v, 9, 0.9, 619, _w);
    const border = sstep(0.13, 0.0, _w[1] - _w[0]);
    const core = sstep(0.34, 0.02, _w[0]);
    const m = 0.78 + 0.46 * big + 0.30 * (fine - 0.5) + 0.14 * core - 0.34 * border;
    o[0] = m * (1 + 0.05 * core);
    o[1] = m * (1 + 0.02 * (big - 0.5));
    o[2] = m * (1 - 0.07 * core);
    o[3] = 0.48 + 0.34 * (fine - 0.5) + 0.16 * core - 0.22 * border;
  };
}

/** 百叶窗：竖向板缝 + 漆面不匀 + 轻微掉漆（明度调制图）。 */
function shutterField() {
  const BOARDS = 4;                    // tile 1.0m → 板宽 0.25m
  return (u, v, o) => {
    const bf = u * BOARDS, bi = Math.floor(bf), bl = bf - bi;
    const bv = 0.90 + 0.18 * hashi(wrap(bi, BOARDS), 0, 701);
    const edge = Math.min(bl, 1 - bl);
    const groove = sstep(0.035, 0.11, edge);
    const paint = fbm(u, v, 9, 9, 4, 711);
    worley(u, v, 34, 0.9, 721, _w);
    const chip = sstep(0.09, 0.01, _w[0]) * (1 - groove);
    const m = bv * (0.93 + 0.18 * (paint - 0.5)) * (0.34 + 0.66 * groove) * (1 - 0.30 * chip);
    o[0] = m * (1 + 0.03 * chip);
    o[1] = m;
    o[2] = m * (1 - 0.02 * chip);
    o[3] = 0.30 + 0.62 * groove + 0.08 * (paint - 0.5) - 0.10 * chip;
  };
}

/** 木纹顺纹（明度调制图）。 Timber 多为立柱，所以纹理沿 v 延展。 */
function timberField() {
  return (u, v, o) => {
    const g1 = fbm(u, v, 64, 5, 4, 801);
    const g2 = fbm(u, v, 128, 11, 3, 811);
    worley(u, v, 4, 0.7, 821, _w);
    const knot = sstep(0.24, 0.0, _w[0]);
    const m = 0.88 + 0.30 * (g1 - 0.5) + 0.14 * (g2 - 0.5) - 0.32 * knot;
    o[0] = m * (1 - 0.03 * knot);
    o[1] = m * (1 - 0.04 * knot);
    o[2] = m * (1 - 0.05 * knot);
    o[3] = 0.50 + 0.42 * (g1 - 0.5) - 0.18 * knot;
  };
}

/** 地形圆盘侧壁：水平地质层理（明度调制图）。 */
function strataField() {
  const BANDS = 9;
  return (u, v, o) => {
    const li = wrap(Math.floor(v * BANDS), BANDS);
    const lv = 0.86 + 0.28 * hashi(0, li, 911);
    const line = fbm(u, v, 6, 120, 4, 901);
    const rough = fbm(u, v, 28, 28, 3, 921);
    const m = lv * (1 + 0.22 * (line - 0.5) + 0.12 * (rough - 0.5));
    o[0] = m; o[1] = m; o[2] = m;
    o[3] = 0.48 + 0.34 * (line - 0.5) + 0.12 * (rough - 0.5);
  };
}

/** 通用细颗粒（陶土 / 檐下深影 / 窗洞 / 铁 / 铜 / 亚麻 / 游人）。 */
function grainField() {
  return (u, v, o) => {
    const n = fbm(u, v, 14, 14, 4, 1001);
    const n2 = fbm(u, v, 52, 52, 2, 1011);
    const m = 0.94 + 0.13 * (n - 0.5) + 0.07 * (n2 - 0.5);
    o[0] = m; o[1] = m; o[2] = m;
    o[3] = 0.50 + 0.50 * (n - 0.5);
  };
}

/** 井水：极低粗糙 + 高 envMapIntensity，靠天空反射成立。 */
function waterField() {
  return (u, v, o) => {
    const w1 = fbm(u, v, 5, 5, 3, 1101);
    const w2 = fbm(u, v, 13, 13, 2, 1111);
    const m = 0.92 + 0.16 * (w1 - 0.5) + 0.08 * (w2 - 0.5);
    o[0] = m * 0.94; o[1] = m; o[2] = m * 1.02;
    o[3] = 0.50 + 0.70 * (w1 - 0.5) + 0.30 * (w2 - 0.5);
  };
}

/* ======================= 配方表 ======================= */

/**
 * 每条配方声明：field 生成器、目标反照率水平（mean = sRGB 均值）、世界尺度参数。
 * tinted=true  → 生成完整 albedo，材质 baseColor 会被置白（mean / hi 生效）
 * tinted=false → 生成明度调制图，材质保留自身 baseColor（色相信息在里面，均值锁 0.985）
 *
 * 灰缝 / 逐片色差只决定**对比度**；实际反照率由 mean 直接指定，
 * 不再靠猜 tint gain —— 这也是墙面「白麻子」问题的根治点。
 * desat：把色相往灰色拉一点，回到托斯卡纳那种晒褪了的灰绿/黄绿。
 */
export function buildRecipes(tintOf) {
  const T = (name, desat = 0) => {
    const c = tintOf(name);
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return [0, 1, 2].map((i) => c[i] + (l - c[i]) * desat);
  };
  return [
    { key: 'stonePale', mean: 0.565, hi: 0.86, field: ashlarField(T('Limestone | cut pale blocks'), { contrast: 0.46, mossiness: 0.7 }) },
    { key: 'stoneOchre', mean: 0.515, hi: 0.85, field: ashlarField(T('Limestone | weathered grey ochre'), { contrast: 0.54, mossiness: 0.95 }) },
    { key: 'stoneDamp', mean: 0.470, hi: 0.82, field: ashlarField(T('Limestone | damp base'), { contrast: 0.50, mossiness: 1.1 }) },
    { key: 'rubble', mean: 0.560, hi: 0.86, field: rubbleField(T('Village masonry | subtle variation 1.001')) },
    { key: 'plaster', mean: 0.580, hi: 0.87, field: plasterField(T('Tuscan lime plaster')) },
    { key: 'flag', mean: 0.545, hi: 0.84, field: flagstoneField(T('Piazza | small warm flagstones')) },
    { key: 'path', mean: 0.550, hi: 0.84, field: pathField(T('Paths | pale crushed limestone')) },
    { key: 'lawn', mean: 0.440, hi: 0.74, field: turfField(T('Gardens | muted green lawn', 0.24), 0.40) },
    { key: 'wild', mean: 0.420, hi: 0.72, field: turfField(T('Land | sun dried grasses and wild herbs', 0.24), 0.85) },
    { key: 'soil', mean: 0.440, hi: 0.74, field: soilField(T('Land | warm cultivated soil', 0.10)) },
    { key: 'vine', mean: 0.300, hi: 0.62, field: vineField(T('Vineyards | narrow dark furrows')) },
    { key: 'roof', field: roofWeatherField() },
    { key: 'foliage', field: foliageField() },
    { key: 'shutter', field: shutterField() },
    { key: 'timber', field: timberField() },
    { key: 'strata', field: strataField() },
    { key: 'grain', field: grainField() },
    { key: 'water', field: waterField() },
  ];
}

/**
 * 明度调制图专用：这些贴图要和材质自带的 baseColor 相乘，所以均值必须≈1，
 * 否则等于给所有材质统一压一层暗滤镜（屋顶 0.89 / 百叶 0.83 / 木纹 0.86 …）。
 * 烘完先量均值，再整体缩放到 target，保留相对变化但不动色相结构。
 */
function bakeLuminance(size, fn, target) {
  const buf = bake(size, fn, 'rgb');
  let sum = 0;
  const n = size * size;
  for (let i = 0; i < buf.length; i += 4) sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
  const mean = sum / n / 255;
  const k = mean > 1e-4 ? target / mean : 1;
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] *= k; buf[i + 1] *= k; buf[i + 2] *= k;   // Uint8ClampedArray 自动夹到 0..255
  }
  return buf;
}

/**
 * 完整 albedo 专用：**只定「反照率水平」，绝不凭空造对比度。**
 *
 * 做法：整体缩放到 targetMean，再对超过 targetHi 的高光做软截断。
 * 贴图自身的对比度完全由 field 函数决定，灰缝 / 逐片色差 / 斑驳的深浅
 * 就是写在那里的数值，不在这里二次加工。
 *
 * 踩过的坑（血泪）：早前这里同时强制「均值 → targetMean」和「P99.9 → targetHi」。
 * 当 field 本身动态范围不大时，两点一卡就等于做了一次 **k ≈ 5 的对比拉伸**，
 * 灰缝被推到 0.07（线性 0.011），阳光一照就是纯黑 —— 整个广场碎成黑白棋盘，
 * 墙面也糊成一片黑底白点。现在只缩放不拉伸，对比度归 field 管。
 *
 * @param targetMean 目标平均反照率（sRGB 0..1）。石灰岩 ~0.58，草地 ~0.44。
 * @param targetHi   软截断起点（sRGB 0..1），高于此值开始压向 1.0，永不撞顶。
 */
function bakeAlbedo(size, fn, targetMean, targetHi) {
  const buf = bake(size, fn, 'rgb');
  const n = size * size;
  let sum = 0;
  for (let i = 0; i < buf.length; i += 4) sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
  const k = sum > 1e-3 ? (targetMean * 255 * n) / sum : 1;
  const hi = targetHi * 255;
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = softCap(buf[i] * k, hi);
    buf[i + 1] = softCap(buf[i + 1] * k, hi);
    buf[i + 2] = softCap(buf[i + 2] * k, hi);
  }
  return buf;
}

/**
 * 逐条烘焙；onStep 用于把真实进度回报给加载层。
 *
 * 刻意**不**在配方之间 await 让出主线程：tests/shots.mjs 是按「渲染帧」等待的，
 * 一旦中途让出，rAF 就可能在此刻合成一帧「模型已载入但贴图还没贴上」的中间画面，
 * 被截图工具当成最终结果拍下来。这里保持「模型解析完成 → 贴图烘焙 → 材质注入 →
 * 阴影首帧」是一整段同步块，中途不存在可被合成的帧。
 */
export async function bakeAll(recipes, aniso, onStep) {
  const out = {};
  for (let i = 0; i < recipes.length; i++) {
    const r = recipes[i];
    if (onStep) onStep(i / recipes.length, r.key);
    const pair = r.mean === undefined
      ? { map: bakeLuminance(ALBEDO_SIZE, r.field, 0.985), detail: bake(DETAIL_SIZE, r.field, 'h') }
      : {
        map: bakeAlbedo(ALBEDO_SIZE, r.field, r.mean, r.hi === undefined ? 0.88 : r.hi),
        detail: bake(DETAIL_SIZE, r.field, 'h'),
      };
    out[r.key] = {
      map: toTexture(pair.map, ALBEDO_SIZE, { srgb: true, aniso }),
      detail: toTexture(pair.detail, DETAIL_SIZE, { srgb: false, aniso }),
    };
  }
  if (onStep) onStep(1, 'done');
  return out;
}

export const worldScale = {
  stonePale: 0.25, stoneOchre: 0.25, stoneDamp: 0.25, rubble: 0.34,
  plaster: 0.25, flag: 0.25, path: 0.33,
  lawn: 0.145, wild: 0.145, soil: 0.20, vine: 0.208,
  roof: 0.29, foliage: 0.46, shutter: 1.0, timber: 0.62,
  strata: 0.25, grain: 0.85, water: 0.33,
};
