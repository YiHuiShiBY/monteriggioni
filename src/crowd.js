/**
 * Monteriggioni · 人物系统（设计规格 WALLWALK-CROWD.md 第 3.3 / 3.4 / 3.5 节）
 * ---------------------------------------------------------------------------
 * 解决的问题：`src/people.js` 造出了 40 个会摆姿势的人，但**站在哪、往哪走、什么时候
 * 转身**得由这里回答。三条路径全部从**活着的 three 场景**里取，不凭空画：
 *
 *   1. 环城墙道   第一批 `wallwalk.js` 提取的 436 点中心线；第二批给塔楼开了通行口之后，
 *                 这条线**穿过塔楼不再被切断**，全环只剩城门口那一处收口
 *   2. 南北主街   `Via Primo Maggio | main village street` / `Village street | north approach`
 *   3. 广场       `Piazza Roma | open stone square`，绕开井、两处咖啡座、教堂
 *
 * ── 建筑禁区怎么来的（规格 3.3 的修正版）──────────────────────────────────
 * 规格原文要求用 `scene_manifest.json` 的 `footprints_xy`。**本模块不碰它**：
 * 那是 **Blender 坐标 (x, y)**，场景是 **three 坐标 (x, y_up, z)**，两者差一个换轴符号。
 * 原探针（`probe-crowd.mjs --glb`）里那条判据实测是失效的：它选中的「广场盒」是
 * `Piazza Roma | east arcade house | gable 1` —— 一个退化的 gable 薄片（x 只有 [37,37]），
 * 根本不是广场面；换轴候选 A / B 两边都是 0/47 命中，区分不出任何东西。
 *
 * 正确做法和 `wallwalk.js` 一样：**直接遍历活着的 `town`**，把墙体类网格（名字含
 * `masonry` / 钟楼 / 井圈 / 咖啡座家具）与 13 座塔楼的世界包围盒 **xz 投影**收成禁区集合。
 * 坐标系天然是 three 的，不存在换轴问题。（换轴结论本身记在这里备用：
 * `three.z = -blender.y`，已用 `Piazza Roma` three z[-49,-17] ↔ landscape.py
 * Blender y 17..49 对上；`TUNE.coordSign = -1` 作为占位说明保留，实际没有一处用到。）
 *
 * 采样时逐点检测，落进禁区的采样点直接丢弃、**并在此处断成两段**（不跨洞连线，
 * 否则人会从建筑肚子里穿过去）。这就是规格「不要靠手调路径躲开」那条纪律的落地。
 *
 * ── 三条路径的实测取样面（全部由活场景的包围盒 / 顶点现算）────────────────
 *   `Via Primo Maggio | main village street`  x[-6.80, 6.80] z[-17, 83]
 *   `Village street | north approach`         x[-6.80, 6.80] z[-83, -49]
 *   `Piazza Roma | open stone square`         x[-16.0, 20.0] z[-49, -17]
 *
 * 街面和广场面都是**带厚度、跟着地形起伏的板**（街面顶沿程 14.23 → 14.12，
 * 广场面 14.46 → 14.40），所以**不能**简单拿包围盒 max.y 当地面 —— 那样 z=80 的人
 * 会浮空 11cm，广场北端会陷进地里。这里对每块地面网按 1m 网格扫一遍真实顶点建
 * **高程场**（每格取最高 y = 板的顶面），逐点双线性取样，误差在厘米级。
 *
 * ── 步态相位按路程推进（规格 3.2 的硬要求）──────────────────────────────
 * 推进只有一处：`phase += 路程 / TUNE.gait.strideM`。速度只影响路程、不直接进相位，
 * 所以有人加速只会「步子变快」，不会原地滑步。`gaitProbe()` 复用同一个 advance() 自证。
 *
 * ── 阴影：全镇是一次性烘焙的（app.js `shadowMap.autoUpdate = false`）────────
 * 太阳静止，所以整张阴影贴图只在加载后画一次。会走的人让这件事变别扭：不重烘，
 * 影子会永远钉在初始位置，广场上留一堆和人对不上的黑斑。这里做两段策略（详见
 * `TUNE.shadow`）：真 GPU 上按**模拟时间**节流重烘（滞后 ~0.15m，贴脚）；本机扛不住的
 * 时候自动降级成「按位移门限重烘」，宁可滞后 0.6m，也不要影子脱节到看不出。
 * `window.__asset.crowd.refreshShadows()` 保留手动触发口。
 *
 * three r160 纪律：不引入任何新依赖，不使用 r162+ / r163+ 的 API。
 */

import * as THREE from 'three';
import { TUNE as WALLWALK } from './wallwalk.js';
import { buildPeople, applyPose, commitFrame, newPose, poseFigure, TUNE as PEOPLE } from './people.js';

/* ============================== TUNE ============================== */

