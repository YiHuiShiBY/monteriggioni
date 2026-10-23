/**
 * Monteriggioni · 城墙步道（设计规格 WALLWALK-CROWD.md 第 2 节）
 * ---------------------------------------------------------------------------
 * 解决的问题：环墙顶面现在只有一条 436 段的连续压顶石（`Coping_*`），**全程没有雉堞**，
 * 内侧直接 9.5m 落到地面 —— 从任何角度看过去都读不出「这是一条能走的墙道」。
 * 这里在压顶石之上程序化生成三样东西，全程不改 GLB：
 *
 *   1. 铺装步道面  `flag` 配方，一条绕城的可行走带
 *   2. 外侧雉堞    `Limestone | cut pale blocks`，垛口 / 空档有节奏
 *   3. 内侧矮护墙  同上，带压顶石盖
 *
 * ── 中心线怎么来的 ─────────────────────────────────────────────────────────
 * **只从 `Coping_*` 网格自身读**，不重新实现 `scripts/fortifications.py` 的 `boundary()`
 * （那是 Blender 侧函数，重新实现必然和实际资产对不上）。
 * 每片压顶石用 `computeBoundingBox()` 取**顶面中心**（不是几何中心），再用节点的世界
 * 旋转把局部 X 轴（长轴，≈1.30m）解成沿墙切向、局部 Z 轴（2.18m 那一轴）解成横墙方向；
 * 绕质心算极角排序得有序中心线。
 *
 * ── 实测出来的几条硬事实（`node tests/probe-wall.mjs --glb` 可复现）───────────
 *   · `Coping_*` 恰好 436 片，每片 长度(1.17~1.38, 中位 1.303) × 0.26 × 2.18
 *   · 相邻极角间隙中位 0.0140 rad → 弧长 **1.24m**，和 570/436≈1.3 对得上
 *   · 最大的两个极角间隙各 9.73m，正好落在 ±90°（three 坐标 (0, ∓89.3)）= 两座城门
 *   · 压顶石中心**就是墙身中线**（Curtain 横向厚实测 2.03–2.05m，中心 ±1.02m），
 *     压顶石 2.18m 比墙身宽，两侧各挑出约 6.5cm
 *   · 墙顶标高 20.82 ~ 23.52m（随地形与 `9.5+.55sin2t+.25sin7t` 起伏）
 *
 * ⚠ 设计规格第 1 节写的「城墙整体厚 4.1m，压顶只盖外侧 2.18m，内侧 1.9m 是裸墙顶」
 *   与 GLB 不符：墙身就是 2.05m 厚，压顶石**盖满整个墙顶**。所以可用横向空间只有 2.18m，
 *   下面三段的分带是按这个实测值算的，不是按规格表算的。
 *
 * ── 最终参数 ───────────────────────────────────────────────────────────────
 *   横向分带（沿「自外墙面向内」量，单位 m；压顶石顶面全长 2.18，从 -0.07 起算）：
 *
 *      外墙面 0.00
 *              ├─ 0.07  压顶石外挑
 *              ├─[ -0.07 → 0.46 ]  外侧雉堞      厚 0.53  高 1.50  埋入 0.08
 *              ├─[  0.46 → 1.66 ]  铺装步道      宽 1.20
 *              ├─[  1.66 → 2.11 ]  内侧矮护墙    厚 0.45  高 0.95  埋入 0.10
 *      内墙面 2.05 ── 压顶石内挑到 2.11
 *
 *      合计 0.53 + 1.20 + 0.45 = 2.18 ✓ 严丝合缝铺满压顶石顶面
 *
 *   · 步道宽 1.20m（规格写 1.55m）：2.18m 的墙顶上，0.53 垛口 + 0.45 护墙只剩 1.20。
 *     要 1.55 就必须砍掉垛口或护墙，这里选了保住「外垛口 / 中可行走 / 内矮墙」三段关系。
 *   · 雉堞周期 1.70m = 垛口 0.95 + 空档 0.75。全环按弧长算是 563.62/1.70 ≈ 331 个，
 *     扣掉 13 座塔楼占住的一段和两座城门的避让区，**实测生成 253 个**（门楼处另有 6 个被判避让）。
 *   · 步道段长 0.75m，对应 599 段（规格按整圈 570m 写的是 760 段；差额 = 塔楼段 + 城门断口）。
 *   · 门楼避让：中心线上**最大的两个极角间隙**（各 9.73m，实测落在 three 坐标 x≈0 的 ±90°）
 *     即两座城门，其 4.5m 半径内不生成雉堞；步道与护墙照常连续通过。
 *   · 13 座塔楼实体占住墙顶（塔身 4.9×4.8、外挑 0.45m，横向比墙还宽），塔基范围内三样构件
 *     全部不生成（实测 70 个中心线点落在 62 个塔楼包围盒里），否则步道会埋进实心石头里，白费面数。
 *     墙顶因此被切成 **14 段**可走段（实测）。
 *
 * ── 铺装面为什么是「高出 1.8cm / 埋入 4.2cm」而不是「低 4cm」─────────────────
 *   规格要求铺装面比压顶石低 3–5cm。实测压顶石盖满整个墙顶，所以「低 4cm」等于把铺装
 *   整块埋进石头里 —— **完全看不见**。这里按真实铺装做法取：石板**底面埋进压顶石 4.2cm**
 *   （共面必然 z-fighting，埋入就天然不共面），**顶面高出 1.8cm**，侧立面露出来读作铺装层。
 *
 * ── 材质 ─────────────────────────────────────────────────────────────────
 *   不新建 MeshStandardMaterial。三样构件**直接复用 GLB 里已经被 `materials.js`
 *   的 DISPATCH 注入过三平面投影的材质实例**（同一材质被 436 片压顶石共用，再共享不增加
 *   program 数、不增加 drawcall），所以新构件的贴图 / bump / 环境光强度与全镇完全一致，
 *   不会出现「贴上去的白模」。解析结果（实测）：
 *     步道面   → `Piazza | small warm flagstones | GLB`（flag 配方）
 *     雉堞/护墙 → `Limestone | cut pale blocks | GLB`（stonePale 配方）
 *
 * ── 实测产出（`node tests/probe-wall.mjs`）────────────────────────────────
 *   中心线 436 点 / 中位间距 1.261m / 周长 563.62m · 步道 599 段 · 雉堞 253 个 ·
 *   护墙 599 段 · 新增 13,312 三角面 · 新增 3 个 drawcall（主通道；r160 的
 *   `info.reset()` 在阴影 pass 之后，所以 `renderer.info` 永远量不到阴影通道）
 *
 * ── 塔楼通行口（第二批）────────────────────────────────────────────────────
 * 上一批的结论是：13 座塔楼把墙顶占住，人走到塔前就折返，全环丢了 113.6m。
 * 这一批给每座塔开门洞，让墙道全圈连续。
 *
 * ⚠ **塔楼有四面，真正挡路的是两侧翼，不是内外两面**（`node tests/probe-tower.mjs` 实测）：
 *   墙道沿**切向**穿过塔身，塔的四面里挡路的是两侧的 `Tower_XX_Side`
 *   （1.0m 厚、径向通长 4.6~5.0m、中心沿墙 ±1.78~2.08m ⇒ 外表面 ±2.28~2.58m）。
 *   `InnerLower` / `Outer` 的面法线是**径向**的，开了洞也过不去。
 *   所以每座塔开四面：`Side` 两面（功能性的，人真的从这儿穿过去）
 *   + `Inner` / `Outer` 各一面（镇内 / 城外看得见的塔门）。
 *
 * ⚠ **侧翼的门必须开在外表面**（这条踩过：门开在 1.0m 厚侧翼的**内**表面上，
 *   等于开在石头肚子里 —— 近景图里就是一堵没有门的实墙）。
 *   人顺着墙道走近塔楼，先撞上的是侧翼的**外**表面（沿墙 ±2.28~2.58m 那张脸），
 *   门就得开在那张脸上。塔身沿墙的半宽因此取 `max|侧翼中心| + 半厚`。
 *
 * ⚠ **塔内那段墙道只有 ±1.31m 露在外面**（两片侧翼内表面之间）：
 *   再往外侧翼就把压顶石和铺装一起埋进石头里了。所以「甲板穿过塔楼」在画面上的读法是
 *   —— 铺装一路铺到塔脚、钻进侧翼的门洞、从另一侧的门洞再钻出来，
 *   中间那一小段在石头里（GLB 本来就这么造的，冻结资产改不了）。
 *
 * ⚠ **内墙那一面不能一刀切**（`fortifications.py` 的两段式 + 实测标高）：
 *   `InnerLower` 占 base~base+10，`InnerUpper` 占 base+10~base+h；
 *   `idx%4==2` 的三座塔（T02 / T06 / T10）内立面根本不是墙，是 `archwall` 开敞拱背。
 *   而甲板面实测落在 base+9.07 ~ base+10.48（13 座塔逐座量，见 probe-tower）：
 *   T06(+10.08) / T10(+10.12) 的甲板已经在开敞拱背里，再画一个假门洞就是拿门套
 *   去挡真洞口 —— 这三座塔的内侧一律**不开洞**，让真拱洞当通路。
 *
 * ── 假门洞怎么做（GLB 是冻结资产，不能布尔开挖）────────────────────────────
 *   加法式做法的三件套，全部落在既有 `Mesher` 上、按材质合并进既有 mesh：
 *     ① 暗色凹体：沿面法向**埋进墙里 0.26m** 的体块，只有正面可见（其余五面埋在石头里），
 *        正面高出墙面 1.5cm —— 共面必然 z-fight，只能错开这么点。
 *        材质用 GLB 自带的 `Window deep recess`（baseColor 0.055/0.076/0.064，够暗）。
 *     ② 石门套：挑出墙面 0.30m 的门垛 + 过梁 + 门槛，`Limestone | cut pale blocks`。
 *     ③ 门槛顶压在甲板面**以下** 1cm：门套顶与铺装顶共面的话，人的鞋底会和它 z-fight。
 *   **进深读数全部来自门套**：门垛内侧面与过梁底面是真实面，会自遮挡、会吃太阳影子。
 *   凹体本身是平板 —— 这是冻结资产的必然结果（真挖洞要么布尔要么重砌塔身），
 *   不是偷懒；但它读作门洞，因为四周 0.30m 的石套把「平面」包成了「洞」。
 *
 * ── 甲板穿过塔楼 ──────────────────────────────────────────────────────────
 *   压顶石本身是连续的（`fortifications.py` 只在两座城门处断，城墙在塔位照常生成），
 *   所以塔内的过道地板 = 同一条铺装带直接铺过去：同材质、同标高、同宽 1.20m，
 *   两端天然搭接在墙道铺装上，没有缝也没有高差。
 *   塔内**不生成雉堞**（塔顶自带压顶石当外侧护墙，继续生成会和它抢面）
 *   也**不生成内侧矮护墙**（塔内是 4.6m 深的空腔，护墙会立在半空）。
 *
 * ── 第三批：把塔门从「假门洞」改成「真洞」──────────────────────────────────
 * 上一批的 49 个门洞是**向墙面内推的不透光暗色凹体**：从一侧的门洞看不到另一侧，
 * 因为 GLB 里塔的墙体是实心盒子挡在中间。墙道沿**切向**穿塔，真正挡路的是两片 `Side`
 * （1.0m 厚、径向通长 4.6~5.0m、通高 15.5~20.2m）；内外墙法向沿径向，是通道的两侧。
 * 这一批：**隐藏 GLB 的 26 片侧翼，自己用带洞的版本重建**，洞是**真通透**的。
 *
 * ⚠ **洞的断面取「整个空腔」，不是 1.10m 的门宽**（实测，`node node_tmp_thru.mjs`）：
 *   空腔 = 内墙朝空腔那面到外墙朝空腔那面，径向宽 **2.81~3.24m**（逐塔）。
 *   墙道带只有 1.20m，把 1.10m 的门开在带上会在门洞两侧各留一道 0.9m 以上的
 *   「门垛」，而人从洞里看出去时被近处门垛挡掉大半 —— 看得见的还是石头。
 *   取满空腔之后，侧翼被减去的是一个 2.8~3.2m 宽 × 2.0m 高的**通洞**，
 *   剩下的 0.4~0.9m 径向墙肢在洞的两侧当门边，读作塔身开了一道门洞。
 *
 * ⚠ **每片侧翼拆成 4 块**（原盒体减去洞，洞之外的部分逐项照抄，实测足迹/厚度/高度一致）：
 *   ① 内侧墙肢（通高）  ② 外侧墙肢（通高）
 *   ③ 门槛下的墙身（塔基 → 门槛顶）  ④ 过梁 + 其上墙体（过梁底 → 塔顶）
 *   ③ 的顶面压在**甲板面以下 2cm**：塔内那段地板本来是压顶石顶（与铺装同高），
 *   门槛顶若也取甲板面就与压顶石顶共面 ⇒ z-fighting。压低 2cm 既躲开共面，
 *   又让空腔里多出一层 2cm 的石地板（原先那一带是直落塔基的空洞）。
 *   ④ 的底面 = 过梁底 = 洞的顶棚，必须留。
 *
 * ⚠ **塔内铺装确实埋在石头里，量出来的数字**（`node_tmp_thru.mjs`，逐塔）：
 *   塔内墙（`InnerLower`+`InnerUpper`）朝空腔那面在 u ≈ **-1.72~-1.50**，
 *   墙道中心线在 u ≈ **-1.52~-1.35**，铺装带 u ∈ [中心线-0.64, 中心线+0.56]。
 *   ⇒ 铺装带被内墙吃掉 **0.36~0.61m**（带宽 1.20m 的一半上下），
 *     露在空腔里的只有 **0.59~0.84m**。
 *   处理：把铺装带**在塔内那一段的内沿收到内墙表面外 1cm**（`TUNE.tower.deckClear`），
 *   净宽变成 0.58~0.83m；收束的过渡刻意摊在侧翼那 1.0m 厚度里（|along| 从半宽
 *   收到 半宽−侧翼厚），所以画面上**看不到台阶**，是「走进门洞时地面自然变窄」。
 *   同材质、同标高（顶面仍高出压顶石 2.2cm），所以没有高差也没有断裂。
 *   ⚠ 走线本身动不了（中心线就是压顶石中心，是 552.59m 那条路径）：
 *     走线到内墙表面的净距只有 **0.03~0.28m**，人肩半宽 0.215m，
 *     于是 T00 / T09 两座塔人的左肩会陷进内墙 0.18~0.19m（T03/T04/T11 ≤0.03m）。
 *     这是冻结资产的冲突（塔比墙外挑 0.45m、径向 4.6~5.0m，内墙正好压在走线上），
 *     改它要动路径，超出本轮范围 —— 数字如实报出，见报告。
 *
 * ⚠ **③ 内门洞提对比：只上「门套换更亮一档石材」这一条**。
 *   依据（先量后选）：塔内立面整面在镇子的阴影里（`previews/shots/pass-inner-a-passage.jpg`
 *   实拍），而 `lighting.js` 只有 DirectionalLight + HemisphereLight + 天空 PMREM，
 *   **没有 AO、没有 SSAO**。所以阴影面上能起作用的只有两条：
 *     · 凹部压更深 —— 无 AO 时不产生任何额外压暗（凹体材质 baseColor 已经只有 0.055），
 *       纯粹白做，**否**；
 *     · 门套露出多少「朝天面」—— 竖直的墙面上唯一比墙本身吃光多的就是**水平面**
 *       （过梁顶、滴水线顶），它们吃满天空 IBL + 半球天光。所以把内门的
 *       `reveal 0.30→0.42`、`lintel 0.26→0.34`、门垛 `0.34→0.42`，
 *       再加一条 0.12m 高、外挑比过梁再多 0.12m 的**滴水线**（`TUNE.passage.facade.inner`），
 *       门套就有一条明显更亮的上沿 + 一条更暗的过梁底，明暗成对出现 ⇒ 读作门。
 *   外立面维持原配置（它整面吃太阳，本来就认得出）。
 *
 * ── 第四批：护墙豁口（城墙阶梯 WALLSTAIR.md §1.4）──────────────────────────
 * 内侧矮护墙高 `0.95 − 0.10 = 0.85m`、顶宽只有 0.45m，而人的直径
 * `2 × TUNE.walk.radius = 0.68m` 站不上去 ⇒ 阶梯的接墙段必须**从豁口穿进铺装面**。
 * 豁口只砍护墙与它的压顶石盖，**雉堞与铺装一律不动**。
 *
 * ⚠ 豁口比阶梯的接墙段（平台 1.0m）宽：半宽取 `STAIR.gap.halfWidthM` 0.80 而不是
 *   0.60，理由见 `wallstair.js` 的文件头（护墙逐段生成，0.60 会只跳 1 段、
 *   净开口掉到 0.75m）。宽出来那部分露出的是**压顶石台面**（本来就是能走的甲板），
 *   不是空洞 —— 所以豁口比阶梯宽是安全的。
 *
 * 实现方式就是在塔楼避让那行旁边加一条并列的 `if (inAnyGap(...)) continue;`：
 * 护墙本来就是**逐段**生成的（每段 `step = 0.75m`），跳过整段之后两侧留下的是
 * 干净的竖切口，与塔楼避让段的收口做法完全一致 —— 不会留悬空的半个盒子。
 *
 * ⚠ **豁口的匹配用世界 xz 距离，不用弧长**：中心线的起点在环缝（城门口），
 *   而生成循环的 `globalArc` 从环缝开始算，两者原点差一截；用 xz 距离就没有原点问题。
 *
 * 什么时候用：`buildWallWalk({ town })` 不传 `gaps` 时，豁口由本函数内部的
 * `planStairs()` 落位表自动给出（6 座阶梯 ⇒ 6 个豁口）。传 `gaps` 则覆盖它。
 *
 * three r160 纪律：不引入任何新依赖，不使用 r162+ / r163+ 的 API。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { normName } from './materials.js';
import { planStairs, assertBandMatches, makeArcSampler, TUNE as STAIR } from './wallstair.js';

/* ============================== TUNE ============================== */

