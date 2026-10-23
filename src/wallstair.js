/**
 * Monteriggioni · 城墙阶梯（设计规格 WALLSTAIR.md · 第四批，取代第三批的攀爬梯）
 * ---------------------------------------------------------------------------
 * 解决的问题：上一批是「6 座斜靠木梯 + 一整套攀爬状态机」（`st.climb` / `tryGrab` /
 * W-S 上爬 / `poseClimb`）。用户明确否掉了：
 *   **「不是这样的墙梯，是像长城那样的阶梯，一阶一阶上去那种，贴着墙引出来」**
 * 本文件把那一套整体换成**可行走的石阶**：踢面 0.17m ≪ `TUNE.walk.stepUp` 0.55，
 * 常规行走规则直接放行，**不需要任何攀爬状态机**。
 *
 * ── 为什么阶梯必须**逐级**建成曲面，而不是一段直跑 ───────────────────────────
 * 墙是一圈 R≈85m 的凸形环。沿墙长 15m 的一段，**切线与弧的偏离是 1.33m**
 * （切线上离切点 15m 的点离圆心 √(84²+15²)=85.3，比圆弧上的同参数点远 1.33m；
 * 而 15m **弦**对弧的弓高只有 0.34m —— 两个数差 4 倍，别混）。
 * ⇒ 若把整条 flight 建在梯脚那一帧的局部系里，梯脚那头会**扎进墙里 1.1m**。
 *   所以每一级都取自己那一段的中心线局部系建（见 `buildWallStairs` 的 `frames`），
 *   解析面也用同一批帧（`makeFootprint` 的 `sx/stx/snx`），两者共用一份数字。
 *
 * ── 横向分带（`across` 口径，自外墙面向内）──────────────────────────────────
 *   0.00 外墙面 ／ 2.05 内墙面 ／ 2.11 压顶石内挑 ／ 1.66~2.11 内侧矮护墙
 *   0.46~1.66 铺装步道 ／ 2.25~3.25 **flight 与顶部平台**（宽 1.0m）
 *   2.11~2.25 **门槛石**（0.14m，跨过压顶石内挑与平台之间那道 14cm 的空缝）
 *
 * ⚠ **规格 §1.4 的「0.59m 悬挑」与实测不符**：`接墙桥 across 1.66~2.25` 里，
 *   压顶石是**实心地铺在 1.66~2.11 之下的**（`Coping_*` 横向 2.18m，−0.07~2.11），
 *   所以真正的悬挑只有 **2.11→2.25 = 0.14m**。规格要求加石托座，仍然加了
 *   （`TUNE.stair.corbel`，画面上读作墙内面的一道石托），但它是**画面件不是结构件** ——
 *   见 README 与本批探针 S2 的读数。
 *
 * ── 护墙豁口：为什么半宽取 0.80 而不是 0.60 ─────────────────────────────────
 * 护墙是**逐段**生成的（段长 ≈ 0.7495m），而「这一段有没有护墙」判的是**段起点**。
 * 半宽 0.60 ⇒ 圆里只保证有 1 个段起点（点间距 0.7495 > 0.60）⇒ 净开口可能只有
 * **0.75m**，达不到规格 §1.4 要求的 ≥1.2m。要**恒定**跳 2 段就得 2×halfWidth > 2×段长
 * ⇒ halfWidth > 0.7495。取 **0.80** ⇒ 恒跳 2 段（净开口 1.50m）或 3 段（2.25m）。
 *
 * ── 材质 ─────────────────────────────────────────────────────────────────
 * 不新建 MeshStandardMaterial。踏步石体直接复用 town 里已被 `materials.js` 的 DISPATCH
 * 注入过三平面投影的**实例**（与 `wallwalk.js` 的 `resolveMaterials` 同一做法）：
 * 石体 → `Limestone | cut pale blocks`，踏面石板 → `Piazza |`（flag 配方）。
 * 两种材质墙道都在用 ⇒ **不增加 program 数**，只增加 2 个 drawcall。
 *
 * ⚠ 本文件**不 import wallwalk.js**（会造成循环依赖）：横向分带的数字是**抄**过来的，
 *   一致性由 `assertBandMatches()` 在 `buildWallWalk` 里核对，抄错当场抛。
 *
 * three r160 纪律：不引入任何新依赖，不使用 r162+ / r163+ 的 API。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { normName } from './materials.js';

/* ============================== TUNE ============================== */

