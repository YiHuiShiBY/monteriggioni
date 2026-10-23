/**
 * Monteriggioni · 人物系统（Blender 建模资产 → 运行时 15 段刚性骨架）
 * ===========================================================================
 * 上一批这 40 个人是 `BoxGeometry` / `CylinderGeometry` 现场拼的 6 个方块，
 * **84 三角面/人**。近景读出来是「六根方棍插在地上」—— 用户要的就是这个改掉。
 *
 * 本批改成消费 `scripts/character.py` 产出的独立资产 `assets/character.glb`：
 * **9 个刚性部件 / 490 三角面 / 一次实例化**。`Monteriggioni.glb` 零改动。
 *
 * ── 为什么是「9 条 InstancedMesh + 每人 15 个实例」而不是「6 条 + 240 个实例」──
 * 上一批的说明写的是「6 条 = 6 个 drawcall，40 人共用」，本批一度沿用这句话，
 * **那是错的**：关节要能弯，每个刚性段就必须有自己的矩阵，
 * 而 `instanceMatrix` 是 one-instance-one-matrix 的硬限制。
 * 所以：头 / 头巾 / 躯干各 1 个实例，四条肢段（上臂·前臂·手·大腿·小腿·脚）
 * 左右共用几何、各 2 个 ⇒ 40 × 15 = **600 个实例**，
 * drawcall 6 → 9，三角面 3,360 → 25,920。
 * ⇒ **改一处造型就要多一条 drawcall，这是「能弯关节」的价码，不是浪费。**
 *
 * ── 几何从哪来：GLB 的 9 个网格 1:1 对应 9 条 InstancedMesh ────────────────
 * `partGeometries(char)` 从 `character.glb` 的 scene 里按节点名取几何。
 * **这里没有 mergeGeometries 可做**，而且**不该做**：
 * 上一批躯干是「骨盆盒 + 胸廓盒」两个 geometry 合成一件（合完仍 1 个 drawcall），
 * 本批一件就是一个网格，合并会把关节缝焊死 —— 弯肘时前臂会被拽着腋下一起变形。
 * GLB 由 `export_materials='NONE'` 导出（不导材质、不导 UV）：
 * 颜色全走 `instanceColor`，贴图靠 `materials.js` 注入的世界坐标三平面投影。
 *
 * ── 局部系：网页按「几何原点在关节上」摆位 ────────────────────────────────
 * `character.py` 的 `emit()` 把关节原点减进顶点、节点 TRS 留单位阵，
 * 所以每个网格的局部原点**就是它的关节**。这条是被一个真 bug 教出来的：
 * `_limb` 原本在中线造几何而减掉的原点带横向分量 ⇒ 两条腿会挤在同一侧。
 * 它躲过了全部装配读数（`REST_POSE` 里那几条 +HIP_HALF 恰好把错误抵消了），
 * 所以 `tests/_probe-character.mjs` 单独有一条判据盯**局部包围盒**。
 * ⇒ **装配读数正确 ≠ 局部系干净。**
 *
 * ── 材质：不新建裸 MeshStandardMaterial ────────────────────────────────────
 * 与上一批完全同一套纪律（见 `crowdMaterial` 的注释）：人群材质是
 * `Visitors | skin` 那个**已被 materials.js 的 DISPATCH 注入过三平面投影**的实例的克隆，
 * 贴图 / 凹凸 / 环境光强度与全镇那 92 个材质一致，不会掉成白模。
 * `clone()` 不搬 `onBeforeCompile` / `customProgramCacheKey`，这里原样交接。
 *
 * ── 为什么要打 USE_INSTANCING 补丁 ─────────────────────────────────────────
 * `materials.js` 注入的顶点段是
 *     vTriPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
 *     vTriNrm = normalize( mat3( modelMatrix ) * objectNormal );
 * —— **没有乘 instanceMatrix**。实例化之后这会造成两件事：
 *   1. 法线没跟着人转。朝向不同的人被同一套世界方向的光照亮，
 *      一个人转向 90°，正反面的明暗关系整个错掉。
 *   2. 贴图从「贴世界」退化成「贴人」，人一动纹路就跟着滑。
 * 所以在 `<project_vertex>` 之后把 instanceMatrix 补回去。整段包在
 * `#ifdef USE_INSTANCING` 里，非实例化路径（镇子那 92 个材质）原样不变。
 *
 * ── 色域：4 个角色 ──────────────────────────────────────────────────────────
 *   skin    头 / 双臂三段      trouser  双腿三段
 *   cloth   躯干（tunic）      hair     头巾
 * `hair` 是本批新增的第四个角色，取 cloth 02（最深的一档）压暗去饱和。
 * 仍靠 `instanceColor` 逐实例上色，**不新建「每人一套材质」**。
 *
 * ── 步态在 `src/gait.js` ───────────────────────────────────────────────────
 * 骨架、步态、两骨 IK 全部在那个**零依赖**的模块里，人群与玩家共用同一份
 * `poseFigure()`。本文件只负责「把 15 段姿态写进实例矩阵」。
 *
 * three r160 纪律：不引入任何新依赖，不使用 r162+ / r163+ 的 API。
 */

