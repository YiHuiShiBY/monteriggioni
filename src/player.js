/**
 * Monteriggioni · 第三人称可操作小人
 * ===========================================================================
 * 目标：一个小人，第三人称视角，鼠标 + 键盘操控，在镇子里走。
 *
 * ── 为什么不新建一套人物造型 ─────────────────────────────────────────────
 * `people.js` 已经有一套**规格化**的分件人物（9 部件、15 段刚性骨架、腿占身高 53%、
 * 步态在 `src/gait.js` 里由两骨 IK 求解）。玩家小人直接复用**同一套几何与同一套步态**：
 * 玩家走在市集人群旁边时，如果两套比例不一致，画面会读成「两种生物」。
 * 所以这里只做「单份实例化」—— 把 9 条 InstancedMesh 换成 **15 个普通 Mesh**
 * （9 件里 6 件是左右各一个）。
 *
 * ⚠ 上一批本文件里还有**第二份**步态公式（`poseFigure`），与 `crowd.js` 的 `poseWalker`
 *   靠人肉同步。现在两处都调 `people.js` 转发的同一个 `poseFigure()`。
 *
 * ── 步态 ──────────────────────────────────────────────────────────────────
 * 步态全部在 `src/gait.js`：单支撑 + 两骨 IK，膝会弯、脚会抬、支撑相脚不打滑。
 * 代价是**步幅变短了**（一周期 1.16m，上一批 1.48m），所以走路/奔跑速度同步下调，
 * 让**步频**维持在人的量级（1.35 m/s ≈ 2.2 步/s）。速度不改的话 1.55 m/s 会变成
 * 2.7 步/s，画面上读成小跑。`tests/probe-gait.mjs` 末尾那张换算表是这张调速的依据。
 *
 * ── 行走面：地面高程场 + 禁区盒 ────────────────────────────────────────────
 * 不用逐帧向下射线。260 万面在软件光栅下一次射线要几秒，而每帧一次射线
 * 是「每帧几秒」—— 那是把画面钉死。crowd.js 已经证明的做法是**建高程场**，
 * 但本模块踩过一个坑：**只 splat 顶点是不够的**。
 * 701×701 = 49.1 万格里只有 1.1 万格拿到数据（顶点间距几十米而格子是 0.5m，
 * 顶点之间的整片地面从来没被写过），补洞之后整张场变成常数平面。
 * 所以这里**光栅化三角形**（重心坐标插值 y），空格降到 0，
 * 场恢复 0.431 … 14.80（跨度 14.37m）。
 *
 * 高度查询用**双线性插值**而不是最近格：0.5m 的格在近景里是可见的台阶。
 *
 * 禁区 = 墙体类网格的世界包围盒 xz 投影（沿用 crowd.js 的正则），
 * 再加一条**限高**：盒子顶面高于「脚底 + stepUp」才挡人。
 * 这一条是城墙能被挡住、而路缘石能被迈过的全部原因 ——
 * 城墙顶比街面高 6m，路缘石只有十几厘米。
 *
 * ── 第三人称相机：复用 OrbitControls，不自己写轨道 ────────────────────────
 * 相机每帧**整体平移**（`controls.target` 与 `camera.position` 加同一个 delta），
 * 于是用户用鼠标转出来的视角被完整保留，而目标点平滑地跟着人走。
 * 自己是「每帧把 target 设成角色位置」的话，鼠标转视角会失效。
 *
 * three r160 纪律：不引入任何新依赖，不使用 r162+ / r163+ 的 API。
 */

import * as THREE from 'three';
import { TUNE as PEOPLE, partGeometries, crowdMaterial, newPose, poseFigure } from './people.js';
// ⚠ 解析面（阶梯的踏面高）来自 `wallstair.js` 的 `sampleStairSurface` ——
//   **必须共用同一份参数**：高程场承载不了 0.34m 的踏面，见 `TUNE.stair`。
import { sampleStairSurface } from './wallstair.js';

const G = PEOPLE.gait;