export const TUNE = {
  /** 压顶石顶面净宽（GLB 实测，每片都精确等于 2.18）。 */
  copingWidth: 2.18,
  /** 墙身横向厚度实测 2.03–2.05m；压顶石中心落在墙身中线上。 */
  wallHalf: 1.02,

  /** 外侧雉堞：垛口 0.95(沿墙) × 0.53(横向) × 1.50(高)，空档 0.75，周期 1.70。 */
  merlon: {
    from: -0.07, to: 0.46,          // 相对外墙面的横向区间
    length: 0.95, depth: 0.53, height: 1.50,
    gap: 0.75, period: 1.70,
    sink: 0.08,                     // 垛口底面埋进压顶石的深度
    skipBottom: true,               // 底面永远看不见
  },

  /** 铺装步道面：宽 1.20m，占满垛口与护墙之间的全部空档。 */
  walkway: {
    from: 0.46, to: 1.66,
    topProud: 0.022,                // 顶面高出压顶石顶面 1.8~2.2cm（否则整块埋进石头）
    bedDepth: 0.045,                // 板底埋进压顶石 4.5cm —— 这一条替代「低 4cm」，共面会 z-fight
    segLen: 0.75,                   // 目标段长；整圈 570/0.75 ≈ 760 段（规格值），实测 599 段
  },

  /** 内侧矮护墙：0.45 厚 × 0.95 高，顶带 0.52 × 0.12 压顶石（两侧各挑出 3.5cm）。 */
  parapet: {
    from: 1.66, to: 2.11,
    height: 0.95, sink: 0.10,
    capOverhang: 0.035, capThick: 0.12,
  },

  /** 门楼避让：中心线上最大的两个极角间隙即两座城门，此半径内不生成雉堞。 */
  gate: { halfClear: 4.5, gapPick: 2, gapMinRatio: 3.0 },

  /**
   * 塔楼实体占住墙顶，范围内不生成雉堞 / 内侧矮护墙（但铺装一路铺过去）。
   * `test` 判包围盒（沿用上一批的判据，雉堞断口的位置因此和改前完全一致）；
   * `frame` 逐件取塔身坐标系，用来定位四面门洞。
   * ⚠ GLTFLoader 的 `sanitizeNodeName` 会把点删掉（`Tower_00_Side.001` → `Tower_00_Side001`），
   *   所以逐件解析只认字母段，别写 `Side\.\d`。
   * `side` 专门用来**核对**要隐藏的侧翼节点：同样不能锚结尾（第二片会被改名成
   *   `Tower_00_Side001`）。真正隐藏的是 `buildFlanks()` 里逐片重建的那批网格引用，
   *   `hideTowerFlanks()` 用这条正则交叉核对「扫出来的 == 重建的」，数量对不上就抛 ——
   *   少重建一片却把它藏了，塔身上就多一个洞。
   */
  tower: {
    test: /^Tower_\d\d_(Side|Outer|InnerLower|InnerUpper)/,
    frame: /^Tower_(\d\d)_([A-Za-z]+)/,
    side: /^Tower_\d\d_Side/,
    margin: 0.25,
    /** 塔内铺装内沿收到内墙表面之外这么多（1cm：留一点缝，贴死会 z-fight）。 */
    deckClear: 0.010,
  },

  /**
   * 塔楼通行口。见文件头「假门洞怎么做」「第三批」两节。
   * `width` / `height` 是**净宽 / 净高**；侧翼那一面的净宽不取 `width`，
   * 取整个空腔（实测 2.81~3.24m），理由见文件头。
   */
  passage: {
    width: 1.10,         // 净宽（内外立面的假门洞用）
    height: 2.00,        // 净高（甲板面以上）—— 侧翼真洞的净高也用它
    reveal: 0.30,        // 门套自墙面挑出的深度 = 假门洞的全部进深
    jamb: 0.34,          // 门垛宽（沿门宽方向）
    lintel: 0.26,        // 过梁高
    sill: 0.12,          // 门槛高（在甲板面以下）
    sillDrop: 0.01,      // 门槛顶再压低 1cm：门套顶与铺装顶共面的话人的鞋底会 z-fight
    backSink: 0.02,      // 门套背面沉进墙面 2cm，避免背面留缝
    recessDepth: 0.26,   // 暗色凹体沿面法向埋进墙里的深度
    recessProud: 0.015,  // 暗色凹体正面高出墙面 1.5cm（共面必然 z-fight）
    /** 塔身沿墙半宽（= 侧翼外表面，实测 2.28~2.58）要够大才值得在侧翼开门。 */
    minFlankHalf: 1.60,

    /** 侧翼真洞：门槛面 = 甲板面，门槛顶再压低这么多（躲开压顶石顶面，见文件头）。 */
    tunnel: { sillDrop: 0.020 },

    /**
     * 内外立面假门洞的两套配置（③）。
     * `inner` 整面在阴影里且场景无 AO，所以只加厚「朝天面」：门套挑得更深、
     * 过梁更高更厚，再加一条外挑的滴水线。外立面吃太阳，维持上一批的数值。
     */
    facade: {
      inner: { reveal: 0.42, jamb: 0.42, lintel: 0.34, dripH: 0.12, dripProud: 0.12 },
      outer: { reveal: 0.30, jamb: 0.34, lintel: 0.26, dripH: 0.00, dripProud: 0.00 },
    },
  },

  /** 材质：从 GLB 已注入三平面的实例里按 DISPATCH 的同一批正则挑。 */
  material: {
    stone: /Limestone \| cut pale blocks/,
    paving: /Piazza \|/,
    // 侧翼重建件必须用塔墙本来的料（`fortifications.py` 里 Side 用的是 MATS['stone']），
    // 用 `stonePale` 会让塔的侧翼比四面墙白一档 —— 换个材质就把塔的配色改了。
    flank: /Limestone \| weathered grey ochre/,
    // 归一化后的实名是 `Window deep recess`（**没有**那根竖线，别照抄别的条目的写法）。
    dark: /^Window deep recess/,
  },
};

