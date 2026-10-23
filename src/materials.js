/**
 * Monteriggioni · 三平面材质注入 + 材质分派
 * ---------------------------------------------------------------------------
 * GLB 里 2594 个 primitive 全部没有 TEXCOORD_0，所以常规 map 贴不上。
 * 这里用 onBeforeCompile 把 map / bumpMap / roughness 的采样换成
 * **世界坐标三平面投影**，跨物体尺度一致、无接缝、零额外顶点属性。
 *
 * 注入点（全部在 main() 内，靠替换 three 的 chunk 完成）：
 *   <map_fragment>            → 建立投影上下文 + 采样 albedo + 算 bump 高度
 *   <roughnessmap_fragment>   → 由 bump 高度扰动粗糙度
 *   <normal_fragment_maps>    → 由 bump 梯度扰动法线（世界空间 → 视图空间）
 *
 * r160 纪律：不使用 r162+ 的 AgX / Neutral，也不使用 r163+ 的 Scene.environmentIntensity。
 */

import * as THREE from 'three';
import { DETAIL_SIZE, worldScale } from './textures.js';

/* ======================= GLSL ======================= */

const VERT_PARS = /* glsl */`
varying vec3 vTriPos;
varying vec3 vTriNrm;
uniform float uTriScale;
`;

const VERT_BODY = /* glsl */`
  vTriPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vTriNrm = normalize( mat3( modelMatrix ) * objectNormal );
`;

const FRAG_PARS = /* glsl */`
varying vec3 vTriPos;
varying vec3 vTriNrm;
uniform float uTriScale;
uniform vec2  uTriOffset;
uniform float uTriEps;
uniform float uTriAmp;
uniform float uTriMoist;
uniform float uTriRoughVar;
uniform float uTriFadeNear;
uniform float uTriFadeFar;
uniform float uTriFadeZoom;
uniform float uWet;
uniform float uSnow;
uniform vec3  uSnowCol;
uniform float uDebugNrm;
`;