export const TUNE = {
  /** 行走面。cell 与 crowd.js 同值，两套系统看到的地形必须一致。 */
  ground: {
    cell: 0.5,
    /** 高程场覆盖范围：以镇中心为心，足够走到城墙外的原野。 */
    extentM: 175,
    /** 空洞邻域补几轮。0 = 不补（探针用来看真实空洞）。 */
    dilate: 3,
  },

  /**
   * 行走手感。
   *
   * ⚠ 速度**本批下调了**（1.55 → 1.35，3.6 → 2.9），不是手感变差，是步幅变短了：
   *   步态从「一根刚腿绕髋转」换成单支撑两骨 IK 之后，踝前后行程受
   *   `|ankle−hip| ≤ thigh+shin` 约束，一周期只能走 1.16m（上一批 1.48m）。
   *   步频 = v / 周期长度，不同步调速的话 1.55 m/s 会变成 **2.7 步/s**，
   *   画面上读成小跑而不是走。`tests/probe-gait.mjs` 末尾有换算表。
   */
  walk: {
    speedWalk: 1.35,      // m/s ⇒ 1.08 周期/s = 2.2 步/s（正常人量级）
    speedRun: 2.90,       // 按住 Shift ⇒ 2.5 周期/s = 5.0 步/s
    accel: 14,            // m/s²，起步与刹车都不飘
    radius: 0.34,         // 碰撞圆半径（肩宽 0.43 的一半略小，穿窄缝要过）
    stepUp: 0.55,         // 能迈上的高度。低于它的盒子不挡人。
    /** 能走下的最大落差。与 stepUp 对称：只拦上坡的话人会从垛口「掉」到街面。 */
    maxDrop: 1.6,
    height: 1.80,         // 与 PEOPLE.nominalHeight 一致
    turnLag: 14,          // 转身角速度（rad/s），越大越跟手
  },

  /** 第三人称跟随。 */
  camera: {
    dist: 6.4,            // 默认跟多远（水平距离）
    minDist: 2.0,
    maxDist: 16,
    /** 目标点取胸口而不是脚：取脚的话相机会低头看地面。 */
    lookY: 1.32,
    /** 相机比目标点高多少。dist=6.4 / rise=1.35 ⇒ 俯角约 12°，标准过肩取景。 */
    rise: 1.35,
    /** 目标点跟随的刚度（越大越贴）。每帧用 1-exp(-k·dt) 保证与帧率无关。 */
    followK: 9.0,
  },

  /** 行走模式的阴影节流（模拟时间秒）。全局 autoUpdate=false，不节流影子会站在原地。 */
  shadow: { rebakeSec: 0.12 },

  /** 出生点：广场面上，避开建筑禁区。进 walking 时若落进禁区会自动顶出来。 */
  spawn: { x: 0, z: 0, yaw: 0.6 },

  /**
   * 城墙阶梯（第四批，`wallstair.js` 的落位表 + 解析面）。
   *
   * ⚠⚠ **阶梯是「可行走面」，不是攀爬物**：踢面 0.17m ≪ 下面的 `stepUp` 0.55，
   *   常规行走规则**直接放行**，所以本文件里没有任何阶梯专用的状态机
   *   （上一批那套 `st.climb` / `tryGrab` / `poseClimb` 已整体删掉）。
   *   阶梯要的只有三件事，全在 `TUNE.stair` 与下面 `buildWalkable` 的解析面里：
   *     ① `sample()` 先查解析面（踏面 0.34m 比高程场的 0.5m 格还窄，靠场必然糊成斜坡）；
   *     ② 站在阶梯上时跳过禁区推出（幕墙盒会把人从阶梯上横向推出去）；
   *     ③ 阶梯自带横向夹紧（与 `TUNE.corridor` 同一套思路）。
   *   `analyticStair` 是**负向对照开关**：关掉它就退回高程场，探针 S11 靠它证明
   *   「逐级走完全程」那条判据不是恒真。
   */
  stair: {
    /** 解析面开关。关掉 = `sample()` 退回纯高程场（阶梯必然糊成一条斜坡）。 */
    analytic: true,
    /** 横向夹紧：把人的圆柱夹在 flight 带里（只改横向分量，切向不动）。 */
    lateralClamp: true,
    /**
     * 阶梯**不是**墙道，所以走廊夹紧在阶梯上必须让位。
     * ⚠ 这是**硬要求**：flight 的 across 是 2.25~3.25，而走廊带是 [0.85, 1.23] ——
     *   夹一次就把人从阶梯上横着拽 1.0m 进护墙带里。顶部那几条横向带
     *   （`handoff`）一直铺到 across 1.23，正是为了让交接那一帧位移为 0。
     */
    bypassCorridor: true,
  },

  /**
   * 墙道横向走廊夹紧（第五批）。
   *
   * ⚠⚠ **为什么必须有它**：高程场里墙顶那一条数据是 GLB 的 `Coping_*`，
   *   横向是**全宽 2.18m**（across ∈ [−0.07, 2.11]），而生成的三段里
   *   **外侧垛口比墙顶高 1.42m、内侧矮护墙比墙顶高 0.85m**（实测）。
   *   这两条石头带**既不在禁区盒里**（`WallWalk_Merlons` / `WallWalk_Parapet`
   *   是整环合并成的单 mesh，整片 AABB 等于镇子的外接矩形，加进去等于封死全镇），
   *   **在高度场上又是一条平路**（splat 的是压顶石顶面）。
   *   ⇒ `maxDrop 1.6` 只挡得住「从墙道边缘掉到街面」，**挡不住「走进垛口或护墙里」**：
   *   铺装带只有 1.20m 宽，玩家直径 2×0.34 = 0.68m，净空只剩 0.52m。
   *   唯一的办法是把人**夹**在铺装带里。
   *
   * ⚠ `from` / `to` 是 **across 口径**（自外墙面向内，= dot(Δ,inN) + wallHalf），
   *   不是 dot 口径。
   * ⚠⚠ 两侧的余量是 **5cm 而不是 2cm**：探针从生产几何上量到的两条石头面**比标称分带还靠外**
   *   （垛口内表面 across **0.4634** vs 标称 0.46；护墙内表面 across **1.6254** vs 标称 1.66，
   *   也就是护墙比标称的 1.66 多吃掉了 3.5cm —— 护墙几何带压顶盖与门套，比分带表宽）。
   *   2cm 余量实测出来的净间隙是 **−0.0146m**（圆柱压在护墙上），5cm 才量得到正的
   *   ~4.6cm。走廊净宽 1.23 − 0.85 = 0.38m：铺装带 1.20m 减去两条石头面之间
   *   1.162m 的自由宽，再减去 0.68m 的身体直径，正好是这个量。
   */
  corridor: {
    wallHalf: 1.02,    // wallwalk.js 的 wallHalf：across = dot(Δ, inN) + 这个
    from: 0.85,        // 垛口内表面实测 0.4634 + 半径 0.34 + 余量 0.05 ≈ 0.8534，取 0.85
    to: 1.23,          // 护墙内表面实测 1.6254 − 半径 0.34 − 余量 0.05 = 1.2354，取 1.23
    marginM: 0.05,
    /**
     * 生效判据：`groundY ≥ yMin`（墙顶实测 20.83~23.54m、街面约 14m，
     * 19 卡在两者中间；墙道以外唯一可能超过 19m 的是 SurroundingLand 的远山，
     * 由下面两条距离判据排除）。
     * ⚠ 光靠 yMin **不够**：远山能到 90m 高，夹一下就把人从山头瞬移上墙。
     */
    yMin: 19.0,
    /** 沿墙切向距离上限。两座城门处中心线有 9.73m 的断口（实测），
     *  半断口 4.87m，取 5.5m 让门楼上的那一段也在走廊里。 */
    maxAlongM: 5.5,
    /** 横向距离上限。压顶石台面只有 across ∈ [−0.07, 2.11] ⇒ |dot| ≤ 1.09m，
     *  取 3.0m 足够覆盖台面 + 玩家半径，又把「镇子里任何一个远处的点」全排除掉。 */
    maxAcrossM: 3.0,
  },
};

/* ======================================================================== */
/*                            行走面：高程场 + 禁区                            */
/* ======================================================================== */

function rawName(o) { return o.userData.name || o.name || ''; }

/** 会被当成「地面」的网：GLB 地形 + 三条铺装面 + surrounds 造的地盘 + **墙道铺装**。 */
const GROUND_MESHES = new Set([
  'Terrain | Monteriggioni hill',
  'Via Primo Maggio | main village street',
  'Village street | north approach',
  'Piazza Roma | open stone square',
  'SurroundingLand',
  // 墙道铺装（第四批）。**不进的话墙顶 20.82~23.52m 在高程场里根本不存在**，
  // 玩家就算被放到墙顶也会因 `groundY − g = 7m > maxDrop` 被判「掉下悬崖」弹回去。
  // 雉堞 / 护墙 / 护墙压顶盖**一律不进**：护墙顶只比铺装高 0.85m 但它在**内侧**，
  // 进来会 splat 出「可以站在护墙上」的错误面。
  'WallWalk_Paving',
]);

/**
 * 同样算「地面」、但**按模式匹配**的网（436 片压顶石，名字带编号，没法列进上面的精确名集合）。
 *
 * ⚠⚠ 为什么墙顶必须靠 `Coping_*` 而不是只靠 `WallWalk_Paving`（实测，第三轮 probe-ladder）：
 *   铺装步道只有 **1.20m 宽**，而高程场是 **0.5m 一格、按三角形覆盖到格心**。
 *   1.20m 只够 2~3 格，格心落不落在这条带上是**随墙的朝向周期性变化**的：
 *   实测沿中心线 436 点里有 **11 点所在的格根本没有墙顶数据**（取到街面 13.98~17.93m），
 *   另有 **65/218 个抽查点被双线性插值拉低 0.87~1.85m**（墙内壁是 7m 断崖，
 *   相邻格是街面值时，0.5m 内插值就会漏出几米）。表现就是：墙道中线高程最大落差 7.911m，
 *   人走上去会「脚下一空」掉到街面。
 *   压顶石是**墙自己的顶面**，横向 2.18m（比步道宽近一倍），436 片首尾相接铺满全环 ——
 *   把它 splat 进来，墙顶就成了一条 2.18m 宽、连续无断点的**平台**，
 *   步道中线（across 1.06）离两侧边缘各 ≥1.05m = 2 格，双线性再也够不到街面。
 *   `Coping_*` 的顶面标高与 `extractCenterline` 的 `top` 实测**逐点相等**
 *   （压顶石顶面 − 中心线 top：min/p10/中位/p90/max 全是 0cm），所以它就是墙顶本身，
 *   不是另一个「更高的面」—— 不会把墙道抬高一截。
 */
const GROUND_PATTERNS = [/^Coping_\d+$/];
const isGroundMesh = (nm) => GROUND_MESHES.has(nm) || GROUND_PATTERNS.some((re) => re.test(nm));

/**
 * 建筑禁区。**与 crowd.js 的正则保持一致** —— 两套系统看到的墙必须是同一堵墙。
 * ⚠ 第四批加了 `^Curtain_`：幕墙本体（`fortifications.py` 逐段建的 448 段里跳过两座城门）
 *   原来**不在**禁区盒里，意思是从街上可以直接走穿墙体到城外。
 *   这是一处**行为变更**，见 README 与 `tests/probe-ladder.mjs` 的 P6 前后对比。
 *   能安全加的前提是 `Curtain_NNN` 是**逐段**网格（每片约 1.3×2.05×10m），
 *   逐片包围盒才是一串小盒子；整环合并成一片的话，一个盒子就把整个镇子框死了。
 *   `probe-ladder` 的 P6b 会把「每片 AABB 的尺寸」量出来，不靠这条注释当证据。
 * ⚠ `WallWalk_Parapet` / `WallWalk_Merlons` **故意不加**：它们是**整环合并成一个 mesh** 的，
 *   整片 AABB 就是「整个镇子的外接矩形」，加进去等于把镇子封死。
 *   掉不下去不靠禁区盒，靠高程场：墙道进了场，护墙外侧的格子是街面（低 7m），
 *   `maxDrop 1.6` 直接拦住（规格 §5.2 的理由在实测后不成立，见 README）。
 */