/* ============================ 中心线提取 ============================ */

const RE_COPING = /^Coping_\d+$/;
const _v3 = new THREE.Vector3();

/**
 * 从 `Coping_*` 网格提取有序中心线。
 * @returns {{points:Array, perimeter:number, centroid:THREE.Vector2}}
 */
function extractCenterline(town) {
  const raw = [];
  town.traverse((o) => {
    if (!o.isMesh || !RE_COPING.test(o.name || '')) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    // 顶面中心：取局部包围盒的上表面中心，再过世界矩阵。
    // 压顶石是居中的长方体，bb.min/max 关于 0 对称，所以取 min/max 平均即为几何中心。
    const top = new THREE.Vector3(
      (bb.min.x + bb.max.x) * 0.5, bb.max.y, (bb.min.z + bb.max.z) * 0.5
    ).applyMatrix4(o.matrixWorld);
    // 局部 X = 长轴(≈1.30m 沿墙)；局部 Z = 2.18m 那一轴，横跨墙顶。
    const tangent = new THREE.Vector3(1, 0, 0).transformDirection(o.matrixWorld);
    const across = new THREE.Vector3(0, 0, 1).transformDirection(o.matrixWorld);
    raw.push({ name: o.name, top, tangent, across });
  });

  // 质心：整圈压顶石的算术平均。城墙是闭合凸形 Oval，质心就在镇中心附近。
  const c = new THREE.Vector2(0, 0);
  for (const r of raw) c.add(new THREE.Vector2(r.top.x, r.top.z));
  c.multiplyScalar(1 / raw.length);

  // 定向：把 across 统一成「指向城外」的外法线 outN。
  for (const r of raw) {
    r.out = new THREE.Vector3(r.across.x, 0, r.across.z).normalize();
    if (r.out.x * (r.top.x - c.x) + r.out.z * (r.top.z - c.y) < 0) r.out.negate();
    r.inN = r.out.clone().negate();
  }

  // 绕质心按极角排序 → 沿墙一周的有序中心线。
  raw.sort((a, b) => Math.atan2(a.top.z - c.y, a.top.x - c.x) - Math.atan2(b.top.z - c.y, b.top.x - c.x));

  // 切向定向：与相邻点连线同向。用每片压顶石自己的长轴（不是跨门的弦），
  // 这样两座城门断口处的朝向依然正确。
  const n = raw.length;
  const chord = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = raw[(i - 1 + n) % n].top, b = raw[(i + 1) % n].top;
    chord.subVectors(b, a).setY(0).normalize();
    if (chord.dot(raw[i].tangent) < 0) raw[i].tangent.negate();
    raw[i].tangent.setY(0).normalize();
  }

  // 弧长
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = raw[i].top, b = raw[(i + 1) % n].top;
    perimeter += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return { points: raw, perimeter, centroid: c };
}

/** 相邻中心线点的间距统计 —— 判据：应 ≈ 570/436 ≈ 1.3m。 */
function spacingStats(points) {
  const d = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i].top, b = points[(i + 1) % points.length].top;
    d.push(Math.hypot(b.x - a.x, b.z - a.z));
  }
  const s = d.slice().sort((x, y) => x - y);
  const sum = d.reduce((a, b) => a + b, 0);
  return {
    n: d.length, min: +s[0].toFixed(3),
    p50: +s[s.length >> 1].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
    mean: +(sum / d.length).toFixed(3),
  };
}

/**
 * 城门 = 中心线上最大的两个极角间隙。
 * 实测这两个间隙各 9.73m、落在 ±90°，正好是两座城门 —— 用数据判定，不写死坐标。
 */
function findGates(points, centroid) {
  const n = points.length;
  const ang = points.map((p) => Math.atan2(p.top.z - centroid.y, p.top.x - centroid.x));
  const gaps = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let g = ang[j] - ang[i];
    if (i === n - 1) g += Math.PI * 2;
    gaps.push({ i, g });
  }
  const sorted = gaps.slice().sort((a, b) => a.g - b.g);
  const median = sorted[sorted.length >> 1].g;
  const picked = gaps
    .filter((e) => e.g > median * TUNE.gate.gapMinRatio)
    .sort((a, b) => b.g - a.g)
    .slice(0, TUNE.gate.gapPick);
  // 间隙两侧那两片压顶石的中点 = 城门轴线。实测两座城门都落在 three 坐标 x≈0。
  // （不能只取「极角中点最近的中心线点」——那里根本没有点，会偏到缺口边上 4.5m 处。）
  const centres = picked.map((e) => {
    const a = points[e.i], b = points[(e.i + 1) % n];
    return {
      x: +((a.top.x + b.top.x) / 2).toFixed(2),
      z: +((a.top.z + b.top.z) / 2).toFixed(2),
      arcGapM: +e.g.toFixed(4),
    };
  });
  return { centres, gapArc: picked.map((e) => +e.g.toFixed(4)) };
}

/** 13 座塔楼实体的水平包围盒（xz 投影），用来标记「墙顶被塔占住」的区段。 */
function collectTowerBlocks(town) {
  const boxes = [];
  const b = new THREE.Box3();
  town.traverse((o) => {
    if (!o.isMesh || !TUNE.tower.test.test(o.name || '')) return;
    b.setFromObject(o);
    if (!isFinite(b.min.x)) return;
    boxes.push({ minX: b.min.x - TUNE.tower.margin, maxX: b.max.x + TUNE.tower.margin, minZ: b.min.z - TUNE.tower.margin, maxZ: b.max.z + TUNE.tower.margin });
  });
  return boxes;
}

function inTower(boxes, x, z) {
  for (const b of boxes) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
  return false;
}

/* ========================== 塔楼坐标系与门洞面 ========================== */

const _bx = new THREE.Vector3();

/**
 * 逐座塔取出**定向**塔身坐标系，并定出四面墙上「甲板面所在」的那一段。
 *
 * 为什么不直接用 `collectTowerBlocks()` 的包围盒：门洞要贴着塔的**真实面**开，
 * 而包围盒是旋转长方体的轴对齐外接框，沿墙方向最多虚出 1m；用它开门洞会开在空气里。
 * 塔的局部坐标（GLB 已把 Blender Z-up→Y-up 烘进节点，见 probe-wall.mjs）：
 *   局部 X = 沿墙切向、局部 Z = 外法线、局部 Y = 竖直。
 * 所以每件只要 `matrixWorld` 的两条基向量 + 包围盒中心，就能量出它在塔坐标系里的
 * （沿墙 along, 径向 u, 竖直 y）。
 *
 * 实测（`node tests/probe-tower.mjs`，13 座塔逐座）：
 *   · 侧翼 Side：厚 1.0、径向通长 4.6~5.0、沿墙 ±1.78~2.07 → **挡路的是这两片**
 *   · 内墙 Inner：0.8 厚、沿墙居中、径向 -1.93~-2.12；Outer：1.0 厚、径向 +1.80~+2.02
 *   · 甲板面落在 base+9.07 ~ base+10.48；T06(+10.08) / T10(+10.12) 已在开敞拱背内
 * @returns {Array} 每座塔一个描述；`faces` 是可以直接开洞的面（法向 n 已指向观看者）
 */