export const TUNE = {
  /** 落位表：几座、怎么分。规格第 0 节：6 座，均匀分布，一律靠城内一侧。 */
  plan: {
    count: 6,
    /** 候选点落在塔内 / 门楼避让区时，沿弧长找最近合法点的搜索半径。 */
    searchRadiusM: 12,
    /**
     * 净空判据比**暂算**的 flight 长多少米。
     * ⚠ 真实长度要等 `groundAt` 把街面高程量回来才定（`TUNE.stair.streetY` 只是初值，
     *   实测偏差可达 1.6m ⇒ 级数差 ±9、长度差 ±3m），所以净空判据先多要 2m，
     *   最终长度由 `buildWallStairs` 再核一遍（探针 S2 量的是**最终**长度下的净空）。
     */
    clearancePadM: 2.0,
  },

  /** 单座阶梯的几何（规格 §1.4 / §1.5）。 */
  stair: {
    /** 踢面。**实测爬升现算**：`riserM = rise / round(rise / riserM)` ⇒ 恒 ≈0.17m。 */
    riserM: 0.17,
    /** 踏面。⚠ **比高程场的格子 0.5m 还窄** ⇒ 阶梯绝不能靠高程场承载，见 player.js。 */
    treadM: 0.34,
    /** flight 与顶部平台的横向区间（across 口径）。宽 1.0m。 */
    flightFrom: 2.25,
    flightTo: 3.25,
    /** 顶部平台沿墙长。 */
    landingM: 1.0,
    /**
     * 门槛石：跨过「压顶石内挑 2.11」与「平台内沿 2.25」之间那道 14cm 的空缝。
     * 厚 22mm、顶面比铺装低 2mm（`sillDropM`），外沿往平台石体里塞 10mm。
     * 这三个数是**为了不共面**定的：门槛石 / 压顶石顶面 / 平台踏面石板两两错开。
     */
    sillThickM: 0.022,
    sillDropM: 0.002,
    sillTuckM: 0.010,
    /** 顶部平台解析面还要往内接到走廊夹紧带的内沿(1.23)，交接才不拽人（见 §4.3）。 */
    handoffFrom: 1.23,
    /** 护墙豁口内侧那条：护墙内沿 1.66，其外侧是**露出来的压顶石台面**（比铺装低 2.2cm）。 */
    notchFrom: 1.66,
    notchTo: 2.11,
    /** 平台石体厚度（悬在压顶石之外那 0.14m 上）。 */
    landingThickM: 0.30,
    /**
     * 石托座（规格 §1.4 要求；实测悬挑只有 0.14m，所以它是画面件不是结构件，见文件头）。
     * `from` 取 **2.03 而不是 2.05**：埋进墙面 2cm，与幕墙内立面不共面。
     */
    corbel: { from: 2.03, to: 2.25, halfAlongM: 0.36, dropM: 0.22 },
    /** 踏面石板厚。石体顶面比踏面低 `plateInsetM` ⇒ 板与石体互相咬 30mm，不共面。 */
    plateM: 0.035,
    plateInsetM: 0.005,
    /** 石板的平面内缩（2mm）：相邻石板之间留一道 4mm 的缝，读作石缝而不是一个平面。 */
    plateShrinkM: 0.002,
    /** 每一级盒体底面埋进街面的深度（阶梯是个实心石体，不是薄板）。 */
    sinkM: 0.80,
    /** 相邻两级的盒体沿墙长各多出这么多（盖掉逐帧建带来的 ±2mm 角缝）。 */
    stepOverlapM: 0.002,
    /**
     * 街面高程的**初值**。真实街面用 `buildWallStairs({ groundAt })` 从高程场量回来；
     * 初值只影响落位期对 flight 长度的暂算（进而影响净空判据的范围），不影响能不能上。
     */
    streetY: 14.0,
    /**
     * 梯脚高程的取样点（across 口径，取 3 个求中位）。
     * ⚠ **为什么不能取 2.25**：实测高程场在 across 2.11~2.75 一带被压顶石的
     *   splat 抬高过（6 个等分候选点里，across 2.25 读到过 20.80m 而街面只有 14.5m）。
     *   2.75 往外就干净了：6 个候选点的 across 2.75/3.00/3.25 读数互相只差 0.1m。
     */
    footProbeAcross: [2.75, 3.00, 3.25],
    /** 梯脚高程在第一级**之前**这么多米处量（别量在第一级踏面上）。 */
    footBackM: 0.30,

    /**
     * 解析面**查找表**：世界 XZ 上一张 0.10m 的小网格，每格存「这一格属于第几级」。
     *
     * ⚠⚠ **为什么不能再靠帧投影现算**（这一条是被实测逼出来的，不是设计偏好）：
     *   原来的 `sampleStairSurface()` 先用**平台那一帧**把查询点投影成 `along` / `across`，
     *   再拿它定级号。圆弧上距落位点 s 处的横向投影偏差是 `s²/(2R)`（R ≈ 89.8m）：
     *   16.3m 处偏 **1.48m**、19.9m 处偏 **2.20m** —— 而横向早退只给 1.7m 余量，
     *   于是**远端整级被拒**，实测 282 个采样点里 178 个退回街面（S4 判红 7.07m）。
     *   级号再估得准也没用：偏差是**横向**的，落在框外就没了。
     *   ⇒ 表在**建 mesh 的同一个循环里**用**同一批帧**烘好（见 `stampRect`），
     *     查询时只做一次数组寻址，**完全不过中心线、不做任何投影**。
     *     格子归属由烘表时的级帧决定 ⇒ 表与渲染几何天生同源，不会分叉。
     */
    grid: {
      /** 格边（米）。0.10m ≪ 踏面 0.34m，一格最多落进一级。
       *  ⚠⚠ **实测从 0.10 降到 0.05**：顶部条带里最薄的是**门槛石**，
       *   across 2.11→2.25 只有 **0.14m** —— 比 0.10m 的格子还窄 ⇒ 那一格
       *   中心有时落进带内、有时落进带外，6 座里 4 座的门槛石带解析不出来
       *   （S5 差 6.29~9.36m）。0.05m 下该带稳定覆盖 2~3 格，6/6 一致。
       *   代价：格数 ×4（11908 → 约 4.8 万格、约 0.6MB），查询仍是 O(1) 寻址。 */
      cellM: 0.05,
    },
  },

  /**
   * 护墙豁口半宽（沿墙）。**恒定跳 ≥2 段** ⇒ 净开口 ≥1.50m（理由见文件头）。
   * 阶梯的接墙段（平台 + 门槛石）本身只占 ±0.5m，豁口比它宽出来的那部分
   * 露出的是**压顶石台面**（本来就是能走的甲板），不是空洞。
   */
  gap: { halfWidthM: 0.80 },

  /**
   * 横向分带（**规格口径**：自外墙面向内）。
   * ⚠ 抄自 `wallwalk.js` 的 TUNE，两边必须一致，`assertBandMatches()` 负责核对。
   */
  band: {
    wallHalf: 1.02,          // 墙身半厚：外墙面 0.00 → 内墙面 2.05
    walkwayFrom: 0.46,       // 铺装带外沿
    walkwayTo: 1.66,         // 铺装带内沿
    walkwayTopProud: 0.022,  // 铺装顶面高出压顶石顶面
    parapetFrom: 1.66,       // 内侧矮护墙外沿
    parapetTo: 2.11,         // 内侧矮护墙内沿（= 压顶石内挑）
    parapetHeight: 0.95,
    parapetSink: 0.10,
    copingInnerEdge: 2.11,   // 压顶石内挑：门槛石的内沿就取它
  },

  /**
   * 净空判据扫哪些盒子。**墙自己的盒子不算障碍** ——
   * 阶梯本来就贴着内墙（内沿 2.25 离压顶石内挑只有 0.14m），
   * 而 `Curtain_*` 的禁区盒带 `BLOCKER_MARGIN` 0.42m 余量，一直盖到 across 2.47。
   * 把墙自己算成障碍的话，**全环没有任何一点合法**，一条阶梯都放不下。
   */
  obstacle: {
    exclude: /^Curtain_\d+$/,
    /** 净空余量：盒子边再留这么多才算「压到了」。 */
    marginM: 0.05,
  },

  /** 材质：从 GLB 已注入三平面的实例里按 DISPATCH 的同一批正则挑。 */
  material: {
    stone: /Limestone \| cut pale blocks/,
    paving: /Piazza \|/,
  },
};

/**
 * 整组候选要试的平移量（米）：**0.5m 细网格，0~±60m，按 |平移量| 从小到大排**。
 *
 * ⚠ 为什么从第三批那张 20 格的稀疏表改成细网格（实测换的，不是拍脑袋）：
 *   第三批只有「落位点本身」一条判据，81 个整米里 8 个合法，所以 20 格稀疏表够用。
 *   这一批多了规格 §1.6 的**背后净空**判据：13 座塔楼各占约 7m，全环 91/563 ≈ 16% 被挡，
 *   一个 18m 的窗口单独看有 **84%** 合法，**6 座同时合法只有 0.84⁶ ≈ 35%**。
 *   ⇒ 20 个离散值几乎不可能凑齐（实测 20 个里 0 个成功、14 个败在净空上），
 *     241 个细网格值里则 plenty。按 |平移量| 排序 = **优先取最小的整体平移**，
 *     座间距因此仍守在 `perimeter/6` 附近（每座另有的 ≤`searchRadiusM` 挪动）。
 */
export const ARC_OFFSETS = (() => {
  const out = [0];
  for (let v = 0.5; v <= 60.0001; v += 0.5) {
    out.push(+v.toFixed(2), -v.toFixed(2));
  }
  return out;
})();

/** 规格口径的 across → 相对中心线的偏移（`wallwalk.js` 的 `P(s, off, …)` 用的就是它）。 */
const offOf = (acrossM) => acrossM - TUNE.band.wallHalf;

/**
 * 核对 `wallwalk.js` 的 TUNE 与本文件的 band 是否漂了。
 * 抄数字而不是 import，就是为了这一刻：漂了就当场炸。
 * @param {object} tuneWall `wallwalk.js` 的 TUNE
 */
export function assertBandMatches(tuneWall) {
  const b = TUNE.band, w = tuneWall;
  const pairs = [
    ['wallHalf', b.wallHalf, w.wallHalf],
    ['walkway.from', b.walkwayFrom, w.walkway.from],
    ['walkway.to', b.walkwayTo, w.walkway.to],
    ['walkway.topProud', b.walkwayTopProud, w.walkway.topProud],
    ['parapet.from', b.parapetFrom, w.parapet.from],
    ['parapet.to', b.parapetTo, w.parapet.to],
    ['parapet.height', b.parapetHeight, w.parapet.height],
    ['parapet.sink', b.parapetSink, w.parapet.sink],
  ];
  for (const [k, mine, theirs] of pairs) {
    if (Math.abs(mine - theirs) > 1e-6) {
      throw new Error(
        `wallstair: 横向分带与 wallwalk 不一致 —— ${k} 本文件 ${mine} / wallwalk ${theirs}。` +
        ' 两边 TUNE 抄岔了，修好再跑（否则阶梯会装到错误的一侧）。'
      );
    }
  }
  return true;
}

/* ============================== 中心线弧长 ============================== */

/**
 * 中心线的弧长表 + 按弧长取局部系。
 *
 * 阶梯**必须逐级**取帧（文件头那条 1.33m 的切线–弧偏离），所以这个采样器是
 * 几何的一部分而不是工具函数：`buildWallStairs` 的每一级与解析面的每一级
 * 都从这里取帧，两边共用同一个 `at()`。
 */