import * as THREE from 'three';
import { normName } from './materials.js';
import {
  RIG, GAIT, SLOT, SLOTS, LEGS, ARMS, newPose, poseFigure,
} from './gait.js';

/* ============================== TUNE ============================== */

export const TUNE = {
  /**
   * 9 条 InstancedMesh，顺序即 `pose.joint` 里的槽段划分。
   *   `per = 1` → 每人 1 个实例，实例下标 = i
   *   `per = 2` → 左右共用同一份几何，实例下标 = i·2 与 i·2+1
   * `slot` 是这个部件占用的第一个槽（`slot + side`）。
   */
  parts: [
    { key: 'head', node: 'char_head', slot: SLOT.head, per: 1, role: 'skin' },
    { key: 'hood', node: 'char_hood', slot: SLOT.hood, per: 1, role: 'hair' },
    { key: 'torso', node: 'char_torso', slot: SLOT.torso, per: 1, role: 'cloth' },
    { key: 'armUpper', node: 'char_armUpper', slot: SLOT.armUpperL, per: 2, role: 'skin' },
    { key: 'armLower', node: 'char_armLower', slot: SLOT.armLowerL, per: 2, role: 'skin' },
    { key: 'hand', node: 'char_hand', slot: SLOT.handL, per: 2, role: 'skin' },
    { key: 'legUpper', node: 'char_legUpper', slot: SLOT.legUpperL, per: 2, role: 'trouser' },
    { key: 'legLower', node: 'char_legLower', slot: SLOT.legLowerL, per: 2, role: 'trouser' },
    { key: 'foot', node: 'char_foot', slot: SLOT.footL, per: 2, role: 'trouser' },
  ],

  /** 标称身高（米）。人群实际身高 = height / nominal × 标称几何。 */
  nominalHeight: 1.80,

  /**
   * 骨架与步态**转发自 gait.js**，不复制第二份。
   * 上一批的 `TUNE.body` / `TUNE.gait` 是两处字面量各自维护，
   * 改一处另一处不动 ⇒ 头飘、髋高对不上。现在只有一份。
   */
  rig: RIG,
  gait: GAIT,

  /**
   * 色域的权威来源 = GLB 里既有的 `Visitors | cloth 00..03` 与 `Visitors | skin`
   * 的 baseColorFactor（`node tests/probe-crowd.mjs --glb` 实测，**线性** RGB）：
   *   cloth 00 (0.62,0.21,0.12)  cloth 01 (0.63,0.67,0.59)
   *   cloth 02 (0.17,0.24,0.31)  cloth 03 (0.73,0.64,0.44)
   *   skin     (0.53,0.34,0.22)
   * 不引入新色相：衣色多出的两组由这 4 色线性插值得到，肤色是 skin 同一暖棕族的
   * 4 档明度，裤色是 cloth 02 压暗。
   */
  color: {
    cloth: [
      [0.62, 0.21, 0.12],   // 00 砖红
      [0.63, 0.67, 0.59],   // 01 灰绿
      [0.17, 0.24, 0.31],   // 02 靛蓝
      [0.73, 0.64, 0.44],   // 03 土黄
      [0.40, 0.455, 0.450], // 01↔02 之间
      [0.675, 0.425, 0.280], // 00↔03 之间
    ],
    skin: [
      [0.72, 0.50, 0.36],    // skin × 1.35
      [0.58, 0.39, 0.27],    // × 1.10
      [0.47, 0.30, 0.19],    // × 0.88
      [0.36, 0.23, 0.15],    // × 0.68
    ],
    trouser: [
      [0.145, 0.204, 0.264],  // cloth 02 × 0.85
      [0.105, 0.149, 0.192],  // cloth 02 × 0.62
      [0.150, 0.150, 0.160],  // cloth 02 去饱和后压暗
    ],
    /**
     * 头巾（第四个材质角色）。**不引入新色相**：全部由 cloth 的四色去饱和后压暗得到
     * —— 头巾离脸近，饱和度高的色会把整张脸的读图抢走。
     */
    hair: [
      [0.105, 0.149, 0.192],  // cloth 02 去饱和 × 0.70
      [0.148, 0.170, 0.165],  // cloth 01 去饱和 × 0.62
      [0.062, 0.082, 0.105],  // cloth 02 去饱和 × 0.42
      [0.205, 0.180, 0.125],  // cloth 03 去饱和 × 0.52
    ],
  },

  /** 材质：从 town 里挑哪个已注入实例当克隆源，以及人群自己独占的 program key。 */
  material: {
    carrier: /^Visitors \| skin/,
    cacheKey: 'monteriggioni-triplanar-v3-people',
  },

  /** 阴影：躯干 + 双腿 + 上臂。头 / 手 / 脚太小，不值得（省一截阴影开销）。 */
  castShadowParts: ['torso', 'legUpper', 'legLower', 'armUpper'],
};