const BLOCKER_TEST = /\|\s*masonry$|Romanesque nave|square campanile shaft|open masonry ring|^Cafe \d|^Curtain_\d+$/;

const BLOCKER_MARGIN = 0.42;

/**
 * 收集建筑禁区盒。**`buildWalkable` 与 `buildWallWalk`（规格 §1.6 的净空判据）共用这一份**
 * —— 正则只有一处，重写一遍的话两份迟早分叉，分叉之后净空判据报出来的数就是假的。
 *
 * ⚠ `app.js` 必须在 `buildWallWalk` **之前**调它（净空判据要用），
 *   而 `buildWalkable` 在之后（高程场要用 `WallWalk_Paving`）。所以盒子收集与
 *   高程场建造拆成两步：这里只收盒子，`buildWalkable` 自己再收一次（结果相同）。
 *
 * @param {Array} roots 要扫的根对象
 * @param {Function} [exclude] 名字正则，命中就**排除**（阶梯用它排掉墙自己的 `Curtain_*`）
 * @returns {Array} `[{ name, minX, maxX, minZ, maxZ, topY, bottomY }]`
 */
export function collectBlockerBoxes(roots, exclude) {
  const out = [];
  const b = new THREE.Box3();
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const nm = rawName(o);
      if (!BLOCKER_TEST.test(nm)) return;
      if (exclude && exclude.test(nm)) return;
      b.setFromObject(o);
      if (!isFinite(b.min.x) || !isFinite(b.max.y)) return;
      const m = BLOCKER_MARGIN;
      out.push({
        name: nm,
        minX: b.min.x - m, maxX: b.max.x + m,
        minZ: b.min.z - m, maxZ: b.max.z + m,
        topY: b.max.y, bottomY: b.min.y,
      });
    });
  }
  return out;
}

/**
 * 建行走面。
 *
 * @param roots 要扫的**全部**根对象。⚠ 不能只给 town：
 *   `SurroundingLand`（镇外原野）是 `surrounds.js` 造出来直接 `scene.add()` 的，
 *   **不在 town 子树里**。只扫 town 的话下面那句「找不到地面网」会当场抛错，
 *   而症状是整个页面启动失败 —— 一个看不见的错会让页面白屏。
 *
 * @returns {{ sample(x,z):number|null, blockers:Array, field:object }}
 */