export function makeArcSampler(centerline) {
  const n = centerline.length;
  if (!n) throw new Error('wallstair: 中心线是空的');
  const arc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = centerline[i].top, b = centerline[(i + 1) % n].top;
    arc[i + 1] = arc[i] + Math.hypot(b.x - a.x, b.z - a.z);
  }
  const perimeter = arc[n];
  if (!(perimeter > 1)) throw new Error(`wallstair: 中心线周长异常 ${perimeter}`);

  const _o = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3();
  const frame = {
    arcM: 0, o: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0), n: new THREE.Vector3(0, 0, 1), topY: 0,
  };
  /** 弧长 → 该处的中心线局部系（`t` 切向、`n` 指向城内）。同一个 frame 对象反复复用。 */
  function at(s) {
    const t = ((s % perimeter) + perimeter) % perimeter;
    let i = 0;
    while (i < n - 2 && arc[i + 1] < t) i++;
    const j = i + 1;
    const span = Math.max(1e-6, arc[j] - arc[i]);
    const f = Math.min(1, Math.max(0, (t - arc[i]) / span));
    _o.lerpVectors(centerline[i].top, centerline[j].top, f);
    _t.lerpVectors(centerline[i].tangent, centerline[j].tangent, f).setY(0).normalize();
    _n.lerpVectors(centerline[i].inN, centerline[j].inN, f).setY(0).normalize();
    frame.arcM = t;
    frame.o.copy(_o);
    frame.t.copy(_t);
    frame.n.copy(_n);
    frame.topY = _o.y;
    return frame;
  }
  return { n, arc, perimeter, at };
}

/* ============================== 落位表 ============================== */

/**
 * 暂算的 flight 级数与沿墙长（街面高程还不知道时的版本）。
 * 只用来定**净空判据扫多大一段**；最终值由 buildWallStairs 用真实街面高程重算。
 */
function provisionalSpan(wallTopY) {
  const S = TUNE.stair, B = TUNE.band;
  const rise = wallTopY + B.walkwayTopProud - S.streetY;
  const count = Math.max(2, Math.round(rise / S.riserM));
  return { count, lengthM: count * S.treadM };
}

/**
 * 沿索引方向的弧长差（米）。**下标绕环递增**，所以 `to >= from` 就是在向前走。
 *
 * ⚠⚠ 这个函数的前一版是 `to > from ? arc[to] - arc[from] : arc[to] + P - arc[from]`，
 *   拿它当「向后走多远」用时，`to < from` 分支返回的是**绕环向前一整圈**的距离（≈562m），
 *   于是 `back > searchRadiusM` 在 s=1 就成立 —— 12m 搜索半径实际只走了 ±1 个点，
 *   6 座里有 2 座因此报「找不到合法点」。向后要的距离是 `arc[from] - arc[to]`，
 *   所以调用方一律写成 `arcStep(arc, prev, idx)`：**永远从旧的下标指向新的**。
 */
function arcStep(arc, from, to) {
  return to >= from ? arc[to] - arc[from] : arc[from] - arc[to];
}

/**
 * 沿中心线按弧长均分落位。**纯数据**：不建任何 mesh、不碰 three 的场景图、
 * 也不建 mesh 需要的每级帧（那要等 `groundAt` 把街面高程量回来）。
 *
 * 落位的语义：一个候选点 = **顶部平台 / 接墙段的中心**（护墙豁口就开在这里），
 * flight 从它**沿 −切向**往下伸。所以净空判据要扫的是 `[arcLand − 平台半长 − 暂算长度, arcLand + 平台半长]`。
 *
 * @param {object} o
 * @param {Array}  o.centerline  `extractCenterline` 的 `points`：`{ top, inN, tangent }`
 * @param {number} o.count       阶梯数（规格 §0：6）
 * @param {Function} o.isBlocked  `(pt) => boolean`，中心线点对象，true = 不能放（塔内 / 门楼避让）。
 *        **count > 0 时必填**。
 * @param {Function} o.isFootprintClear  `(pt, arcFrom, arcTo) => string|null`，
 *        规格 §1.6：那一段弧长上、阶梯 footprint 的横向带里不许有挡路的东西。
 *        **count > 0 时必填** —— 不给就抛错（静默把阶梯塞进房子里是最坏的一种错）。
 *        ⚠ 返回**字符串**（挡路那个东西的名字 + 读数）而不是布尔：判据一失败就要能说出是谁挡的，
 *          只回一个 `false` 的判据，报告里只能写「有建筑」三个字，等于没量。
 * @param {number[]} [o.arcOffsets]  整组候选要试的平移量，默认 `ARC_OFFSETS`。
 * @param {object}   [o.diag]        判据失败时用来**报数字**的全环读数
 *        （`{bandStepM, bandFreeM, bandRuns, perimeterM}`，由 `wallwalk.js` 的预烘带给出）。
 *        没有它就只能抛一句「放不下」，报告里写不出「最长空档多少、要多少才够」。
 * @returns {{count:number, perimeterM:number, nominalSpacingM:number, spacingM:number,
 *            arcOffsetM:number, offsetsTried:number, stairs:Array}}
 */
