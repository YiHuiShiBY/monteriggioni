/**
 * Monteriggioni · 骨架与步态（**纯数学，零依赖**）
 * ===========================================================================
 * 这个文件**不 import three**。原因不是洁癖：
 *   网页里跑一次要开浏览器、走 SwiftShader 软光栅、等渲染帧，动辄几十秒；
 *   而「膝盖弯得对不对、脚打不打滑、有没有穿地」全是**数**，秒级就该验完。
 *   `tests/probe-gait.mjs` 直接 import 本文件，验的是**生产代码本身**，
 *   不是探针里重写一遍的那份 —— 和「量产物不量意图」同一条纪律。
 *
 * three 侧（people.js / crowd.js / player.js）消费这里的
 * `RIG / GAIT / SLOT / newPose / poseFigure`，把 `Float64Array(7)` 摆进 InstancedMesh。
 *
 * ── 坐标与朝向 ──────────────────────────────────────────────────────────────
 * **人物局部系**：X 横向、Y 竖直向上、**Z 朝前**（yaw=0 时面朝 three 的 +Z，
 * 与 `people.js` 的 `yaw = atan2(dx, dz)` 一致）。
 * 原点在人**脚下踩的那个平面**上 —— 所有 y 都是相对地面的高度。
 *
 * ── 为什么必须有这个文件：膝关节是被几何逼出来的 ────────────────────────────
 * 上一批的步态是「一根刚腿绕髋转」：
 *     髋高 = 腿长 · cos(摆角)，摆角 = A·sin φ
 * 这两个式子互为因果，**髋到踝的距离恒等于腿长**，于是膝盖在数学上
 * 永远是直的 —— 不是没写膝盖，是这套公式里没有能弯膝盖的自由度。
 * 而且当时 `hipY 0.855 − 脚踝 0.070 = 0.785` **恰好等于**腿长 0.400+0.385，
 * 站立落差 = 腿长 ⇒ 脚踝前后行程恒为 0 ⇒ 人群「滑步」。同一个恒等式的两面。
 *
 * 现在改成**真的单支撑**：一个周期里只有一条腿着地，
 *   · 支撑相：踝在地面上，前后位移**对相位线性** ⇒ 脚在世界系里不动（不打滑）
 *   · 摆动相：踝抬起来 ⇒ 髋到踝的距离变短 ⇒ **膝关节自然弯出来**
 * 髋高不再由摆角决定，而是一个独立的 2× 步频起伏（过步最高、双支撑最低），
 * 于是「髋高」和「腿伸直」这两件事**解耦**了，膝盖才有了弯的余地。
 *
 * 代价是几何上多了一条硬约束，全周期都必须满足：
 *     |ankle − hip| ≤ thigh + shin
 * 破了它，IK 只能夹住，脚就会离开地面。`tests/probe-gait.mjs` 第一条判据就是这个。
 *
 * three r160 纪律：不引依赖、不用 r162+ / r163+ API。
 */

const TAU = Math.PI * 2;
const PI = Math.PI;

/* ============================== 骨架 ============================== */

/**
 * 与 `scripts/character.py` 的同名常量**逐项对应**，改一处必须改两处。
 * 单位是米，标称身高 1.80m。
 */