export const TUNE = {
  /**
   * Blender(x,y) → three(x,z) 的换轴符号。**本批没有一处真的用到它**
   * （禁区与路径全部直接从活着的 three 场景读），保留字段只为记录实测结论。
   */
  coordSign: -1,

  /** 稳定 hash 的种子。同一 seed 重跑，人群的位置/速度/配色/相位完全一致。 */
  seed: 20260929,

  /** 规格 3.4：约 40 人，热闹市集。 */
  population: { wall: 14, street: 16, piazza: 10, piazzaIdle: 2 },

  /** 每人速度区间（m/s）；广场慢、主街略慢、墙道全速。 */
  speed: { min: 0.55, max: 1.35, piazzaScale: 0.62, streetScale: 0.94 },

  /** 身高区间（米）。GLB 静态 12 人实测 2.08m（偏高），这里给真实区间。 */
  height: { min: 1.66, max: 1.94 },

  /**
   * 双向车道的横向偏移（米，按组区分）与换向时的横向过渡长度。
   * 墙道净宽只有 1.20m，两向各贴一侧（0.26m），运行时按方向横移；
   * 主街 13.6m 宽，两流分开 2.0m —— 这条偏移**直接烘进折线**（街面是斜面，
   * 中轴采高程再横移会差 4.6cm，见 streetPath 的注释）；
   * 广场不需要分道。
   */
  lane: { half: { wall: 0.26, street: 2.00, piazza: 0 }, blendM: 1.4 },

  /** 三条路径的几何参数。 */
  path: {
    sampleStep: 0.90,      // 重采样步长（沿路径弧长，不是沿参数）
    minRunM: 6.0,          // 短于这个长度的残段直接丢掉
    wallEndTrimM: 0.70,    // 塔楼占位段两端再退一点，免得人站在塔角上
    streetInsetM: 1.50,    // 主街两端各缩进
    piazza: { cx: 2.0, cz: -33.0, hx: 12.5, hz: 9.0, r: 4.5 },  // 圆角环线
    piazzaSpur: [{ x: -2.0, z: -18.5 }, { x: -2.0, z: -46.5 }],  // 街口 → 北端穿行
    piazzaIdles: [         // 少量停留：井边、咖啡座前
      { x: 5.0, z: -30.0, yaw: 2.35 },
      { x: 12.0, z: -39.5, yaw: -1.05 },
    ],
  },

  /**
   * 禁区。名字命中即取世界包围盒的 xz 投影。
   * `masonry` 覆盖全部连排民居 / 街屋 / 花园翼楼 / 教堂 / 钟楼（实测 37 个盒）。
   */
  blocker: {
    test: /\|\s*masonry$|Romanesque nave|square campanile shaft|open masonry ring|^Cafe \d/,
    margin: 0.45,
  },

  /**
   * 地面高程场：cell 米网格扫真实顶点取最大 y，空格邻域补。
   * 0.5m 而不是 1m：这两块地面都是**斜面**（实测主街横向落差 15.6cm/13.6m，
   * 广场沿 x 坡 1.55%），格越粗「取格内最大」带来的偏高就越大。0.5m 下
   * 斜率引入的偏差 ≤ 0.25m × 1.55% ≈ 4mm。
   */
  ground: { cell: 0.5, dilate: 3 },

  /** 地面网的**原始**名字（GLB 里的原样，严格相等匹配，避开同前缀的其它构件）。 */
  surface: {
    street: 'Via Primo Maggio | main village street',
    northApproach: 'Village street | north approach',
    piazza: 'Piazza Roma | open stone square',
  },

  /**
   * 动态阴影策略。**关键：节流按「模拟时间」计，不按墙钟。**
   *
   * 真 GPU（60fps）上 0.15s 模拟时间 = 9 帧，一次 4096² 重烘 ~35ms → 约 5% 开销，
   * 影子滞后 ≈ 0.15m，肉眼是贴脚的。
   *
   * 慢机上不行：headless SwiftShader 实测**普通帧 5.7~55s、一次重烘再加 11~13s**，
   * 而主循环把 dt 夹在 0.25s —— 一帧就到点，等于每帧重画 4096²。所以第一阶段
   * 会被 `abortFrameMs` 判负（120ms ≈ 8fps 以下），落进第二阶段「降级」：
   * 每 `degradedMinFrames` 帧、且累计位移超过 `degradedMaxDriftM` 才重烘一次。
   * 代价是影子最多滞后 ~0.6m（人的影子本身长 2m），但**方向与全镇一致、且不会脱节到看不出**；
   * 宁可这样，也不要「一次烘完就永远不动」——那会在广场上留一堆和人对不上的黑斑。
   */
  shadow: {
    rebake: true,
    rebakeSec: 0.15,        // 模拟时间节流
    abortFrameMs: 120,     // 帧间隔超过它 = 本机扛不住每帧重烘
    degradedMinFrames: 2,  // 降级模式：最少隔几帧
    degradedMaxDriftM: 0.6,// 降级模式：累计位移阈值
  },
};

const GROUP_CODE = { wall: 1, street: 2, piazza: 3 };

/* ============================ 稳定随机 ============================ */

/** FNV-1a 变体：把若干整数混成一个 uint32，跨会话、跨平台一致。 */
function mix(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    let x = n >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff; h = Math.imul(h, 16777619) >>> 0; x >>>= 8;
    }
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32：小而稳的 PRNG，同 seed 逐位可复现。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (v) => +v.toFixed(2);
const r3 = (v) => +v.toFixed(3);
const r4 = (v) => +v.toFixed(4);

/* ========================= 从活场景取数据 ========================= */

/**
 * 拿对象的**原始**名字。
 *
 * 踩过的坑：GLTFLoader 会把**节点名**过一遍 `PropertyBinding.sanitizeNodeName`，
 * 里面是 `name.replace(/\s/g, '_')` —— `Via Primo Maggio | main village street`
 * 到了 three 里叫 `Via_Primo_Maggio_|_main_village_street`。照 GLB 原名写正则
 * 一条都匹配不上（本模块第一版就死在这儿）。原始名被 GLTFLoader 存在
 * `userData.name` 里（GLTFLoader.js:4214），**材质名则完全不 sanitize**。
 * 所以：按名字找对象一律走这个函数，按材质分派才直接用 `material.name`。
 */
function rawName(o) {
  return o.userData.name || o.name || '';
}

function findMesh(town, name) {
  let hit = null;
  town.traverse((o) => { if (!hit && o.isMesh && rawName(o) === name) hit = o; });
  return hit;
}

/** 建筑禁区集合：世界包围盒的 xz 投影（含 margin）。 */
function collectBlockers(town) {
  const out = [];
  const m = TUNE.blocker.margin;
  const b = new THREE.Box3();
  town.traverse((o) => {
    if (!o.isMesh || !TUNE.blocker.test.test(rawName(o))) return;
    b.setFromObject(o);
    if (!isFinite(b.min.x)) return;
    out.push({
      name: rawName(o),
      minX: b.min.x - m, maxX: b.max.x + m,
      minZ: b.min.z - m, maxZ: b.max.z + m,
      topY: b.max.y,
    });
  });
  return out;
}