export function planStairs({ centerline, count, isBlocked, isFootprintClear, arcOffsets = ARC_OFFSETS, diag = null }) {
  const n = centerline.length;
  if (count > 0 && typeof isBlocked !== 'function') {
    throw new Error('wallstair: count>0 必须给 isBlocked(p) —— 没有它无法排除塔内 / 门楼区段');
  }
  if (count > 0 && typeof isFootprintClear !== 'function') {
    throw new Error('wallstair: count>0 必须给 isFootprintClear(p, arcFrom, arcTo) —— 没有它无法执行规格 §1.6 的净空判据');
  }
  const A = makeArcSampler(centerline);
  const { arc, perimeter } = A;
  const S = TUNE.stair, B = TUNE.band;
  const halfLand = S.landingM / 2;
  /** 落位搜不出来时把每次试探记下来（平时为 null = 不记，热路径上零开销）。 */
  let probeLog = null;

  /** 弧长 → 最近中心线下标。⚠ 二分而不是线性扫：细网格有 241 个平移量 × 6 座 × 19 个搜索位。 */
  const indexAtArc = (s) => {
    const t = ((s % perimeter) + perimeter) % perimeter;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arc[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };

  /** 候选点的 footprint 净空区间（净空判据 + 余量）。 */
  const clearSpanAt = (idx) => {
    const span = provisionalSpan(centerline[idx].top.y);
    return {
      lengthM: span.lengthM,
      from: arc[idx] - halfLand - span.lengthM - TUNE.plan.clearancePadM,
      to: arc[idx] + halfLand,
    };
  };

  /**
   * 在 `wantArc` 处落一座：候选点被否就沿弧长找最近的合法点（半径 ≤ searchRadiusM）。
   * **两条判据都要过**：落位点本身合法（塔内 / 门楼）**且**背后 18m 净空。
   * ⚠ 只判第一条是这一批踩过的坑：+11m 那一版的第 0 座落位点离塔楼很远，
   *   但 flight 往回伸的时候正穿过 12m 外的一座塔 —— 落位点合法 ≠ 阶梯合法。
   * @returns {{chosen:number, searchArc:number, candidate:number, span:object}|null}
   */
  /** 试探一个候选点。**永远**回一个 verdict（而不是「通过就返回、否则 null」），
   *  这样 `placeAt` 才能把每次试探记进 `probeLog` —— 落位搜不出来的时候，
   *  光看一句「±12m 内没有合法点」根本不知道是**够不着**还是**够得着但被判否**。 */
  const verdictAt = (i) => {
    if (isBlocked(centerline[i])) return { ok: false, span: null, why: '塔内 / 门楼避让', kind: 'blocked' };
    const span = clearSpanAt(i);
    const why = isFootprintClear(centerline[i], span.from, span.to);
    return why ? { ok: false, span: null, why, kind: 'clear' } : { ok: true, span, why: null, kind: null };
  };
  function placeAt(wantArc) {
    const idx = indexAtArc(wantArc);
    let last = null;
    const try_ = (i, tag) => {
      const v = verdictAt(i);
      last = v;
      if (probeLog && probeLog.length < 80) probeLog.push(tag + '@' + arc[i].toFixed(1) + '=' + (v.ok ? 'OK' : v.kind));
      return v.ok ? { chosen: i, span: v.span } : null;
    };
    const hit = try_(idx, '0');
    if (hit) return { ...hit, searchArc: 0, candidate: idx, why: null, whyKind: null };
    for (let s = 1; s <= n; s++) {
      const prev = (idx - s + n) % n, next = (idx + s) % n;
      const a = try_(prev, '-' + s); if (a) return { ...a, searchArc: -arcStep(arc, prev, idx), candidate: idx, why: null, whyKind: null };
      const b = try_(next, '+' + s); if (b) return { ...b, searchArc: +arcStep(arc, idx, next), candidate: idx, why: null, whyKind: null };
      const back = arcStep(arc, prev, idx);
      if (back > TUNE.plan.searchRadiusM) {
        if (probeLog) probeLog.push('break@' + back.toFixed(1) + 'm');
        return { fail: '±' + TUNE.plan.searchRadiusM + 'm 内没有合法点', why: last.why, whyKind: last.kind };
      }
    }
    return { fail: '整圈扫完没有合法点', why: last.why, whyKind: last.kind };
  }

   /* ⚠ **整组候选整体平移重试**（沿用第三批已验证的做法）。
   *   规格 §2：等分 6 段取中点，候选被否就沿弧长找最近合法点，半径 ≤ 12m。
   *   实测：判据带余量之后塔区 / 门楼的禁放带被加宽，三条约束（等分 / 12m 半径 / 全合法）
   *   不能同时满足 ⇒ 保留「等分 + 每座 12m 内找最近合法点」，把**整组候选**沿弧长
   *   整体平移若干固定偏移再试。全部失败就抛错（规格 §1.6：放不下就停下来报数字）。
   *
   * ⚠⚠ **规格 §1.6 的净空判据必须并进这个搜索循环，不能选完再判**：
   *   落位点本身合法 **≠** 它背后那 13~18m 合法。实测第一个平移量（+11m）的第 0 座
   *   落位在弧长 57.6m、离塔楼很远，但 flight 往回伸 16.6m 时**正穿过弧长 48m 的一座塔**。
   *   在循环外判的话整个 boot 直接抛错、页面白屏，而不是「换下一个平移量」。
   *   塔区占环 13 座 × 约 5m ≈ 11.5%，所以 20 个偏移里绝大多数都合法。 */
  let placed = null, arcOffset = 0, tried = 0, clearFail = null, clearFails = 0;
  for (const off of arcOffsets) {
    tried++;
    const rows = [];
    let ok = true;
    for (let k = 0; k < count; k++) {
      const want = ((((k + 0.5) * perimeter) / count) + off + perimeter * 4) % perimeter;
      const r = placeAt(want);
      if (!r.chosen) {
        ok = false;
        if (r.whyKind === 'clear') clearFails++;
        clearFail = '第 ' + k + ' 座（平移量 ' + off.toFixed(1) + 'm，落位弧长 '
          + want.toFixed(2) + 'm）：' + (r.why || r.fail);
        break;
      }
      /* 暂算 flight 长度：街面高程此刻还不知道（streetY 只是初值）。
       *   这一版只用来定**净空判据扫多大一段**；最终长度由 buildWallStairs 重算。 */
      rows.push({ k, want, r, arcFrom: r.span.from, arcTo: r.span.to });
    }
    if (ok) { placed = rows; arcOffset = off; break; }
  }
  if (!placed) {
    const reach = Math.max.apply(null, arcOffsets.map(Math.abs));
    /* 报数字：这一段是规格 §1.6「放不下就停下来报数字」的那句话的兑现 ——
     * 只抛「都找不到合法点」等于没量。报的是全环空档到底多长、每座要多少。 */
    let extra = '';
    if (diag) {
      const runs = diag.bandRuns;
      const need = [];
      for (let i = 0; i < n; i++) {
        const sp = provisionalSpan(centerline[i].top.y);
        need.push(sp.lengthM + 2 * halfLand + 2 * TUNE.plan.clearancePadM);
      }
      const lo = Math.min.apply(null, need), hi = Math.max.apply(null, need);
      /* 分开数两条判据：只报「都找不到」没法知道是哪条卡住的。
       * 落位点数（`okBoth`）是决定性的 —— 它就是**全环所有合法落位点的总数**。 */
      let okBlocked = 0, okClear = 0;
      const okBoth = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const b = !isBlocked(centerline[i]);
        const sp = clearSpanAt(i);
        const c = !isFootprintClear(centerline[i], sp.from, sp.to);
        if (b) okBlocked++;
        if (c) okClear++;
        okBoth[i] = (b && c) ? 1 : 0;
      }
      const landRuns = [];
      let i = 0;
      while (i < n) {
        if (!okBoth[i]) { i++; continue; }
        const s = i;
        while (i < n && okBoth[i]) i++;
        landRuns.push([+arc[s].toFixed(2), +(arc[i] - arc[s]).toFixed(2)]);
      }
      const nOk = landRuns.reduce((a, r) => a + r[1], 0);
      /* **与平移量无关**的那个决定性数字：每座槽位离最近的合法落位点有多远。
       * 整体平移只是把 6 个槽位一起挪，`minDist` 不变 ⇒ 一旦某座 > searchRadiusM，
       * 241 个平移量里**没有一个**能救它，加平移范围是白费力气，只能动搜索半径。 */
      const minDist = [];
      for (let k = 0; k < count; k++) {
        const nom = ((((k + 0.5) * perimeter) / count) + perimeter * 4) % perimeter;
        let best = Infinity;
        for (let i = 0; i < n; i++) {
          if (!okBoth[i]) continue;
          /* ⚠ 这里比的是**弧长**（米），不能走 `arcStep()` —— 那个收的是**下标**。
           *   混着写过一次，出来的全是 NaN，害我以为「每座都够近」其实没量到。 */
          const d = ((arc[i] - nom) % perimeter + perimeter) % perimeter;
          best = Math.min(best, Math.min(d, perimeter - d));
        }
        minDist.push(isFinite(best) ? +best.toFixed(2) : -1);
      }
      /* 逐座实测：平移量 0 这一组，每座到底落在哪 / 为什么被否。
       * 前面那堆统计都只是推，只有这一行是 `placeAt` 自己跑出来的。 */
      const trace = [];
      for (let k = 0; k < count; k++) {
        const want = ((((k + 0.5) * perimeter) / count) + perimeter * 4) % perimeter;
        probeLog = [];
        const r = placeAt(want);
        trace.push(k + '@' + want.toFixed(1) + (r.chosen
          ? '→' + arc[r.chosen].toFixed(1)
          : '✗ ' + String(r.why || r.fail).slice(0, 70) + ' {' + probeLog.join(' ') + '}'));
        probeLog = null;
      }
      extra = ' 全环（规格 §1.6 那条带）净空 ' + diag.bandFreeM.toFixed(1) + '/' + diag.perimeterM.toFixed(1)
        + 'm，分成 ' + runs.length + ' 段连续空地；一座阶梯要占 ' + lo.toFixed(1) + '~' + hi.toFixed(1)
        + 'm（暂算级数），够长的有 ' + runs.filter((r) => r[1] >= hi).length + ' 段。'
        + ' 落位点：过「塔内/门楼」判据 ' + okBlocked + '/' + n
        + '，过净空判据 ' + okClear + '/' + n + '，两条都过 ' + landRuns.length + ' 处共 ' + nOk.toFixed(1) + 'm。'
        + ' 合法落位区（起点弧长/长度 m）：' + (landRuns.length ? landRuns.map((r) => r[0] + '/' + r[1]).join('，') : '（无）')
        + ' 各槽位到最近合法落位点 ' + minDist.join('/') + 'm（搜索半径 ' + TUNE.plan.searchRadiusM
        + 'm ⇒ ' + minDist.map((d) => (d > TUNE.plan.searchRadiusM ? '超' : 'OK')).join('/') + '）。'
        + ' 平移量 0 逐座：' + trace.join(' ｜ ');
    }
    throw new Error(
      'wallstair: ' + count + ' 座阶梯沿弧长平移 0~±' + reach
      + 'm 都找不到合法点（试了 ' + tried + ' 个平移量，其中 ' + clearFails
      + ' 个败在规格 §1.6 的净空判据上）。'
      + (clearFail ? ' 最后一次失败：' + clearFail : '')
      + extra
      + ' 需要放宽落位或改塔区避让口径，不许硬塞，也不许自行改坡度。'
    );
  }

  /**
   * 落位点所在的那一段连续空地有多宽。
   *
   * ⚠ 为什么要**和总长一起报**：总长是被踢面 0.17 / 踏面 0.34 锁死的（爬升一高就变长），
   *   而「还剩多少余量」只取决于净空。将来有人想把阶梯加宽 / 加长，
   *   得能一眼看出离撞到下一座塔楼还有多远 —— 那个数就是 `clearGapM`。
   *
   * @returns {{fromM:number, lengthM:number}|null}
   */
  const gapAt = (arcM) => {
    if (!diag || !diag.bandRuns) return null;
    const t = ((arcM % perimeter) + perimeter) % perimeter;
    for (const r of diag.bandRuns) {
      const end = r[0] + r[1];
      if (end <= perimeter) { if (t >= r[0] && t <= end) return { fromM: r[0], lengthM: r[1] }; }
      else if (t >= r[0] || t <= end - perimeter) return { fromM: r[0], lengthM: r[1] };   // 跨过弧长 0 的那一段
    }
    return null;
  };

  const stairs = [];
  for (const row of placed) {
    const k = row.k;
    const wantArc = row.want;
    const { chosen, searchArc, candidate } = row.r;
    const pt = centerline[chosen];
    const inN = pt.inN.clone().setY(0).normalize();
    const tangent = pt.tangent.clone().setY(0).normalize();
    const wallTopY = pt.top.y;                       // 压顶石顶面中心 = 墙顶标高
    const topY = wallTopY + B.walkwayTopProud;      // 阶梯顶 = 铺装顶面（与墙道齐平）
    const span = provisionalSpan(wallTopY);
    const arcLand = arc[chosen];

    stairs.push({
      id: 'WallStair_' + String(k).padStart(2, '0'),
      index: k,
      centerIndex: chosen,
      candidateIndex: candidate,
      candidateArcM: +wantArc.toFixed(2),
      arcM: +arcLand.toFixed(2),
      arcOffsetM: +arcOffset.toFixed(2),
      shiftedArcM: +searchArc.toFixed(2),
      movedAlongArcM: +(arcLand - wantArc).toFixed(2),
      /* 落位点所在的那一段连续空地（与 `lengthM` 一起报，才看得出还剩多少余量）。 */
      clearGapM: (gapAt(arcLand) || {}).lengthM ?? null,
      clearGapFromM: (gapAt(arcLand) || {}).fromM ?? null,
      wallTopY: +wallTopY.toFixed(3),
      topY0: +topY.toFixed(3),
      count0: span.count,
      length0: +span.lengthM.toFixed(3),
      /** 护墙豁口：以平台 / 接墙段中心为心，沿墙 ±halfWidthM 不生成护墙。 */
      gap: { x: +pt.top.x.toFixed(3), z: +pt.top.z.toFixed(3), halfWidthM: TUNE.gap.halfWidthM },
      /** 净空判据实际扫过的弧长区间（探针要核对它与最终长度一致）。 */
      clearArc: [+row.arcFrom.toFixed(2), +row.arcTo.toFixed(2)],
      inN, tangent,
    });
  }

  const gaps = [];
  for (let k = 0; k < stairs.length; k++) {
    const a = stairs[k].arcM, b = stairs[(k + 1) % stairs.length].arcM;
    gaps.push(+(b - a + (b < a ? perimeter : 0)).toFixed(2));
  }
  return {
    count: stairs.length,
    perimeterM: +perimeter.toFixed(2),
    nominalSpacingM: +(perimeter / Math.max(1, count)).toFixed(2),
    spacingM: gaps,
    arcOffsetM: +arcOffset.toFixed(2),
    offsetsTried: tried,
    stairs,
  };
}