export const RIG = {
  /**
   * 髋关节在**模型标称系**里的高度。它只用来和资产对读，不是运行时髋高 ——
   * 运行时的髋高是 `GAIT.idleHipY` / `GAIT.hipBaseY ± hipBobM`，
   * 因为髋高一变，腿就必须相应地屈伸，两者不能绑死（上一批就是绑死的）。
   */
  hipY: 0.955,          // 资产标称髋高（占身高 53.0%）

  /**
   * 颈根 / 肩关节**高出髋多少**。写成「差值」而不是各自的高度：
   * 头与躯干是挂在髋上的，髋高一动，这个差值必须不变，
   * 否则头会跟着髋一起上下漂。`= character.py 的 NECK_Y − HIP_Y`。
   */
  neckAboveHip: 0.630,
  shoulderAboveHip: 0.480,

  shoulderHalf: 0.215,  // 肩半宽 → 肩宽 0.43
  hipHalf: 0.090,       // 髋半宽 → 髋宽 0.18

  thigh: 0.455,
  shin: 0.429,
  footH: 0.075,         // 踝离地高 = 脚掌高

  upper: 0.275,
  fore: 0.245,
  hand: 0.080,

  /**
   * 鞋底在**踝的局部系**里前后各伸多远（+Z 是脚尖方向）。
   * 算「脚 pitched 之后哪个点着地、踝要抬多高」要用这两个数（见 `footClear`）——
   * `tests/probe-gait.mjs` 的 G6 会从 character.glb 里把它们量回来对读。
   * ⚠ 跟端只有 5.0cm（脚掌重心在前），一开始按「对称」写了 7.8cm，被 G6c 抓到。
   */
  soleFront: 0.092,
  soleBack: 0.050,
};

RIG.leg = RIG.thigh + RIG.shin;      // 0.884 = 髋到踝的最大可达距离
RIG.arm = RIG.upper + RIG.fore + RIG.hand;
/**
 * 站直时髋到踝要跨 `RIG.hipY − footH = 0.880`，而腿能跨 0.884 ——
 * **多出来的 4mm 就是站姿的屈膝量**。
 * ⚠ 别想把它做成 0：多 0 就没有余量（呼吸、浮点误差都会把脚顶出地面），
 *   多 1cm 站姿就变成明显下蹲。4mm 对应约 11° 屈膝，是正常人的放松站姿。
 */
RIG.standSlack = RIG.leg - (RIG.hipY - RIG.footH);

/* ============================== 步态 ============================== */

export const GAIT = {
  /**
   * 踝相对髋的最大前后位移（米）。**半步长**，一步 = 2·reachM。
   * 换算成 `strideM` 是恒等式、不是自由参数：支撑相的踝是**对相位线性**走的
   * （见 `ankleAt`），脚不打滑的充要条件是
   *     d(踝世界z)/d(路程) = 0  ⇒  (−2·reachM/π) · (1/strideM) = −1
   *     ⇒ strideM = 2·reachM / π
   * 一旦 strideM 与 reachM 不满足这条，脚就在蹭地 —— 探针逐相位量世界坐标验它。
   */
  reachM: 0.290,

  /**
   * 站定时的髋高。比 `RIG.hipY` 低 6mm 是**故意的**：
   * 呼吸让髋上下起伏 5mm，如果基线正好落在「腿刚好伸直」那一点上，
   * 吸气那一下就会把腿顶到够不着的地方（脚离地）。留 6mm 让整个呼吸周期都在范围内。
   */
  idleHipY: 0.949,
  idleBreathM: 0.005,
  idleBreathHz: 0.27,

  /** 髋的基准高度 + 起伏。起伏是 **2× 步频**（一个周期上下两次）。 */
  hipBaseY: 0.920,
  hipBobM: 0.030,

  /** 摆动相抬脚高度。**这是膝关节唯一的弯曲来源** —— 脚不抬，腿就不会短。 */
  footLiftM: 0.070,

  /** 踝的俯仰（**正 = 脚尖下压**）。支撑相：跟触地翘尖 → 踩平 → 蹬离压尖。 */
  toeUpStance: 0.20,
  toeDownStance: 0.44,
  toeUpSwing: 0.20,

  /** 手臂：肩摆 + 肘屈。肘不是恒定的，走路时前后不对称。 */
  armSwingRad: 0.34,
  elbowBaseRad: 0.22,
  elbowSwingRad: 0.20,

  swayM: 0.018,         // 髋部左右摆
  torsoYawRad: 0.10,    // 躯干反向拧
  torsoRollRad: 0.05,   // 躯干侧倾
};