const FRAG_MAP = /* glsl */`
  // ---- 距离 LOD（必须在采样之前算，后面所有 UV 都用缩放后的 triS）----
  // 草皮这类贴图世界尺度 6.9m 一循环，铺到几百米外会同时出两件事：
  //   ① 欠采样成摩尔纹；② 平铺重复暴露成一张规则网纹。
  //
  // 试过「按距离淡出到贴图均值」——**不行**：远处会变成一片没有明暗起伏的
  // 奶油色死面，地形起伏的阴影全被 bump 淡掉之后连起伏都读不出来了。
  //
  // 改成**把采样尺度拉粗**：远处一张贴图覆盖 1/zoom 倍的世界面积
  // （6.9m → 最远约 46m 一块），高频细节自然欠采样掉，剩下的是大块色调起伏
  // —— 那正是几百米外真实田野该有的读法。bump 与粗糙度扰动同步收掉。
  float triFar  = smoothstep( uTriFadeNear, uTriFadeFar, length( vTriPos - cameraPosition ) );
  float triS    = uTriScale * mix( 1.0, uTriFadeZoom, triFar );

  vec3  triN = normalize( vTriNrm );
  if ( ! gl_FrontFacing ) triN = - triN;
  vec3  triW = pow( abs( triN ), vec3( 5.0 ) );
  triW /= max( triW.x + triW.y + triW.z, 1e-4 );

  vec4 triTex =
      texture2D( map, vTriPos.zy * triS + uTriOffset )     * triW.x
    + texture2D( map, vTriPos.xz * triS + uTriOffset.yx )   * triW.y
    + texture2D( map, vTriPos.xy * triS + uTriOffset )     * triW.z;

  vec3  triAn = abs( triN );
  vec2  triDU, triDV;
  if ( triAn.x >= triAn.y && triAn.x >= triAn.z )      { triDU = vec2( 0.0, 1.0 ); triDV = vec2( 1.0, 0.0 ); }
  else if ( triAn.y >= triAn.z )                      { triDU = vec2( 1.0, 0.0 ); triDV = vec2( 0.0, 1.0 ); }
  else                                                { triDU = vec2( 1.0, 0.0 ); triDV = vec2( 0.0, 1.0 ); }
  vec2  triBaseUV = ( triAn.x >= triAn.y && triAn.x >= triAn.z
      ? vTriPos.zy : ( triAn.y >= triAn.z ? vTriPos.xz : vTriPos.xy ) ) * triS + uTriOffset;
  float triStepK = triS * uTriEps;
  float triH0 = 0.5, triHx = 0.5, triHy = 0.5;
  #ifdef USE_BUMPMAP
    triH0 = texture2D( bumpMap, triBaseUV ).x;
    triHx = texture2D( bumpMap, triBaseUV + triDU * triStepK ).x;
    triHy = texture2D( bumpMap, triBaseUV + triDV * triStepK ).x;
  #endif

  diffuseColor.rgb *= triTex.rgb * uTriAmp;

  // ---- 天气：积雪与雨水 ----
  // 判据一律用 **triN.y（世界法线的竖直分量）**，不是屏幕空间、也不是模型局部 Y ——
  // 转相机时雪不会跟着跑到侧面上。
  float triUp  = clamp( triN.y, 0.0, 1.0 );
  // 积雪：只落在朝上的面。用 bump 高度把 mask 打散，否则像刷了一层白漆。
  float triSnowM = clamp( uSnow * smoothstep( 0.30, 0.78, triUp ) * ( 0.72 + 0.56 * triH0 ), 0.0, 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.30 + uSnowCol, triSnowM );
  // 雨水：湿面反照率下降（实测干草 0.48 → 湿面约 0.18~0.25），
  // 但只有朝上的面真正存水，竖直面几乎不湿。
  diffuseColor.rgb *= mix( 1.0, 0.60, uWet * ( 0.30 + 0.70 * triUp ) );

  if ( uTriMoist > 0.0 ) {
    float m = uTriMoist * exp( - max( vTriPos.y - 0.15, 0.0 ) * 2.6 );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.34, 0.36, 0.27 ), clamp( m, 0.0, 0.82 ) );
  }

  /* ---- 调试出口：把着色器**真正看到的**法线画成颜色 ----
   * 为什么需要：判据问的「这个像素是不是朝上」，射线量的是 hit.face.normal
   * （**面**法线），而这段代码量的是 vTriNrm（**插值后**的顶点法线）。
   * 实测城墙 Curtain 的面法线均值 y = −0.0000（纯竖直面），
   * 顶点法线里却有 16.7% 的 y > 0.30 —— 两者对不上，
   * 而「雪爬到墙上」这个现象正是从这 16.7% 来的。
   * 探针不用猜：把 uDebugNrm 置 1，直接从像素读回 triN.y。
   * 平时恒为 0，零成本。
   *
   * ⚠ 写这段注释时踩了两次：GLSL 块是**模板字符串**，
   * 注释里出现反引号会提前闭合模板，materials.js 整个模块变成 SyntaxError，
   * 页面零异常停在加载层 0%。
   * 而且**光靠 node --check 抓不到** —— 它对无 type:module 的 .js 用的是
   * script 解析目标，浏览器用的是 module 目标，两者在
   * 「模板字符串提前闭合」这类地方结论相反（实测 --check 退出码 0，import 抛错）。
   * ⇒ 本文件里**一个反引号都不许出现**；改完跑 tests/check-syntax.mjs，
   *   它把文件拷成 .mjs 再查，强制 module 目标。 */
  if ( uDebugNrm > 0.5 ) {
    diffuseColor.rgb = vec3( clamp( triN.y, 0.0, 1.0 ), clamp( triN.y * 0.5 + 0.5, 0.0, 1.0 ), 0.0 );
  }
`;

const FRAG_ROUGH = /* glsl */`
  // 湿面变光滑 → 天空 IBL 在地面拉出长条高光，这是「刚下过雨」最认得出的一个信号。
  float triWetM = uWet * ( 0.30 + 0.70 * clamp( triN.y, 0.0, 1.0 ) );
  float roughnessFactor = clamp( roughness
    + ( triH0 - 0.5 ) * uTriRoughVar * ( 1.0 - triFar )
    - triWetM * 0.66, 0.03, 1.0 );
`;

