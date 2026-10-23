/**
 * Monteriggioni · 镇外原野（第五批 ④：地台边缘圆盘感）
 * ===========================================================================
 * 问题：航拍封面里镇子坐在一块**平顶圆盘**上，边缘切得干净，外围直接是天空 ——
 *       读作「转台上的建筑模型」，而不是「长在托斯卡纳地里的小镇」。
 *
 * 实测（tests/probe-plinth.mjs，不是推断）：
 *   · 地形是**单独一块** `Terrain_|_Monteriggioni_hill`，9217 点 / 18240 三角面
 *   · 包围盒 x ±181 / y 0.43–14.80 / z ±157 —— 是**椭圆**，不是圆
 *   · 径向剖面：r<90 是 y 13.2–14.8 的高台（起伏仅 1.6m，镇子坐这儿）
 *              r 90→130 从 14 掉到 0.75（≈13m 的陡坡）
 *              r 130–181 是 y 0.4–3.9 的低裙
 *   · **r=181m 处没有任何裙边**，面片直接断在空气里
 *
 * 所以「圆盘感」不是「顶太平」，是**陆地有边界**。修法不是去削那个顶，
 * 是把边界之外接上真风景。
 *
 * 做法（四条纪律都在这行代码里）：
 *   1. **不假设边缘是圆，也不重推边缘**。直接取 GLB 地形网格的**边界环**
 *      （只被一个三角形用到的边首尾串起来），新原野的第 0 圈就摆在这条环上 ——
 *      与原网格**共用同一条边**，接缝的高差按构造就是 0。
 *      第一版用「按角度分箱取最远顶点」+ 向外推 1.2m 封缝，结果在航拍里留了一条
 *      4px 宽的**白环**：地形边缘是往下坡走的，外推那一圈比地面高出约 0.2m，
 *      多出来的 1.2m 从掠射角直接看穿到天空球底部的亮色带。
 *      弦高误差只有 0.024m（不到 0.1px），根本不需要外推。
 *   2. **不新建裸材质**。克隆 GLB 那块地形已经被 materials.js 注入过三平面投影的
 *      材质实例 —— 三平面按**世界坐标**采样，所以新原野的草纹与镇内草皮在纹理
 *      层面天然续上，接缝处不可能对不上。
 *   3. **远景不靠雾堆出来**。FogExp2 density 0.0017 在 1km 处已经吃掉 94%，
 *      远山脊放到 1km 等于白画。所以山脊压在 330–920m —— 那儿雾只有 30–70%，
 *      轮廓才读得出来，同时又是自然的空气透视。
 *   4. **接缝处不留折痕**。新原野第 0 圈的地面坡度是从原网格往内 10m 实测的
 *      真实坡度延续出来的，延续 30m 再过渡到平原，所以接缝上不会出现一条
 *      「法线拐弯」的亮线。
 *
 * 预算：1 个合并网格 = 1 drawcall，约 2.4 万三角面（场景总量 ~260 万）。
 */

import * as THREE from 'three';
import { normName, cloneInjected } from './materials.js';