// strideM 由 reachM 导出（见上面那条恒等式），不手写。
GAIT.strideM = 2 * GAIT.reachM / PI;
GAIT.cycleM = TAU * GAIT.strideM;    // 一个完整周期走 1.16m ≈ 两步

/* ============================== 槽位 ============================== */

/** 一个人 15 个刚性段的位姿槽。`pose.joint[k]` = Float64Array(7) = [x,y,z,qx,qy,qz,qw]。 */
export const SLOTS = 15;
export const SLOT = {
  head: 0, hood: 1, torso: 2,
  armUpperL: 3, armUpperR: 4, armLowerL: 5, armLowerR: 6, handL: 7, handR: 8,
  legUpperL: 9, legUpperR: 10, legLowerL: 11, legLowerR: 12,
  footL: 13, footR: 14,
};

/** 两条腿。`phaseOff` 决定这条腿在周期里的位置：0 = 从支撑相起点开始。 */
export const LEGS = [
  { sgn: -1, upper: SLOT.legUpperL, lower: SLOT.legLowerL, foot: SLOT.footL, phaseOff: 0 },
  { sgn: 1, upper: SLOT.legUpperR, lower: SLOT.legLowerR, foot: SLOT.footR, phaseOff: PI },
];

/**
 * 两条臂。`armSign` 是肩摆的方向系数（与同侧腿**反相**）：
 * 左腿在中段（φ=π/2）支撑时，左臂在前。
 */
export const ARMS = [
  { sgn: -1, upper: SLOT.armUpperL, lower: SLOT.armLowerL, hand: SLOT.handL, armSign: -1 },
  { sgn: 1, upper: SLOT.armUpperR, lower: SLOT.armLowerR, hand: SLOT.handR, armSign: 1 },
];

/* ============================== 小工具 ============================== */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/* ------------------------------ 四元数 ------------------------------ */
/* 全是 4 个数的运算，不值得为它引 three。约定 [x, y, z, w]。 */

/** 把 (0,−1,0) 转到单位向量 (ux,uy,uz)，写进 o[oi..oi+3]。 */
function qFromDown(o, oi, ux, uy, uz) {
  const dot = -uy;                       // (0,-1,0) · u
  if (dot > 0.999999) { o[oi] = 0; o[oi + 1] = 0; o[oi + 2] = 0; o[oi + 3] = 1; return; }
  if (dot < -0.999999) {                 // 目标正上方：轴退化，随便挑一根
    o[oi] = 1; o[oi + 1] = 0; o[oi + 2] = 0; o[oi + 3] = 0; return;
  }
  // axis = (0,-1,0) × u = (−uz, 0, ux)
  let ax = -uz, ay = 0, az = ux;
  const al = Math.hypot(ax, ay, az);
  ax /= al; az /= al;
  const half = Math.acos(dot) * 0.5;
  const s = Math.sin(half);
  o[oi] = ax * s; o[oi + 1] = 0; o[oi + 2] = az * s; o[oi + 3] = Math.cos(half);
}

/** 绕 X 轴转 ang。 */
function qFromX(o, oi, ang) {
  const h = ang * 0.5, s = Math.sin(h);
  o[oi] = s; o[oi + 1] = 0; o[oi + 2] = 0; o[oi + 3] = Math.cos(h);
}