const FRAG_NORMAL = /* glsl */`
  #ifdef USE_BUMPMAP
    // 注意分母：采样步长 triStepK 是 UV 单位，换回世界尺度要再除一次 triS，
    // 即世界步长正好是 uTriEps（米）。早前误用 triStepK 当分母，法线被放大 4 倍，
    // 灰缝边缘于是到处炸出白色高光斑。
    // 另：采样尺度被距离 LOD 拉粗过，bump 特征在世界里同步变大，所以这里直接
    // 按 (1 - triFar) 把浮雕收掉 —— 远处本来也看不见 4mm 的起伏。
    vec2 triG = vec2( triHx - triH0, triHy - triH0 ) / uTriEps;
    vec3 triT = normalize( vec3( triDU.x, 0.0, triDU.y ) );
    vec3 triB = normalize( vec3( triDV.x, 0.0, triDV.y ) );
    vec3 triGS = triT * triG.x + triB * triG.y;
    triGS -= triN * dot( triGS, triN );
    // bumpScale 的物理含义 = 浮雕实际深度（米）。3.2 cm 的灰缝 → 0.03 左右。
    vec3 triNW = normalize( triN - triGS * ( bumpScale * ( 1.0 - triFar ) ) );
  #else
    vec3 triNW = triN;
  #endif
  normal = normalize( ( viewMatrix * vec4( triNW, 0.0 ) ).xyz );
`;

/* ======================= 注入 ======================= */

const CACHE_KEY = 'monteriggioni-triplanar-v2';

/** 每个已注入材质的原始参数。放 WeakMap 而不是 userData ——
 *  `Material.copy()` 会对 userData 做 JSON 深拷贝，Texture 进去就废了。 */
const TRI_PARAMS = new WeakMap();

/**
 * 已注入材质的 uniform 表：material.uuid → onBeforeCompile 里那个 shader.uniforms。
 *
 * 为什么不用 userData 存它：`Material.copy()` 对 userData 做 **JSON 深拷贝**，
 * 存进去的 `{value: 0.5}` 会变成一份**当时的快照**，之后再改原对象克隆件就跟着不动 ——
 * 而 `cloneInjected` 正好要 clone。放 Map 里按 uuid 索引，绕开这条。
 *
 * 天气的湿/雪/夜间辉光就是靠这张表在运行时改 uniform 值，
 * **不新建材质、不重编译 program**（所有注入材质共用一个 customProgramCacheKey）。
 */
const TRI_UNIFORMS = new Map();
const INJECTED = [];

/** 取全部已注入材质（weather.js 调它来统一改环境光强度 / 窗光）。 */
export function injectedMaterials() {
  return INJECTED;
}

/** 取某个已注入材质当前生效的 uniform 表（探针自证「uniform 真的被驱动了」用）。 */
export function getUniforms(mat) {
  return TRI_UNIFORMS.get(mat.uuid) || null;
}

/**
 * 给一个 MeshStandardMaterial 装上三平面着色。
 * 所有被注入的材质共用同一个 customProgramCacheKey → 只编译一个 program。
 */
function injectTriplanar(material, p) {
  material.map = p.map;
  material.bumpMap = p.detail;
  material.bumpScale = p.bumpScale;
  material.needsUpdate = true;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: p.scale };
    shader.uniforms.uTriOffset = { value: p.offset };
    shader.uniforms.uTriEps = { value: 1.0 / (DETAIL_SIZE * p.scale) };
    shader.uniforms.uTriAmp = { value: p.amp };
    shader.uniforms.uTriMoist = { value: p.moist || 0 };
    shader.uniforms.uTriRoughVar = { value: p.roughVar || 0 };
    shader.uniforms.uTriFadeNear = { value: p.fade ? p.fade.near : 1e9 };
    shader.uniforms.uTriFadeFar = { value: p.fade ? p.fade.far : 2e9 };
    shader.uniforms.uTriFadeZoom = { value: p.fade ? p.fade.zoom : 1.0 };
    shader.uniforms.uWet = { value: p.wet || 0 };
    shader.uniforms.uSnow = { value: p.snow || 0 };
    shader.uniforms.uSnowCol = { value: p.snowCol || new THREE.Color(0.82, 0.85, 0.90) };
    /** 调试出口：>0.5 时把 triN.y 画成红色通道（见 FRAG_MAP 末尾）。默认关。 */
    shader.uniforms.uDebugNrm = { value: p.debugNrm || 0 };
    // 记下这张表：天气模块要靠它在运行时改 uniform 值（见 TRI_UNIFORMS 的注释）。
    TRI_UNIFORMS.set(material.uuid, shader.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL);
  };
  material.customProgramCacheKey = () => CACHE_KEY;
}