export const TUNE = {
  /** 找出地形本体：GLB 里只有这一块匹配，且是 Land 桶中顶点数最大的。 */
  landTest: /sun dried grasses/i,

  /** 边缘折线的角度分箱数。192 箱对应 r≈181m 处弦高 0.024m，远小于一个像素。 */
  bins: 192,

  /**
   * 内边界与 GLB 地形**共用同一条边**（见 measureBoundary），所以这里不再需要
   * 任何外推量。保留这个字段只为记录「当初试过 1.2m 外推、结果在航拍里变成白环」。
   */
  sealM: 0,

  /** 铺到多远。1300m 处 FogExp2 已经 98.4%，再远没有意义。 */
  reachM: 1300,

  /** 环向的径向站位：近处密（要接住边缘的起伏），远处按几何级数稀掉。 */
  stops: { nearTo: 120, nearStep: 5, midTo: 400, midStep: 12, farStep0: 14, farGrow: 1.14 },

  /**
   * 接缝处延续原地面坡度的长度（米）。
   * 边缘 30m 内按实测坡度线性延续，之后才过渡到平原基准 ——
   * 直接从边缘高程「水平」切出去会在接缝上留下一条法线拐弯的折痕亮线。
   */
  slopeRunM: 30,
  /** 坡度采样点：往边界内侧这么远取一个高程来算坡（米）。 */
  slopeProbeM: 10,

  /** 从边缘高程缓缓落到平原基准的过渡长度（米）。 */
  apronM: 90,

  /** 起伏：托斯卡纳的丘陵，振幅随距离爬升。 */
  relief: { max: 34, from: 60, to: 520, freq: 0.0022, octaves: 3 },

  /**
   * 远山脊。径向位置与高度都随方位抖动 —— 不抖的话会读成
   * 「围着镇子砌的一圈围墙」，那比圆盘更糟。
   */
  ridge: { inMin: 330, inSpan: 260, width: 330, fall: 380, hMin: 32, hSpan: 37 },

  /** 山脊之后的中远景缓缓抬一点，避免出现一片死平的台面。 */
  farRise: { to: 1300, amount: 10 },

  /**
   * 距离 LOD（米，到相机；zoom = 最远处采样尺度的收缩倍率）。
   * 草皮世界尺度 6.9m 一循环，铺到几百米外会同时欠采样成摩尔纹、
   * 并且平铺重复暴露成一张规则网纹（第一版实拍证实）。
   *
   * 修法是**把采样尺度拉粗**而不是把贴图淡出到均值：
   * 淡出到均值实测会把远景变成一片没有明暗起伏的奶油色死面 ——
   * bump 收掉之后连地形起伏的阴影都读不出来，等于把丘陵拍平了。
   * 拉粗之后高频自己欠采样掉，剩下大块色调起伏，那才是几百米外田野该有的读法。
   *
   * near 取 100：镇外原野内边界在 r≈182m，航拍机位离圆心约 250m，
   * 近侧那一圈离相机只有约 70m，仍是满纹理，接缝处和 GLB 地形完全一致。
   * zoom 0.12 ⇒ 最远处一张贴图覆盖约 58m，读作大块地色而不是织纹。
   *
   * 顺带纠正一个诊断错误：第一版以为那是**摩尔纹**（欠采样），其实不是。
   * 300m 处一个像素footprint 约 0.41m，而贴图一个循环 6.9m —— 那是**放大**
   * 采样，纹理被看得一清二楚，露出来的是**平铺重复**本身。
   * 所以拉粗尺度是唯一对症的修法（mipmap 对放大根本不起作用）。
   */
  detailFade: { near: 100, far: 380, zoom: 0.12 },
};

/* ======================= 确定性噪声 =======================
 * 不用 Math.random：截图要能逐版比对，同一份源码必须每次长出同一片地形。 */

function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, octaves) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * f, y * f);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;                       // 0..1
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* ======================= 实测边缘 ======================= */

/**
 * 提取 GLB 地形网格的**边界环**：只被一个三角形用到的那些边，首尾串成闭合折线。
 *
 * 这是整个模块的接缝保证 —— 新原野第 0 圈直接摆在这条环上，与原网格共用同一条边，
 * 于是接缝处的高差按构造就是 0，不存在「估一个边缘高度」带来的误差。
 *
 * @returns {{loop: Float32Array, cx:number, cz:number}} loop 是 [x,y,z] 连续数组
 */
function measureBoundary(mesh) {
  const geo = mesh.geometry;
  mesh.updateWorldMatrix(true, false);
  const pos = geo.attributes.position;
  const idx = geo.index;
  const nTri = idx ? idx.count / 3 : pos.count / 3;

  // 边 → 被用了几次。只用 1 次的就是边界边。
  const edges = new Map();
  const key = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  for (let t = 0; t < nTri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const k = key(a, b);
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }

  // 顶点 → 与之相连的边界边邻居
  const nbr = new Map();
  const v = new THREE.Vector3();
  const pt = (i) => {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    return [v.x, v.y, v.z];
  };
  const ptCache = new Map();
  const P = (i) => {
    let p = ptCache.get(i);
    if (!p) { p = pt(i); ptCache.set(i, p); }
    return p;
  };

  for (const [k, c] of edges) {
    if (c !== 1) continue;
    const a = Math.floor(k / 4194304), b = k % 4194304;
    if (!nbr.has(a)) nbr.set(a, []);
    if (!nbr.has(b)) nbr.set(b, []);
    nbr.get(a).push(b);
    nbr.get(b).push(a);
  }
  if (!nbr.size) throw new Error('buildSurrounds: 地形网格没有封闭的边界环');

  // 串成闭合环；取最长的那条（地形有孔时会有多条）。
  const used = new Set();
  let best = null;
  for (const start of nbr.keys()) {
    if (used.has(start)) continue;
    const loop = [start];
    let cur = start, prev = -1;
    for (let guard = 0; guard < 200000; guard++) {
      const list = nbr.get(cur);
      if (!list) break;
      let nxt = -1;
      for (const w of list) if (w !== prev && !used.has(w)) { nxt = w; break; }
      if (nxt < 0) { if (cur !== start) loop.push(start); break; }
      used.add(cur);
      loop.push(nxt);
      prev = cur; cur = nxt;
      if (cur === start) break;
    }
    if (!best || loop.length > best.length) best = loop;
  }

  const loop = new Float32Array(best.length * 3);
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < best.length; i++) {
    const p = P(best[i]);
    loop[i * 3] = p[0]; loop[i * 3 + 1] = p[1]; loop[i * 3 + 2] = p[2];
    if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
    if (p[2] < minz) minz = p[2]; if (p[2] > maxz) maxz = p[2];
  }
  return { loop, cx: (minx + maxx) / 2, cz: (minz + maxz) / 2 };
}