function collectTowerFrames(town, points) {
  const raw = new Map();
  const g = new THREE.Box3();

  town.traverse((o) => {
    if (!o.isMesh) return;
    const m = TUNE.tower.frame.exec(o.name || '');
    if (!m) return;
    const id = m[1], part = m[2];
    if (!raw.has(id)) raw.set(id, { id, parts: new Map() });
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    _bx.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
      .applyMatrix4(o.matrixWorld);
    // 半长：局部包围盒在三个局部轴上的半长（节点只有绕 Y 的旋转，缩放为 1）
    const half = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map((v) => v / 2);
    const ex = new THREE.Vector3(1, 0, 0).transformDirection(o.matrixWorld);
    const ez = new THREE.Vector3(0, 0, 1).transformDirection(o.matrixWorld);
    const list = raw.get(id).parts;
    if (!list.has(part)) list.set(part, []);
    list.get(part).push({
      c: _bx.clone(), half, mesh: o,
      ex: new THREE.Vector3(ex.x, 0, ex.z).normalize(),
      ez: new THREE.Vector3(ez.x, 0, ez.z).normalize(),
    });
  });

  const out = [];
  for (const { id, parts } of raw.values()) {
    const sides = parts.get('Side');
    const anchor = (parts.get('Landing') || parts.get('Foot') || sides || [])[0];
    const innerLo = parts.get('InnerLower');
    const outer = (parts.get('Outer') || [])[0];
    const innerUp = parts.get('InnerUpper');
    if (!sides || !sides.length || !anchor || !innerLo || !outer) continue;
    const c = anchor.c;

    // 塔坐标系：切向 = Side 的局部 X（沿墙）；外法线 = **从内墙指向外墙** 的方向。
    // 不靠「离镇心更远」判正负 —— 那个判据在 `collectCenterline` 里成立是因为压顶石
    // 逐片自带法线，而塔的每一件共用同一个旋转，外法线由内 / 外墙的相对位置直接给出，
    // 判据更硬（GLB 里 `Outer` 的径向偏移实测恒为正 +1.80~+2.02，`Inner` 恒为负 -1.93~-2.12）。
    const t = sides[0].ex.clone();
    const n = outer.c.clone().sub(innerLo[0].c).setY(0).normalize();

    /** 一件在塔坐标系里的读数：沿墙 along / 径向 u / 竖直区间。 */
    const read = (m) => ({
      along: m.c.clone().sub(c).dot(t),
      u: m.c.clone().sub(c).dot(n),
      yLo: m.c.y - m.half[1], yHi: m.c.y + m.half[1],
      // 半长按「哪条局部轴是哪条塔轴」取：Side/Inner/Outer 都是局部 X=切向、局部 Z=径向
      halfAlong: m.half[0], halfU: m.half[2],
      // 原网格引用：`buildFlanks()` 重建之后要靠它精确隐藏，别的件用不上。
      mesh: m.mesh,
    });

    const sideR = sides.map(read).sort((a, b) => a.along - b.along);
    const lo = read(innerLo[0]);
    const out0 = read(outer);
    const innerFace = {
      u: lo.u, thick: 2 * lo.halfU, w: 2 * lo.halfAlong, yLo: lo.yLo, yHi: lo.yHi,
    };
    const outerFace = {
      u: out0.u, thick: 2 * out0.halfU, w: 2 * out0.halfAlong, yLo: out0.yLo, yHi: out0.yHi,
    };
    const innerUpFace = innerUp ? read(innerUp[0]) : null;
    /* 塔身沿墙半宽 = **侧翼外表面**。
     * ⚠ 这里第一版写成「侧翼内表面」（|along| - 厚/2 = 1.306），门就开在石头**里面**了：
     *   侧翼是 1.0m 厚的整片石墙，面法向朝塔内，人从墙外走近塔楼时先撞上的是**外表面**，
     *   门必须开在外表面（|along| + 厚/2 = 2.306），也就是塔身沿墙的真实边界。
     *   门开错面时近景图里就是一堵没有门的实墙（shots-passage 的 through 组第一版就这么翻车了）。
     */
    const flankThick = 2 * read(sides[0]).halfAlong;
    const halfAlong = Math.max(Math.abs(sideR[0].along), Math.abs(sideR[sideR.length - 1].along)) + flankThick / 2;

    out.push({
      id, c, t, n, innerFace, innerUpFace, outerFace,
      flankAlong: sideR.map((s) => +s.along.toFixed(3)),
      flankThick: +flankThick.toFixed(3),
      halfAlong: +halfAlong.toFixed(3),
      /** 塔身径向半深：内墙面到外墙面的实测跨度的一半。 */
      halfU: (outerFace.u + outerFace.thick / 2 - (innerFace.u - innerFace.thick / 2)) / 2,
      uMid: (outerFace.u + outerFace.thick / 2 + innerFace.u - innerFace.thick / 2) / 2,
      /**
       * **空腔**（通道真正能走的那一段）的径向边界：内墙朝塔心那面 ↔ 外墙朝塔心那面。
       * 实测 2.81~3.24m 宽。侧翼的洞就取这个断面 —— 取窄了洞两侧会剩下一米多
       * 的「门垛」，从通道里看出去还是石头（见文件头第三批）。
       */
      cavIn: innerFace.u + innerFace.thick / 2,
      cavOut: outerFace.u - outerFace.thick / 2,
      /**
       * 每片侧翼在塔坐标系里的完整盒体（沿墙 / 径向 / 竖直）。
       * ⚠ 必须用 `sideR`（`read()` 之后的读数）而不是 `sides`（原始件）——
       *   写成 `sides` 的话 `s.along / s.yLo` 全是 undefined，一路飘到
       *   `buildFlanks()` 才炸，报错还只是一句没头没脑的 `reading 'toFixed'`。
       * `mesh` 用来精确隐藏原节点。
       */
      flankBoxes: sideR.map((s) => ({
        along: s.along, halfAlong: s.halfAlong,
        u: s.u, halfU: s.halfU,
        yLo: s.yLo, yHi: s.yHi, mesh: s.mesh,
      })),
      /** `InnerLower` 的顶（= base+10）与内立面的顶，用来判甲板面上内墙是否还是实心。 */
      innerLowerTopY: lo.yHi,
      innerTopY: innerUpFace ? innerUpFace.yHi : lo.yHi,
      /** 这一座塔的内立面是不是本来就有真洞口（开敞拱背）。 */
      openBack: !innerUpFace,
    });
  }

  // 甲板面标高：取中心线上离塔心最近的一片压顶石顶面（实测偏差 ≤ 1.5cm，墙顶起伏 ±0.3m/56m）
  for (const f of out) {
    let best = null, bd = Infinity;
    for (const p of points) {
      const d = (p.top.x - f.c.x) ** 2 + (p.top.z - f.c.z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    f.deck = best ? best.top.clone() : new THREE.Vector3();
    f.deckY = best ? best.top.y : 0;
    f.deckInN = best ? best.inN.clone() : new THREE.Vector3(0, 0, 1);
    f.deckT = best ? best.tangent.clone().setY(0).normalize() : new THREE.Vector3(1, 0, 0);
    /** 甲板面（= 最近的压顶石顶面中心）在塔坐标系里的径向读数 u。 */
    f.deckU = (f.deck.x - f.c.x) * f.n.x + (f.deck.z - f.c.z) * f.n.z;
    const deckTop = f.deckY + TUNE.walkway.topProud;
    /**
     * 甲板面那一层，内墙是不是实心？
     * `InnerUpper` 存在的塔（10 座）内墙通高 ⇒ 永远实心。
     * 开敞拱背那 3 座（idx%4==2）内墙只到 base+10，甲板面在它之上时中间是真拱洞 ⇒ 不实心。
     */
    f.innerBlocksAtDeck = f.innerUpFace ? true : f.innerLowerTopY > deckTop;
    /** 内墙高出甲板面多少（0 = 甲板面那一层没有内墙露头）。 */
    f.innerStubH = f.innerBlocksAtDeck ? Math.max(0, f.innerTopY - deckTop) : 0;
    /** 走线到内墙表面的净距 —— 人肩半宽 0.215m，小于它就会陷进墙里。 */
    f.walkClear = +(f.deckU - f.cavIn).toFixed(3);
  }
  return out;
}

/**
 * 某点是否落在塔的**实体**内（沿墙 ±halfAlong × 塔身径向跨度）。
 * 塔内不生成内侧矮护墙 —— 护墙会埋进侧翼石墙里、或立在塔的空腔里。
 * 用定向塔框而不是包围盒：护墙要**紧贴门垛**收口，用包围盒会提前 1m 断掉。
 * 沿墙方向再多让开一个门套挑出量（`passage.reveal`），护墙正好从门垛外沿接着长出去。
 */
function inTowerPassable(frame, x, z) {
  const dx = x - frame.c.x, dz = z - frame.c.z;
  const along = dx * frame.t.x + dz * frame.t.z;
  const u = dx * frame.n.x + dz * frame.n.z - frame.uMid;
  return Math.abs(along) <= frame.halfAlong + TUNE.passage.reveal && Math.abs(u) <= frame.halfU;
}

/* ============================ 塔楼通行口 ============================ */

/**
 * 侧翼真洞：把每片 `Tower_XX_Side` 的实心盒体**减掉一个洞**，拆成 4 块重建。
 *
 * 洞的断面 = 整个空腔（`cavIn ↔ cavOut`，实测 2.81~3.24m）× 净高 2.00m，
 * 沿墙方向**贯穿**侧翼那 1.0m 全厚（所以没有「门垛」可留 —— 侧翼本来就只有 1.0m 厚）。
 * 底落在甲板面（门槛面 = 铺装面），顶是过梁底。
 *
 * ⚠ 四块的区间都是从 GLB 实测回来的（`flankBoxes`），**洞之外的部分逐项照抄原盒体**：
 *   外表面（uLo/uHi）、两端的沿墙面（aLo/aHi）、塔基与塔顶（yLo/yHi）全部落在原平面上，
 *   所以塔的轮廓除了多了个洞之外一个角都不会变。
 * ⚠ 三处**必须留**的面：门槛下的墙身顶面（空腔地板）、过梁底面（洞的顶棚）、
 *   两片墙肢朝洞那面的门边。全部用 FACE_ALL，宁可多 78 个三角形也不冒险漏面。
 *
 * @returns {Array} 每片被重建的侧翼一条记录（含原网格引用，供精确隐藏）
 */
function buildFlanks(frames, out) {
  const P = TUNE.passage;
  const list = [];
  for (const f of frames) {
    const deckY = f.deckY + TUNE.walkway.topProud;   // 门槛面 = 铺装面
    const sillTop = deckY - P.tunnel.sillDrop;        // 门槛顶：压到压顶石顶面之下，躲开共面
    const headY = deckY + P.height;                   // 过梁底 = 洞的顶棚
    const cavW = f.cavOut - f.cavIn;
    if (cavW < P.width) continue;                     // 空腔太窄，开不出净宽就不动它

    for (const bx of f.flankBoxes) {
      /* 自检：盒体读数必须全是有限数。
       * 踩过：`flankBoxes` 一度是拿**原始件**而不是 `read()` 的读数建的，
       * `s.along / s.yLo` 全是 undefined，一路飘到下面 `+bx.yLo.toFixed(2)` 才炸，
       * 报的还是一句没头没脑的 `Cannot read properties of undefined (reading 'toFixed')`
       * —— 而每次开机 15 分钟，这种错要当场炸出来才查得动。 */
      for (const k of ['along', 'halfAlong', 'u', 'halfU', 'yLo', 'yHi']) {
        if (!Number.isFinite(bx[k])) {
          throw new Error(`wallwalk: Tower_${f.id} 侧翼盒体读数 "${k}" 不是有限数（${bx[k]}）—— flankBoxes 拿错了来源？`);
        }
      }
      const uLo = bx.u - bx.halfU, uHi = bx.u + bx.halfU;
      const midU = (f.cavIn + f.cavOut) / 2, halfU = cavW / 2;
      const midY = (bx.yLo + bx.yHi) / 2, halfY = (bx.yHi - bx.yLo) / 2;
      const put = (uC, uH, yC, yH) => {
        const p = f.c.clone().addScaledVector(f.t, bx.along).addScaledVector(f.n, uC);
        out.mFlank.box(p.x, yC, p.z, bx.halfAlong, yH, uH, f.t, _UP, f.n, FACE_ALL);
      };
      // ① 内侧墙肢（通高）  ② 外侧墙肢（通高）
      put((uLo + f.cavIn) / 2, (f.cavIn - uLo) / 2, midY, halfY);
      put((f.cavOut + uHi) / 2, (uHi - f.cavOut) / 2, midY, halfY);
      // ③ 门槛下的墙身（塔基 → 门槛顶）
      put(midU, halfU, (bx.yLo + sillTop) / 2, (sillTop - bx.yLo) / 2);
      // ④ 过梁 + 其上墙体（过梁底 → 塔顶）
      put(midU, halfU, (headY + bx.yHi) / 2, (bx.yHi - headY) / 2);

      list.push({
        id: f.id, mesh: bx.mesh,
        along: +bx.along.toFixed(3), halfAlong: +bx.halfAlong.toFixed(3),
        uLo: +uLo.toFixed(3), uHi: +uHi.toFixed(3),
        yLo: +bx.yLo.toFixed(2), yHi: +bx.yHi.toFixed(2),
        cavIn: +f.cavIn.toFixed(3), cavOut: +f.cavOut.toFixed(3), cavW: +cavW.toFixed(3),
        sillTop: +sillTop.toFixed(3), headY: +headY.toFixed(3),
      });
    }
  }
  return list;
}

/**
 * 隐藏被重建的那批侧翼。
 *
 * ⚠ 用 `visible = false` 而不是从场景移除 / 从 parent 里摘掉：随时一句
 *   `visible = true` 就能切回原样做前后对比，冻结资产一根汗毛都不动。
 * ⚠ 正则 `TUNE.tower.side` 只用来**交叉核对**数量：扫出来的 Side 网格必须和
 *   「被重建的那批」一一对应。少重建一片却把它藏了，塔身上就凭空多个洞 ——
 *   这种错画面上极难发现，所以在这里直接抛。
 */
function hideTowerFlanks(town, rebuilt) {
  const scanned = [];
  town.traverse((o) => { if (o.isMesh && TUNE.tower.side.test(o.name || '')) scanned.push(o); });
  const set = new Set(rebuilt.map((b) => b.mesh));
  const missed = scanned.filter((o) => !set.has(o)).map((o) => o.name);
  if (missed.length) {
    throw new Error(`wallwalk: 这些侧翼没被重建却被正则扫到了，藏起来塔身就多个洞: ${missed.join(', ')}`);
  }
  for (const b of rebuilt) b.mesh.visible = false;
  return { scanned: scanned.length, hidden: set.size, names: scanned.map((o) => o.name) };
}

/**
 * 内外立面的假门洞（侧翼那一面是真洞，由 `buildFlanks()` 负责，这里只登记机位）。
 *
 * 每面给出三样东西就够摆一个假门洞了：
 *   `n`  面法向，**指向观看者**（门就是朝这个方向「开」的）
 *   `a`  面内水平轴 —— 门洞净宽量在这条轴上
 *   `plane` 面所在平面上的一点（取塔心平齐即可，洞心最后投影到面上）
 *
 * ⚠ **门套与凹体整块都在墙的朝外那一面**（凹体埋进墙里 0.26m、门套朝外挑 0.30~0.42m），
 *   所以从通道里往两侧看，看到的是内墙 / 外墙**朝空腔那面**的素墙 —— 上一批那 23 个
 *   凹体不会在通道侧壁上读成「通往虚空的门」。`node tests/shots-thru.mjs --views side`
 *   拍的 `thru-side-*.jpg` 就是这一条的看图证据。
 *
 * 洞口标高一律对齐**该塔处的甲板面**（压顶石顶 + walkway.topProud），
 * 所以门是踩着墙道地面进的，不是悬空的。
 *
 * @param {Array} frames  `collectTowerFrames()` 的输出
 * @param {number} walkMidOff 步道带中点相对墙身中线的横向偏移
 * @param {{mStone:Mesher, mDark:Mesher}} out 两个累加器：石门套 / 暗色凹体
 * @returns {Array} 每个门洞的 `{ id, kind, c, n, a }`（相机机位与探针要用）
 */
function buildPassages(frames, walkMidOff, out) {
  const P = TUNE.passage;
  const UP = new THREE.Vector3(0, 1, 0);
  const list = [];

  for (const f of frames) {
    // 门洞的竖直基准：甲板面（压顶石顶 + topProud）
    const deckY = f.deckY + TUNE.walkway.topProud;
    // 甲板带中心在墙身横断面上的位置（洞要开在带的正中，人从正中穿过去）
    const mid = f.deck.clone().addScaledVector(f.deckInN, walkMidOff);

    const cand = [];
    /* 侧翼两面 —— 墙道沿切向穿塔，真正挡路的就是这两片。
       洞是**真洞**（`buildFlanks` 重建），这里只登记一条机位记录。
       洞心取侧翼**外表面**（塔身沿墙边界 halfAlong）：人从墙外走近时先撞到的那一面。 */
    for (const s of [1, -1]) {
      cand.push({
        kind: 'flank',
        real: true,                            // 不生成凹体/门套
        n: f.t.clone().multiplyScalar(s),
        a: f.n.clone(),
        plane: f.c.clone().addScaledVector(f.t, s * f.halfAlong),
        w: f.cavOut - f.cavIn,                 // 洞的净宽 = 整个空腔
      });
    }
    /* 内立面 —— `openBack` 的塔本来就是开敞拱背，绝不能再拿门套去挡真洞口。 */
    cand.push({
      kind: 'inner',
      skip: f.openBack,
      n: f.n.clone().negate(),
      a: f.t.clone(),
      plane: f.c.clone().addScaledVector(f.n, f.innerFace.u - f.innerFace.thick / 2),
      w: f.innerFace.w,
    });
    /* 外立面 —— 恒为实墙（`Outer` 占 base~base+h），必开。 */
    cand.push({
      kind: 'outer',
      n: f.n.clone(),
      a: f.t.clone(),
      plane: f.c.clone().addScaledVector(f.n, f.outerFace.u + f.outerFace.thick / 2),
      w: f.outerFace.w,
    });

    for (const c of cand) {
      if (c.skip) continue;
      // 门净宽 + 两侧门垛必须容得下这道墙
      if (c.w < P.width + 2 * P.jamb) continue;
      if (c.kind === 'flank' && f.halfAlong < P.minFlankHalf) continue;

      // 洞心：甲板带中心投影到面平面上
      const cc = mid.clone().addScaledVector(c.n, -mid.clone().sub(c.plane).dot(c.n));
      cc.y = deckY;

      const W = P.width, H = P.height;
      const cfg = P.facade[c.kind] || P.facade.outer;
      const J = cfg.jamb, RV = cfg.reveal, LN = cfg.lintel;
      const frameN = (RV - P.backSink) / 2, frameH = (RV + P.backSink) / 2;

      if (!c.real) {
        // ① 暗色凹体：沿面法向埋进墙里，只有正面可见
        const rc = cc.clone().addScaledVector(c.n, P.recessProud - P.recessDepth / 2);
        rc.y = deckY + H / 2 - 0.03;             // 下探 3cm，压住门槛顶
        out.mDark.box(rc.x, rc.y, rc.z, W / 2, H / 2 + 0.03, P.recessDepth / 2,
          c.a, UP, c.n, FACE_PZ);

        // ② 门垛 ×2（沿 a 排在洞口两侧，y 从门槛底到过梁顶）
        const jambY = deckY + (H + LN - P.sill) / 2;
        const jambH = (H + LN + P.sill) / 2;
        for (const s of [1, -1]) {
          const p = cc.clone()
            .addScaledVector(c.a, s * (W / 2 + J / 2))
            .addScaledVector(c.n, frameN);
          p.y = jambY;
          out.mStone.box(p.x, p.y, p.z, J / 2, jambH, frameH, c.a, UP, c.n, FACE_SURROUND);
        }
        // ③ 过梁：横跨门垛外沿
        {
          const p = cc.clone().addScaledVector(c.n, frameN);
          p.y = deckY + H + LN / 2;
          out.mStone.box(p.x, p.y, p.z, W / 2 + J, LN / 2, frameH, c.a, UP, c.n, FACE_SURROUND);
        }
        // ④ 门槛：顶面压在甲板面**以下** 1cm，别和铺装顶共面
        {
          const p = cc.clone().addScaledVector(c.n, frameN);
          p.y = deckY - (P.sill + P.sillDrop) / 2;
          out.mStone.box(p.x, p.y, p.z, W / 2 + J, (P.sill - P.sillDrop) / 2, frameH, c.a, UP, c.n, FACE_SURROUND);
        }
        // ⑤ 滴水线（只在 TUNE.passage.facade.inner 里给值，外立面 cfg.dripH = 0）：
        //    横向一条比过梁再外挑一点的小挑檐，它的**顶面朝天**、底面朝下，
        //    在整面阴影的塔内立面上是唯一比墙本身吃光多的两个面 ⇒ 门套因此读得出来。
        if (cfg.dripH > 0) {
          const p = cc.clone().addScaledVector(c.n, (RV + cfg.dripProud - P.backSink) / 2);
          p.y = deckY + H + LN + cfg.dripH / 2;
          out.mStone.box(p.x, p.y, p.z, W / 2 + J + 0.06, cfg.dripH / 2,
            (RV + cfg.dripProud + P.backSink) / 2, c.a, UP, c.n, FACE_SURROUND);
        }
      }

      list.push({
        id: f.id, kind: c.kind, real: !!c.real,
        c: cc.clone(), n: c.n.clone(), a: c.a.clone(),
        width: c.real ? c.w : W, height: H, deckY: +deckY.toFixed(3),
        // 机位要用的：洞心在面上的位置（真洞的中心就是空腔中心）
        plane: c.plane.clone(),
      });
    }
  }
  return list;
}


/* ========================== 三角面装配器 ========================== */

const FACE_PX = 1, FACE_NX = 2, FACE_PY = 4, FACE_NY = 8, FACE_PZ = 16, FACE_NZ = 32;
const FACE_ALL = FACE_PX | FACE_NX | FACE_PY | FACE_NY | FACE_PZ | FACE_NZ;
const FACE_NO_BOTTOM = FACE_ALL & ~FACE_NY;   // 底面埋进压顶石里，永远看不见
/** 门套：底面埋进甲板 / 背面（-Z = 埋进石墙那侧）永远看不见。 */
const FACE_SURROUND = FACE_ALL & ~FACE_NY & ~FACE_NZ;

/**
 * 极简面片累加器：position + normal，无索引。
 * 全部构件都用它，保证 mergeGeometries 的属性集一致（有/无索引不一致会返回 null）。
 */
class Mesher {
  constructor() { this.pos = []; this.nrm = []; }

  /**
   * 加一个四边形。`want` 是期望的外法线：若算出来的几何法线与它反向，自动翻转绕序。
   * 这样调用方不必关心绕序，能挡掉一整类「面朝里所以看不见」的 bug。
   */
  quad(a, b, c, d, want) {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = d.x - a.x, vy = d.y - a.y, vz = d.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    let flip = false;
    if (want && (nx * want.x + ny * want.y + nz * want.z) < 0) { flip = true; [nx, ny, nz] = [-nx, -ny, -nz]; }
    if (flip) { const t = b; b = d; d = t; }
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }

  tri(a, b, c, nx, ny, nz) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }

  /**
   * 以 (中心, 三轴半长) 摆一个正交长方体，可按位掩码跳过埋进石头里、永远看不见的面。
   * 面位：+X 1 / -X 2 / +Y 4 / -Y 8 / +Z 16 / -Z 32（+Z 是内侧，-Z 是外侧）。
   */
  box(cx, cy, cz, hx, hy, hz, e1, e2, e3, faces = FACE_ALL) {
    const P = (a, b, c) => new THREE.Vector3(
      cx + e1.x * (a * hx) + e2.x * (b * hy) + e3.x * (c * hz),
      cy + e1.y * (a * hx) + e2.y * (b * hy) + e3.y * (c * hz),
      cz + e1.z * (a * hx) + e2.z * (b * hy) + e3.z * (c * hz)
    );
    const v = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) v.push(P(a, b, c));
    const idx = (a, b, c) => v[((a + 1) >> 1) * 4 + ((b + 1) >> 1) * 2 + ((c + 1) >> 1)];
    if (faces & FACE_PX) this.quad(idx(1, -1, -1), idx(1, 1, -1), idx(1, 1, 1), idx(1, -1, 1), e1);
    if (faces & FACE_NX) this.quad(idx(-1, -1, -1), idx(-1, -1, 1), idx(-1, 1, 1), idx(-1, 1, -1), e1.clone().negate());
    if (faces & FACE_PY) this.quad(idx(-1, 1, -1), idx(-1, 1, 1), idx(1, 1, 1), idx(1, 1, -1), e2);
    if (faces & FACE_NY) this.quad(idx(-1, -1, -1), idx(1, -1, -1), idx(1, -1, 1), idx(-1, -1, 1), e2.clone().negate());
    if (faces & FACE_PZ) this.quad(idx(-1, -1, 1), idx(1, -1, 1), idx(1, 1, 1), idx(-1, 1, 1), e3);
    if (faces & FACE_NZ) this.quad(idx(-1, -1, -1), idx(-1, 1, -1), idx(1, 1, -1), idx(1, -1, -1), e3.clone().negate());
  }

  get triangles() { return this.pos.length / 9; }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.computeBoundingSphere();
    return g;
  }
}