/* ======================= 分派表 ======================= */

/**
 * tinted=true  → 贴图自带完整颜色，材质 baseColor 置白
 * tinted=false → 贴图是明度调制图，材质保留自身 baseColor（色相信息在 GLB 里）
 *
 * bump 的单位是「浮雕实际深度（米）」，不是 three 默认的任意倍数。
 * detail 贴图是 0..1 归一化高度、一个 texel = 1/(256×scale) 米，
 * 所以 DISPATCH 里给的值要按真实起伏量给：条石灰缝 3.5mm、抹面 2mm、
 * 铺石 3mm。以前直接给 0.024~0.034（≈2.5cm 的浮雕）会把法线整体掀翻，
 * 广场铺石在近景就会碎成黑白棋盘。
 *
 * envMapIntensity 压到 0.70 是为了压住朝上的面（垛口顶面、女墙走道）：
 * 它们正对天顶，法线方向的天空 IBL 全额吃进去，强度 0.80 时会烧成一片死白。
 */
const DISPATCH = [
  { test: /Village roof/,                   recipe: 'roof',     tinted: false, rough: 0.78, metal: 0.0, bump: 0.004, env: 0.95, roughVar: 0.16 },
  { test: /Limestone \| cut pale blocks/,  recipe: 'stonePale',tinted: true,  rough: 0.86, metal: 0.0, bump: 0.0035, env: 0.70, roughVar: 0.20 },
  { test: /Limestone \| weathered grey ochre/, recipe: 'stoneOchre', tinted: true, rough: 0.88, metal: 0.0, bump: 0.0040, env: 0.70, roughVar: 0.22 },
  { test: /Limestone \| damp base/,        recipe: 'stoneDamp',tinted: true,  rough: 0.72, metal: 0.0, bump: 0.0040, env: 0.80, roughVar: 0.18, moist: 0.62 },
  { test: /Village masonry/,               recipe: 'rubble',   tinted: true,  rough: 0.87, metal: 0.0, bump: 0.0040, env: 0.70, roughVar: 0.20 },
  { test: /Tuscan lime plaster/,           recipe: 'plaster',  tinted: true,  rough: 0.90, metal: 0.0, bump: 0.003, env: 0.85, roughVar: 0.16 },
  { test: /Piazza \|/,                     recipe: 'flag',     tinted: true,  rough: 0.90, metal: 0.0, bump: 0.004, env: 0.95, roughVar: 0.18 },
  { test: /Paths \|/,                      recipe: 'path',     tinted: true,  rough: 0.93, metal: 0.0, bump: 0.006, env: 0.95, roughVar: 0.18 },
  { test: /Gardens \|/,                    recipe: 'lawn',     tinted: true,  rough: 0.95, metal: 0.0, bump: 0.004, env: 1.00, roughVar: 0.12 },
  { test: /Land \| sun dried/,             recipe: 'wild',     tinted: true,  rough: 0.95, metal: 0.0, bump: 0.004, env: 1.00, roughVar: 0.12 },
  { test: /Land \| warm cultivated/,       recipe: 'soil',     tinted: true,  rough: 0.95, metal: 0.0, bump: 0.006, env: 0.95, roughVar: 0.18 },
  { test: /Vineyards \|/,                  recipe: 'vine',     tinted: true,  rough: 0.95, metal: 0.0, bump: 0.006, env: 0.95, roughVar: 0.18 },
  { test: /^(Vineyard foliage|Oak leaves|Olive leaves|Cypress)/,
                                                       recipe: 'foliage',  tinted: false, rough: 0.86, metal: 0.0, bump: 0.003, env: 0.90, roughVar: 0.14, leaf: true },
  { test: /Shutters \|/,                   recipe: 'shutter',  tinted: false, rough: 0.72, metal: 0.0, bump: 0.005, env: 0.90, roughVar: 0.16 },
  { test: /^(Aged chestnut timber|Trees \|)/, recipe: 'timber', tinted: false, rough: 0.84, metal: 0.0, bump: 0.004, env: 0.80, roughVar: 0.18 },
  { test: /Cut earth \|/,                  recipe: 'strata',   tinted: false, rough: 0.95, metal: 0.0, bump: 0.005, env: 0.90, roughVar: 0.18 },
  { test: /Well \|/,                       recipe: 'water',    tinted: false, rough: 0.07, metal: 0.0, bump: 0.003, env: 2.00, roughVar: 0.04 },
  { test: /Forged dark iron/,              recipe: 'grain',    tinted: false, rough: 0.45, metal: 0.85, bump: 0.002, env: 1.10, roughVar: 0.14 },
  { test: /Campanile \| aged bronze/,      recipe: 'grain',    tinted: false, rough: 0.35, metal: 0.90, bump: 0.002, env: 1.30, roughVar: 0.14 },
  { test: /Cafe parasols \|/,              recipe: 'grain',    tinted: false, rough: 0.62, metal: 0.0, bump: 0.003, env: 1.10, roughVar: 0.12 },
  { test: /.*/,                            recipe: 'grain',    tinted: false, rough: 0.84, metal: 0.0, bump: 0.003, env: 0.90, roughVar: 0.14 },
];