/* ============================== 解析面 ============================== */

/**
 * 解析面（`player.js` 的 `sample(x,z)` 先查它）。
 *
 * ⚠ **为什么必须有它**：高程场是 0.5m 一格、按三角形覆盖到格心，而**踏面只有 0.34m**
 *   —— 比一格还窄 ⇒ 有相当比例的格子拿不到踏面高度，剩下被 `max` splat 成
 *   「较高那一级」，空格子落进补洞扫描 ⇒ 台阶糊成一条斜坡。
 *   （上一批已实测过同一族问题：1.20m 宽的铺装步道就已经有「436 点里 11 点
 *   所在的格没有墙顶数据」。0.34m 只会更糟。）探针 S11 的负向对照就量这一条。
 *
 * 形状（全是定型数组，6 座一共 300 来级，每次查询先做 6 次 O(1) 排除）：
 *   · 每座一个 `o/t/n` 局部系（原点在**平台中心**）+ `aFoot/aLand/uF0/uF1`
 *   · `decks[]`：顶部那几片横向条带（平台 / 门槛石 / 豁口露出的压顶石台面 / 交接带），
 *     逐条高程不同（压顶石台面比铺装低 2.2cm）
 *   · 每级一帧 `sx,sz,stx,stz,snx,snz,sy` —— **与建 mesh 用的是同一批帧**
 */
function makeFootprint(nodes, perimeterM) {
  const n = nodes.length;
  let S = 0;
  for (const nd of nodes) S += nd.count;
  const fp = {
    n, sN: S, perimeterM,
    ids: nodes.map((nd) => nd.id),
    ox: new Float64Array(n), oz: new Float64Array(n),
    tx: new Float64Array(n), tz: new Float64Array(n),
    nx: new Float64Array(n), nz: new Float64Array(n),
    aFoot: new Float64Array(n), aLand: new Float64Array(n), aDeck: new Float64Array(n),
    uF0: new Float64Array(n), uF1: new Float64Array(n),
    baseY: new Float64Array(n), riser: new Float64Array(n), tread: new Float64Array(n),
    topY: new Float64Array(n), wallTopY: new Float64Array(n),
    count: new Int32Array(n), sOff: new Int32Array(n + 1),
    /* 顶部条带：扁平拼接，长度 = Σ deckCount */
    deckOff: new Int32Array(n + 1),
    deckA0: new Float64Array(0), deckA1: new Float64Array(0),
    deckU0: new Float64Array(0), deckU1: new Float64Array(0), deckY: new Float64Array(0),
    /* 每级一帧 */
    sx: new Float64Array(S), sz: new Float64Array(S),
    stx: new Float64Array(S), stz: new Float64Array(S),
    snx: new Float64Array(S), snz: new Float64Array(S),
    sy: new Float64Array(S), sStair: new Int32Array(S),
    /* 每座一张世界 XZ 查找表（`buildWallStairs` 与建 mesh 同一次循环烘出来的） */
    grids: [],
  };
  const decks = [];
  let dOff = 0, s = 0;
  for (let k = 0; k < n; k++) {
    const nd = nodes[k];
    fp.grids.push(nd.grid);
    fp.ox[k] = nd.landFrame.o.x; fp.oz[k] = nd.landFrame.o.z;
    fp.tx[k] = nd.landFrame.t.x; fp.tz[k] = nd.landFrame.t.z;
    fp.nx[k] = nd.landFrame.n.x; fp.nz[k] = nd.landFrame.n.z;
    fp.aFoot[k] = -(nd.landingM / 2 + nd.lengthM);
    fp.aLand[k] = 0;
    fp.aDeck[k] = nd.landingM / 2;
    fp.uF0[k] = offOf(TUNE.stair.flightFrom);
    fp.uF1[k] = offOf(TUNE.stair.flightTo);
    fp.baseY[k] = nd.baseY; fp.riser[k] = nd.riserM; fp.tread[k] = nd.treadM;
    fp.topY[k] = nd.topY; fp.wallTopY[k] = nd.wallTopY;
    fp.count[k] = nd.count;
    fp.sOff[k] = s;
    for (let i = 0; i < nd.count; i++, s++) {
      const f = nd.stepFrames[i];
      fp.sx[s] = f.o.x; fp.sz[s] = f.o.z;
      fp.stx[s] = f.t.x; fp.stz[s] = f.t.z;
      fp.snx[s] = f.n.x; fp.snz[s] = f.n.z;
      fp.sy[s] = f.y; fp.sStair[s] = k;
    }
    const a0 = -nd.landingM / 2, a1 = nd.landingM / 2;
    for (const d of nd.decks) decks.push({ a0, a1, u0: d.u0, u1: d.u1, y: d.y });
    fp.deckOff[k] = dOff;
    dOff += nd.decks.length;
    fp.deckOff[k + 1] = dOff;
  }
  fp.deckA0 = new Float64Array(decks.length);
  fp.deckA1 = new Float64Array(decks.length);
  fp.deckU0 = new Float64Array(decks.length);
  fp.deckU1 = new Float64Array(decks.length);
  fp.deckY = new Float64Array(decks.length);
  for (let i = 0; i < decks.length; i++) {
    fp.deckA0[i] = decks[i].a0; fp.deckA1[i] = decks[i].a1;
    fp.deckU0[i] = decks[i].u0; fp.deckU1[i] = decks[i].u1; fp.deckY[i] = decks[i].y;
  }
  fp.deckCount = dOff;
  return fp;
}