function insideAny(boxes, x, z) {
  for (const b of boxes) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
  return false;
}

/**
 * 地面高程场：把一块地面网的真实顶点按 `cell` 米网格取最大 y（板的顶面），空格邻域补齐。
 * 街面 / 广场面都跟着地形起伏，用包围盒 max.y 会让人浮空十几厘米，必须逐点取。
 */
function heightField(mesh, cell, dilate) {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry;
  g.computeBoundingBox();
  const bb = g.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  const nx = Math.max(2, Math.ceil((bb.max.x - bb.min.x) / cell) + 1);
  const nz = Math.max(2, Math.ceil((bb.max.z - bb.min.z) / cell) + 1);
  const h = new Float32Array(nx * nz).fill(-Infinity);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const m = mesh.matrixWorld;
  let top = -Infinity, bottom = Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    if (v.y > top) top = v.y;
    if (v.y < bottom) bottom = v.y;
    const ix = Math.min(nx - 1, Math.max(0, Math.round((v.x - bb.min.x) / cell)));
    const iz = Math.min(nz - 1, Math.max(0, Math.round((v.z - bb.min.z) / cell)));
    const k = iz * nx + ix;
    if (v.y > h[k]) h[k] = v.y;
  }
  for (let pass = 0; pass < dilate; pass++) {
    const src = h.slice();
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const k = z * nx + x;
        if (src[k] !== -Infinity) continue;
        let best = -Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const zz = z + dz, xx = x + dx;
            if (zz < 0 || zz >= nz || xx < 0 || xx >= nx) continue;
            const s = src[zz * nx + xx];
            if (s > best) best = s;
          }
        }
        h[k] = best;
      }
    }
  }
  for (let k = 0; k < h.length; k++) if (h[k] === -Infinity) h[k] = top;
  return { x0: bb.min.x, z0: bb.min.z, cell, nx, nz, h, top, bottom, mesh: mesh.name };
}

function sampleField(f, x, z) {
  const fx = (x - f.x0) / f.cell, fz = (z - f.z0) / f.cell;
  const x0 = Math.min(f.nx - 2, Math.max(0, Math.floor(fx)));
  const z0 = Math.min(f.nz - 2, Math.max(0, Math.floor(fz)));
  const tx = Math.min(1, Math.max(0, fx - x0));
  const tz = Math.min(1, Math.max(0, fz - z0));
  const a = f.h[z0 * f.nx + x0], b = f.h[z0 * f.nx + x0 + 1];
  const c = f.h[(z0 + 1) * f.nx + x0], d = f.h[(z0 + 1) * f.nx + x0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/* ============================ 折线工具 ============================ */

function dedupe(pts) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].distanceToSquared(out[out.length - 1]) > 1e-8) out.push(pts[i]);
  }
  return out;
}

/** 按固定弧长步长重采样（不是按参数均匀），这样人在弯道上不会忽快忽慢。 */
function resample(pts, step) {
  const clean = dedupe(pts);
  if (clean.length < 2) return clean;
  const out = [clean[0].clone()];
  let carry = 0;
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1], b = clean[i];
    const seg = a.distanceTo(b);
    if (seg < 1e-9) continue;
    let t = (step - carry) / seg;
    while (t <= 1) {
      out.push(new THREE.Vector3().lerpVectors(a, b, t));
      t += step / seg;
    }
    carry = (carry + seg) % step;
  }
  return out;
}

function newStat() {
  return { rejected: 0, droppedShort: 0, kept: 0, points: 0, runs: 0, lengthM: 0 };
}

function mergeStat(dst, src) {
  dst.rejected += src.rejected; dst.droppedShort += src.droppedShort;
  dst.kept += src.kept; dst.points += src.points; dst.runs += src.runs;
  dst.lengthM = r2(dst.lengthM + src.lengthM);
}

/**
 * 候选采样点 → 可走段。
 * 候选项是 `{ p: Vector3 }`，**`null` 表示就地丢弃**（塔楼占位、端点退让都靠它）。
 * 命中禁区或为 null 的点直接丢掉并**在此断段** —— 不跨洞连线，否则人会从建筑肚子里穿过去。
 * `latAt(p)` 给车道偏移方向（墙道用墙内法线）；不给就用切向的右手法线（街 / 广场）。
 */
function makeRuns(cands, isBlocked, stats, { step, minRunM, latAt }) {
  const chunks = [];
  let cur = [];
  for (const c of cands) {
    if (!c || isBlocked(c.p)) {
      stats.rejected++;
      if (cur.length >= 2) chunks.push(cur);
      cur = [];
      continue;
    }
    cur.push(c);
  }
  if (cur.length >= 2) chunks.push(cur);

  const out = [];
  for (const chunk of chunks) {
    const pts = resample(chunk.map((c) => c.p), step);
    if (pts.length < 2) continue;
    const n = pts.length;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + pts[i].distanceTo(pts[i - 1]);
    const length = cum[n - 1];
    if (length < minRunM) { stats.droppedShort++; continue; }
    const tan = new Array(n), lat = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      tan[i] = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
      const l = latAt ? latAt(pts[i]) : null;
      lat[i] = (l ? l.clone() : new THREE.Vector3(-tan[i].z, 0, tan[i].x)).setY(0).normalize();
    }
    stats.kept++;
    stats.points += n;
    out.push({ pts, cum, tan, lat, length });
  }
  stats.runs = out.length;
  stats.lengthM = r2(out.reduce((s, r) => s + r.length, 0));
  return out;
}