function mergeOrThrow(list, label) {
  const clean = list.filter(Boolean);
  if (!clean.length) return null;
  for (const g of clean) {
    if (g.index !== null) throw new Error(`${label}: 合并前必须全部转成无索引几何`);
  }
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error(`${label}: mergeGeometries 返回 null（属性集不一致？）`);
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/* ============================ 材质挑选 ============================ */

/**
 * 从 town 里挑出已经被 materials.js 的 DISPATCH 注入过三平面的材质实例，直接复用。
 * 不新建材质 —— 新建的会掉回没有程序化贴图的白模。
 */
function resolveMaterials(town) {
  const found = {};
  town.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      const key = normName(m.name);
      if (!found.stone && TUNE.material.stone.test(key)) found.stone = m;
      if (!found.paving && TUNE.material.paving.test(key)) found.paving = m;
      if (!found.flank && TUNE.material.flank.test(key)) found.flank = m;
      if (!found.dark && TUNE.material.dark.test(key)) found.dark = m;
    }
  });
  // 逐项显式检查：`found` 里没被赋过值的键根本不会出现在 Object.entries 里，
  // 光靠遍历检查等于没检查。真出问题时 new THREE.Mesh(geo, undefined) 会静默用
  // three 的默认白材质 —— 那正是「贴上去的白模」，必须在这里炸掉。
  for (const k of ['stone', 'paving', 'flank', 'dark']) {
    const m = found[k];
    if (!m) throw new Error(`wallwalk: town 里找不到 ${k} 对应的 DISPATCH 材质（${TUNE.material[k]}）`);
    if (!m.map || !m.bumpMap || typeof m.customProgramCacheKey !== 'function') {
      throw new Error(`wallwalk: 材质「${m.name}」没有三平面注入（applyMaterials 还没跑？）`);
    }
  }
  return found;
}