const lin2srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function hashName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

function dispatchOf(name) {
  for (const d of DISPATCH) if (d.test.test(name)) return d;
  return DISPATCH[DISPATCH.length - 1];
}

/**
 * 把整套 GLB 材质换成三平面版本。
 * @param {THREE.Object3D} town
 * @param {Object<string,{map:THREE.Texture,detail:THREE.Texture}>} tex
 * @returns {{count:number, tinted:number, leafFixed:number}}
 */
export function applyMaterials(town, tex) {
  const seen = new Map();
  town.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of list) if (!seen.has(m.uuid)) seen.set(m.uuid, m);
  });

  // 92 个材质逐一换成三平面版本。
  let tinted = 0, leafFixed = 0;
  for (const m of seen.values()) {
    const d = dispatchOf(m.name);
    const pair = tex[d.recipe];
    if (!pair) continue;

    // 叶片：GLB 导出的反照率过暗（0.036–0.22），新光照下会一片死黑。
    if (d.leaf) {
      const c = m.color;
      const maxc = Math.max(c.r, c.g, c.b) || 1;
      const k = Math.min(3.6, Math.max(1, 0.145 / maxc));
      c.setRGB(c.r * k, c.g * k, c.b * k);
      leafFixed++;
    }

    const r1 = hashName(m.name + 'a'), r2 = hashName(m.name + 'b');
    const scale = worldScale[d.recipe];

    const params = {
      map: pair.map,
      detail: pair.detail,
      scale,
      offset: new THREE.Vector2(r1 * 4.0, r2 * 4.0),
      amp: 1.0,
      moist: d.moist || 0,
      bumpScale: d.bump,
      roughVar: d.roughVar,
      /** 距离 LOD 区间（米）。默认 null = 永不淡出，只有 cloneInjected 会覆写。 */
      fade: null,
      /** 天气：0..1。默认 0，weather.js 在运行时改的是 uniform 值不是这个。 */
      wet: 0,
      snow: 0,
      snowCol: null,
    };
    injectTriplanar(m, params);
    TRI_PARAMS.set(m, params);
    if (!INJECTED.includes(m)) INJECTED.push(m);

    if (d.tinted) { m.color.setRGB(1, 1, 1); tinted++; }
    m.roughness = d.rough;
    m.metalness = d.metal;
    m.envMapIntensity = d.env;
    m.shadowSide = THREE.FrontSide;   // 双面材质用 FrontSide 渲阴影，避免自阴影痤疮
  }

  return { count: seen.size, tinted, leafFixed };
}