/**
 * 边界环上按角度求交点 —— 每个角度拿到一个**精确落在折线上的 3D 点**。
 * 圆心在边界环包围盒中心，射线取最外侧的交点。
 */
function boundaryHits(bound, bins) {
  const { loop, cx, cz } = bound;
  const N = loop.length / 3;
  const out = [];
  for (let b = 0; b < bins; b++) {
    const th = ((b + 0.5) / bins) * Math.PI * 2 - Math.PI;
    const dx = Math.cos(th), dz = Math.sin(th);
    let bestT = -1, bx = 0, by = 0, bz = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const ax = loop[i * 3] - cx, az = loop[i * 3 + 2] - cz;
      const ex = loop[j * 3] - loop[i * 3], ez = loop[j * 3 + 2] - loop[i * 3 + 2];
      // 解 center + t*d = a + u*e  （2x2）
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ez - az * ex) / den;
      const u = (ax * dz - az * dx) / den;
      if (t > bestT && u >= -1e-9 && u <= 1 + 1e-9) {
        bestT = t;
        bx = loop[i * 3] + u * ex;
        bz = loop[i * 3 + 2] + u * ez;
        by = loop[i * 3 + 1] + u * (loop[j * 3 + 1] - loop[i * 3 + 1]);
      }
    }
    if (bestT < 0) {
      // 理论上不会发生（闭合环必然被每条射线穿过）；兜底用同角度最近顶点。
      let bi = 0, bd = Infinity;
      for (let i = 0; i < N; i++) {
        const ax = loop[i * 3] - cx, az = loop[i * 3 + 2] - cz;
        const cross = Math.abs(ax * dz - az * dx);
        if (cross < bd) { bd = cross; bi = i; }
      }
      bx = loop[bi * 3]; by = loop[bi * 3 + 1]; bz = loop[bi * 3 + 2];
    }
    out.push({ x: bx, y: by, z: bz, r: bestT > 0 ? bestT : Math.hypot(bx - cx, bz - cz) });
  }
  return { hits: out, cx, cz };
}

/**
 * 地形高度场：2m 一格，存**离格心最近的那个顶点**的高程。
 * 用来在边界内侧取一个点、量出边缘处地面真实的向外坡度。
 */
function buildHeightField(mesh, cell) {
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const best = new Map();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const gx = Math.round(v.x / cell), gz = Math.round(v.z / cell);
    const k = gx * 100000 + gz;
    const cxp = gx * cell, czp = gz * cell;
    const d2 = (v.x - cxp) ** 2 + (v.z - czp) ** 2;
    const cur = best.get(k);
    if (!cur || d2 < cur.d2) best.set(k, { d2, y: v.y });
  }
  return {
    cell,
    /** 最近格取值；2m 外的兜底邻域也找一遍。 */
    at(x, z) {
      const gx = Math.round(x / cell), gz = Math.round(z / cell);
      for (let ring = 0; ring < 4; ring++) {
        for (let a = -ring; a <= ring; a++) {
          for (let b = -ring; b <= ring; b++) {
            if (ring > 0 && Math.abs(a) !== ring && Math.abs(b) !== ring) continue;
            const hit = best.get((gx + a) * 100000 + (gz + b));
            if (hit) return hit.y;
          }
        }
      }
      return null;
    },
  };
}

/* ======================= 径向站位 ======================= */