export function buildWalkable({ roots, center }) {
  /* ---- 1. 地面高程场 ---- */
  const half = TUNE.ground.extentM;
  const cell = TUNE.ground.cell;
  const x0 = center.x - half, z0 = center.z - half;
  const nx = Math.ceil((half * 2) / cell) + 1;
  const nz = Math.ceil((half * 2) / cell) + 1;
  const h = new Float32Array(nx * nz).fill(-Infinity);
  const found = [];

  const v = new THREE.Vector3();
  const b = new THREE.Box3();
  const splat = { tris: 0, degenerate: 0, cells: 0 };
  /* ⚠ `roots` 允许重叠（app.js 把 `wall.group` 单独传了一份，而它本来就挂在 town 下）。
   *   不去重的话同一张网会被光栅化两遍：`found` 出现重名、`splat.tris` 翻倍，
   *   而高程场是 max splat，值不会变 —— **探针读到的面数于是虚高一倍，却看不出任何异常**。 */
  const seen = new Set();
  for (const root of roots) {
    root.updateWorldMatrix(true, true);   // 刚 add 进场景的根对象 worldMatrix 还是旧的
    root.traverse((o) => {
      if (!o.isMesh || seen.has(o)) return;
      const nm = rawName(o);
      if (!isGroundMesh(nm)) return;
      seen.add(o);
      o.updateWorldMatrix(true, false);
      found.push(nm);
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      const m = o.matrixWorld;
      const idx = o.geometry.index;
      const nTri = idx ? (idx.count / 3) : (pos.count / 3);
      splat.tris += nTri;

      /* ⚠ 这里**必须光栅化三角形，不能只 splat 顶点**。
       *   第一版就是只 splat 顶点的，结果 701×701 = 49.1 万格里只有 **1.1 万格**
       *   拿到了数据（48 万格是空的），后面全被补洞和扫掠填成同一个值 ——
       *   高程场 min == max == 14.8，**整张场是一个常数平面**。
       *   症状极隐蔽：人物不浮不沉，只是走到山坡上脚下没有坡度，
       *   而 drawcall / 三角面 / 移动速度全部正常。
       *   原因是顶点密度：`SurroundingLand` 是几十个环 + 几条边界线，
       *   顶点间距几十米，而格子是 0.5m —— 顶点之间的整片地面从来没被写过。
       *   三角形光栅化把「边到边」之间的面也填上了，这才是一张高程场。 */
      for (let t = 0; t < nTri; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        v.fromBufferAttribute(pos, i0).applyMatrix4(m);
        const ax = (v.x - x0) / cell, az = (v.z - z0) / cell, ay = v.y;
        v.fromBufferAttribute(pos, i1).applyMatrix4(m);
        const bx = (v.x - x0) / cell, bz = (v.z - z0) / cell, by = v.y;
        v.fromBufferAttribute(pos, i2).applyMatrix4(m);
        const cx = (v.x - x0) / cell, cz = (v.z - z0) / cell, cy = v.y;

        // 三个顶点先各自落格：保证退化三角形（墙面）也留下数据。
        for (const [px, pz, py] of [[ax, az, ay], [bx, bz, by], [cx, cz, cy]]) {
          const ix = Math.round(px), iz = Math.round(pz);
          if (ix < 0 || ix >= nx || iz < 0 || iz >= nz) continue;
          const k = iz * nx + ix;
          if (py > h[k]) h[k] = py;
        }

        // xz 投影退化的（墙面 / 竖板）在地面上没有覆盖，直接跳过。
        const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(den) < 1e-12) { splat.degenerate++; continue; }

        const i0x = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
        const i1x = Math.min(nx - 1, Math.ceil(Math.max(ax, bx, cx)));
        const j0z = Math.max(0, Math.floor(Math.min(az, bz, cz)));
        const j1z = Math.min(nz - 1, Math.ceil(Math.max(az, bz, cz)));
        if (i1x < i0x || j1z < j0z) continue;
        splat.cells += (i1x - i0x + 1) * (j1z - j0z + 1);

        for (let iz = j0z; iz <= j1z; iz++) {
          const pz = iz + 0.5;
          for (let ix = i0x; ix <= i1x; ix++) {
            const px = ix + 0.5;
            const l0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
            if (l0 < 0) continue;
            const l1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
            if (l1 < 0) continue;
            const l2 = 1 - l0 - l1;
            if (l2 < 0) continue;
            const y = l0 * ay + l1 * by + l2 * cy;
            const k = iz * nx + ix;
            if (y > h[k]) h[k] = y;
          }
        }
      }
    });
  }
  const missing = [...GROUND_MESHES].filter((n) => !found.includes(n));
  if (missing.length) throw new Error(`player: 找不到地面网 ${missing.join(' / ')}`);
  // 模式项也要查「一条都没匹配上」—— 正则写错时它会安静地什么都不 splat，
  // 症状是墙顶整条从高程场里消失（和第四批没加 WallWalk_Paving 时一模一样）。
  for (const re of GROUND_PATTERNS) {
    if (!found.some((n) => re.test(n))) throw new Error(`player: 地面网模式 ${re} 一片都没匹配上`);
  }

  /* 空洞邻域补齐：地面网之间有缝（路缘、台阶侧面），不补会踩空。 */
  const holes0 = h.reduce((s, x) => s + (x === -Infinity ? 1 : 0), 0);
  for (let pass = 0; pass < TUNE.ground.dilate; pass++) {
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
            const sv = src[zz * nx + xx];
            if (sv > best) best = sv;
          }
        }
        h[k] = best;
      }
    }
  }

  /* 仍然空着的，是**地面网根本盖不到的地方**。
   * ⚠ 这里**只能往空格子里写**。第一版漏了这个判断，于是
   *   `best = max(h[k], h[k-1], h[k-nx])` 在**每一格**上都执行 ——
   *   而正向扫掠天然把镇心的全局最高点 14.8 一路推到右下角，
   *   反向再推到左上角 ⇒ **整张 49 万格的场被刷成常数 14.8**。
   *   症状：人物不浮不沉、drawcall 正常、移动正常，只是脚下没有坡度 ——
   *   而分网实测明明显示地形有 14.37m 落差。
   *   **判据的教训：一个「填空」的循环如果不判断「这格是不是空的」，
   *   它就不是填空，是重写。** */
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const k = z * nx + x;
      if (isFinite(h[k])) continue;
      let best = -Infinity;
      if (x > 0 && h[k - 1] > best) best = h[k - 1];
      if (z > 0 && h[k - nx] > best) best = h[k - nx];
      if (isFinite(best)) h[k] = best;
    }
  }
  for (let z = nz - 1; z >= 0; z--) {
    for (let x = nx - 1; x >= 0; x--) {
      const k = z * nx + x;
      if (isFinite(h[k])) continue;
      let best = -Infinity;
      if (x < nx - 1 && h[k + 1] > best) best = h[k + 1];
      if (z < nz - 1 && h[k + nx] > best) best = h[k + nx];
      if (isFinite(best)) h[k] = best;
    }
  }

  let flat = 0, lo = Infinity, hi = -Infinity;
  for (let k = 0; k < h.length; k++) {
    if (!isFinite(h[k])) { h[k] = 0; flat++; }   // 理论上不该再有；留着当兜底
    if (h[k] < lo) lo = h[k];
    if (h[k] > hi) hi = h[k];
  }

  /** 双线性采样。格边缘返回 null = 走出可行走范围。 */
  function sampleField(x, z) {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    if (fx < 0 || fz < 0 || fx > nx - 1 || fz > nz - 1) return null;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const i1 = Math.min(ix + 1, nx - 1), j1 = Math.min(iz + 1, nz - 1);
    const h00 = h[iz * nx + ix], h10 = h[iz * nx + i1];
    const h01 = h[j1 * nx + ix], h11 = h[j1 * nx + i1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /* ---- 2b. 城墙阶梯的解析面（第四批）----
   * ⚠⚠ **阶梯绝不能靠高程场承载**：场是 0.5m 一格、按三角形覆盖到格心，
   *   而**踏面只有 0.34m** —— 比一格还窄 ⇒ 有相当比例的格子拿不到踏面高度，
   *   剩下的被 `max` splat 成「较高那一级」，空格子落进补洞扫描，
   *   结果是**台阶糊成一条斜坡**（阶梯的形状本身没了）。
   *   （第三批已实测过同一族问题：1.20m 宽的铺装步道就已经有「436 点里 11 点
   *   所在的格没有墙顶数据」。0.34m 只会更糟。）
   * ⇒ `sample()` **先查解析面**，查不到才回落高程场；`sampleField()` 是纯场，
   *   留给探针做「关掉解析面」的负向对照与溯源。
   * 解析面的几何与逐级高度由 `wallstair.js` 提供（与建 mesh 用的是同一批帧），
   * 所以「脚下踩到的高度」与「画出来的那一级踏面」是同一个数。 */
  let stairFp = null;
  let stairAnalytic = TUNE.stair.analytic;
  const _stairHit = { on: false, y: 0, stair: -1, step: -1, region: '', u: 0, across: 0 };
  /** 解析面查询；结果写进 `_stairHit`，不为它分配对象（每帧都要调）。 */
  function stairAt(x, z) {
    _stairHit.on = false;
    if (!stairAnalytic || !stairFp) return _stairHit;
    const r = sampleStairSurface(stairFp, x, z);
    if (!r) return _stairHit;
    _stairHit.on = true;
    _stairHit.y = r.y; _stairHit.stair = r.stair; _stairHit.step = r.step;
    _stairHit.region = r.region; _stairHit.u = r.u; _stairHit.across = r.across;
    return _stairHit;
  }

  function sample(x, z) {
    const s = stairAt(x, z);
    if (s.on) return s.y;
    return sampleField(x, z);
  }

  /* ---- 2. 禁区盒 ---- */
  const blockers = collectBlockerBoxes(roots);
  if (!blockers.length) throw new Error('player: 一个禁区盒都没收集到 —— 正则或场景结构变了');

  /** 圆与禁区盒的最小推出向量。返回 null = 没撞上。 */
  function push(x, z, feetY) {
    let px = 0, pz = 0, hits = 0;
    for (const bx of blockers) {
      if (bx.topY <= feetY + TUNE.walk.stepUp) continue;      // 矮的：迈过去
      const cx = Math.min(Math.max(x, bx.minX), bx.maxX);
      const cz = Math.min(Math.max(z, bx.minZ), bx.maxZ);
      const dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= TUNE.walk.radius * TUNE.walk.radius) continue;  // 圆心在盒内或盒外够远
      hits++;
      if (d2 > 1e-12) {                       // 圆心在盒外：沿最近点方向推出去
        const d = Math.sqrt(d2);
        const need = TUNE.walk.radius - d;
        px += (dx / d) * need; pz += (dz / d) * need;
      } else {                                // 圆心在盒内：沿最浅的一边推出去
        const ox = Math.min(x - bx.minX, bx.maxX - x);
        const oz = Math.min(z - bx.minZ, bx.maxZ - z);
        if (ox < oz) px += (x - (bx.minX + bx.maxX) / 2 > 0 ? 1 : -1) * (ox + TUNE.walk.radius);
        else pz += (z - (bx.minZ + bx.maxZ) / 2 > 0 ? 1 : -1) * (oz + TUNE.walk.radius);
      }
    }
    return hits ? { x: px, z: pz, hits } : null;
  }

  return {
    sample, sampleField, push, blockers, stairAt,
    /** 装上阶梯的解析面（`app.js` 在 `buildWallStairs()` 之后调：高程场先建，
     *  解析面后装 —— 阶梯自己**不进高程场**，它只在这里接管自己 footprint 里的高度）。 */
    attachStairs(fp) { stairFp = fp && fp.n ? fp : null; return !!stairFp; },
    /** 解析面开关（探针 S11 的负向对照：关掉就退回高程场，阶梯必然糊成斜坡）。 */
    setStairAnalytic(on) { stairAnalytic = !!on; },
    get stairs() { return stairFp; },
    get stairAnalytic() { return stairAnalytic; },
    field: {
      cell, nx, nz, x0, z0, holes0, flat,
      lo: +lo.toFixed(3), hi: +hi.toFixed(3),
      meshes: found, splat,
      // 模式项匹配到的片数（精确名项看 meshes 就够，模式项是 436 个带编号的名字）
      copingCount: found.filter((n) => /^Coping_\d+$/.test(n)).length,
    },
  };
}

/* ======================================================================== */
/*                                单人骨架                                    */
/* ======================================================================== */