/**
 * 解析面查询：点落在阶梯 footprint 内就返回该点的**踏面高**，否则返回 null。
 *
 * ⚠⚠ **只查 `fp.grids` 的数组寻址，不做任何投影、不碰中心线。**
 *   曾经的前一版是「用平台那一帧把点投影成 along/across 再定级号」，
 *   圆弧上 16m 处的横向投影就偏 1.48m、20m 处偏 2.20m，远端整级直接落到框外
 *   （实测 282 个采样点 178 个退回街面）。表是建 mesh 时用同一批帧烘的，
 *   所以「脚下高度」与「画出来的那一级」在构造上就是同一个数。
 *
 * 命中返回 `{ y, stair, step, region, u, across }`：
 *   `region` = `flight`（某一级踏面）/ `deck`（顶部条带）。
 *   `u` / `across` 仍要算 —— `player.js` 的横向夹紧靠它定位，
 *   但用的是**命中那一级自己的帧**（或落位帧），不是全局中心线，所以没有弧偏离。
 *
 * @param {object} fp `buildWallStairs` 的 `footprint`
 * @param {number} x @param {number} z
 * @returns {object|null}
 */
export function sampleStairSurface(fp, x, z) {
  if (!fp || !fp.n) return null;
  for (let k = 0; k < fp.n; k++) {
    const g = fp.grids[k];
    if (!g || !g.cells) continue;
    const ix = Math.floor(x / g.cs) - g.i0;
    const iz = Math.floor(z / g.cs) - g.j0;
    if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) continue;
    const c = iz * g.nx + ix;
    if (!g.used[c]) continue;
    const isDeck = g.region[c] === 1;
    const j = g.level[c];
    /* 该用哪一帧算 u：flight 用**这一级自己**的帧，deck 用落位帧。 */
    const s = isDeck ? -1 : (fp.sOff[k] + j);
    const fr = isDeck
      ? { ox: fp.ox[k], oz: fp.oz[k], nx: fp.nx[k], nz: fp.nz[k] }
      : { ox: fp.sx[s], oz: fp.sz[s], nx: fp.snx[s], nz: fp.snz[s] };
    const u = (x - fr.ox) * fr.nx + (z - fr.oz) * fr.nz;
    return {
      y: g.y[c], stair: k, step: j,
      region: isDeck ? 'deck' : 'flight',
      u, across: u + TUNE.band.wallHalf,
    };
  }
  return null;
}

/* ============================== 材质挑选 ============================== */

/**
 * 与 `wallwalk.js` 的 `resolveMaterials` 同一套做法：从 town 里挑出**已经注入三平面**
 * 的材质实例直接复用。逐项显式检查 —— 挑不到就抛，绝不静默退回 three 默认白材质。
 */
function resolveMaterials(town) {
  const found = {};
  town.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      const key = normName(m.name);
      if (!found.stone && TUNE.material.stone.test(key)) found.stone = m;
      if (!found.paving && TUNE.material.paving.test(key)) found.paving = m;
    }
  });
  for (const k of ['stone', 'paving']) {
    if (!found[k]) throw new Error(`wallstair: town 里找不到阶梯材质（${TUNE.material[k]}）`);
    const m = found[k];
    if (!m.map || !m.bumpMap || typeof m.customProgramCacheKey !== 'function') {
      throw new Error(`wallstair: 材质「${m.name}」没有三平面注入（applyMaterials 还没跑？）`);
    }
  }
  return found;
}

/* ============================== 建 mesh ============================== */

const _UP = new THREE.Vector3(0, 1, 0);

/**
 * 造一个盒体几何并摆好（不合并）。`a/b/c` 是盒体三条局部轴，`sa/sb/sc` 是沿各自的尺寸。
 * ⚠ 盒体几何**不能有索引**（`mergeGeometries` 要求属性集一致），所以显式 toNonIndexed。
 *
 * ⚠ 局部轴取 `(切向, 内法线, 竖直)`：**这三个构成右手系**（实测 T×N = +Y，
 *   对 CCW 排序的椭圆环恒成立），所以法线不会被 `applyMatrix4` 翻掉。
 */
function boxAt(centre, t, n, sa, sb, sc) {
  const g = new THREE.BoxGeometry(sa, sb, sc);
  const m = new THREE.Matrix4().makeBasis(t, n, _UP);
  m.setPosition(centre);
  g.applyMatrix4(m);
  return g.toNonIndexed();
}

/** 在某个局部系里摆一个盒体：中心用 (along, across, y) 三个局部坐标给出。 */
function boxIn(frame, alongM, acrossM, y, sa, sb, sc) {
  const c = frame.o.clone()
    .addScaledVector(frame.t, alongM)
    .addScaledVector(frame.n, acrossM);
  c.y = y;
  return boxAt(c, frame.t, frame.n, sa, sb, sc);
}

function toPlain(g) { return g.index ? g.toNonIndexed() : g; }

/**
 * 把「沿墙 × 横向」的一块矩形盖进该座阶梯的**查找表草稿**。
 *
 * ⚠⚠ **必须和建 mesh 在同一个循环里调用、用同一批帧** —— 草稿里每一格的
 *   归属就是那一格属于哪一级/哪条带，**由帧直接给出，不是事后反算**。
 *   分成两处写（这里算一遍、那里再推一遍）早晚会漂，漂了就是「解析面与渲染几何
 *   系统性错位」，而这种错位在画面上完全看不出来，只在判据里表现为随机的几米误差。
 *
 * @param {number[]} draft 扁平数组，每格 5 个数：`x, z, level, y, region`
 *        （`level < 0` = 顶部条带，`region` 0 = flight / 1 = deck）
 */
function stampRect(draft, frame, alongLo, alongHi, u0, u1, level, y, region) {
  const cs = TUNE.stair.grid.cellM;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const a of [alongLo, alongHi]) {
    for (const u of [u0, u1]) {
      const x = frame.o.x + frame.t.x * a + frame.n.x * u;
      const z = frame.o.z + frame.t.z * a + frame.n.z * u;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  const i0 = Math.floor((minX - cs) / cs), i1 = Math.floor((maxX + cs) / cs);
  const j0 = Math.floor((minZ - cs) / cs), j1 = Math.floor((maxZ + cs) / cs);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * cs, z = (j + 0.5) * cs;
      const ex = x - frame.o.x, ez = z - frame.o.z;
      const a = ex * frame.t.x + ez * frame.t.z;
      if (a < alongLo || a > alongHi) continue;
      const u = ex * frame.n.x + ez * frame.n.z;
      if (u < u0 || u > u1) continue;
      draft.push(x, z, level, y, region);
    }
  }
}