const _smp = { p: new THREE.Vector3(), tan: new THREE.Vector3(), lat: new THREE.Vector3() };
function sampleRun(run, s) {
  const cum = run.cum, n = cum.length;
  const q = Math.min(run.length, Math.max(0, s));
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= q) lo = mid; else hi = mid; }
  const i = lo, j = Math.min(i + 1, n - 1);
  const seg = cum[j] - cum[i];
  const t = seg > 1e-9 ? (q - cum[i]) / seg : 0;
  _smp.p.lerpVectors(run.pts[i], run.pts[j], t);
  _smp.tan.copy(run.tan[i]);
  _smp.lat.copy(run.lat[i]);
  return _smp;
}

/* ============================ 三条路径 ============================ */

/**
 * 1) 环城墙道：直接用 `wallwalk.js` 的 436 点中心线。
 *
 * 塔楼**不再**是断点：上一批按塔楼包围盒把墙道切成 14 段（人物走到塔前就折返，
 * 全环丢 113.6m）；`wallwalk.js` 第二批给每座塔开了通行口，中心线现在穿过塔楼，
 * 这里也就不能再切 —— 人真的从门洞里走过去。
 *
 * 接缝对齐 `wall.seamIndex`（wallwalk 算出的最大极角间隙之后 = 一座城门），
 * 两端各退 `wallEndTrimM` 后闭合处的城门弦被剔掉，于是：
 * 人在城门口折返，而不会在城墙中段凭空断一截，也不会站在塔角上。
 *
 * 步道带中心 = 横向 [walkway.from, walkway.to] 的中点相对墙身中线（wallHalf），
 * 顶面高 = 压顶石顶 + walkway.topProud —— 与铺装顶面逐米对齐。
 */
function wallPath({ town, wall }) {
  const stats = newStat();
  const pts = wall.centerline;
  const n = pts.length;
  // 接缝落在城门口（wallwalk 算的同一个角间隙），不是任意一点。
  const start = Number.isInteger(wall.seamIndex) ? wall.seamIndex : 0;

  const off = (WALLWALK.walkway.from + WALLWALK.walkway.to) / 2 - WALLWALK.wallHalf;
  const dy = WALLWALK.walkway.topProud;
  const trim = Math.max(1, Math.ceil(TUNE.path.wallEndTrimM / TUNE.path.sampleStep));

  // 绕一圈（多带一个点让接缝闭合）。
  const cands = [];
  for (let k = 0; k <= n; k++) {
    const p = pts[(start + k) % n];
    const v = p.top.clone().addScaledVector(p.inN, off);
    v.y += dy;
    cands.push({ p: v });
  }
  // 每段首尾各退 trim 个采样点，免得人站在城门口 / 塔角上。
  const first = cands.findIndex(Boolean);
  const last = cands.length - 1 - cands.slice().reverse().findIndex(Boolean);
  for (let k = 0; k < trim; k++) {
    if (first + k <= last) cands[first + k] = null;
    if (last - k >= first) cands[last - k] = null;
  }

  // 车道方向 = 最近的压顶石自带的内法线 inN（不是重采样后按序取的，索引对不上）。
  const latAt = (p) => {
    let best = null, bd = Infinity;
    for (const q of pts) { const d = q.top.distanceToSquared(p); if (d < bd) { bd = d; best = q; } }
    return best ? best.inN : null;
  };

  const runs = makeRuns(cands, () => false, stats, {
    step: TUNE.path.sampleStep, minRunM: TUNE.path.minRunM, latAt,
  });
  return { runs, stats };
}

/**
 * 2) 南北主街：**两条车道各建一条折线**（x = ±lane.half.street），而不是中轴一条 + 运行时横移。
 *
 * 原因：主街是**有横向落差的斜面**（实测西缘 14.070 → 东缘 14.226，13.6m 落差 15.6cm）。
 * 早前在中轴采样高程、运行时把人横移 2m，落差就变成 ~4.6cm 的浮空/陷地。
 * 车道直接写进折线，高程就采在人真正站着的那条 x 上。
 * `run.fixedLane = 0` 表示「横向偏移已经烘进折线」，`run.dirHint` 固定该车道的行进方向
 * （面向 +z 时右手边是 −x，所以东侧车道往北、西侧车道往南）。
 */
function streetPath({ fields, blockers }) {
  const stats = newStat();
  const half = TUNE.lane.half.street;
  const runs = [];
  // 只取街面与北引道两块，广场那张网不参与（它的 z 范围和街不连续）。
  for (const key of ['street', 'northApproach']) {
    const field = fields[key];
    const bb = field.bbox;
    const z0 = bb.min.z + TUNE.path.streetInsetM;
    const z1 = bb.max.z - TUNE.path.streetInsetM;
    const steps = Math.max(2, Math.round((z1 - z0) / TUNE.path.sampleStep));
    for (const laneX of [-half, half]) {
      const cands = [];
      for (let i = 0; i <= steps; i++) {
        const z = z0 + (z1 - z0) * (i / steps);
        cands.push({ p: new THREE.Vector3(laneX, sampleField(field, laneX, z), z) });
      }
      const st = newStat();
      const rs = makeRuns(cands, (p) => insideAny(blockers, p.x, p.z), st, {
        step: TUNE.path.sampleStep, minRunM: TUNE.path.minRunM,
      });
      for (const r of rs) { r.fixedLane = 0; r.dirHint = laneX < 0 ? -1 : 1; }
      runs.push(...rs);
      mergeStat(stats, st);
    }
  }
  return { runs, stats };
}