/**
 * GLB 里材质名带 Blender 导出的 ` | GLB` 尾巴（例：`Paths | pale crushed limestone | GLB`）。
 * 烘贴图时是按「前缀」引用的，所以查表必须用前缀匹配 + 归一化，
 * 否则查不到就静默回落到中性米色 —— 整片地面/石墙会一起变成一坨白。
 */
export function normName(name) {
  return String(name || '').replace(/\s*\|\s*GLB\s*$/, '').trim();
}

/**
 * 克隆一个**已注入三平面**的材质，并允许覆写注入参数（距离 LOD 等）。
 *
 * 为什么不能直接 `material.clone()`：three 的 `Material.copy()` **不复制**
 * `onBeforeCompile`，也不复制 `customProgramCacheKey`。克隆出来的是一个
 * 没有任何注入的白模 —— 贴图、bump、三平面全丢，渲染结果直接退回 GLB 原色。
 * 所以必须拿着原始参数重新注入一次。
 *
 * @param {THREE.Material} src applyMaterials 处理过的材质实例
 * @param {Object} override 覆写字段，如 `{ fade: { near: 170, far: 560 } }`
 */
export function cloneInjected(src, override = {}) {
  const p = TRI_PARAMS.get(src);
  if (!p) throw new Error('cloneInjected: 源材质没有注入记录（applyMaterials 还没跑？）');
  const m = src.clone();
  const next = { ...p, ...override };
  injectTriplanar(m, next);
  // clone() 只带走了 color/roughness/metalness/envMapIntensity 这些标量，
  // 上面 applyMaterials 里设的 shadowSide 也要补，否则远景不参与阴影。
  m.shadowSide = THREE.FrontSide;
  m.needsUpdate = true;
  TRI_PARAMS.set(m, next);
  if (!INJECTED.includes(m)) INJECTED.push(m);
  return m;
}

/**
 * 运行时改**全部**已注入材质的天气 uniform。
 * 这是天气系统作用到全场景表面的唯一入口 —— 不新建材质、不重编译。
 */
export function setWeatherUniforms({ wet, snow, snowColor }) {
  for (const m of INJECTED) {
    const u = TRI_UNIFORMS.get(m.uuid);
    if (!u) continue;
    if (u.uWet) u.uWet.value = wet;
    if (u.uSnow) u.uSnow.value = snow;
    if (u.uSnowCol && snowColor) u.uSnowCol.value.copy(snowColor);
  }
}

/**
 * 调试视图开关：打开后所有注入材质把 `triN.y` 画成颜色。
 * 红通道 = clamp(triN.y, 0, 1)，绿通道 = triN.y * 0.5 + 0.5（0.5 = 水平）。
 * 平时恒关，只给探针用（见 FRAG_MAP 末尾的注释：为什么要这条出口）。
 */
export function setDebugNormalView(on) {
  for (const m of INJECTED) {
    const u = TRI_UNIFORMS.get(m.uuid);
    if (u && u.uDebugNrm) u.uDebugNrm.value = on ? 1 : 0;
  }
}

/** 供 textures.js 在烘焙阶段查询材质固有色（前缀匹配，命中不了的给中性回退）。 */
export function tintLookupFor(town) {
  const list = [];
  town.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    for (const m of (Array.isArray(obj.material) ? obj.material : [obj.material])) {
      list.push({ key: normName(m.name), color: m.color });
    }
  });
  return (name) => {
    const key = normName(name);
    let hit = list.find((e) => e.key === key);
    if (!hit) hit = list.find((e) => e.key.startsWith(key));
    if (!hit) return [0.6, 0.58, 0.52];
    const c = hit.color;
    return [lin2srgb(c.r), lin2srgb(c.g), lin2srgb(c.b)];
  };
}