/* ============================ 材质 ============================ */

/** 把 `instanceMatrix` 补回 materials.js 的三平面 varying（见文件头）。 */
const INST_BODY = /* glsl */`
#ifdef USE_INSTANCING
  vTriPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  vTriNrm = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );
#endif
`;

/**
 * 克隆一个已被 materials.js 注入三平面的材质，作为人物专用材质。
 * 与 wallwalk.js 同样的纪律：挑不到就当场抛错，绝不静默回落到 three 默认白材质。
 *
 * `base` 给了就把基色设成它 —— 给**单个**小人用（没有 instanceColor，颜色只能从
 * material.color 来）；不给就是原来的「置白 + 全交给 instanceColor」那套。
 * 注意基色是**线性** RGB，TUNE.color 里那些值就是线性的。
 */
export function crowdMaterial(town, base) {
  let src = null;
  town.traverse((o) => {
    if (src || !o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (TUNE.material.carrier.test(normName(m.name))) { src = m; break; }
    }
  });
  if (!src) throw new Error(`people: town 里找不到 ${TUNE.material.carrier} 对应的已注入材质`);
  if (!src.map || !src.bumpMap || typeof src.customProgramCacheKey !== 'function') {
    throw new Error(`people: 材质「${src.name}」没有三平面注入（applyMaterials 还没跑？）`);
  }

  const m = src.clone();
  // clone() 不搬 onBeforeCompile / customProgramCacheKey，这里原样交接：
  // 闭包里握着 uTriScale / uTriOffset / uTriAmp 等 uniform，丢掉就等于退回白模。
  const inner = src.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    inner(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + INST_BODY);
  };
  // 独立 program：补丁只对人物有意义，也绝不能被镇子那 92 个材质抢先编译掉。
  m.customProgramCacheKey = () => TUNE.material.cacheKey;
  // 色相：给了 base 就用它（单小人），否则置白、全部交给 instanceColor（人群）。
  if (base) m.color.setRGB(base[0], base[1], base[2]);
  else m.color.setRGB(1, 1, 1);
  m.name = `${normName(src.name)} | ${base ? 'player' : 'crowd'}`;
  return m;
}

/* ============================ 几何 ============================ */

/**
 * 从 `assets/character.glb` 的 scene 里取出 9 个部件的几何。
 *
 * ⚠ 名字一律走 `o.userData.name`（GLTFLoader 把原名存在那里；节点名过了
 *   `PropertyBinding.sanitizeNodeName`，把空格换成下划线）。和 crowd.js 的
 *   `rawName()` 同一个理由。挑不到就抛错，绝不静默用默认几何。
 *
 * 导出的 GLB **不带材质也不带 UV**（`export_materials='NONE'`）：
 * 颜色走 instanceColor，贴图靠世界坐标三平面投影，都不需要 UV。
 */