/* ============================== 主入口 ============================== */

const _UP = new THREE.Vector3(0, 1, 0);

/** 护墙段长（估）：`steps = round(周长 / segLen)`，所以实际段长 = 周长 / steps。 */
const estParapetStep = (perimeter) =>
  perimeter / Math.max(1, Math.round(perimeter / TUNE.walkway.segLen));

/**
 * 生成墙道步道三件套 + 塔楼通行口，挂到 `town` 下（town 变换是单位阵，世界坐标直接用）。
 * 必须在 `applyMaterials` **之后**调用。
 * @param {object} o
 * @param {THREE.Object3D} o.town
 * @param {Array} [o.gaps] 护墙豁口 `[{ x, z, halfWidthM }]`（世界 xz + 沿墙半宽）。
 *   省略时用内部 `planStairs()` 的落位表自动生成。
 * @param {Array} [o.obstacles] 建筑禁区盒 `[{ name, minX, maxX, minZ, maxZ, topY }]`，
 *   由 `app.js` 用 `player.js` 的 `collectBlockerBoxes()` 收集。**规格 §1.6 的净空判据要它**
 *   （不传就退化成「不判净空」，`stats().stairsClearChecked` 会是 0，一眼看得出来）。
 * @returns {{group:THREE.Group, stats:Function, centerline:Array, seamIndex:number, passages:Array, stairs:object}}
 */