/** 3) 广场：绕井与两处咖啡座的圆角环线 + 一条南北穿行线。 */
function piazzaRaw(field) {
  const P = TUNE.path.piazza;
  const out = [];
  const at = (x, z) => out.push({ p: new THREE.Vector3(x, sampleField(field, x, z), z) });
  const R = Math.min(P.r, P.hx, P.hz);
  const line = (x0, z0, x1, z1) => {
    const k = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / TUNE.path.sampleStep));
    for (let i = 0; i <= k; i++) at(x0 + (x1 - x0) * (i / k), z0 + (z1 - z0) * (i / k));
  };
  const arc = (cx, cz, a0, a1) => {
    const k = Math.max(2, Math.round((Math.abs(a1 - a0) * R) / TUNE.path.sampleStep));
    for (let i = 0; i <= k; i++) {
      const a = a0 + (a1 - a0) * (i / k);
      at(cx + Math.cos(a) * R, cz + Math.sin(a) * R);
    }
  };
  line(P.cx + P.hx, P.cz - P.hz + R, P.cx + P.hx, P.cz + P.hz - R);
  arc(P.cx + P.hx - R, P.cz + P.hz - R, 0, Math.PI / 2);
  line(P.cx + P.hx - R, P.cz + P.hz, P.cx - P.hx + R, P.cz + P.hz);
  arc(P.cx - P.hx + R, P.cz + P.hz - R, Math.PI / 2, Math.PI);
  line(P.cx - P.hx, P.cz + P.hz - R, P.cx - P.hx, P.cz - P.hz + R);
  arc(P.cx - P.hx + R, P.cz - P.hz + R, Math.PI, 1.5 * Math.PI);
  line(P.cx - P.hx + R, P.cz - P.hz, P.cx + P.hx - R, P.cz - P.hz);
  arc(P.cx + P.hx - R, P.cz - P.hz + R, 1.5 * Math.PI, 2 * Math.PI);

  const S = TUNE.path.piazzaSpur;
  const k = Math.round(Math.hypot(S[1].x - S[0].x, S[1].z - S[0].z) / TUNE.path.sampleStep);
  for (let i = 0; i <= k; i++) {
    const x = S[0].x + (S[1].x - S[0].x) * (i / k);
    const z = S[0].z + (S[1].z - S[0].z) * (i / k);
    out.push({ p: new THREE.Vector3(x, sampleField(field, x, z), z) });
  }
  return out;
}

/* ============================ 人群 ============================ */

/** 按弧长比例把 count 个人铺到若干段上（最大余数法），返回每段人数。 */
function spread(runs, count) {
  const out = runs.map(() => 0);
  if (!runs.length || count <= 0) return out;
  const total = runs.reduce((s, r) => s + r.length, 0);
  if (total <= 0) return out;
  const raw = runs.map((r) => (count * r.length) / total);
  for (let i = 0; i < runs.length; i++) out[i] = Math.floor(raw[i]);
  let left = count - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  for (let k = 0; k < left; k++) out[order[k % order.length].i]++;
  return out;
}

/**
 * 人的位姿容器：`newPose()` 与 `poseFigure()` 都来自 `people.js`（转发自 `gait.js`），
 * 这里只补上**世界位姿**那四个字段（人群系统自己管的，不属于骨架）。
 * 上一批本文件里有一份自己的 `newPose`（6 个槽）和一整套 `setPart` /
 * 四元数临时量；那些现在是 `gait.js` 的职责，两处各写一份必然走偏。
 */
function wrapPose() {
  const p = newPose();
  p.x = 0; p.y = 0; p.z = 0; p.yaw = 0; p.scale = 1;
  return p;
}

const G = PEOPLE.gait;

/**
 * 姿态求解。**只做一件事：把「沿折线的弧长」翻译成 `poseFigure` 要的相位。**
 *
 * 上一批这里有一整套自己的公式（刚腿绕髋 + 髋高 = 腿长·cos(摆角)），
 * player.js 里还有**第二份**几乎一样的。两份公式靠人肉保持同步，
 * 而它们是「膝关节永远弯不了」的那套 —— 本批统一到 `src/gait.js` 的
 * 单支撑 + 两骨 IK，人群与玩家共用**同一份** `poseFigure()`。
 * 本函数因此从 ~55 行缩到 12 行，能力反而多了：弯肘、弯膝、抬脚、跟触地/蹬离。
 */
function poseWalker(w, time) {
  const p = w.pose;
  p.scale = w.height / PEOPLE.nominalHeight;

  if (w.mode === 'idle') {
    p.x = w.home.x; p.y = w.home.y; p.z = w.home.z; p.yaw = w.home.yaw;
    poseFigure(p, { moving: false, phase: w.phase, time, breathPhase: w.seedPhase });
    return;
  }

  const smp = sampleRun(w.run, w.s);
  p.x = smp.p.x + smp.lat.x * w.lane;
  p.y = smp.p.y;
  p.z = smp.p.z + smp.lat.z * w.lane;
  p.yaw = Math.atan2(smp.tan.x * w.dir, smp.tan.z * w.dir);

  poseFigure(p, { moving: true, phase: w.phase, time, breathPhase: w.seedPhase });
}

/**
 * 推进一个人。**相位只从路程来**：`phase += 路程 / strideM`。
 * 速度只影响路程，所以加速的人只是步频变高，绝不会原地滑步。
 */
function advance(w, dt) {
  if (w.mode === 'idle') return;
  const d = w.speed * dt;
  w.dist += d;
  w.phase += d / G.strideM;
  w.s += w.dir * d;
  if (w.s >= w.run.length) { w.s = 2 * w.run.length - w.s; w.flip(); w.reversals++; }
  else if (w.s <= 0) { w.s = -w.s; w.flip(); w.reversals++; }
  // 换向时横向过到对侧车道，过渡长度固定 1.4m（不是瞬移）。
  const step = d / TUNE.lane.blendM;
  const diff = w.laneTarget - w.lane;
  w.lane += Math.max(-step, Math.min(step, diff));
}

/* ============================== 主入口 ============================== */

/**
 * 生成整群人，挂到 `town` 下。必须在 `applyMaterials` 与 `buildWallWalk` **之后**调用。
 */