function radialStops() {
  const S = TUNE.stops;
  // 头几圈排得密一点：它们在延续边缘的实测坡度，采样越稀坡度折线越粗。
  const out = [0];
  for (const d of [0.6, 1.6, 3, 5, 8, 12, 17, 23]) { if (d <= S.nearTo) out.push(d); }
  for (let d = S.nearTo; d <= S.midTo; d += S.midStep) out.push(d);
  let d = S.midTo + S.farStep0, step = S.farStep0;
  while (d < TUNE.reachM) { out.push(d); step *= S.farGrow; d += step; }
  out.push(TUNE.reachM);
  return Array.from(new Set(out.map((v) => +v.toFixed(3)))).sort((a, b) => a - b);
}

/* ======================= 高程场 ======================= */

/**
 * d = 从实测边界环向外的径向距离（米）。
 * d=0 处必须**精确等于**边界点的高程（那一点就在 GLB 的边上），这是硬约束。
 * 另外前 slopeRunM 米按边界处**实测到的地面坡度**线性延续，
 * 这样接缝上不会出现法线拐弯的折痕亮线。
 */
function heightAt(x, z, d, theta, edge, plainY) {
  if (d <= 0) return edge.y;

  // 1. 边缘坡度延续，30m 内线性，之后平滑交给平原基准。
  const run = Math.min(1, d / TUNE.slopeRunM);
  let y = edge.y + edge.slope * Math.min(d, TUNE.slopeRunM);
  y += (plainY - edge.y) * smoothstep(0, TUNE.slopeRunM + TUNE.apronM, d);

  // 2. 丘陵起伏。振幅从边缘的 0 爬到远处满值，所以接缝处导数也是连续的。
  const R = TUNE.relief;
  y += (fbm(x * R.freq, z * R.freq, R.octaves) - 0.5) * 2 * R.max * smoothstep(R.from, R.to, d) * run;

  // 3. 远山脊：径向带宽与高度都随方位抖动，否则读成「围着镇子的一圈墙」。
  const G = TUNE.ridge;
  const wob = fbm(Math.cos(theta) * 3.1 + 11.0, Math.sin(theta) * 3.1 + 7.0, 2);
  const inR = G.inMin + G.inSpan * wob;
  const outR = inR + G.width;
  const band = smoothstep(inR, inR + 200, d) * (1 - smoothstep(outR, outR + G.fall, d));
  y += (G.hMin + G.hSpan * wob) * band;

  // 4. 山脊之后的中远景缓缓抬起，破掉「一块死平的台面」。
  y += TUNE.farRise.amount * smoothstep(600, TUNE.farRise.to, d);
  return y;
}

/* ======================= 主体 ======================= */

/**
 * @param {THREE.Object3D} town 已经跑过 applyMaterials 的 GLB 根节点
 * @returns {{mesh:THREE.Mesh, stats:Function}}
 */