/** o = a ⊗ b（与 three 的 `a.multiply(b)` 同一约定：先 b 后 a）。 */
function qMul(o, oi, a, ai, b, bi) {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * Rx(roll) ⊗ Ry(yaw) —— 与 three `Euler(x=roll, y=yaw, z=0, 'XYZ')` **逐项同构**。
 * 展开：x = sr·cy, y = cr·sy, z = sr·sy, w = cr·cy。
 */
function qYawRoll(o, oi, yaw, roll) {
  const hy = yaw * 0.5, sy = Math.sin(hy), cy = Math.cos(hy);
  const hr = roll * 0.5, sr = Math.sin(hr), cr = Math.cos(hr);
  o[oi] = sr * cy; o[oi + 1] = cr * sy; o[oi + 2] = sr * sy; o[oi + 3] = cr * cy;
}

/** 用四元数旋转向量 (vx,vy,vz)，结果写进 o[oi..oi+2]。 */
function qRot(o, oi, q, qi, vx, vy, vz) {
  const x = q[qi], y = q[qi + 1], z = q[qi + 2], w = q[qi + 3];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  o[oi] = vx + w * tx + (y * tz - z * ty);
  o[oi + 1] = vy + w * ty + (z * tx - x * tz);
  o[oi + 2] = vz + w * tz + (x * ty - y * tx);
}

/* ============================== 踝的轨迹 ============================== */

const _ankle = [0, 0, 0, 0];   // [ax, clear, lift, pitch]

/**
 * 一条腿在相位 `psi` 时的踝目标（人物局部系，原点 = 脚下地面）。
 * 结果写进模块级的 `_ankle`，返回归一化相位 t ∈ [0, 2π)。
 *
 * ⚠ **支撑相的 ax 必须对相位线性**，这是脚不打滑的充要条件：
 *   脚的世界 z = 人物 z + ax(t)，而 t = 路程 / strideM，
 *   要 d(脚z)/d(路程) = 0 就得 dax/dt = −strideM = −2·reachM/π。
 *   换成正弦就成了「摆动腿落点对得上、支撑腿在蹭地」。
 */
export function ankleAt(psi) {
  const t = ((psi % TAU) + TAU) % TAU;
  if (t < PI) {
    // 支撑相：跟触地(t=0) → 踩平(t=0.5) → 蹬离(t=1)
    const u = t / PI;
    _ankle[0] = GAIT.reachM * (1 - 2 * u);
    _ankle[1] = 0;                                   // clear = footClear(pitch)
    _ankle[2] = 0;                                   // lift
    _ankle[3] = -GAIT.toeUpStance * Math.cos(PI * u) + GAIT.toeDownStance * smoothstep(0.70, 1.0, u);
  } else {
    // 摆动相：把脚从蹬离姿滚到下一个跟触地姿，中途抬起来
    const u = (t - PI) / PI;
    _ankle[0] = -GAIT.reachM + 2 * GAIT.reachM * u;
    _ankle[1] = 0;
    _ankle[2] = GAIT.footLiftM * Math.sin(PI * u);
    _ankle[3] = GAIT.toeDownStance
      + (-GAIT.toeUpSwing - GAIT.toeDownStance) * smoothstep(0, 1, u);
  }
  return t;
}

/** 取 `ankleAt` 的结果（避免调用方直接摸模块级数组）。 */
export function ankleTarget(psi) {
  const t = ankleAt(psi);
  return { t, ax: _ankle[0], clear: footClear(_ankle[3]), lift: _ankle[2], pitch: _ankle[3] };
}

/**
 * 踝在 pitched 之后，鞋底离地要多高。
 *
 * 局部系里鞋底躺在 `y = −footH` 这个平面上、前后从 −soleBack 伸到 +soleFront。
 * 绕 X 转 β（**正 = 脚尖下压**）之后，最低点的 y 是
 *     y(β, z) = −footH·cos β − z·sin β
 * 它对 z 单调，所以最低点必在两端之一：
 *     β ≥ 0（尖下压）⇒ 支点在趾；β < 0（尖上翘）⇒ 支点在跟。
 * 少了这一项，脚一俯仰就会有一头扎进地里 —— 蹬离那一下尤其明显。
 */
export function footClear(beta) {
  const c = Math.cos(beta), s = Math.sin(beta);
  return beta >= 0
    ? RIG.footH * c + RIG.soleFront * s
    : RIG.footH * c - RIG.soleBack * s;
}

/* ============================== 姿态 ============================== */

export function newPose() {
  const joint = Array.from({ length: SLOTS }, () => new Float64Array(7));
  for (const j of joint) { j[3] = 0; j[4] = 0; j[5] = 0; j[6] = 1; }
  return {
    joint,
    /**
     * 诊断量，给 `tests/probe-gait.mjs` 读。
     * **探针不重算，直接读生产输出** —— 免得「量的是另一份实现」。
     */
    diag: {
      reachRatio: 0,      // max(|ankle−hip| / (thigh+shin))，必须 ≤ 1
      kneeMinDeg: 0,      // 膝关节最小弯曲角
      kneeMaxDeg: 0,
      soleMinY: 0,        // 鞋底最低点相对地面的高度，必须 ≥ 0
    },
    /** 两条踝的局部坐标（脚滑判据要用）。 */
    ankle: new Float64Array(6),
  };
}

const _q2 = new Float64Array(4);
const _qT = new Float64Array(4);
const _v = new Float64Array(3);

function setJ(J, k, x, y, z, q, qi) {
  const a = J[k];
  a[0] = x; a[1] = y; a[2] = z;
  a[3] = q[qi]; a[4] = q[qi + 1]; a[5] = q[qi + 2]; a[6] = q[qi + 3];
}

/**
 * 骨骼链上前进一段：`from + q·(0,−len,0)`。
 * ⚠ 段长**必须乘进去** —— 忘了乘就成了「每段 1 米」的怪物（第一版就写错过）。
 */
function chainStep(q, qi, len, out) {
  qRot(out, 0, q, qi, 0, -len, 0);
}

/**
 * 一条腿的两骨 IK。
 *
 * 局部约定：两根骨的静止方向都是 −Y（竖直向下）。所以从「髋」指向「膝」的方向
 * 向量直接就是 `normalize(knee − hip)`，四元数由 `qFromDown` 给出。
 * **膝的极向量 = +Z（前）** —— 人屈膝时膝盖往前凸，方向反了会读成反关节。
 *
 * 髋与踝的横向差恒为 0（踝就在髋正下方），所以整条 IK 退化成 y-z 平面上的二维问题，
 * 可以省掉一个方向的搜索。
 */
function solveLeg(J, leg, hipX, hipY, ankleY, ankleZ, footPitch, d) {
  const l1 = RIG.thigh, l2 = RIG.shin;
  const maxL = l1 + l2;
  const minL = Math.abs(l1 - l2) + 1e-4;

  const dy = ankleY - hipY, dz = ankleZ;
  const raw = Math.hypot(dy, dz);
  if (raw > 1e-9) d.reachRatio = Math.max(d.reachRatio, raw / maxL);

  const L = Math.min(maxL, Math.max(minL, raw));
  const uy = raw > 1e-9 ? dy / raw : -1, uz = raw > 1e-9 ? dz / raw : 0;

  // 膝在「髋→踝」直线上的投影距离与垂距
  const a = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  // 极向量 +Z 去掉 u 的分量后归一化。ux ≡ 0 ⇒ |w| = |uy|，w = (0, −sign(uy)·uz, |uy|)。
  let wy, wz;
  if (Math.abs(uy) < 1e-6) { wy = 1; wz = 0; }        // 腿接近水平：极向量退化，改用膝盖朝上
  else { wy = -Math.sign(uy) * uz; wz = Math.abs(uy); }

  // 大腿方向 = u·a + w·h
  const d1y = uy * a + wy * h;
  const d1z = uz * a + wz * h;
  // 膝的位置（髋在 (hipX, hipY, 0)）
  const ky = hipY + d1y, kz = d1z;
  // 小腿方向 = u·(raw−a) − w·h，用**未夹的** raw 才能让脚落到目标点上
  const d2y = uy * (raw - a) - wy * h;
  const d2z = uz * (raw - a) - wz * h;

  setJ(J, leg.upper, hipX, hipY, 0, _qFromDown(d1y, d1z), 0);
  setJ(J, leg.lower, hipX, ky, kz, _qFromDown(d2y, d2z), 0);
  qFromX(_q2, 0, footPitch);
  setJ(J, leg.foot, hipX, ankleY, ankleZ, _q2, 0);

  // 诊断：**弯曲角** = 180° − 膝的内角。
  // ⚠ `acos(cosK)` 给的是内角（腿伸直时 = 180°），第一版直接拿它跟「屈膝 < 20°」
  //   比，结果永远是 169° 判红 —— 量的是内角，判的是弯曲角，差一个补角。
  //   用**未夹**的距离算，夹了就等于把够不着这件事藏起来。
  const cosK = (l1 * l1 + l2 * l2 - raw * raw) / (2 * l1 * l2);
  const bendDeg = 180 - Math.acos(Math.min(1, Math.max(-1, cosK))) * 180 / PI;
  if (bendDeg < d.kneeMinDeg) d.kneeMinDeg = bendDeg;
  if (bendDeg > d.kneeMaxDeg) d.kneeMaxDeg = bendDeg;
  d.soleMinY = Math.min(d.soleMinY, ankleY - footClear(footPitch));
}

const _qd = new Float64Array(4);
function _qFromDown(dy, dz) {
  const l = Math.hypot(dy, dz) || 1e-9;
  qFromDown(_qd, 0, 0, dy / l, dz / l);
  return _qd;
}

/**
 * 三段手臂链：肩摆 `swing` + 肘屈 `elbow`，腕刚性接续。
 *
 * ⚠ 每一段的**下一节位置必须用上一节自己的四元数**走上一节的段长。
 *   第一版在这里写成「用前臂的四元数走 RIG.upper 的长度」，
 *   肘于是被放到了肩往前 27.5cm 的地方 —— 段长和朝向配错了臂。
 *   ⇒ 抽成这一个函数，行走与站定共用，才不会只改一处。
 */
const _qa = new Float64Array(4);
const _qe = new Float64Array(4);
const _n2 = new Float64Array(3);
function solveArm(J, arm, shX, shY, shZ, swing, elbow) {
  qFromX(_qa, 0, swing);
  qMul(_qa, 0, _qT, 0, _qa, 0);            // 上臂 = 躯干 ⊗ 肩摆
  setJ(J, arm.upper, shX, shY, shZ, _qa, 0);
  chainStep(_qa, 0, RIG.upper, _n2);        // 肘
  const ex = shX + _n2[0], ey = shY + _n2[1], ez = shZ + _n2[2];
  qFromX(_qe, 0, elbow);
  qMul(_qe, 0, _qa, 0, _qe, 0);            // 前臂 = 上臂 ⊗ 肘屈
  setJ(J, arm.lower, ex, ey, ez, _qe, 0);
  chainStep(_qe, 0, RIG.fore, _n2);         // 腕（刚性接续）
  setJ(J, arm.hand, ex + _n2[0], ey + _n2[1], ez + _n2[2], _qe, 0);
}

/**
 * 把一个人的 15 段姿态写进 `pose`。
 *
 * `st` = `{ moving, phase, time, breathPhase }`
 *   · `phase` 只从**路程**来（`phase += 路程 / strideM`），速度不直接进相位
 *   · `moving = false` 时只呼吸，腿并立、髋在标称高度
 *
 * ⚠ 本函数是**人群与玩家唯一的造型入口**。上一批两处各写了一份
 *   （`crowd.js poseWalker` / `player.js poseFigure`），改一处必须记得改另一处；
 *   现在只有这一份，`poseWalker` 只负责把「沿折线的弧长」翻译成 `phase`。
 */
export function poseFigure(pose, st) {
  const J = pose.joint;
  const d = pose.diag;
  d.reachRatio = 0; d.kneeMinDeg = 1e9; d.kneeMaxDeg = 0; d.soleMinY = 1e9;

  if (!st.moving) {
    /* ---- 站定：腿并立、髋在站姿高度，只有呼吸 ---- */
    const br = Math.sin(st.time * GAIT.idleBreathHz * TAU + (st.breathPhase || 0));
    const hipY = GAIT.idleHipY + GAIT.idleBreathM * br;
    qYawRoll(_qT, 0, 0, 0.035 * br);
    qRot(_v, 0, _qT, 0, 0, RIG.neckAboveHip, 0);
    setJ(J, SLOT.head, _v[0], hipY + _v[1], _v[2], _qT, 0);
    setJ(J, SLOT.hood, _v[0], hipY + _v[1], _v[2], _qT, 0);
    setJ(J, SLOT.torso, 0, hipY, 0, _qT, 0);
    // 站定时肘只留一点自然的弯曲
    const el0 = -(GAIT.elbowBaseRad * 0.45 + 0.02 * br);
    for (const arm of ARMS) {
      qRot(_v, 0, _qT, 0, arm.sgn * RIG.shoulderHalf, RIG.shoulderAboveHip, 0);
      solveArm(J, arm, _v[0], hipY + _v[1], _v[2], 0.02 * br, el0);
    }
    for (let i = 0; i < LEGS.length; i++) {
      const leg = LEGS[i];
      pose.ankle[i * 3] = leg.sgn * RIG.hipHalf;
      pose.ankle[i * 3 + 1] = RIG.footH;
      pose.ankle[i * 3 + 2] = 0;
      solveLeg(J, leg, leg.sgn * RIG.hipHalf, hipY, RIG.footH, 0, 0, d);
    }
    return pose;
  }

  /* ---- 行走 ---- */
  const phase = st.phase;
  const sinP = Math.sin(phase);
  // 髋高：2× 步频。过步（φ=π/2，两腿前后都归零）时最高，双支撑时最低。
  const hipY = GAIT.hipBaseY - GAIT.hipBobM * Math.cos(2 * phase);
  const sway = GAIT.swayM * sinP;

  qYawRoll(_qT, 0, -GAIT.torsoYawRad * sinP, GAIT.torsoRollRad * sinP);

  // 头 + 头巾：跟着躯干走
  qRot(_v, 0, _qT, 0, 0, RIG.neckAboveHip, 0);
  setJ(J, SLOT.head, _v[0], hipY + _v[1], _v[2], _qT, 0);
  setJ(J, SLOT.hood, _v[0], hipY + _v[1], _v[2], _qT, 0);
  setJ(J, SLOT.torso, sway, hipY, 0, _qT, 0);

  /* 腿：两骨 IK 到踝目标 */
  for (let i = 0; i < LEGS.length; i++) {
    const leg = LEGS[i];
    const a = ankleTarget(phase + leg.phaseOff);
    const lat = sway + leg.sgn * RIG.hipHalf;
    const ankleY = a.clear + a.lift;
    pose.ankle[i * 3] = lat; pose.ankle[i * 3 + 1] = ankleY; pose.ankle[i * 3 + 2] = a.ax;
    solveLeg(J, leg, lat, hipY, ankleY, a.ax, a.pitch, d);
  }

  /* 手臂：肩摆 + 肘屈。肘屈随手臂前后变化，不是恒定的。 */
  for (const arm of ARMS) {
    qRot(_v, 0, _qT, 0, arm.sgn * RIG.shoulderHalf, RIG.shoulderAboveHip, 0);
    const shX = sway + _v[0], shY = hipY + _v[1], shZ = _v[2];
    // 与同侧腿反相：左腿在中段支撑时左臂在前
    const swing = arm.armSign * GAIT.armSwingRad * sinP;
    // 肘：底屈 + 随手臂前摆加大。肘屈 = 绕 X 的**负**角（手往身前收）。
    const el = -(GAIT.elbowBaseRad + GAIT.elbowSwingRad * 0.5 * (1 - arm.armSign * sinP));
    solveArm(J, arm, shX, shY, shZ, swing, el);
  }

  return pose;
}