export function buildCrowd({ town, wall, renderer, char }) {
  town.updateWorldMatrix(true, true);

  const TOTAL = TUNE.population.wall + TUNE.population.street + TUNE.population.piazza;

  /* ---- 1. 从活场景取数据 ---- */
  const blockers = collectBlockers(town);

  const fields = {};
  for (const [key, name] of Object.entries(TUNE.surface)) {
    const mesh = findMesh(town, name);
    if (!mesh) throw new Error(`crowd: town 里找不到地面网 ${key}（${name}）`);
    const f = heightField(mesh, TUNE.ground.cell, TUNE.ground.dilate);
    f.bbox = new THREE.Box3().setFromObject(mesh);
    f.mesh = name;
    fields[key] = f;
  }

  /* ---- 2. 三条路径 ---- */
  const wallBuilt = wallPath({ town, wall });
  if (!wallBuilt.runs.length) throw new Error('crowd: 墙道一条可走段都没剩下');
  const streetBuilt = streetPath({ fields, blockers });
  if (!streetBuilt.runs.length) throw new Error('crowd: 主街一条可走段都没剩下');
  const piazzaStat = newStat();
  const piazzaRuns = makeRuns(piazzaRaw(fields.piazza), (p) => insideAny(blockers, p.x, p.z), piazzaStat, {
    step: TUNE.path.sampleStep, minRunM: TUNE.path.minRunM,
  });
  if (!piazzaRuns.length) throw new Error('crowd: 广场一条可走段都没剩下');

  /* ---- 3. 铺人 ---- */
  const walkers = [];
  const laneHalf = (g) => TUNE.lane.half[g] || 0;

  function nextWalker(group, run, dir) {
    const id = walkers.length;
    const r = rng(mix(TUNE.seed, GROUP_CODE[group], id));
    const scale = group === 'piazza' ? TUNE.speed.piazzaScale : group === 'street' ? TUNE.speed.streetScale : 1;
    const half = laneHalf(group);
    // `fixedLane` 的段（主街）横向偏移已烘进折线，运行时不再横移。
    const lane0 = run && run.fixedLane !== undefined ? run.fixedLane : -dir * half;
    const w = {
      id, group, run, dir,
      s: 0,
      lane: lane0, laneTarget: lane0,
      speed: r3(TUNE.speed.min + (TUNE.speed.max - TUNE.speed.min) * r() * scale),
      height: r3(TUNE.height.min + (TUNE.height.max - TUNE.height.min) * r()),
      phase: r() * Math.PI * 2, dist: 0, reversals: 0,
      seedPhase: r() * Math.PI * 2,
      skinIdx: (r() * PEOPLE.color.skin.length) | 0,
      clothIdx: (r() * PEOPLE.color.cloth.length) | 0,
      trouserIdx: (r() * PEOPLE.color.trouser.length) | 0,
      hairIdx: (r() * PEOPLE.color.hair.length) | 0,
      mode: 'walk',
      pose: wrapPose(),
      flip() {
        this.dir = -this.dir;
        this.laneTarget = (this.run && this.run.fixedLane !== undefined)
          ? this.run.fixedLane
          : -this.dir * laneHalf(this.group);
      },
    };
    walkers.push(w);
    return w;
  }

  function fill(runs, group, count) {
    const quotas = spread(runs, count);
    let n = 0;
    runs.forEach((run, ri) => {
      const k = quotas[ri];
      for (let j = 0; j < k; j++, n++) {
        // 主街的每条折线自带方向（车道已固定）；墙道 / 广场按人序交替方向 = 双向对行。
        const dir = run.dirHint !== undefined ? run.dirHint : (n % 2 === 0 ? 1 : -1);
        const w = nextWalker(group, run, dir);
        w.s = ((j + 0.5) / k) * run.length;
      }
    });
    return n;
  }

  const placedWall = fill(wallBuilt.runs, 'wall', TUNE.population.wall);
  const placedStreet = fill(streetBuilt.runs, 'street', TUNE.population.street);
  const placedPiazza = fill(piazzaRuns, 'piazza', TUNE.population.piazza - TUNE.population.piazzaIdle);
  if (placedWall !== TUNE.population.wall || placedStreet !== TUNE.population.street
      || placedPiazza !== TUNE.population.piazza - TUNE.population.piazzaIdle) {
    throw new Error(`crowd: 铺人失败 wall ${placedWall}/${TUNE.population.wall} street ${placedStreet}/${TUNE.population.street} piazza ${placedPiazza}`);
  }

  // 广场里的少量停留者：呼吸式微摆，不走路。
  for (const spot of TUNE.path.piazzaIdles) {
    let x = spot.x, z = spot.z;
    for (let k = 0; k < 24 && insideAny(blockers, x, z); k++) { x -= 0.6; z += 0.4; }
    const w = nextWalker('piazza', null, 1);
    w.mode = 'idle';
    w.home = { x, y: sampleField(fields.piazza, x, z), z, yaw: spot.yaw };
  }
  if (walkers.length !== TOTAL) throw new Error(`crowd: 人数 ${walkers.length} ≠ 目标 ${TOTAL}`);

  /* ---- 4. 造型 + 一人四色 ---- */
  const people = buildPeople({ town, count: TOTAL, char });
  town.add(people.group);

  /**
   * `instanceColor` 是**每条 InstancedMesh 独立一份**，所以「一人四色」是这样落的：
   * 头 / 两条手臂三段 = 肤色，躯干 = 衣色，双腿三段 = 裤色，头巾 = 头巾色。
   *
   * ⚠ 索引**按 parts 表走、不写死**。上一批是 6 条 mesh，下标写死 0..5；
   *   本批 9 条、其中 6 条 `per=2`（实例下标 = i·2 / i·2+1），
   *   写死下标的话左半边会没人上色 —— 而 `instanceColor` 没写的实例
   *   默认是**白**，于是 40 个人各有半边身子是白的，而且**不报错**。
   */
  const _col = new THREE.Color();
  for (const w of walkers) {
    const byRole = { skin: PEOPLE.color.skin[w.skinIdx], hair: PEOPLE.color.hair[w.hairIdx],
      cloth: PEOPLE.color.cloth[w.clothIdx], trouser: PEOPLE.color.trouser[w.trouserIdx] };
    PEOPLE.parts.forEach((spec, k) => {
      const rgb = byRole[spec.role];
      _col.setRGB(rgb[0], rgb[1], rgb[2]);
      for (let side = 0; side < spec.per; side++) {
        people.meshes[k].setColorAt(w.id * spec.per + side, _col);
      }
    });
  }
  for (const m of people.meshes) m.instanceColor.needsUpdate = true;

  /* ---- 5. 首帧姿态 ----
   * 阴影在加载后 250ms 才烘焙，必须先把人摆好，否则影子烘的是一堆单位矩阵。 */
  let time = 0;
  for (const w of walkers) { poseWalker(w, 0); applyPose(people, w.id, w.pose); }
  commitFrame(people);

  /* ---- 6. 动态阴影节流（见 TUNE.shadow 与文件头）---- */
  const shadow = {
    mode: TUNE.shadow.rebake ? 'on' : 'off',
    reason: TUNE.shadow.rebake ? '启用：按模拟时间节流重烘阴影贴图' : '配置关闭：沿用全场一次性烘焙',
    clock: 0, frame: 0, inflight: false, rebakes: 0, lastFrameMs: 0,
    lastBakeFrame: 0, lastDriftM: 0,
    distAtBake: walkers.map((w) => w.dist),
  };

  /** 距上次烘焙后人群走出的最大距离（米）——用累计路程上界，够便宜也够准。 */
  function maxDriftM() {
    let d = 0;
    for (let i = 0; i < walkers.length; i++) {
      const v = Math.abs(walkers[i].dist - shadow.distAtBake[i]);
      if (v > d) d = v;
    }
    return d;
  }

  function requestBake() {
    shadow.inflight = true;
    shadow.lastBakeFrame = shadow.frame;
    for (let i = 0; i < walkers.length; i++) shadow.distAtBake[i] = walkers[i].dist;
    renderer.shadowMap.needsUpdate = true;
  }

  /* ---- 7. 对外接口 ---- */

  function update(dt) {
    time += dt;
    for (const w of walkers) {
      advance(w, dt);
      poseWalker(w, time);
      applyPose(people, w.id, w.pose);
    }
    commitFrame(people);

    // 阴影节流。到点请求一次重烘，**下一帧**的 dt 才覆盖了那一次渲染，那才是真实代价。
    if (shadow.mode === 'off') return;
    shadow.frame++;
    if (shadow.inflight) {
      shadow.inflight = false;
      shadow.rebakes++;
      shadow.lastFrameMs = r2(dt * 1000);
      // 第一阶段判负：本机扛不住「按 0.15s 模拟时间」的重烘频率 → 落进降级模式。
      if (shadow.mode === 'on' && dt * 1000 > TUNE.shadow.abortFrameMs) {
        shadow.mode = 'degraded';
        shadow.reason = `降级：本机重烘一帧 ${(dt * 1000).toFixed(0)}ms > ${TUNE.shadow.abortFrameMs}ms，`
          + `改为每 ≥${TUNE.shadow.degradedMinFrames} 帧、位移 ≥${TUNE.shadow.degradedMaxDriftM}m 才重烘一次`;
      }
      return;
    }
    if (shadow.mode === 'on') {
      shadow.clock += dt;
      if (shadow.clock >= TUNE.shadow.rebakeSec) { shadow.clock = 0; requestBake(); }
      return;
    }
    const drift = maxDriftM();
    shadow.lastDriftM = r2(drift);
    if (shadow.frame - shadow.lastBakeFrame >= TUNE.shadow.degradedMinFrames
        && drift >= TUNE.shadow.degradedMaxDriftM) requestBake();
  }

  /**
   * 步态相位推进自证：dt 固定、速度不同，走过同样时间后
   * φ 必须等于 φ0 + v·t/strideM，而不是所有人是同一个「按时间推进」的值。
   * 直接复用 update 用的 advance()，自证的是生产代码本身，不是复写一遍。
   */
  function gaitProbe() {
    const dt = 1 / 60, seconds = 3;
    const steps = Math.round(seconds / dt);
    const cases = [];
    for (const w of walkers) {
      if (w.mode === 'idle') continue;
      const phase0 = w.phase;
      const sim = Object.assign({}, w, { dist: 0 });
      sim.phase = phase0;
      for (let k = 0; k < steps; k++) advance(sim, dt);
      const walked = sim.speed * seconds;
      const expected = phase0 + walked / G.strideM;
      cases.push({
        id: w.id, group: w.group, speed: w.speed,
        walkedM: r3(walked),
        phaseRad: r4(sim.phase),
        expectedPhaseRad: r4(expected),
        errRad: Number(Math.abs(sim.phase - expected).toExponential(2)),
      });
    }

    // 变速算例：前 1.5s 走 v，后 1.5s 走 2v。若相位按时间推进，末相位与 v 无关。
    const v0 = TUNE.speed.min;
    const seedWalker = walkers.find((w) => w.mode === 'walk');
    const changed = Object.assign({}, seedWalker, { dir: 1, phase: 0, dist: 0, reversals: 0, speed: v0 });
    let walkedC = 0;
    for (let k = 0; k < steps / 2; k++) { advance(changed, dt); walkedC += v0 * dt; }
    changed.speed = v0 * 2;
    for (let k = 0; k < steps / 2; k++) { advance(changed, dt); walkedC += v0 * 2 * dt; }

    const speeds = cases.map((c) => c.speed);
    const maxErr = Math.max(...cases.map((c) => c.errRad));
    return {
      formula: 'φ = φ0 + 累计路程(m) / strideM   —— 速度只进路程，不直接进相位',
      strideM: G.strideM,
      cycleM: r3(G.cycleM),
      simSeconds: seconds,
      dtSeconds: dt,
      walkingPeople: cases.length,
      maxErrRad: maxErr,
      allWithinEpsilon: maxErr < 1e-9,
      /** 若按时间推进，所有人 3 秒后的相位都会是这一个值（与速度无关）——那正是要避开的 bug。 */
      timeDrivenPhaseIfBuggy: r4(seconds / G.strideM),
      speedRangeMps: [Math.min(...speeds), Math.max(...speeds)],
      speedChangeCase: {
        note: `前 1.5s 走 ${v0}m/s，后 1.5s 走 ${v0 * 2}m/s`,
        walkedM: r3(walkedC),
        phaseRad: r4(changed.phase),
        expectedPhaseRad: r4(walkedC / G.strideM),
        errRad: Number(Math.abs(changed.phase - walkedC / G.strideM).toExponential(2)),
      },
      cases,
    };
  }

  const pathStats = {
    wall: { ...wallBuilt.stats, source: 'wallwalk.js 中心线（穿过塔楼通行口，两端在城门口收口）' },
    street: { ...streetBuilt.stats, source: 'Via Primo Maggio | main village street + Village street | north approach' },
    piazza: { ...piazzaStat, source: 'Piazza Roma | open stone square（圆角环线 + 南北穿行线）' },
  };
  const speeds = walkers.map((w) => w.speed);
  const heights = walkers.map((w) => w.height);

  const payload = {
    people: TOTAL,
    seed: TUNE.seed,
    coordSign: TUNE.coordSign,
    coordSignUsed: false,
    coordSignNote: '本批所有坐标直接从活着的 three 场景读，未做任何 Blender→three 换算',
    byGroup: {
      wall: walkers.filter((w) => w.group === 'wall').length,
      street: walkers.filter((w) => w.group === 'street').length,
      piazza: walkers.filter((w) => w.group === 'piazza').length,
      piazzaIdle: walkers.filter((w) => w.mode === 'idle').length,
    },
    speedMps: { min: Math.min(...speeds), max: Math.max(...speeds) },
    heightM: { min: Math.min(...heights), max: Math.max(...heights), nominal: PEOPLE.nominalHeight },
    drawCalls: people.drawCalls,
    instances: people.instances,
    triangles: people.triangles,
    trianglesPerPerson: people.trianglesPerPerson,
    material: {
      name: people.material.name,
      map: people.material.map ? `${people.material.map.image.width}²` : null,
      bumpMap: people.material.bumpMap ? `${people.material.bumpMap.image.width}²` : null,
      programCacheKey: people.material.customProgramCacheKey(),
      baseColor: [people.material.color.r, people.material.color.g, people.material.color.b],
    },
    colorways: {
      skin: PEOPLE.color.skin.length, cloth: PEOPLE.color.cloth.length,
      trouser: PEOPLE.color.trouser.length, hair: PEOPLE.color.hair.length,
    },
    parts: people.meshes.map((m, i) => ({
      name: m.name,
      triangles: (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3,
      instances: m.count,
      castShadow: m.castShadow,
      role: PEOPLE.parts[i].role,
      gltfNode: PEOPLE.parts[i].node,
    })),
    gait: {
      strideM: G.strideM,
      cycleM: r3(G.cycleM),
      stepM: r3(G.cycleM / 2),
      reachM: G.reachM,
      hipBaseY: G.hipBaseY,
      hipBobM: G.hipBobM,
      footLiftM: G.footLiftM,
      armSwingRad: G.armSwingRad,
      swayM: G.swayM,
      /**
       * 步态的全部硬数字都在 `src/gait.js`，由 `tests/probe-gait.mjs` 逐相位验过
       * （够得着 / 不穿地 / 支撑相脚不打滑 / 膝角有变化范围 / 腿不从袍子里穿出来）。
       * 这里只把最近一帧的真实诊断值带出来，方便在浏览器里对读。
       */
      live: (() => {
        const dg = walkers[0].pose.diag;
        return {
          reachRatio: r4(dg.reachRatio),
          kneeBendDeg: [r3(dg.kneeMinDeg), r3(dg.kneeMaxDeg)],
          soleMinY: r4(dg.soleMinY),
        };
      })(),
      feetGrounded: '支撑相踝 = 地面 + footClear(俯仰)，脚底恒在路径面上；摆动相靠抬脚让膝弯出来',
    },
    lane: TUNE.lane,
    paths: pathStats,
    blockers: {
      count: blockers.length, marginM: TUNE.blocker.margin,
      // 塔楼不再是墙道路径的禁区：通行口在 wallwalk.js 那一侧开好了。
      // 塔楼只对街面 / 广场有约束，而它们本来就不贴墙，不受影响。
      towerBlocksUsed: 0,
      source: '遍历活场景收集的墙体类网格世界包围盒 xz 投影',
    },
    ground: {
      cellM: TUNE.ground.cell,
      surfaces: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, {
        mesh: f.mesh, topY: r3(f.top), slabThickM: r3(f.top - f.bottom),
        xz: [r2(f.bbox.min.x), r2(f.bbox.min.z), r2(f.bbox.max.x), r2(f.bbox.max.z)],
      }])),
    },
  };

  /** 活字段每次现算（探针与截图都在场景跑起来之后才读）。 */
  function stats() {
    return {
      ...payload,
      shadows: {
        castParts: PEOPLE.castShadowParts,
        mode: shadow.mode,
        reason: shadow.reason,
        rebakes: shadow.rebakes,
        lastBakeFrameMs: shadow.lastFrameMs,
        maxDriftM: shadow.lastDriftM,
        frames: shadow.frame,
        rebakeSec: TUNE.shadow.rebakeSec,
        abortFrameMs: TUNE.shadow.abortFrameMs,
        degradedMinFrames: TUNE.shadow.degradedMinFrames,
        degradedMaxDriftM: TUNE.shadow.degradedMaxDriftM,
        note: 'mode=on 按模拟时间节流（真 GPU）；degraded 按位移门限重烘（慢机）；off 完全不重烘',
      },
    };
  }

  return {
    group: people.group,
    walkers,
    update,
    refreshShadows() { renderer.shadowMap.needsUpdate = true; },
    stats,
    gaitProbe,
  };
}