export function buildSurrounds({ town }) {
  /* ---- 找到地形本体并复用它的材质实例（三平面已注入，不能另造） ---- */
  let land = null;
  town.traverse((o) => {
    if (land || !o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || !TUNE.landTest.test(normName(m.name || ''))) return;
    if (!land || o.geometry.attributes.position.count > land.geometry.attributes.position.count) land = o;
  });
  if (!land) throw new Error('buildSurrounds: 找不到地形网格（材质名未匹配 /sun dried grasses/）');

  const bound = measureBoundary(land);
  const { hits, cx, cz } = boundaryHits(bound, TUNE.bins);
  const field = buildHeightField(land, 2);

  /* 逐角度量出边缘处地面真实的向外坡度（往内侧 slopeProbeM 取一个高程来比）。
   * 没有它，新原野第 0 圈就会「水平」切出去，接缝上出现一条法线拐弯的折痕亮线。 */
  const edges = hits.map((h, b) => {
    const theta = ((b + 0.5) / TUNE.bins) * Math.PI * 2 - Math.PI;
    const ix = h.x - Math.cos(theta) * TUNE.slopeProbeM;
    const iz = h.z - Math.sin(theta) * TUNE.slopeProbeM;
    const yin = field.at(ix, iz);
    const slope = yin == null ? 0 : (h.y - yin) / TUNE.slopeProbeM;
    return { ...h, theta, slope, slopeFromInland: yin };
  });

  const plainY = edges.reduce((s, e) => s + e.y, 0) / edges.length;

  const stops = radialStops();
  const bins = TUNE.bins;
  const rows = stops.length;

  const positions = new Float32Array(rows * bins * 3);
  let loY = Infinity, hiY = -Infinity;

  for (let k = 0; k < rows; k++) {
    const d = stops[k];
    for (let b = 0; b < bins; b++) {
      const e = edges[b];
      // 第 0 圈直接用边界环上的实测点（不外推、不重算高程）。
      const x = d === 0 ? e.x : e.x + Math.cos(e.theta) * d;
      const z = d === 0 ? e.z : e.z + Math.sin(e.theta) * d;
      const y = d === 0 ? e.y : heightAt(x, z, d, e.theta, e, plainY);
      const i = (k * bins + b) * 3;
      positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
      if (y < loY) loY = y;
      if (y > hiY) hiY = y;
    }
  }

  /* ---- 索引：一个纯条带网格，不分组合并，本来就只有 1 个 drawcall ---- */
  const quads = (rows - 1) * bins;
  const indices = new Uint32Array(quads * 6);
  let p = 0;
  for (let k = 0; k < rows - 1; k++) {
    for (let b = 0; b < bins; b++) {
      const b1 = (b + 1) % bins;
      const a0 = k * bins + b, a1 = k * bins + b1;
      const c0 = (k + 1) * bins + b, c1 = (k + 1) * bins + b1;
      indices[p++] = a0; indices[p++] = c0; indices[p++] = c1;
      indices[p++] = a0; indices[p++] = c1; indices[p++] = a1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  /* ---- 材质：克隆地形本体那个已注入的实例，并单独打开距离 LOD ----
   * 不能直接复用同一个实例：LOD 区间一变，GLB 自己的地形也会跟着被抹平，
   * 镇子周围那圈草地就没纹理了。cloneInjected 保留三平面注入，只换参数。 */
  const srcMat = Array.isArray(land.material) ? land.material[0] : land.material;
  const mat = cloneInjected(srcMat, { fade: TUNE.detailFade });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'SurroundingLand';
  mesh.castShadow = false;      // 平地自投影只会出 acne；阴影相机也只有 ±155m
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  // 接缝自检。第 0 圈按构造就在 GLB 的边界环上，所以径向差应当**恒等于 0**；
  // 角向差也应当在弦高误差内（192 段切 26 段折线，约 0.02m）。
  // 任何非零值都说明边界环提取或求交写错了。
  let seamR = 0, seamY = 0;
  for (let b = 0; b < bins; b++) {
    const e = edges[b], i = b * 3;
    seamR = Math.max(seamR, Math.abs(Math.hypot(positions[i] - cx, positions[i + 2] - cz) - e.r));
    seamY = Math.max(seamY, Math.abs(positions[i + 1] - e.y));
  }
  const slopes = edges.map((e) => e.slope);
  const bbox = new THREE.Box3().setFromBufferAttribute(land.geometry.attributes.position);

  return {
    mesh,
    stats: () => ({
      rimBins: bins,
      /** GLB 地形边界环上的顶点数（= 新原野内边界按角度求交得到的点数）。 */
      boundaryLoopVerts: bound.loop.length / 3,
      rimRMin: +Math.min(...edges.map((e) => e.r)).toFixed(2),
      rimRMax: +Math.max(...edges.map((e) => e.r)).toFixed(2),
      rimYMin: +Math.min(...edges.map((e) => e.y)).toFixed(2),
      rimYMax: +Math.max(...edges.map((e) => e.y)).toFixed(2),
      /** 边缘处地面实测坡度（向外为正）。范围太宽说明高度场采样不可靠。 */
      edgeSlopeMin: +Math.min(...slopes).toFixed(3),
      edgeSlopeMax: +Math.max(...slopes).toFixed(3),
      plainY: +plainY.toFixed(2),
      sealM: TUNE.sealM,
      seamRadialMaxM: +seamR.toFixed(4),
      seamHeightMaxM: +seamY.toFixed(4),
      rings: rows,
      reachM: TUNE.reachM,
      newTriangles: quads * 2,
      newDrawCalls: 1,
      material: mat.name,
      detailFade: TUNE.detailFade,
      center: [+cx.toFixed(2), +cz.toFixed(2)],
      heightRange: [+loY.toFixed(2), +hiY.toFixed(2)],
      landBBox: { min: [+bbox.min.x.toFixed(1), +bbox.min.y.toFixed(1), +bbox.min.z.toFixed(1)], max: [+bbox.max.x.toFixed(1), +bbox.max.y.toFixed(1), +bbox.max.z.toFixed(1)] },
    }),
  };
}