export function buildWallWalk({ town, gaps, obstacles }) {
  town.updateWorldMatrix(true, true);

  // 横向分带是抄进 wallstair.js 的（那边不能 import 本文件）。抄岔了当场炸。
  assertBandMatches(TUNE);

  const { points, perimeter, centroid } = extractCenterline(town);
  const spacing = spacingStats(points);
  const gates = findGates(points, centroid);
  const towers = collectTowerBlocks(town);
  const frames = collectTowerFrames(town, points);
  const mats = resolveMaterials(town);

  /* ---- 1. 沿中心线重采样 ----
   * 上一批在这里按塔楼包围盒把中心线切成 14 段（人物走到塔前就折返，全环丢 113.6m）。
   * 现在塔楼有了通行口，中心线**穿过**塔楼，不再被切断；塔楼只用来让位雉堞与内侧护墙。
   */
  const n = points.length;
  const towerPts = points.map((p) => inTower(towers, p.top.x, p.top.z));

  // 从最大的极角间隙处起切，保证环形接缝落在城门口而不是某座塔中间。
  const ang = points.map((p) => Math.atan2(p.top.z - centroid.y, p.top.x - centroid.x));
  let seam = 0, seamG = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const g = (i === n - 1 ? ang[0] + Math.PI * 2 - ang[n - 1] : ang[j] - ang[i]);
    if (g > seamG) { seamG = g; seam = j; }
  }
  const roll = (i) => points[(seam + i) % n];

  // 中心线不再被任何东西切断：整圈一个 run（城门那里本来就是连续压顶石，
  // `findGates` 的两座城门逻辑一个字没动，仍然只管雉堞避让）。
  const runs = [];
  {
    const cur = { idx: [], arc: [0] };
    for (let i = 0; i < n; i++) cur.idx.push(roll(i));
    for (let k = 1; k < cur.idx.length; k++) {
      const a = cur.idx[k - 1].top, b = cur.idx[k].top;
      cur.arc.push(cur.arc[k - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    cur.length = cur.arc[cur.arc.length - 1];
    runs.push(cur);
  }
  const runnable = runs.filter((r) => r.length >= TUNE.walkway.segLen);

  /** 在某段里按弧长取样：位置 / 顶面高 / 内法线。 */
  function sampleRun(r, s) {
    const arc = r.arc;
    let lo = 0, hi = arc.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (arc[mid] <= s) lo = mid; else hi = mid; }
    const a = r.idx[lo], b = r.idx[Math.min(lo + 1, r.idx.length - 1)];
    const t = b === a ? 0 : Math.min(1, Math.max(0, (s - arc[lo]) / Math.max(1e-6, arc[lo + 1] - arc[lo])));
    const p = new THREE.Vector3().lerpVectors(a.top, b.top, t);
    // 属性名必须叫 inN —— 中心线点上是 inN，这里返回 inN，调用方不要再写成 nIn。
    const inN = new THREE.Vector3().lerpVectors(a.inN, b.inN, t).normalize();
    return { p, inN, tangent: a.tangent };
  }

  const O = TUNE;   // 简写
  const offWalkOut = O.walkway.from - O.wallHalf;
  const offWalkIn = O.walkway.to - O.wallHalf;
  const offMerOut = O.merlon.from - O.wallHalf;
  const offMerIn = O.merlon.to - O.wallHalf;
  const offParOut = O.parapet.from - O.wallHalf;
  const offParIn = O.parapet.to - O.wallHalf;
  const offCapOut = offParOut - O.parapet.capOverhang;
  const offCapIn = offParIn + O.parapet.capOverhang;

  const mWalk = new Mesher();
  const mMer = new Mesher();
  const mPar = new Mesher();
  const mDark = new Mesher();   // 门洞的暗色凹体（唯一的新材质 → 唯一的新 drawcall）
  const mFlank = new Mesher();  // 侧翼真洞重建件（塔墙本来的料，见 TUNE.material.flank）

  let segCount = 0, parSegCount = 0, merlonCount = 0, gateSkip = 0, towerSkipPts = 0;
  let towerMerlonSkip = 0, towerParSkip = 0, towerDeckSegs = 0;
  let globalArc = 0;

  const P = (s, off, dy) => {
    const q = s.p.clone().addScaledVector(s.inN, off);
    q.y += dy;
    return q;
  };
  /** 该采样点是不是落在某座塔的实体里（雉堞与内侧护墙要让位，铺装不让）。 */
  const inAnyTower = (p) => towers.some((b) => p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ);
  const inAnyPassable = (p) => frames.some((f) => inTowerPassable(f, p.x, p.z));

  /* ---- 护墙豁口 + 阶梯落位（第四批）----
   * 顺序有讲究：**先**落位（它要用塔楼避让判据 + 规格 §1.6 的净空判据过滤），
   * **再**由落位表导出豁口 —— 反过来就变成「先在塔里开了个豁口，再把阶梯放进去」。
   * 落位是纯数据，不建 mesh；建 mesh 在 `buildWallStairs()`（app.js 在 buildWalkable 之后调，
   * 因为它要用高程场把梯脚的真实街面高度量回来 —— 级数与沿墙长都由那个爬升现算）。 */
  /* ⚠ 合法性判据要带**余量**，不是「这一点在不在塔里」。
   *   护墙豁口的净开口是 ±`STAIR.gap.halfWidthM`，而护墙按 `segLen` 一段一段生成、
   *   「这一段有没有护墙」判的是**段起点**。只判中心线点的话，一个刚挪出塔区的点，
   *   它的相邻段起点仍落在塔区里 ⇒ 豁口开在护墙**本来就没有**的地方。
   *   所以这里沿切向再判 ±(豁口半宽 + 半段长)。
   * ⚠ 抽成**具名 const**：payload 上的 `planStairsAt()` 要在别的平移量上复用同一套判据，
   *   写成内联实参的话写不出这个名字就是 ReferenceError，而 catch 之后只会安静地
   *   回一句「这个平移量不合法」—— 81 个偏移全假失败都看不出来。 */
  const isStairBlocked = (pt) => {
    const m = STAIR.gap.halfWidthM + estParapetStep(perimeter) / 2;
    for (const d of [0, -m, m]) {
      const q = new THREE.Vector3(
        pt.top.x + pt.tangent.x * d, pt.top.y, pt.top.z + pt.tangent.z * d
      );
      if (inAnyPassable(q) || inAnyTower(q)) return true;
    }
    return false;
  };
  /* ⚠ 规格 §1.6 的净空判据：**落位点背后那 1.0~2.0m 宽 × 十几米长的带
   *   里不许有任何建筑**（镇内是挤满房子的，13~18m 连续空地不一定有）。
   *   这条判据扫的是**暂算**的 flight 长度（`planStairs` 内部加了 `clearancePadM`），
   *   **最终**长度由 `buildWallStairs` 重算后再核一遍（探针 S2 量的是最终长度）。
   * ⚠ 障碍盒由 `app.js` 用 `player.js` 的 `collectBlockerBoxes()` 传进来 ——
   *   正则只有那一份，不在这里重写一遍（两份正则迟早分叉，分叉之后净空判据就是假的）。
   *   `STAIR.obstacle.exclude` 排掉**墙自己**的 `Curtain_*` 盒：阶梯本来就贴着内墙，
   *   而幕墙盒带 0.42m 余量一直盖到 across 2.47，把墙算成障碍的话全环都放不下。 */
  const freeBoxes = (obstacles || []).filter((b) => !STAIR.obstacle.exclude.test(b.name || ''));
  const clearArc = makeArcSampler(points);          // 净空判据每座要扫几十个弧长，采样器只建一次
  /* ⚠⚠ **净空判据必须分高度**（不分高度时全环都放不下）。
   *   阶梯的 footprint 横向跨 1.23~3.25，而这两段的「脚下高度」差着 9m：
   *     · flight 那一段（across 2.25~3.25）从**街面**起 ⇒ 任何高过街面 0.3m 的盒子都挡路；
   *     · 顶部那几条（across 1.23~2.25：交接带 / 豁口台面 / 门槛石）在**墙顶**⇒
   *       只有高过墙顶 0.3m 的盒子才撞得上，街边那些 1~3m 的房子从阶梯下面过去，压根不冲突。
   *   不分高度的话，一个横跨街道的房子的 **AABB** 会把墙道那一条也盖住 ——
   *   而 AABB 对旋转物体是**外接框**，量出来的「重叠」大半是假的。
   *
   * ⚠ **先整环烘成一条 0.25m 的「被挡弧长带」，再让落位去查它**（不是每座现扫几何）。
   *   理由是量出来的：13 座塔楼各占约 7m，全环 91m/563m 被挡 ⇒ 一个 18m 的窗口
   *   单独看有 **84%** 合法，6 座同时合法只有 **0.84⁶ ≈ 35%**。所以落位必须能
   *   在**很多**个平移量上试（细网格 0~±60m / 0.5m，共 241 个），
   *   而每试一个都要查 6 座 × 18m 的带 —— 现扫几何是 241×6×18m×5×80 ≈ 2000 万次盒测试，
   *   预烘成带之后只要 241×6×80 ≈ 12 万次数组读。同一份读数还直接就是规格 §1.6 的答案。 */
  const BAND_STEP = 0.25;
  const bandN = Math.ceil(perimeter / BAND_STEP);
  const bandBlocked = new Uint8Array(bandN);
  const bandWhy = new Array(bandN).fill('');
  const m = STAIR.obstacle.marginM;
  const uFlight0 = STAIR.stair.flightFrom - STAIR.band.wallHalf;
  const uTop0 = STAIR.stair.handoffFrom - STAIR.band.wallHalf;
  const u1 = STAIR.stair.flightTo - STAIR.band.wallHalf;
  const streetMinY = STAIR.stair.streetY + 0.30;
  for (let k = 0; k < bandN; k++) {
    const f = clearArc.at((k + 0.5) * BAND_STEP);
    const topMinY = f.topY + 0.30;
    for (let u = uTop0; u <= u1 + 1e-6; u += 0.5) {
      const onFlight = u >= uFlight0 - 1e-6;
      const minY = onFlight ? streetMinY : topMinY;
      const x = f.o.x + f.n.x * u;
      const z = f.o.z + f.n.z * u;
      let why = '';
      for (const b of freeBoxes) {
        if (b.topY <= minY) continue;
        if (x >= b.minX - m && x <= b.maxX + m && z >= b.minZ - m && z <= b.maxZ + m) { why = b.name; break; }
      }
      if (!why && inAnyTower(new THREE.Vector3(x, f.o.y, z))) why = '塔楼实体';
      if (why) { bandBlocked[k] = 1; bandWhy[k] = why + '（弧长 ' + f.arcM.toFixed(1) + 'm across ' + (u + STAIR.band.wallHalf).toFixed(2) + '）'; break; }
    }
  }
  let bandFreeM = 0;
  for (let k = 0; k < bandN; k++) if (!bandBlocked[k]) bandFreeM += BAND_STEP;
  /**
   * 环形连续空段 `[[起点弧长, 长度], …]`，按长度降序。
   * 判据跑不通时报数字用：光说「全环都放不下」等于没量，得说得清**最长有多长、要多少才够**。
   */
  const bandRuns = (() => {
    let k0 = -1;
    for (let k = 0; k < bandN; k++) if (bandBlocked[k]) { k0 = k; break; }
    if (k0 < 0) return [[0, +perimeter.toFixed(2)]];
    const runs = [];
    let k = (k0 + 1) % bandN, len = 0, start = k;
    for (let i = 0; i < bandN; i++) {
      if (bandBlocked[k]) {
        if (len > 0) runs.push([+(start * BAND_STEP).toFixed(2), +(len * BAND_STEP).toFixed(2)]);
        start = (k + 1) % bandN; len = 0;
      } else len++;
      k = (k + 1) % bandN;
    }
    if (len > 0) runs.push([+(start * BAND_STEP).toFixed(2), +(len * BAND_STEP).toFixed(2)]);
    return runs.sort((a, b) => b[1] - a[1]);
  })();
  /**
   * @returns {string|null} null = 净空；否则是**挡路的那一格**的名字 + 读数。
   */
  const isStairFootprintClear = (pt, arcFrom, arcTo) => {
    let k0 = Math.floor((((arcFrom % perimeter) + perimeter) % perimeter) / BAND_STEP);
    const k1 = Math.floor((((arcTo % perimeter) + perimeter) % perimeter) / BAND_STEP);
    for (let k = k0; k <= k1; k++) {
      const kk = ((k % bandN) + bandN) % bandN;
      if (bandBlocked[kk]) return bandWhy[kk];
    }
    return null;
  };
  const stairPlan = planStairs({
    centerline: points,
    count: STAIR.plan.count,
    isBlocked: isStairBlocked,
    isFootprintClear: obstacles ? isStairFootprintClear : (() => null),   // 判据见 stats().stairsClearChecked
    diag: obstacles ? { bandStepM: BAND_STEP, bandFreeM, bandRuns, perimeterM: perimeter } : null,
  });
  const gapList = (gaps && gaps.length) ? gaps : stairPlan.stairs.map((l) => l.gap);
  for (const g of gapList) {
    if (!isFinite(g.x) || !isFinite(g.z) || !(g.halfWidthM > 0)) {
      throw new Error(`wallwalk: 非法的护墙豁口 ${JSON.stringify(g)}（要 {x, z, halfWidthM>0}）`);
    }
  }
  /**
   * 这一**段**是不是落在某个阶梯豁口里。
   *
   * ⚠⚠ **必须判段中点，不能判段起点**（这一条是被 S6 的射线判据逼出来的，不是洁癖）：
   *   护墙是沿重采样线一段一段生成的，段长 ≈0.763m，而豁口半宽 0.80m。
   *   只判 `sA.p`（段起点）时，**落位点脚下那一段的起点相位是任意的** ——
   *   相位大就切不到它，于是接墙段正上方留着**一整段实心护墙**。
   *   实测 6 座里 4 座如此（S6 向下打射线：空洞宽 0m、落位点正上方是实心护墙）。
   *   后果不只难看：解析面的 `notch` 条带（across 1.66~2.11）正是护墙所占的那一圈，
   *   护墙没切掉 ⇒ 人能站进石头里，S12 量到圆柱与护墙重叠 **−0.1603m**。
   *   判段中点后，任何落位点脚下那一段的中点距落位点 ≤ 半段长 0.38m < 0.80m，**必被切**。
   *
   * @param {THREE.Vector3} p 段起点
   * @param {THREE.Vector3} q 段终点
   */
  const inAnyGap = (p, q) => {
    const mx = (p.x + q.x) * 0.5, mz = (p.z + q.z) * 0.5;
    for (const g of gapList) {
      const dx = mx - g.x, dz = mz - g.z;
      if (dx * dx + dz * dz <= g.halfWidthM * g.halfWidthM) return true;
    }
    return false;
  };
  let gapSkip = 0;

  /**
   * 塔内铺装带的**内沿**该收到哪儿（沿 `inN` 的偏移；`offWalkIn` = 0.64 是常态值）。
   *
   * 实测（`node_tmp_thru.mjs`）：内墙朝空腔那面在 u ≈ -1.72~-1.50，铺装带内沿在
   * u ≈ 中心线-0.64 = -2.16~-1.99 ⇒ 塔内有 **0.36~0.61m** 的带宽是埋在石头里的。
   * 这里把内沿收到「内墙表面外 1cm」，净宽剩 0.58~0.83m。
   *
   * ⚠ 收束过程摊在**侧翼那 1.0m 厚度**里（|along| 从 `halfAlong` 收到
   *   `halfAlong − flankThick`，ramp ∈ [0,1]），所以台阶整个躲在门洞里，
   *   画面上看到的是「走进门洞时地面自然变窄」，不是墙上多出一道横棱。
   * ⚠ 内墙不在甲板面那一层的三座（开敞拱背：真拱洞正对通道）不收。
   * ⚠ 上限按**采样点自己的 u** 算，所以收完之后内沿精确落在 `cavIn + deckClear`
   *   这一个平面上 —— 铺装带的内侧立面仍然是平面，法线算得准。
   */
  function innerEdgeOff(x, z) {
    for (const f of frames) {
      const dx = x - f.c.x, dz = z - f.c.z;
      const a = Math.abs(dx * f.t.x + dz * f.t.z);
      if (a > f.halfAlong || !f.innerBlocksAtDeck) continue;
      const ramp = Math.min(1, (f.halfAlong - a) / f.flankThick);
      if (ramp <= 0) continue;
      const sampleU = dx * f.n.x + dz * f.n.z;
      const full = Math.max(0, Math.min(offWalkIn, sampleU - f.cavIn - O.tower.deckClear));
      return offWalkIn + (full - offWalkIn) * ramp;
    }
    return offWalkIn;
  }
  let deckClipped = 0;

  for (const r of runnable) {
    const segLen = O.walkway.segLen;
    const steps = Math.max(1, Math.round(r.length / segLen));
    const step = r.length / steps;

    /* ---- 铺装步道 + 内侧矮护墙：沿同一条重采样折线，保证两者严丝合缝 ---- */
    for (let k = 0; k < steps; k++) {
      const sA = sampleRun(r, k * step);
      const sB = sampleRun(r, (k + 1) * step);
      segCount++;

      const wTopA = O.walkway.topProud, wBotA = -O.walkway.bedDepth;
      // 塔内那一段的内沿收到内墙表面外（见 innerEdgeOff 的注释）；两端各算一次，
      // 于是过渡是梯形而不是台阶。
      const inA = innerEdgeOff(sA.p.x, sA.p.z), inB = innerEdgeOff(sB.p.x, sB.p.z);
      if (inA < offWalkIn - 1e-4 || inB < offWalkIn - 1e-4) deckClipped++;
      const aOut = P(sA, offWalkOut, wBotA), aOutT = P(sA, offWalkOut, wTopA);
      const aIn = P(sA, inA, wBotA), aInT = P(sA, inA, wTopA);
      const bOut = P(sB, offWalkOut, wBotA), bOutT = P(sB, offWalkOut, wTopA);
      const bIn = P(sB, inB, wBotA), bInT = P(sB, inB, wTopA);
      const nOutW = _v3.copy(sA.inN).negate();
      mWalk.quad(aOut, aOutT, bOutT, bOut, nOutW);
      mWalk.quad(aIn, bIn, bInT, aInT, sA.inN);
      mWalk.quad(aOutT, aInT, bInT, bOutT, _UP);

      /* 塔内的这一段就是「塔内过道地板」：压顶石本身连续（塔位不生成断口），
         所以铺装直接铺过去就够 —— 同材质、同标高、同宽 1.20m，两端天然搭接。 */
      if (inAnyTower(sA.p)) towerDeckSegs++;

      /* 护墙：塔内不生成。塔内是 4.6m 深的空腔，护墙会立在半空；
         用定向塔框的「可走半宽」收口，护墙正好断在门垛外沿。 */
      if (inAnyPassable(sA.p)) { towerParSkip++; continue; }
      /* 护墙豁口（第四批）：阶梯的接墙段要从这儿穿进铺装面。与塔楼避让并列，
         同样只跳过护墙与压顶石盖，铺装与雉堞照常。 */
      if (inAnyGap(sA.p, sB.p)) { gapSkip++; continue; }
      parSegCount++;
      const pBotA = -O.parapet.sink, pTopA = O.parapet.height - O.parapet.sink;
      const qOut = P(sA, offParOut, pBotA), qOutT = P(sA, offParOut, pTopA);
      const qIn = P(sA, offParIn, pBotA), qInT = P(sA, offParIn, pTopA);
      const rOut = P(sB, offParOut, pBotA), rOutT = P(sB, offParOut, pTopA);
      const rIn = P(sB, offParIn, pBotA), rInT = P(sB, offParIn, pTopA);
      mPar.quad(qOut, qOutT, rOutT, rOut, _v3.copy(sA.inN).negate());
      mPar.quad(qIn, rIn, rInT, qInT, sA.inN);
      mPar.quad(qOutT, qInT, rInT, rOutT, _UP);

      // 护墙压顶石盖
      const cBotA = pTopA, cTopA = pTopA + O.parapet.capThick;
      const uOut = P(sA, offCapOut, cBotA), uOutT = P(sA, offCapOut, cTopA);
      const uIn = P(sA, offCapIn, cBotA), uInT = P(sA, offCapIn, cTopA);
      const vOut = P(sB, offCapOut, cBotA), vOutT = P(sB, offCapOut, cTopA);
      const vIn = P(sB, offCapIn, cBotA), vInT = P(sB, offCapIn, cTopA);
      mPar.quad(uOut, uOutT, vOutT, vOut, _v3.copy(sA.inN).negate());
      mPar.quad(uIn, vIn, vInT, uInT, sA.inN);
      mPar.quad(uOutT, uInT, vInT, vOutT, _UP);
    }

    /* ---- 外侧雉堞：按全局弧长定相位，垛口 / 空档节奏全圈一致 ---- */
    const period = O.merlon.period;
    const halfLen = O.merlon.length / 2;
    let s = Math.ceil((globalArc - halfLen) / period) * period + halfLen;
    for (; s <= globalArc + r.length + halfLen; s += period) {
      const local = s - globalArc;
      if (local < halfLen - 1e-6 || local > r.length - halfLen + 1e-6) continue;
      const sm = sampleRun(r, local);
      // 门楼避让：两座城门中心 4.5m 内不生成
      let nearGate = false;
      for (const g of gates.centres) {
        if (Math.hypot(sm.p.x - g.x, sm.p.z - g.z) < O.gate.halfClear) { nearGate = true; break; }
      }
      if (nearGate) { gateSkip++; continue; }
      // 塔内不生成雉堞：塔顶自带压顶石当外侧护墙，这里再生成会和它抢面（z-fighting）。
      // 判据沿用上一批的塔楼包围盒，所以断口位置和改前逐米一致。
      if (inAnyTower(sm.p)) { towerMerlonSkip++; continue; }
      const cy = sm.p.y - O.merlon.sink + O.merlon.height / 2;
      const cxz = sm.p.clone().addScaledVector(sm.inN, (offMerOut + offMerIn) / 2);
      mMer.box(
        cxz.x, cy, cxz.z,
        halfLen, O.merlon.height / 2, O.merlon.depth / 2,
        sm.tangent.clone().setY(0).normalize(), _UP, sm.inN,
        O.merlon.skipBottom ? FACE_NO_BOTTOM : FACE_ALL
      );
      merlonCount++;
    }
    globalArc += r.length;
  }
  towerSkipPts = 0;   // 中心线不再被塔楼切断，剔除点数恒为 0

  /* ---- 塔楼通行口 ----
   * ① 侧翼**真洞**：26 片 GLB 的 `Tower_XX_Side` 逐片减掉一个通洞重建（4 块/片），
   *    原节点 `visible = false`（不摘除，随时能切回对比）。
   * ② 内外立面假门洞：石门套并进 `mPar`（同材质 → 同 drawcall），暗色凹体单独一个 mesh。
   */
  const flanks = buildFlanks(frames, { mFlank });
  const hidden = hideTowerFlanks(town, flanks);
  const passages = buildPassages(frames, (offWalkOut + offWalkIn) / 2, { mStone: mPar, mDark });

  /* ---- 合并 + 挂场景 ---- */
  const group = new THREE.Group();
  group.name = 'WallWalk';

  const geoWalk = mergeOrThrow([mWalk.build()], '步道面');
  const geoMer = mergeOrThrow([mMer.build()], '雉堞');
  const geoPar = mergeOrThrow([mPar.build()], '内侧矮护墙 + 内外立面门套');
  const geoDark = mDark.triangles ? mergeOrThrow([mDark.build()], '门洞暗色凹体') : null;
  const geoFlank = mFlank.triangles ? mergeOrThrow([mFlank.build()], '塔楼侧翼真洞') : null;

  const mkMesh = (name, geo, mat) => {
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const meshes = [
    mkMesh('WallWalk_Paving', geoWalk, mats.paving),
    mkMesh('WallWalk_Merlons', geoMer, mats.stone),
    mkMesh('WallWalk_Parapet', geoPar, mats.stone),
    // 侧翼真洞：必须用塔墙本来的 `weathered grey ochre`，换成 `cut pale blocks`
    // 就等于把 26 片侧翼刷白一档 —— 材质一换塔的配色就变了。
    mkMesh('WallWalk_TowerFlanks', geoFlank, mats.flank),
    // `Window deep recess` 是 GLB 独有的材质，门套并进 Parapet（同材质同 drawcall）。
    mkMesh('WallWalk_PassageRecess', geoDark, mats.dark),
  ].filter(Boolean);
  town.add(group);

  const triOf = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const newTriangles = meshes.reduce((s, m) => s + triOf(m.geometry), 0);
  const kindCount = passages.reduce((m, p) => { m[p.kind] = (m[p.kind] || 0) + 1; return m; }, {});

  const payload = {
    centerlinePoints: points.length,
    centerlineSpacingM: spacing,
    centerlinePerimeterM: +perimeter.toFixed(2),
    walkSegments: segCount,
    merlons: merlonCount,
    merlonSkippedAtGate: gateSkip,
    merlonSkippedInTower: towerMerlonSkip,
    parapetSegments: parSegCount,
    parapetSkippedInTower: towerParSkip,
    /** 护墙豁口（第四批）：因阶梯落位而跳过的护墙段数。 */
    parapetSkippedInGap: gapSkip,
    stairGaps: gapList.length,
    stairGapHalfWidthM: STAIR.gap.halfWidthM,
    /** 豁口实际净宽 = 跳过的段数 × 段长（段长 ≈ 中心线周长 / 铺装段数）。 */
    stairGapOpenM: +((gapSkip / Math.max(1, gapList.length)) * (perimeter / Math.max(1, segCount))).toFixed(2),
    /** 净空判据扫了几个盒子（0 = app.js 没传 obstacles，规格 §1.6 没执行）。 */
    stairsClearBoxes: freeBoxes.length,
    stairsClearChecked: obstacles ? 1 : 0,
    stairPlan: {
      count: stairPlan.count,
      perimeterM: stairPlan.perimeterM,
      nominalSpacingM: stairPlan.nominalSpacingM,
      spacingM: stairPlan.spacingM,
      /** 整组候选沿弧长的平移量（0 = 规格原样的等分中点就合法）。 */
      arcOffsetM: stairPlan.arcOffsetM,
      offsetsTried: stairPlan.offsetsTried,
      riserTargetM: STAIR.stair.riserM,
      treadM: STAIR.stair.treadM,
      flightAcrossM: [STAIR.stair.flightFrom, STAIR.stair.flightTo],
      placed: stairPlan.stairs.map((l) => ({
        id: l.id, arcM: l.arcM, centerIndex: l.centerIndex,
        shiftedArcM: l.shiftedArcM, movedAlongArcM: l.movedAlongArcM,
        wallTopY: l.wallTopY, count0: l.count0, length0: l.length0, clearArc: l.clearArc,
      })),
    },
    runs: runnable.length,
    runsSkippedByTower: runs.length - runnable.length,    centerlinePointsInTower: towerSkipPts,
    /** 中心线上落在塔楼包围盒里的点数（改前这些点把墙道切成 14 段，现在直接穿过去） */
    centerlinePointsOverTower: towerPts.filter(Boolean).length,
    towerBlocks: towers.length,
    towerFrames: frames.length,
    /** 塔内过道地板：铺装带穿过塔楼实体的段数（两端的搭接天然连续，无缝无高差） */
    towerDeckSegments: towerDeckSegs,
    passages: passages.length,
    passagesByFace: kindCount,
    passageM: { width: TUNE.passage.width, height: TUNE.passage.height, reveal: TUNE.passage.reveal },
    passageSkippedOpenBack: frames.filter((f) => f.openBack).map((f) => f.id),
    passageDeckY: frames.map((f) => ({ id: f.id, deckY: +(f.deckY + O.walkway.topProud).toFixed(2), halfAlong: f.halfAlong, openBack: f.openBack })),

    /* ---- 第三批：侧翼真洞 ---- */
    /** 正则 `/^Tower_\d\d_Side/` 扫到的侧翼网格数（必须 == 重建数，否则 hideTowerFlanks 会抛）。 */
    towerFlanksScanned: hidden.scanned,
    towerFlanksHidden: hidden.hidden,
    towerFlanksRebuilt: flanks.length,
    towerFlankPieces: flanks.length * 4,
    /** 洞的断面：径向取满空腔，竖直 = 甲板面起净高 2.00m，沿墙贯穿侧翼全厚 1.0m。 */
    tunnelM: flanks.length ? {
      clearWidthM: [Math.min(...flanks.map((b) => b.cavW)), Math.max(...flanks.map((b) => b.cavW))].map((v) => +v.toFixed(2)),
      clearHeightM: TUNE.passage.height,
      flankThicknessM: +frames[0].flankThick.toFixed(2),
      sillDropM: TUNE.passage.tunnel.sillDrop,
    } : null,
    /** 逐塔的洞 / 铺装相交读数（②的实测数字都在这里）。 */
    towerTunnel: frames.map((f) => {
      const deckTop = f.deckY + O.walkway.topProud;
      const sampleU = f.deckU;
      const bandU = [sampleU - O.walkway.to + O.wallHalf, sampleU - O.walkway.from + O.wallHalf];
      const eaten = f.innerBlocksAtDeck ? Math.max(0, Math.min(bandU[1], f.cavIn) - bandU[0]) : 0;
      return {
        id: f.id,
        deckY: +deckTop.toFixed(2),
        deckU: +sampleU.toFixed(3),
        cavIn: +f.cavIn.toFixed(3), cavOut: +f.cavOut.toFixed(3), cavW: +(f.cavOut - f.cavIn).toFixed(3),
        bandU: bandU.map((v) => +v.toFixed(3)),
        bandW: +(bandU[1] - bandU[0]).toFixed(3),
        buriedByInnerWallM: +eaten.toFixed(3),
        clippedW: +(bandU[1] - bandU[0] - eaten).toFixed(3),
        innerBlocksAtDeck: f.innerBlocksAtDeck,
        innerStubH: +f.innerStubH.toFixed(2),
        walkClearM: f.walkClear,
      };
    }),
    towerDeckClippedSegments: deckClipped,
    gates: gates.centres,
    gateGapArc: gates.gapArc,
    walkwayWidthM: +(O.walkway.to - O.walkway.from).toFixed(2),
    merlonDepthM: +(O.merlon.to - O.merlon.from).toFixed(2),
    parapetThickM: +(O.parapet.to - O.parapet.from).toFixed(2),
    bandSumM: +((O.merlon.to - O.merlon.from) + (O.walkway.to - O.walkway.from) + (O.parapet.to - O.parapet.from)).toFixed(2),
    copingWidthM: O.copingWidth,
    walkwayBedDepthM: O.walkway.bedDepth,
    walkwayTopProudM: O.walkway.topProud,
    newTriangles,
    newDrawCalls: meshes.length,
    meshes: meshes.map((m) => ({ name: m.name, triangles: triOf(m.geometry), material: m.material.name })),
  };

  return {
    group,
    meshes,
    centerline: points,
    gates: gates.centres,
    /** 环形接缝落在最大极角间隙之后 —— 也就是城门口。crowd.js 用它对齐自己的接缝。 */
    seamIndex: seam,
    passages,
    towers: frames,
    /** 阶梯落位表（纯数据）。`app.js` 拿它去 `buildWallStairs()` 建 mesh。 */
    stairs: stairPlan,
    /**
     * **按指定的整组平移量试算落位**（只算，不建任何 mesh；非法就返回 `{ok:false, error}`）。
     *
     * 存在的理由：判据「离城门/塔楼多远、背后有没有 13~18m 净空」
     * 要在多个平移量上跑**同一套**合法性判据（`inAnyPassable` / `inAnyTower`
     * + 豁口余量 + 规格 §1.6 的净空）。把这个闭包挂在返回值上，探针就能
     * `A.wall.planStairsAt(x)` 逐个试算；在探针里重写一遍这套判据 = 两份公式迟早分叉，
     * 分叉之后报告里的数就是假的。（`stats()` 里那份是给日志看的纯数据，不带函数。）
     */
    planStairsAt: (offM) => {
      try {
        const r = planStairs({
          centerline: points, count: STAIR.plan.count,
          isBlocked: isStairBlocked, arcOffsets: [offM],
          isFootprintClear: obstacles ? isStairFootprintClear : (() => null),   // 判据见 stats().stairsClearChecked
        });
        return {
          ok: true, arcOffsetM: r.arcOffsetM, spacingM: r.spacingM,
          minSpacingM: Math.min(...r.spacingM), maxSpacingM: Math.max(...r.spacingM),
          arcM: r.stairs.map((l) => l.arcM),
          /* 落定的中心线下标。探针量「离城门/塔楼多远」必须用它，
           * 不能拿 arcM 反查 —— 中心线在两座城门处有 9.73m 的断口，
           * 沿弧长二分在断口附近会落到隔壁点上去。 */
          centerIndex: r.stairs.map((l) => l.centerIndex),
          clearArc: r.stairs.map((l) => l.clearArc),
        };
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 140) };
      }
    },
    stats: () => payload,
  };
}