/**
 * 生成一个小人：**15 个 Mesh** 挂在一个 Group 下，4 份材质（肤 / 衣 / 裤 / 头巾）。
 * 材质是 people.js 那套注入过的克隆，所以贴图、凹凸、环境光强度与全镇一致。
 *
 * ⚠ Mesh 数量是 15 而不是 9：9 件里有 6 件是**左右各一个**的肢体段
 *   （上臂·前臂·手·大腿·小腿·脚），它们共用同一份几何但各有各的姿态。
 *   这里逐段建 Mesh，`write()` 按 `PEOPLE.parts` 的 `slot / per` 写进去。
 *   ⚠ 索引**按 parts 表走、不写死**。上一批 `PART_MESH` 写死了 6 个下标，
 *   本批部件表一变就全错 —— 而且 `mesh.getObjectByName` 那种写法会静默拿到 undefined。
 */
export function buildFigure({ town, colorway, char }) {
  const geos = partGeometries(char);
  const pal = PEOPLE.color;
  const pick = (role) => pal[role][Math.min(pal[role].length - 1, colorway?.[role] | 0)];

  // 四份材质：同 program 不会变，而四份已经能让「一人四色」读出来。
  const mats = {
    skin: crowdMaterial(town, pick('skin')),
    cloth: crowdMaterial(town, pick('cloth')),
    trouser: crowdMaterial(town, pick('trouser')),
    hair: crowdMaterial(town, pick('hair')),
  };

  const group = new THREE.Group();
  group.name = 'Player';
  const castSet = new Set(PEOPLE.castShadowParts);

  // parts[k] = 这一件对应的 per 个 Mesh（per=1 时就是 1 个）。
  const parts = PEOPLE.parts.map((spec) => {
    const list = [];
    for (let side = 0; side < spec.per; side++) {
      const m = new THREE.Mesh(geos[spec.key], mats[spec.role]);
      const tag = spec.per === 1 ? spec.key : `${spec.key}${side === 0 ? 'L' : 'R'}`;
      m.name = `Player_${tag}`;
      m.castShadow = castSet.has(spec.key);
      m.receiveShadow = false;
      m.frustumCulled = false;   // 单个 15 段的角色，剔除不值得那点开销
      m.matrixAutoUpdate = true;
      group.add(m);
      list.push(m);
    }
    return list;
  });
  const flat = parts.flat();
  // 记住最近一次写进来的 pose，`poseDiag()` 要读 gait.js 写在它身上的诊断量
  // （**读生产输出，不在探针里重算一遍**）。
  let lastPose = null;
  const NO_DIAG = { reachRatio: 0, kneeMinDeg: 0, kneeMaxDeg: 0, soleMinY: 0 };

  return {
    group, parts, flat, mats,
    /** 把一个 {15 段关节} 写进 15 个 Mesh。 */
    write(pose) {
      lastPose = pose;
      for (let k = 0; k < PEOPLE.parts.length; k++) {
        const spec = PEOPLE.parts[k];
        for (let side = 0; side < spec.per; side++) {
          const a = pose.joint[spec.slot + side];
          const m = parts[k][side];
          m.position.set(a[0], a[1], a[2]);
          m.quaternion.set(a[3], a[4], a[5], a[6]);
        }
      }
    },
    setVisible(on) { group.visible = on; },
    poseDiag() { return lastPose ? lastPose.diag : NO_DIAG; },
  };
}

/* ======================================================================== */
/*                    步态：与人群**同一份**，在 src/gait.js                     */
/* ======================================================================== */
/* 上一批本文件里有一整套自己的公式（刚腿绕髋 + 髋高 = 腿长·cos(摆角)），
   与 crowd.js 的 poseWalker 靠人肉同步 —— 而它们是「膝关节永远弯不了」的那套。
   现在只保留驱动量的差异：
     人群 —— 由「沿折线的弧长」推进
     玩家 —— 由「自己的位移」推进
   相位都只从路程来 ⇒ 加速只是步频变高，绝不会原地滑步。 */
/* ======================================================================== */
/*                                控制器                                      */
/* ======================================================================== */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _want = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 玩家控制器。
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {THREE.PerspectiveCamera} o.camera
 * @param {object} o.controls   OrbitControls
 * @param {object} o.walkable   buildWalkable 的返回值
 * @param {THREE.Vector3} o.center 镇中心（高程场原点）
 * @param {object} o.town
 */