export function partGeometries(char) {
  if (!char || !char.traverse) {
    throw new Error('people: partGeometries 需要 character.glb 的 scene（app.js 里先 await 加载）');
  }
  const out = {};
  char.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.userData.name || o.name || '';
    const spec = TUNE.parts.find((p) => p.node === name);
    if (!spec) return;
    const g = o.geometry;
    if (!g || !g.attributes.position) throw new Error(`people: ${name} 没有 POSITION`);
    if (!g.attributes.normal) throw new Error(`people: ${name} 没有 NORMAL（法线朝外全靠它）`);
    if (out[spec.key]) throw new Error(`people: ${name} 在 GLB 里出现了两次`);
    out[spec.key] = g;
  });
  const miss = TUNE.parts.filter((p) => !out[p.key]).map((p) => p.node);
  if (miss.length) throw new Error(`people: character.glb 里缺部件 —— ${miss.join(' / ')}`);
  return out;
}

/** 一个网格的三角面数（GLB 出来的都是 indexed）。 */
export function triCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

/* ============================ 姿态写入 ============================ */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qA = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _r = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);

/**
 * 把一个人的 15 段姿态写进第 i 个实例。
 * `pose` 由 crowd.js 持有并**逐帧原地改写**（不重新分配）：
 *   { x, y, z, yaw, scale, joint: Float64Array(7) × 15, diag, ankle }
 *   joint[k] = [jx, jy, jz, qx, qy, qz, qw]
 */
export function applyPose(ppl, i, pose) {
  _v.set(pose.x, pose.y, pose.z);
  _q.setFromAxisAngle(_up, pose.yaw);
  _s.setScalar(pose.scale);
  _r.compose(_v, _q, _s);
  for (let k = 0; k < TUNE.parts.length; k++) {
    const spec = TUNE.parts[k];
    const mesh = ppl.meshes[k];
    for (let side = 0; side < spec.per; side++) {
      const a = pose.joint[spec.slot + side];
      _p.set(a[0], a[1], a[2]);
      _qA.set(a[3], a[4], a[5], a[6]);
      _m.compose(_p, _qA, _one);
      _m.premultiply(_r);
      mesh.setMatrixAt(i * spec.per + side, _m);
    }
  }
}

/** 每帧一次：把 600 个实例矩阵推给 GPU。漏了就会看到人卡在原地。 */
export function commitFrame(ppl) {
  for (const m of ppl.meshes) m.instanceMatrix.needsUpdate = true;
}

/* ============================ 主入口 ============================ */

/**
 * 生成 9 条 InstancedMesh，挂进一个新的 Group（由 crowd.js 挂到 town 下）。
 * 必须在 `applyMaterials` **之后**调用。
 *
 * 实例数 = Σ(per) × count = 15 × count。左右肢段用同一份几何、两个实例，
 * 靠 `applyPose` 把第 2i / 2i+1 号实例摆到左 / 右槽位。
 */
export function buildPeople({ town, count, char }) {
  const material = crowdMaterial(town);
  const geos = partGeometries(char);
  const castSet = new Set(TUNE.castShadowParts);

  const meshes = TUNE.parts.map((spec) => {
    const n = count * spec.per;
    const m = new THREE.InstancedMesh(geos[spec.key], material, n);
    m.name = `Crowd_${spec.key}`;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = castSet.has(spec.key);
    m.receiveShadow = false;
    // 人群分散在 200m 见方的镇子里，逐帧动的包围球必然失准；9 个 drawcall、
    // 每人 648 个面，不做视锥剔除比剔除更划算，也顺带让探针量到的增量稳定。
    m.frustumCulled = false;
    m.count = n;
    return m;
  });

  const group = new THREE.Group();
  group.name = 'Crowd';
  for (const m of meshes) group.add(m);

  const instancesPerPerson = TUNE.parts.reduce((s, p) => s + p.per, 0);
  const trianglesPerPerson = TUNE.parts.reduce(
    (s, p) => s + triCount(geos[p.key]) * p.per, 0
  );

  return {
    group, meshes, material, count,
    instancesPerPerson,
    trianglesPerPerson,
    triangles: trianglesPerPerson * count,
    drawCalls: meshes.length,
    instances: meshes.reduce((s, m) => s + m.count, 0),
  };
}

export { RIG, GAIT, SLOT, SLOTS, LEGS, ARMS, newPose, poseFigure };