/** 草稿 → 定型的网格表（`used` / `level` / `y` / `region` 四张平行数组）。 */
function packGrid(draft) {
  const n = draft.length / 5;
  const cs = TUNE.stair.grid.cellM;
  /* 空表 ⇒ 尺寸会是 NaN（`Infinity - Infinity`），`new Uint8Array(NaN)` 直接抛，
   *   整个页面白屏。空表不是错误状态（`sample()` 查不中就落回高程场），给它一张 0 格表。 */
  if (!n) {
    return {
      cs, i0: 0, j0: 0, nx: 1, nz: 1, cells: 0, areaM2: 0,
      used: new Uint8Array(1), level: new Int16Array(1),
      y: new Float64Array(1), region: new Uint8Array(1),
    };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let c = 0; c < n; c++) {
    const x = draft[c * 5], z = draft[c * 5 + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const i0 = Math.floor(minX / cs), i1 = Math.floor(maxX / cs);
  const j0 = Math.floor(minZ / cs), j1 = Math.floor(maxZ / cs);
  const nx = Math.max(1, i1 - i0 + 1), nz = Math.max(1, j1 - j0 + 1);
  const g = {
    cs, i0, j0, nx, nz, cells: 0,
    used: new Uint8Array(nx * nz),
    level: new Int16Array(nx * nz),
    y: new Float64Array(nx * nz),
    region: new Uint8Array(nx * nz),
  };
  for (let c = 0; c < n; c++) {
    const ix = Math.floor(draft[c * 5] / cs) - i0;
    const iz = Math.floor(draft[c * 5 + 1] / cs) - j0;
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
    const k = iz * nx + ix;
    g.used[k] = 1;
    g.level[k] = draft[c * 5 + 2];
    g.y[k] = draft[c * 5 + 3];
    g.region[k] = draft[c * 5 + 4];
    g.cells++;
  }
  /** footprint 面积（m²）—— 报告里要和「全环带宽面积」比。 */
  g.areaM2 = +(g.cells * cs * cs).toFixed(3);
  return g;
}

/** 中位数（偶数个取中间两个的平均）。 */
function median(list) {
  const s = list.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/**
 * 按落位表建 6 座阶梯的几何，合并成**两个** mesh（石体 / 踏面石板）。
 *
 * ⚠ 级数与沿墙长**由实测爬升现算**，不许写死：`rise = topY − baseY`，
 *   `count = round(rise / 0.17)`，`riserM = rise / count`（所以顶端与墙道**精确齐平**，
 *   而不是差半级）。`baseY` 用 `groundAt` 从真实高程场取中位数。
 *
 * @param {object} o
 * @param {THREE.Object3D} o.town
 * @param {object|Array} o.plan  `planStairs` 的返回值（或它的 `stairs` 数组）
 * @param {Array} o.centerline  `buildWallWalk` 的 `centerline`（逐级取帧要用）
 * @param {Function} [o.groundAt] `(x,z) => number|null`，**用真实高程场把梯脚 y 量回来**。
 * @returns {{group:THREE.Group, meshes:Array, nodes:Array, footprint:object, stats:Function}}
 */
export function buildWallStairs({ town, plan, centerline, groundAt }) {
  town.updateWorldMatrix(true, true);
  const list = Array.isArray(plan) ? plan : (plan && plan.stairs) || [];
  if (!list.length) throw new Error('wallstair: 落位表是空的（planStairs 没出结果？）');
  if (!Array.isArray(centerline) || !centerline.length) {
    throw new Error('wallstair: buildWallStairs 需要 centerline（每一级都要在中心线的弧上取自己的帧）');
  }

  const A = makeArcSampler(centerline);
  const S = TUNE.stair, B = TUNE.band;
  const mats = resolveMaterials(town);
  const stoneParts = [], plateParts = [], nodes = [];

  for (const pd of list) {
    const arcLand = pd.arcM;
    /* ⚠ `A.at()` **返回同一个复用对象**（每级都要取帧，不复用就是 300 次分配）。
     *   所以平台那一帧必须**立刻快照**，否则下面量街面高程时调几次 `at()` 就把它冲掉了，
     *   平台 / 门槛石 / 石托座会全部建到梯脚那一片去。 */
    const f0 = A.at(arcLand);
    const landFrame = {
      o: f0.o.clone(), t: f0.t.clone(), n: f0.n.clone(),
      arcM: f0.arcM, topY: f0.topY,
    };
    const wallTopY = landFrame.topY;
    const topY = wallTopY + B.walkwayTopProud;

    /* ---- 街面高程：across 2.75/3.00/3.25 三点取中位（理由见 TUNE.footProbeAcross）---- */
    let baseY = S.streetY, groundErr = null, footY = null, footYmin = null, footYmax = null;
    let lengthM = pd.length0, count = pd.count0, riserM = rise0of(topY, baseY, count);

    /* 迭代 3 轮：flight 长度 ← 街面高程 ← flight 长度。街面在 1m 内几乎是平的，
     *   第二轮残差 < 2cm，第三轮只用来确认收敛。 */
    for (let it = 0; it < 3; it++) {
      const arcFoot = arcLand - S.landingM / 2 - lengthM;
      const footFrame = A.at(arcFoot - S.footBackM);
      const ys = [];
      if (typeof groundAt === 'function') {
        for (const ac of S.footProbeAcross) {
          const g = groundAt(footFrame.o.x + footFrame.n.x * offOf(ac), footFrame.o.z + footFrame.n.z * offOf(ac));
          if (g !== null && isFinite(g)) ys.push(g);
        }
      }
      if (!ys.length) ys.push(S.streetY);
      const med = median(ys);
      footY = ys;
      footYmin = Math.min(...ys);
      footYmax = Math.max(...ys);
      const nextBase = med;
      if (typeof groundAt === 'function') groundErr = +(nextBase - S.streetY).toFixed(3);
      const r = topY - nextBase;
      const c = Math.max(2, Math.round(r / S.riserM));
      const len = c * S.treadM;
      const done = nextBase === baseY && c === count && Math.abs(len - lengthM) < 1e-6;
      baseY = nextBase; count = c; lengthM = len; riserM = rise0of(topY, baseY, count);
      if (done && it > 0) break;
    }

    /* ---- 逐级取帧（曲面，不是直线，见文件头）---- */
    const arcFoot = arcLand - S.landingM / 2 - lengthM;
    const stepFrames = [];
    for (let i = 0; i < count; i++) {
      const fr = A.at(arcFoot + (i + 0.5) * S.treadM);
      stepFrames.push({
        o: fr.o.clone(), t: fr.t.clone(), n: fr.n.clone(),
        arcM: +fr.arcM.toFixed(3),
        /** 第 i 级踏面高：与解析面、探针判据用的是同一个式子。 */
        y: +(baseY + (i + 1) * riserM).toFixed(6),
      });
    }

    /* ---- 逐级建几何 + **同一次循环里**盖查找表 ----
     *   ⚠ 盖表不许挪到别处：表里每格的级号就是这一格踩上去的踏面高，
     *   而它必须与上面那两个 box 用**同一个 `fr`**。见 `stampRect` 的说明。 */
    const uF0 = offOf(S.flightFrom), uF1 = offOf(S.flightTo);
    const uMid = (uF0 + uF1) / 2, uW = uF1 - uF0;
    const botY = baseY - S.sinkM;
    const gridDraft = [];
    for (let i = 0; i < count; i++) {
      const fr = stepFrames[i];
      const tY = fr.y;
      const stoneTop = tY - S.plateInsetM;
      stoneParts.push(boxIn(fr, 0, uMid, (botY + stoneTop) / 2,
        S.treadM + 2 * S.stepOverlapM, uW, stoneTop - botY));
      plateParts.push(boxIn(fr, 0, uMid, tY - S.plateM / 2,
        S.treadM - 2 * S.plateShrinkM, uW - 2 * S.plateShrinkM, S.plateM));
      /* 归属判据 = 半个踏面（`|along| ≤ tread/2`），相邻级相距 0.34m > 2×0.17m ⇒ 互不重叠。 */
      stampRect(gridDraft, fr, -S.treadM / 2, S.treadM / 2, uF0, uF1, i, tY, 0);
    }

    /* ---- 顶部平台（石体 1.0m 沿墙 × 1.0m 横向，悬在压顶石内挑之外 0.14m）---- */
    const landTop = topY - S.plateInsetM;
    const landBot = topY - S.landingThickM;
    stoneParts.push(boxIn(landFrame, 0, uMid, (landBot + landTop) / 2,
      S.landingM + 2 * S.stepOverlapM, uW, landTop - landBot));
    plateParts.push(boxIn(landFrame, 0, uMid, topY - S.plateM / 2,
      S.landingM - 2 * S.plateShrinkM, uW - 2 * S.plateShrinkM, S.plateM));

    /* ---- 门槛石：跨过 2.11（压顶石内挑）→ 2.25（平台内沿）之间那道 14cm 空缝。
     *   厚 22mm、**顶面比铺装低 2mm**：压住压顶石顶面（wallTopY）不共面，
     *   又与平台的踏面石板错开 2mm ⇒ 三块板两两都不共面。
     *   外沿往平台石体里塞 1cm ⇒ 端面埋进石头里，既看不见也不打架。
     *   沿墙比平台石板短 7mm ⇒ 两者的端面错开，不共面。 */
    const sillU0 = offOf(B.copingInnerEdge);
    const sillU1 = uF0 + S.sillTuckM;
    const sillTop = topY - S.sillDropM;
    stoneParts.push(boxIn(landFrame, 0, (sillU0 + sillU1) / 2, sillTop - S.sillThickM / 2,
      S.landingM - 0.007 - 2 * S.plateShrinkM, sillU1 - sillU0, S.sillThickM));

    /* ---- 石托座（规格 §1.4）。挂在内墙面上，接住平台悬出压顶石的那 0.14m。
     *   ⚠ 内沿埋进墙面 2cm（`corbel.from` 取 2.03 而不是 2.05）——
     *   与 `Curtain_*` / `InnerLower` 的内立面共面会 z-fight。 ---- */
    const C = S.corbel;
    const cU0 = offOf(C.from), cU1 = offOf(C.to);
    stoneParts.push(boxIn(landFrame, 0, (cU0 + cU1) / 2, landBot - C.dropM / 2,
      C.halfAlongM * 2, cU1 - cU0, C.dropM));

    /* ---- 顶部解析面：逐条横向带，高程逐条不同 ---- */
    const decks = [
      // 平台：与墙道铺装同标高
      { u0: uF0, u1: uF1, y: topY, tag: 'landing' },
      // 门槛石：比铺装低 2mm（与渲染逐毫米一致）
      { u0: sillU0, u1: uF0, y: sillTop, tag: 'sill' },
      // 护墙豁口里露出来的**压顶石台面**：比铺装低 2.2cm（wallwalk 的 walkwayTopProud）
      { u0: offOf(S.notchFrom), u1: sillU0, y: wallTopY, tag: 'notch' },
      // 往内接到走廊夹紧带的内沿，交接时一帧都不拽人（§4.3）
      { u0: offOf(S.handoffFrom), u1: offOf(S.notchFrom), y: topY, tag: 'handoff' },
    ];

    /* 顶部条带也盖进表（平台那一帧离它们只有 ±0.5m，没有弧偏离问题）。
     *   后盖：平台与最后一级踏面在 along 上有重叠，而两者高程本就相等。 */
    for (const d of decks) {
      stampRect(gridDraft, landFrame, -S.landingM / 2, S.landingM / 2, d.u0, d.u1, -1, d.y, 1);
    }
    const grid = packGrid(gridDraft);

    nodes.push({
      id: pd.id,
      index: pd.index,
      centerIndex: pd.centerIndex,
      candidateIndex: pd.candidateIndex,
      candidateArcM: pd.candidateArcM,
      arcM: pd.arcM,
      arcOffsetM: pd.arcOffsetM,
      shiftedArcM: pd.shiftedArcM,
      movedAlongArcM: pd.movedAlongArcM,
      clearGapM: pd.clearGapM,
      clearGapFromM: pd.clearGapFromM,
      gap: pd.gap,
      clearArc: pd.clearArc,
      /** 平台 / 接墙段的局部系（解析面的原点也是它）。 */
      landFrame: { o: landFrame.o.clone(), t: landFrame.t.clone(), n: landFrame.n.clone() },
      stepFrames,
      decks,
      /** 解析面查找表（世界 XZ 小网格，每格记级号/高程/区域）。查询只读它，不再做投影。 */
      grid,
      count, riserM: +riserM.toFixed(6), treadM: S.treadM,
      lengthM: +lengthM.toFixed(3),
      riseM: +(topY - baseY).toFixed(3),
      /** 坡度（度）：atan(踢面 / 踏面)。 */
      angleDeg: +((Math.atan2(riserM, S.treadM) * 180) / Math.PI).toFixed(2),
      baseY: +baseY.toFixed(4),
      topY: +topY.toFixed(4),
      wallTopY: +wallTopY.toFixed(4),
      /** 街面初值与实测高程的差（探针要报；`null` = 没给 groundAt）。 */
      groundErrM: groundErr,
      /** 梯脚高程的三个取样读数（across 2.75/3.00/3.25）。 */
      footProbeY: footY ? footY.map((v) => +v.toFixed(3)) : null,
      footSpreadM: footY ? +(footYmax - footYmin).toFixed(3) : null,
      footArcM: +arcFoot.toFixed(2),
      landingM: S.landingM,
      landingThickM: S.landingThickM,
      /** 横向（across 口径）读数，探针核对用。 */
      flightAcrossM: [S.flightFrom, S.flightTo],
      totalAlongM: +(lengthM + S.landingM).toFixed(3),
      /** 平台内沿离压顶石内挑有多少（= 真正悬挑的长度，见文件头）。 */
      copingGapM: +(S.flightFrom - B.copingInnerEdge).toFixed(3),
      sillAcrossM: [B.copingInnerEdge, +(sillU1 - TUNE.band.wallHalf).toFixed(3)],
      sillTopY: +sillTop.toFixed(4),
    });
  }

  const footprint = makeFootprint(nodes, A.perimeter);

  const group = new THREE.Group();
  group.name = 'WallStairs';
  const meshes = [];
  const mkMesh = (name, parts, mat) => {
    if (!parts.length) return null;
    const geo = mergeGeometries(parts.map(toPlain), false);
    if (!geo) throw new Error(`wallstair: mergeGeometries 返回 null（${name} 的属性集不一致？）`);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    meshes.push(mesh);
    return mesh;
  };
  mkMesh('WallStairs_Stone', stoneParts, mats.stone);
  mkMesh('WallStairs_Treads', plateParts, mats.paving);
  town.add(group);

  const triOf = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const newTriangles = meshes.reduce((s, m) => s + triOf(m.geometry), 0);
  const payload = {
    stairs: nodes.length,
    count: TUNE.plan.count,
    riserTargetM: S.riserM,
    treadM: S.treadM,
    widthM: +(S.flightTo - S.flightFrom).toFixed(2),
    landingM: S.landingM,
    gapHalfWidthM: TUNE.gap.halfWidthM,
    materials: [mats.stone.name, mats.paving.name],
    newTriangles,
    newDrawCalls: meshes.length,
    meshes: meshes.map((m) => ({ name: m.name, triangles: triOf(m.geometry), material: m.material.name })),
    riserRangeM: [Math.min(...nodes.map((n) => n.riserM)), Math.max(...nodes.map((n) => n.riserM))],
    countRange: [Math.min(...nodes.map((n) => n.count)), Math.max(...nodes.map((n) => n.count))],
    totalAlongRangeM: [Math.min(...nodes.map((n) => n.totalAlongM)), Math.max(...nodes.map((n) => n.totalAlongM))],
    /**
     * 解析面查找表的规模与覆盖率。
     * 「全环带宽面积」= 周长 × flight 宽度，是阶梯在**理想情况下**能占满的上限，
     * 拿它当分母 ⇒ 这个比值就是「6 座阶梯实际盖住了墙内侧可行走带的百分之几」。
     */
    grid: {
      cellM: S.grid.cellM,
      cellsTotal: nodes.reduce((a, n) => a + n.grid.cells, 0),
      areaTotalM2: +nodes.reduce((a, n) => a + n.grid.areaM2, 0).toFixed(2),
      ringBandAreaM2: null,          // 下面按周长补
      perStair: nodes.map((n) => ({ id: n.id, cells: n.grid.cells, areaM2: n.grid.areaM2 })),
    },
    perStair: nodes.map((nd) => ({
      id: nd.id, arcM: nd.arcM, centerIndex: nd.centerIndex,
      shiftedArcM: nd.shiftedArcM, movedAlongArcM: nd.movedAlongArcM,
      count: nd.count, riserM: +nd.riserM.toFixed(4), treadM: nd.treadM, angleDeg: nd.angleDeg,
      lengthM: nd.lengthM, totalAlongM: nd.totalAlongM, riseM: nd.riseM,
      clearGapM: nd.clearGapM, clearGapFromM: nd.clearGapFromM,
      baseY: nd.baseY, topY: nd.topY, wallTopY: nd.wallTopY,
      groundErrM: nd.groundErrM, footSpreadM: nd.footSpreadM, footProbeY: nd.footProbeY,
      footArcM: nd.footArcM, copingGapM: nd.copingGapM,
    })),
  };
  /* 全环带宽面积 = 周长 × flight 宽。`perimeter` 取自实际中心线（不是写死的 563.62）。 */
  payload.grid.ringBandAreaM2 = +((footprint.perimeterM || 0) * (S.flightTo - S.flightFrom)).toFixed(2);
  payload.grid.coveragePct = payload.grid.ringBandAreaM2 > 0
    ? +((payload.grid.areaTotalM2 / payload.grid.ringBandAreaM2) * 100).toFixed(3) : null;

  return { group, meshes, nodes, footprint, tune: TUNE, stats: () => payload };
}

/** 踢面 = 爬升 ÷ 级数（级数由爬升现算，所以踢面恒 ≈ TUNE.stair.riserM）。 */
function rise0of(topY, baseY, count) {
  return (topY - baseY) / Math.max(1, count);
}