export function createPlayer({ scene, camera, controls, walkable, center, town, renderer, char, centerline, onModeChange }) {
  const figure = buildFigure({ town, char, colorway: { skin: 1, cloth: 2, trouser: 0, hair: 1 } });
  scene.add(figure.group);

  const pose = newPose();
  const st = {
    active: false,
    x: TUNE.spawn.x, y: 0, z: TUNE.spawn.z,
    vx: 0, vz: 0,
    yaw: TUNE.spawn.yaw,
    phase: 0, time: 0, breath: 0.7,
    speed: 0, dist: 0,
    groundY: 0,
    blocked: 0,
    rebakeClock: 0,
    /** 墙道横向走廊夹紧的开关（S12 负向对照要在页内把它关掉再量一遍）。 */
    corridorClamp: true,
    /** 本帧横向被夹了多少米（0 = 没夹）。诊断用。 */
    corridorPushM: 0,
    /** 本帧夹紧为什么没夹（诊断用）：in-band / off / yMin / along / across / step(Δx) / clamped / no-centerline */
    corridorWhy: 'in-band',
    /** 阶梯解析面是否在用（诊断用）。假 = 已关掉，`sample()` 退回高程场。 */
    stairAnalytic: walkable.stairAnalytic !== false,
    /** 本帧脚下是不是踩在阶梯上；踩在阶梯上时禁区推出与走廊夹紧都让位。 */
    onStair: false,
    stairId: null,
    stairStep: -1,
    stairRegion: '',
    /** 本帧阶梯横向夹紧的米数（0 = 没夹）。 */
    stairPushM: 0,
    /** 触屏摇杆量（x 右正 / y 上正，[-1,1]；0 = 没在用）。与键盘互不冲突：触屏设备没键盘。 */
    stickX: 0, stickY: 0, stickRun: false,
  };

  /**
   * 中心线的紧凑副本（436 点 → 6 个 Float64Array）。
   *
   * 只为走廊夹紧服务：每帧找一次最近点，436 次点乘，可以忽略。
   * **不建空间索引**是刻意的 —— 省下几十行代码，而每帧多算 400 个点积
   * 换来的代价在这个场景里量不出来（整帧本来就在跑 62,572 个三角形的 splat）。
   */
  const CL = (() => {
    const src = Array.isArray(centerline) ? centerline : [];
    const n = src.length;
    const x = new Float64Array(n), z = new Float64Array(n);
    const nx = new Float64Array(n), nz = new Float64Array(n);
    const tx = new Float64Array(n), tz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = src[i];
      if (!p || !p.top || !p.inN) continue;
      x[i] = p.top.x; z[i] = p.top.z;
      const l = Math.hypot(p.inN.x, p.inN.z) || 1;
      nx[i] = p.inN.x / l; nz[i] = p.inN.z / l;
      const tl = Math.hypot(p.tangent.x, p.tangent.z) || 1;
      tx[i] = p.tangent.x / tl; tz[i] = p.tangent.z / tl;
    }
    return { n, x, z, nx, nz, tx, tz };
  })();
  const _c = { i: -1, x: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0, along: 0, u: 0 };
  /** 离 (px,pz) 最近的中心线点，结果写进 `_c`（每帧只调一次，不为它分配对象）。 */
  function nearestCenterline(px, pz) {
    if (!CL.n) return null;
    let best = Infinity, bi = -1;
    for (let i = 0; i < CL.n; i++) {
      const dx = px - CL.x[i], dz = pz - CL.z[i];
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    if (bi < 0) return null;
    _c.i = bi; _c.x = CL.x[bi]; _c.z = CL.z[bi];
    _c.nx = CL.nx[bi]; _c.nz = CL.nz[bi]; _c.tx = CL.tx[bi]; _c.tz = CL.tz[bi];
    const dx = px - _c.x, dz = pz - _c.z;
    _c.along = dx * _c.tx + dz * _c.tz;
    _c.u = dx * _c.nx + dz * _c.nz;
    return _c;
  }
  /** 中心线在 (px,pz) 处的 across 坐标（自外墙面向内），探针与调试用。 */
  function wallAcross(px, pz) {
    const c = nearestCenterline(px, pz);
    return c ? c.u + TUNE.corridor.wallHalf : null;
  }

  const keys = new Set();
  /**
   * 跟随开关。app.js 在「进入行走」那段相机补间跑着的时候把它关掉 ——
   * 否则第 7 步会以 1-exp(-9·dt) 的强度把 controls.target 往小人身上拽，
   * 和补间抢同一个量，画面会在补间中途被拽偏（看起来是「拐了个弯」）。
   * 补间结束（或被打断）时 app.js 再打开。
   */
  let followOn = true;
  const suspendFollow = (on) => { followOn = !on; };
  const isTypingTarget = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  function onKeyDown(e) {
    if (isTypingTarget(e)) return;
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.has(k)) { keys.add(k); e.preventDefault(); }
  }
  function onKeyUp(e) {
    if (isTypingTarget(e)) return;
    keys.delete(e.key.toLowerCase());
  }
  const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);

  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  // 切标签页回来时 Shift/W 还按着会「幽灵行走」，失焦时清空。
  addEventListener('blur', () => keys.clear());

  /** 把出生点顶出禁区 / 落到地面上。 */
  function resolveSpawn() {
    let x = st.x, z = st.z;
    for (let i = 0; i < 24; i++) {
      const g = walkable.sample(x, z);
      if (g === null) break;
      st.groundY = g;
      const p = walkable.push(x, z, g);
      if (!p) return true;
      x += p.x; z += p.z;
    }
    st.x = x; st.z = z;
    st.groundY = walkable.sample(x, z) ?? 0;
    return true;
  }
  resolveSpawn();

  /** 相机方向的水平投影 —— W 永远是「离相机远」，与鼠标转视角无关。 */
  function camBasis() {
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, _up).normalize();
  }

  /**
   * 阶梯的**横向**夹紧（`TUNE.stair.lateralClamp`），与 `TUNE.corridor` 同一套思路：
   * **只修正横向分量**，切向 `along` 一个字节都不动 ⇒ 人是**顺着阶梯滑**到 flight 带正中，
   * 不是被卡住或弹开。
   *
   * ⚠ 为什么要它：flight 带只有 1.00m 宽，而人的直径 0.68m。`maxDrop 1.6` 本来就能挡住
   *   「从侧面掉到街面」（高差 9m），但那是**撤销整段位移**——人在阶梯中段被卡住的观感
   *   比贴着边走差得多。夹紧之后人始终在带心 ±0.16m 内。
   * ⚠ **只夹 flight**：顶部那几条横向带（平台 / 门槛石 / 豁口台面 / 交接带）两侧
   *   分别是墙道铺装与压顶石台面，本来就是能走的，夹了反而会挡人过豁口。
   *
   * @returns {number} 本帧横向被修正的米数（0 = 没夹）
   */
  function clampStairLateral() {
    st.stairPushM = 0;
    if (!TUNE.stair.lateralClamp) return 0;
    const fp = walkable.stairs;
    if (!fp || !fp.n) return 0;
    const hit = walkable.stairAt(st.x, st.z);
    if (!hit.on || hit.region !== 'flight') return 0;
    const k = hit.stair;
    const r = TUNE.walk.radius;
    const lo = fp.uF0[k] + r, hi = fp.uF1[k] - r;
    if (hi <= lo) return 0;                       // 带宽不够夹（不可能，但别把 NaN 写进位置）
    const cu = hit.u < lo ? lo : (hit.u > hi ? hi : hit.u);
    if (Math.abs(cu - hit.u) < 1e-9) return 0;
    /* 用**这一级自己的内法线**修正横向：阶梯是曲面，用最近中心线点的 inN 会差 1.3m。 */
    const s = fp.sOff[k] + hit.step;
    st.x += fp.snx[s] * (cu - hit.u);
    st.z += fp.snz[s] * (cu - hit.u);
    st.stairPushM = Math.abs(cu - hit.u);
    return st.stairPushM;
  }

  /**
   * 行走模式相机的**理想位姿**：当前朝向的正后方、水平 6.4m、抬高 1.35m。
   * app.js 用它当「进入行走」那段补间的终点。
   *
   * 为什么不直接用「相机当前的方位」：从航拍机位进来时相机在 300m 高空，
   * 沿当前方向收进来会得到一个**从正上方俯视地面**的机位 —— 人被压在画面最底下。
   * 用出生朝向摆到背后，进场第一眼就是标准第三人称。
   */
  function cameraPose() {
    const t = new THREE.Vector3(st.x, st.groundY + TUNE.camera.lookY, st.z);
    const p = new THREE.Vector3(
      t.x - Math.sin(st.yaw) * TUNE.camera.dist,
      t.y + TUNE.camera.rise,
      t.z - Math.cos(st.yaw) * TUNE.camera.dist
    );
    return { pos: p, target: t };
  }

  /**
   * 进入行走模式。
   * **刻意不动相机**：相机在 300m 外的航拍位上，任何硬设都会「啪」地跳一下，
   * 而只挪 controls.target 而不动 camera.position 同样是一次硬切（那会转朝向）。
   * 正确做法是两者一起补间，所以这一段由 app.js 的 tween 做。
   * update() 第 7 步会把 target 拉向小人，所以哪怕补间被打断也自愈。
   */
  function enter() {
    if (st.active) return true;
    st.active = true;
    keys.clear();
    st.vx = st.vz = 0;
    // 行走模式禁平移：右键拖动 / 双指平移会改 controls.target，
    // 而第 7 步的跟随也在写同一个 target —— 两个都在写就是来回拔河，画面抖。
    // 平移在跟随视角下本来也没有意义；禁掉之后双指手势自动只剩捏合缩放。
    controls.enablePan = false;
    // 阴影贴图是全场一次烘的，不重烘的话小人的影子会站在出生地不动。
    renderer.shadowMap.needsUpdate = true;
    figure.setVisible(true);
    onModeChange && onModeChange(true);
    return true;
  }

  function exit() {
    if (!st.active) return false;
    st.active = false;
    keys.clear();
    st.onStair = false; st.stairId = null;
    st.vx = st.vz = 0;
    st.speed = 0;
    st.stickX = 0; st.stickY = 0; st.stickRun = false;   // 摇杆也归零，退出行走不能还在走
    followOn = true;                 // 补间若还在跑，把跟随权还给 player
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    controls.enablePan = true;
    figure.setVisible(false);
    onModeChange && onModeChange(false);
    return true;
  }

  const toggle = () => (st.active ? exit() : enter());

  function update(dt, nowMs) {
    st.time += dt;
    if (!st.active) {
      // 不在行走模式时也把 pose 写成「站定」，切回来时不会出现一帧 T-pose。
      poseFigure(pose, { moving: false, phase: st.phase, time: st.time, breathPhase: st.breath });
      figure.group.position.set(st.x, st.groundY, st.z);
      figure.group.rotation.y = st.yaw;
      figure.write(pose);
      return;
    }

    /* ---- 1. 输入 → 期望方向（相机空间） ---- */
    camBasis();
    _wish.set(0, 0, 0);
    /* 摇杆优先于键盘（触屏设备没键盘，两者物理上不会同时用）。
     * 摇杆是模拟量：方向 = stick 向量在相机基上的投影，幅值直接进 wishMag 调速；
     * 键盘是开关量：方向归一、幅值恒 1。 */
    let wishMag = 0;
    if (Math.abs(st.stickX) > 1e-4 || Math.abs(st.stickY) > 1e-4) {
      _wish.addScaledVector(_fwd, st.stickY).addScaledVector(_right, st.stickX);
      wishMag = Math.min(1, _wish.length());
      if (_wish.lengthSq() > 1e-8) _wish.multiplyScalar(1 / _wish.length());
    } else {
      if (keys.has('w') || keys.has('arrowup')) _wish.add(_fwd);
      if (keys.has('s') || keys.has('arrowdown')) _wish.sub(_fwd);
      if (keys.has('d') || keys.has('arrowright')) _wish.add(_right);
      if (keys.has('a') || keys.has('arrowleft')) _wish.sub(_right);
      const l = _wish.length();
      if (l > 1e-6) { _wish.multiplyScalar(1 / l); wishMag = 1; }
    }

    /* ---- 1b. 阶梯：禁区推出让位（第四批）----
     * ⚠⚠ **必须让位，否则人会被幕墙从阶梯上横向推出去**：
     *   幕墙 `Curtain_*` 是逐段小盒子（每片 ≤2.6×2.5m），而阶梯上半段人的脚底
     *   在 16~23m、幕墙盒顶约 23m ⇒ `topY ≤ feetY + stepUp` **不成立** ⇒ 每一帧都被推。
     *   阶梯自带 footprint 边界与横向夹紧，不需要幕墙来挡。 */
    const hitStair = walkable.stairAt(st.x, st.z);
    st.onStair = hitStair.on;
    st.stairId = hitStair.on ? walkable.stairs.ids[hitStair.stair] : null;
    st.stairStep = hitStair.step;
    st.stairRegion = hitStair.region;

    /* 触屏的跑 = 摇杆推到外圈；桌面 = Shift。 */
    const run = keys.has('shift') || st.stickRun;
    const vmax = (run ? TUNE.walk.speedRun : TUNE.walk.speedWalk) * wishMag;

    /* ---- 2. 加速 / 刹车 ---- */
    // 用 1-exp(-k·dt) 而不是 v += a·dt：前者与帧率无关，
    // 后者在 5 秒一帧的软件光栅下会一步冲过头。
    const kv = 1 - Math.exp(-TUNE.walk.accel * dt);
    st.vx += (_wish.x * vmax - st.vx) * kv;
    st.vz += (_wish.z * vmax - st.vz) * kv;
    if (wishMag < 1e-4 && st.speed < 0.02) { st.vx = 0; st.vz = 0; }

    /* ---- 3. 位移 + 禁区推出 ---- */
    let nx = st.x + st.vx * dt;
    let nz = st.z + st.vz * dt;
    const g0 = walkable.sample(st.x, st.z) ?? st.groundY;
    const skipPush = st.onStair;
    const hit = skipPush ? null : walkable.push(nx, nz, g0);
    st.blocked = 0;
    if (hit) {
      st.blocked = hit.hits;
      nx += hit.x; nz += hit.z;
      // 贴墙时把速度里朝墙的那一分吃掉，人会沿墙滑而不是弹开。
      const p2 = walkable.push(nx, nz, g0);
      if (p2) { nx += p2.x; nz += p2.z; st.blocked += p2.hits; }
    }
    const movedX = nx - st.x, movedZ = nz - st.z;
    st.x = nx; st.z = nz;

    /* ---- 4. 站到地面上 ---- */
    const g = walkable.sample(st.x, st.z);
    if (g !== null) {
      // 限高是**双向**的：上坡超过 stepUp 当墙（城墙 6m 挡人、路缘 10cm 迈过），
      // 下落差超过 maxDrop 也当墙（垛口/城墙道不会把人甩到街面上）。
      // 只拦上坡不拦下坡的话，人会走着走着从 6m 高的墙道上「掉」到街面 ——
      // 那不是走路，那是传送。
      // ⚠ 阶梯上这一条**恰好**是「一阶一阶上去」的全部机制：踢面 0.17m ≪ stepUp 0.55，
      //   所以每一级都放行；而**走出阶梯 footprint** 时脚下是街面（高差 9m）≫ maxDrop 1.6
      //   ⇒ 自动被拦住 —— 这就是「走不下阶梯侧面」。
      if (g - st.groundY > TUNE.walk.stepUp || st.groundY - g > TUNE.walk.maxDrop) {
        st.x -= movedX; st.z -= movedZ;
      } else st.groundY = g;
    } else {
      st.x -= movedX; st.z -= movedZ;          // 走出可行走范围：贴边停住
    }

    /* ---- 4b. 横向夹紧：阶梯自己的带 vs 墙道走廊带 ----
     * 排在落地之后、姿态之前：落地已经把 `groundY` 定到阶梯/墙顶，夹紧只管横向。
     *
     * ⚠⚠ 两套带**互斥**是硬要求，不是保险：
     *   阶梯的 flight 在 across 2.25~3.25，而走廊带是 [0.85, 1.23] ——
     *   人在阶梯上时若夹一次走廊，就被横着拽 1.0m 进护墙带里。
     *   反过来，顶部那几条横向带（平台 / 门槛石 / 豁口台面 / 交接带）延伸到
     *   across 1.23 = 走廊带内沿，所以**交接那一帧位移恰好是 0**。
     *   阶梯的横向夹紧排在前面：它只管 flight，交接带不管，人才能横着走过豁口。 */
    st.corridorPushM = (st.onStair && TUNE.stair.bypassCorridor) ? 0 : clampWallCorridor();
    clampStairLateral();

    const d = Math.hypot(movedX, movedZ);
    st.dist += d;
    st.phase += d / G.strideM;                 // 相位只从路程来
    st.speed = dt > 0 ? d / dt : 0;
    /* ---- 5. 转身：只朝移动方向转，站着不动时相机转视角不会把人带着转 ---- */
    if (d > 1e-4) {
      const want = Math.atan2(movedX, movedZ);
      st.yaw += shortestAngle(st.yaw, want) * (1 - Math.exp(-TUNE.walk.turnLag * dt));
    }

    /* ---- 6. 姿态 + 位置 ---- */
    poseFigure(pose, { moving: st.speed > 0.05, phase: st.phase, time: st.time, breathPhase: st.breath });
    figure.group.position.set(st.x, st.groundY, st.z);
    figure.group.rotation.y = st.yaw;
    figure.write(pose);

    /* ---- 7 + 8. 相机跟随与阴影节流 ---- */
    followCamera(dt);
  }

  /**
   * 墙道横向走廊夹紧（`TUNE.corridor`，见那里的「为什么必须有它」）。
   *
   * **只修正横向分量**：`u = dot(p.xz − c.xz, inN)`，切向 `along` 一个字节都不动
   * ⇒ 人是**沿墙滑**到铺装带里，不是被卡住或弹开。
   *
   * ⚠ 夹完之后**必须重新取一次地面**：横向挪动最多 1.3m，
   *   虽然实测那一段都是墙顶台面（不动 `groundY` 也对），但重新取一次才与
   *   「位置和高程场永远一致」这条不变量对齐，将来改分带也不会悄悄错。
   *
   * @returns {number} 本帧横向被修正的米数（0 = 没夹）
   */
  function clampWallCorridor() {
    st.corridorWhy = 'in-band';
    if (!st.corridorClamp) { st.corridorWhy = 'off'; return 0; }   // P11 负向对照：关掉它
    if (!CL.n) { st.corridorWhy = 'no-centerline'; return 0; }
    if (st.groundY < TUNE.corridor.yMin) { st.corridorWhy = 'yMin'; return 0; }   // 不在墙道上（街面 ~14m）
    const c = nearestCenterline(st.x, st.z);
    if (!c) { st.corridorWhy = 'no-centerline'; return 0; }
    if (Math.abs(c.along) > TUNE.corridor.maxAlongM) { st.corridorWhy = 'along'; return 0; }
    if (Math.abs(c.u) > TUNE.corridor.maxAcrossM) { st.corridorWhy = 'across'; return 0; }   // 离墙太远：绝不碰
    const lo = TUNE.corridor.from - TUNE.corridor.wallHalf;
    const hi = TUNE.corridor.to - TUNE.corridor.wallHalf;
    const cu = c.u < lo ? lo : (c.u > hi ? hi : c.u);
    if (Math.abs(cu - c.u) < 1e-9) return 0;
    st.x += c.nx * (cu - c.u);
    st.z += c.nz * (cu - c.u);
    const g2 = walkable.sample(st.x, st.z);
    if (g2 !== null) {
      /* ⚠⚠ 这里**不能**用 `stepUp` / `maxDrop` 当界（踩过：5/276 次采样因此把夹紧撤回）。
       *   那 5 次的 Δ 是 0.59~0.76m —— 都在 maxDrop 1.6 以内，也就是说**玩家真能走进
       *   那个坑**，而坑底正好在垛口/护墙石带里。此时「不许跨台阶」和「必须关在走廊里」
       *   直接冲突，夹紧输了，人就站在石头里。
       *   探针的横向场剖面给了依据：走廊带 across [0.85, 1.23] 在 22 个采样点上
       *   是 **+0.01~+0.04m**（= 墙顶，唯一实心的一段），两侧一路掉到 −9m。
       *   ⇒ 夹过去就是踩上真正的墙顶，采用它是**变好**不是变坏。
       *   只留一道 2m 的保险：万一哪天走廊带被改到台面之外，别把人瞬移上房顶。 */
      if (Math.abs(g2 - st.groundY) > 2.0) {
        st.x -= c.nx * (cu - c.u);                  // 差得离谱（>2m）：撤回
        st.z -= c.nz * (cu - c.u);
        st.corridorWhy = `jump(Δ${(g2 - st.groundY).toFixed(2)})`;
        return 0;
      }
      st.groundY = g2;
    }
    st.corridorWhy = 'clamped';
    return Math.abs(cu - c.u);
  }

  /**
   * 相机跟随 + 阴影节流（原 update 的第 7、8 步，**逻辑逐字未改**）。
   *
   * 抽成独立函数只有一个理由：探针要能在**不跑完一整帧**的情况下单独调它
   * （`P.teleport()` 之后 `P.update(0.016)` 一次，跟随就得跟着跑）。
   */
  function followCamera(dt) {
    /* ---- 7. 相机跟随：整体平移，保留用户转出来的视角 ---- */
    if (followOn) {
      _want.set(st.x, st.groundY + TUNE.camera.lookY, st.z);
      _delta.copy(_want).sub(controls.target).multiplyScalar(1 - Math.exp(-TUNE.camera.followK * dt));
      controls.target.add(_delta);
      camera.position.add(_delta);
    }

    /* 缩放范围**只在行走模式收窄**，而且是「相机已经在范围内了才收」。
     * 反过来做会腰斩进场补间：航拍机位离目标 300m，若先把 maxDistance 设成 16，
     * OrbitControls 的下一次 update() 立刻把相机拽到 16m，补间的中段就没了。
     * 改成自愈式：一旦补间把距离带进 [minDist, maxDist]，夹取随即生效且与当前距离自洽。 */
    if (controls.maxDistance !== TUNE.camera.maxDist) {
      const dc = camera.position.distanceTo(controls.target);
      if (dc >= TUNE.camera.minDist && dc <= TUNE.camera.maxDist) {
        controls.minDistance = TUNE.camera.minDist;
        controls.maxDistance = TUNE.camera.maxDist;
      }
    }

    /* ---- 8. 阴影节流 ---- */
    st.rebakeClock += dt;
    if (st.rebakeClock >= TUNE.shadow.rebakeSec) {
      st.rebakeClock = 0;
      renderer.shadowMap.needsUpdate = true;
    }
  }

  /**
   * 把小人放到指定位置并**把相机一并归位**。
   * 相机必须一起动：只挪小人而不挪相机，镜头会留在原地对着空街 ——
   * 截图工具就拍不到「这个人站在那儿」这件事。
   */
  function teleport(x, z, yaw) {
    st.x = x; st.z = z;
    if (yaw !== undefined) st.yaw = yaw;
    st.onStair = false; st.stairId = null; st.stairPushM = 0;
    resolveSpawn();
    const cp = cameraPose();
    controls.target.copy(cp.target);
    camera.position.copy(cp.pos);
    controls.update();
    st.vx = st.vz = 0;
    st.phase = 0;                       // 换地方了，相位从头开始，不带着旧节奏
    renderer.shadowMap.needsUpdate = true;
  }

  function stats() {
    const dg = figure.poseDiag();
    return {
      active: st.active,
      pos: [+st.x.toFixed(3), +st.groundY.toFixed(3), +st.z.toFixed(3)],
      speedMps: +st.speed.toFixed(3),
      yaw: +st.yaw.toFixed(3),
      distM: +st.dist.toFixed(2),
      /** 步态相位。判据：`phase / distM` 必须恒等于 `1 / strideM` ——
       *  一旦不等，说明有人在**原地刷相位**，脚就会在地面上滑。 */
      phase: +st.phase.toFixed(3),
      strideM: G.strideM,
      blockedHits: st.blocked,
      groundY: +st.groundY.toFixed(3),
      keys: [...keys].sort(),
      stick: [+st.stickX.toFixed(3), +st.stickY.toFixed(3), st.stickRun],
      camDist: +camera.position.distanceTo(controls.target).toFixed(2),
      field: walkable.field,
      blockers: walkable.blockers.length,
      parts: figure.flat.map((m) => m.name),
      gaitDiag: {
        reachRatio: +dg.reachRatio.toFixed(4),
        kneeBendDeg: [+dg.kneeMinDeg.toFixed(1), +dg.kneeMaxDeg.toFixed(1)],
        soleMinY: +dg.soleMinY.toFixed(4),
      },
      /* 城墙阶梯（第四批，探针 S4/S8/S9/S10/S11 直接读这几项）。 */
      stair: {
        analytic: st.stairAnalytic,
        on: st.onStair,
        id: st.stairId,
        step: st.stairStep,
        region: st.stairRegion,
        pushM: +st.stairPushM.toFixed(4),
        count: walkable.stairs ? walkable.stairs.n : 0,
      },
      /* 墙道走廊（探针 S12 直接读这几个，不用在页内重算公式） */
      corridor: {
        on: st.corridorClamp,
        pushM: +st.corridorPushM.toFixed(4),
        why: st.corridorWhy,
        across: st.groundY >= TUNE.corridor.yMin ? +wallAcross(st.x, st.z).toFixed(4) : null,
        band: [TUNE.corridor.from, TUNE.corridor.to],
        radius: TUNE.walk.radius,
      },
      materials: Object.entries(figure.mats).map(([k, m]) => ({
        role: k, name: m.name,
        color: [+m.color.r.toFixed(3), +m.color.g.toFixed(3), +m.color.b.toFixed(3)],
      })),
    };
  }

  return {
    figure, group: figure.group, enter, exit, toggle, update, teleport, stats,
    cameraPose, suspendFollow,
    /** 触屏摇杆输入（joystick.js 的 onStick 直连这里）。松手必须回 (0,0,false)。 */
    setStick: (x, y, run) => { st.stickX = +x || 0; st.stickY = +y || 0; st.stickRun = !!run; },
    /** 墙道横向走廊夹紧的开关（S12 负向对照在页内把它关掉再量一遍）。 */
    setCorridorClamp: (on) => { st.corridorClamp = !!on; if (!on) st.corridorPushM = 0; },
    /** 阶梯解析面开关（S11 负向对照）。关掉之后 `sample()` 退回纯高程场。 */
    setStairAnalytic: (on) => { walkable.setStairAnalytic(on); st.stairAnalytic = !!on; },
    /** 阶梯横向夹紧开关。 */
    setStairLateral: (on) => { TUNE.stair.lateralClamp = !!on; },
    get active() { return st.active; },
    get pos() { return { x: st.x, y: st.groundY, z: st.z }; },
    walkable,
  };
}
