/**
 * Monteriggioni · 天气系统
 * ===========================================================================
 * 四种可切换天气：**晴天 / 夜晚 / 雨天 / 雪天**，覆盖整个大场景。
 *
 * 设计的核心判断：**天气主要是着色问题，不是粒子问题。**
 * 雨看起来像雨，靠的是地面变暗变滑、天空压成一块没方向的灰；
 * 雪看起来像雪，靠的是**朝上的面变白**。这两件事都能在材质里做完，
 * 粒子只是最后加上去的那层「证据」。
 *
 *   湿   → 湿面反照率下降（干草 0.48 → 湿面约 0.18~0.25）+ 粗糙度压低，
 *          天空 IBL 在地面拉出长条高光。这是「刚下过雨」最认得出的信号。
 *   雪   → 只加在**世界法线朝上**的面（triplanar 注入里判 `triN.y`），
 *          并用 bump 高度把 mask 打散，否则像刷了一层白漆。
 *   夜   → 月光 + 深蓝环境 + **窗自发光** + 地平线暖辉光。
 *
 * 四条工程约束（都踩过才写下来的）：
 *   1. **不加运行时灯光**。three r160 每加一盏灯都会改 shader permutation，
 *      2.6M 面的场景要重编译全部 program —— 切一次天气卡几秒，不能接受。
 *      夜里的暖意靠「窗自发光 + envGround 变暖 + 提曝光」三件不需要新灯的事。
 *   2. **天气只改 uniform 值，不新建材质**。所有注入材质共用一个
 *      `customProgramCacheKey`，共用一份编译结果；改 `uWet/uSnow` 零重编译。
 *   3. **IBL 要重烘**。雾色和天光一变，PMREM 就过期；过渡结束时重烘一次，
 *      过渡过程中靠 `envIntensity` 跟随，避免每帧都烘。
 *   4. **粒子各自 1 个 drawcall**，且随天气显隐 —— 不在场就不占预算。
 *
 * 预算：晴天 0，雨天 +1，雪天 +1（互斥）。场景总量约 265 万三角面。
 */

import * as THREE from 'three';
import { TUNE } from './lighting.js';
import { applySkyWeather, buildEnvironment } from './sky.js';
import { injectedMaterials, setWeatherUniforms, setDebugNormalView, getUniforms, normName } from './materials.js';

/* 线性空间的颜色助手：THREE.Color.setRGB 默认就是线性，方便直接给物理量。 */
const L = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
const D = (hex) => new THREE.Color(hex);          // hex 走 sRGB→线性，UI 取色用

/* ======================= 四套预设 =======================
 * 每一项都必须给出**全部**字段，缺一个就会在过渡中变成 undefined。
 * clear 的数值就是原先 lighting.js TUNE 里那套调好的午后光，
 * 必须逐字对得上 —— 否则「切回晴天」会悄悄改变原本验收过的画面。
 */
export const PRESETS = {
  clear: {
    label: '晴天',
    sunElevDeg: 42, sunAzimDeg: 68,
    sunColor: D(0xffeccd), sunIntensity: 3.55,
    hemiSky: D(0xb5b2a4), hemiGround: D(0xb59468), hemiIntensity: 0.30,
    skyTop: L(0.055, 0.150, 0.400), skyMid: L(0.235, 0.410, 0.680),
    skyHaze: L(0.910, 0.805, 0.620), skyGround: L(0.420, 0.395, 0.290),
    skyHazeLow: L(0.235, 0.252, 0.270), skySunColor: L(2.60, 2.10, 1.42),
    hazeTop: 0.085, midTop: 0.55,
    overcast: 0, flatTint: L(0.30, 0.31, 0.33),
    stars: 0, horizonGlow: L(0.30, 0.17, 0.06), horizonGlowAmt: 0,
    fogColor: 0xd3c5a8, fogDensity: 0.00170,
    exposure: 0.86, envIntensity: 1.0,
    envGroundColor: L(0.205, 0.150, 0.092), envGroundLift: 0.10,
    wet: 0, snow: 0, snowColor: L(0.82, 0.85, 0.90),
    windowGlow: 0, precip: 'none', rainAmount: 0, snowAmount: 0,
  },

  night: {
    label: '夜晚',
    // 月亮：低强度冷色。方位与晴天同侧，保留已验收过的投影方向关系。
    sunElevDeg: 38, sunAzimDeg: 74,
    sunColor: D(0x9fb8e8), sunIntensity: 0.34,
    hemiSky: D(0x1b2a4a), hemiGround: D(0x0a0c14), hemiIntensity: 0.16,
    skyTop: L(0.008, 0.014, 0.038), skyMid: L(0.020, 0.038, 0.086),
    skyHaze: L(0.085, 0.098, 0.150), skyGround: L(0.030, 0.034, 0.048),
    skyHazeLow: L(0.010, 0.012, 0.020), skySunColor: L(0.70, 0.80, 1.05),
    hazeTop: 0.14, midTop: 0.60,
    overcast: 0, flatTint: L(0.03, 0.04, 0.07),
    stars: 1, horizonGlow: L(0.185, 0.105, 0.038), horizonGlowAmt: 1,
    fogColor: 0x141a28, fogDensity: 0.00210,
    // 夜里必须提曝光，否则 ACES 压完只剩一片黑；提曝光 ≠ 变白天。
    exposure: 1.18, envIntensity: 1.0,
    // 镇里亮着窗，往上传的暖回弹 —— 这一层就是夜里的「路灯」。
    envGroundColor: L(0.062, 0.040, 0.020), envGroundLift: 0.12,
    wet: 0, snow: 0, snowColor: L(0.82, 0.85, 0.90),
    windowGlow: 1, precip: 'none', rainAmount: 0, snowAmount: 0,
  },

  rain: {
    label: '雨天',
    // 太阳压到很低的强度：阴天里直射光大约只剩 5~10%。
    sunElevDeg: 34, sunAzimDeg: 68,
    sunColor: D(0xcfd6de), sunIntensity: 0.80,
    hemiSky: D(0x8e99a6), hemiGround: D(0x4c4a44), hemiIntensity: 0.90,
    skyTop: L(0.130, 0.145, 0.168), skyMid: L(0.185, 0.200, 0.222),
    skyHaze: L(0.300, 0.315, 0.335), skyGround: L(0.160, 0.168, 0.178),
    skyHazeLow: L(0.085, 0.090, 0.098), skySunColor: L(0.85, 0.88, 0.95),
    hazeTop: 0.30, midTop: 0.70,
    overcast: 0.92, flatTint: L(0.175, 0.188, 0.205),
    stars: 0, horizonGlow: L(0.30, 0.17, 0.06), horizonGlowAmt: 0,
    /* 雾密度 0.0062 是**按错误参考算的**，第一版直接照着「雨天要很闷」拍的脑袋值。
     * FogExp2 是 exp(-(density·depth)²)：航拍机位 283m 处
     *   0.0062 → (1.755)² = 3.08 → exp(-3.08) = **0.046**，即 95% 的画面被雾吃掉，
     *   整座镇子糊成一片均匀的蓝灰剪影，屋瓦、砌缝、树冠全部消失。
     * 像素判据当时全绿（雨让朝上面变暗 ✓、竖直面几乎不变 ✓），
     * **是看图才发现画面不能看** —— 这就是目视验收存在的理由。
     * 0.0030 在 283m 处留 ~50%（(0.849)²=0.72 → 0.49），近机位 26m 处只吃 0.6%。 */
    fogColor: 0x6e7780, fogDensity: 0.00300,
    exposure: 1.04, envIntensity: 1.0,
    envGroundColor: L(0.085, 0.088, 0.082), envGroundLift: 0.16,
    wet: 1, snow: 0, snowColor: L(0.82, 0.85, 0.90),
    /* 窗户只在夜里点。雨天留 0.45 会变成「下午三点家家亮灯」——
     * 第一版就是这么写的，看图才发现不对。留一点点当室内灯的余晖。 */
    windowGlow: 0.12, precip: 'rain', rainAmount: 1, snowAmount: 0,
  },

  snow: {
    label: '雪天',
    // 雪天比雨天亮得多（高反照率），但对比度更低、阴影最软。
    sunElevDeg: 30, sunAzimDeg: 66,
    sunColor: D(0xeef2f8), sunIntensity: 0.95,
    hemiSky: D(0xd8e2ee), hemiGround: D(0x9aa0a6), hemiIntensity: 0.95,
    skyTop: L(0.300, 0.335, 0.390), skyMid: L(0.420, 0.455, 0.500),
    skyHaze: L(0.620, 0.650, 0.690), skyGround: L(0.430, 0.450, 0.480),
    skyHazeLow: L(0.300, 0.315, 0.335), skySunColor: L(1.10, 1.15, 1.25),
    hazeTop: 0.34, midTop: 0.75,
    overcast: 0.95, flatTint: L(0.480, 0.510, 0.560),
    stars: 0, horizonGlow: L(0.30, 0.17, 0.06), horizonGlowAmt: 0,
    /* 雪天雾密度 0.00520 → 0.00270。
     * 原来的 0.00520 只在 gate 机位（26m）下验过，那里雾只吃 1.8%，
     * 那个「白茫茫」其实全部来自雪面反照率、跟雾没关系 —— 结论下得太早。
     * 航拍 283m 处 (0.0052*283)²=2.17 ⇒ exp=0.115 ⇒ 88.5% 画面被雾色替掉，
     * 屋顶、墙、地面糊成同一片白，镇子读不出来了（目视才发现，像素判据全绿）。
     * 0.00270：283m 处 exp=0.558（留 56% 场景 + 44% 空气透视），
     * 26m 处 0.5%、40m 处 1.2% —— 近机位几乎不受影响。
     * ⇒ 雾密度定值必须在**最远的那个机位**上验，不能在好看的那个机位上验。 */
    fogColor: 0xb9c4cf, fogDensity: 0.00270,
    exposure: 0.92, envIntensity: 1.0,
    // 雪面把光往上返，所以环境层的「地面」也偏亮偏冷。
    envGroundColor: L(0.300, 0.320, 0.350), envGroundLift: 0.14,
    wet: 0.18, snow: 1, snowColor: L(0.88, 0.90, 0.94),
    windowGlow: 0.35, precip: 'snow', rainAmount: 0, snowAmount: 1,
  },
};

export const WEATHER_NAMES = ['clear', 'night', 'rain', 'snow'];

/* ======================= 雨 ======================= */

const RAIN_VERT = /* glsl */`
attribute vec3 aSeed;      // x=初始 x, y=初始 z, z=相位
attribute float aEnd;      // 0=雨条头, 1=雨条尾
uniform float uTime, uSpeed, uBoxH, uRadius, uLen, uWind, uFade;
varying float vAlpha;
void main() {
  // 雨条头：按时间在一段固定高度里循环下落
  float y = uBoxH * fract( aSeed.z - uTime * uSpeed / uBoxH );
  vec3 head = vec3( aSeed.x, y, aSeed.y );
  // 风把雨吹斜，斜率随高度（越高风越大）
  head.x += uWind * y * 0.11;

  // 体积跟着相机走：把相对坐标 wrap 进一个以相机为心的盒子。
  // 这是雨雪「哪里都能下」的全部秘密 —— 不需要真的把几千个粒子铺满 1300m。
  vec3 rel = head - cameraPosition;
  rel = mod( rel + uRadius, 2.0 * uRadius ) - uRadius;
  vec3 world = cameraPosition + rel;

  float d = length( rel );
  /* **近场必须淡出。** 相机就在雨体积盒内部，一条 2.2m 的雨条在 3m 处
   * 会占掉小半个屏幕 —— 整幅画变成一片白色划痕，完全不像雨。
   * 真实的雨在镜头前一两米是看不见的（失焦、也超出人眼分辨），
   * 所以这里让 2m 内完全消失、9m 才完全显现。 */
  vAlpha = ( 1.0 - smoothstep( uFade * 0.35, uFade, d ) )
         * smoothstep( 2.0, 9.0, d )
         * smoothstep( 0.0, 6.0, y );

  vec3 pos = world - vec3( uWind * uBoxH * 0.028 * aEnd, aEnd * uLen, 0.0 );
  gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
}
`;

const RAIN_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAmount;
varying float vAlpha;
void main() {
  if ( vAlpha * uAmount <= 0.002 ) discard;
  gl_FragColor = vec4( uColor, vAlpha * uAmount );
}
`;

/** 体积盒的半宽。雨与雪共用一个量级，uFade 必须小于它，否则会露出盒子的壁。 */
const BOX_R = 80.0;

/* 种子必须**直接铺满整个盒子**。
 *
 * 踩过的坑（看图才发现的）：原来种子在单位圆盘里生成（aSeed.x/y ∈ [-1,1]），
 * 指望 shader 里的 `mod(head - cameraPosition, 2R) - R` 把它铺开。
 * 但对「相机 40m 外的一个单位圆盘」做模运算，得到的是**同一个点的周期像** ——
 * 6000 条雨滴实际坍缩成几乎同一位置，画面上一条都看不见；
 * 雪花同样坍缩，于是航拍图里雪粒是**聚在左上角一簇**，而不是一场雪。
 * 看起来像「粒子参数调得不好」，真因是分布根本没铺开。
 *
 * 正确做法：种子直接生成在半径 BOX_R 的圆盘里，wrap 只负责让盒子跟着相机平移。
 * 相机在盒内时 wrap 是恒等映射，分布天然均匀。 */

/** 盒内一个随机点（水平圆盘 + 相位），返回 [x, z, phase]。 */
function seedInBox() {
  const ang = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * BOX_R;
  return [Math.cos(ang) * r, Math.sin(ang) * r, Math.random()];
}

function makeRain(count) {
  const g = new THREE.BufferGeometry();
  const seed = new Float32Array(count * 2 * 3);
  const end = new Float32Array(count * 2);
  const pos = new Float32Array(count * 2 * 3);          // 占位，shader 自己算
  let k = 0;
  for (let i = 0; i < count; i++) {
    // 雨条的两端共用 x/z（只差相位与端点标记），所以种子取一次填两遍
    const [x, z, ph] = seedInBox();
    for (let e = 0; e < 2; e++) { seed[k * 3] = x; seed[k * 3 + 1] = z; seed[k * 3 + 2] = ph; end[k] = e; k++; }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);   // 永远跟着相机，交给 GPU 剔除不了

  const m = new THREE.ShaderMaterial({
    name: 'RainStreaks',
    transparent: true, depthWrite: false, fog: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 }, uSpeed: { value: 17.0 }, uBoxH: { value: 46.0 },
      /* 雨条 1.15m 在航拍 283m 外只剩约 3px，又和有雾天空同为中灰 —— 整批看不见。
       * 拉到 2.2m 并把颜色提亮到接近白云，才在灰穹顶上读得出来。
       * uRadius 必须与 seedInBox 的 BOX_R 一致，否则有一部分种子落在盒外被 wrap 二次折叠。 */
      uRadius: { value: BOX_R }, uLen: { value: 2.2 }, uWind: { value: 2.4 },
      uFade: { value: 55.0 }, uAmount: { value: 0 },
      uColor: { value: D(0xd2dce6) },
    },
    vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
  });
  const mesh = new THREE.LineSegments(g, m);
  mesh.name = 'Rain';
  mesh.frustumCulled = false;
  mesh.renderOrder = 900;
  mesh.visible = false;
  return mesh;
}

/* ======================= 雪 ======================= */

const SNOW_VERT = /* glsl */`
attribute vec3 aSeed;      // x=初始 x, y=初始 z, z=相位
uniform float uTime, uSpeed, uBoxH, uRadius, uSize, uFade, uPix;
varying float vAlpha;
void main() {
  float y = uBoxH * fract( aSeed.z - uTime * uSpeed / uBoxH );
  // 雪花不是直落：横向摆动幅度随高度（高处风大），这是雪花最认得出的运动特征
  float sway = sin( uTime * 0.85 + aSeed.z * 39.1 ) * 2.1 + sin( uTime * 1.63 + aSeed.x * 11.7 ) * 0.9;
  vec3 head = vec3( aSeed.x + sway, y, aSeed.y + sway * 0.55 );

  vec3 rel = head - cameraPosition;
  rel = mod( rel + uRadius, 2.0 * uRadius ) - uRadius;
  vec3 world = cameraPosition + rel;

  float d = length( rel );
  // 同雨条：近场淡出。贴脸的大白点会糊成一片，读不出是雪。
  vAlpha = ( 1.0 - smoothstep( uFade * 0.30, uFade, d ) )
         * smoothstep( 1.2, 5.0, d )
         * smoothstep( 0.0, 4.0, y );

  vec4 mv = viewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;
  // 雪花近大远小；clamp 防止贴脸时糊满屏
  gl_PointSize = clamp( uSize * uPix / max( 1.0, -mv.z ), 1.0, 22.0 );
}
`;

const SNOW_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAmount;
varying float vAlpha;
void main() {
  if ( vAlpha * uAmount <= 0.002 ) discard;
  // 软圆点，不用贴图：离中心越近越亮
  float r = length( gl_PointCoord - 0.5 );
  float a = smoothstep( 0.5, 0.13, r ) * vAlpha * uAmount;
  if ( a <= 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
}
`;

function makeSnow(count, pixelRatio) {
  const g = new THREE.BufferGeometry();
  const seed = new Float32Array(count * 3);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, z, ph] = seedInBox();      // 同 makeRain：铺满盒子，不靠 wrap 展开
    seed[i * 3] = x;
    seed[i * 3 + 1] = z;
    seed[i * 3 + 2] = ph;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const m = new THREE.ShaderMaterial({
    name: 'SnowFlakes',
    transparent: true, depthWrite: false, fog: false,
    uniforms: {
      uTime: { value: 0 }, uSpeed: { value: 1.35 }, uBoxH: { value: 46.0 },
      uRadius: { value: BOX_R }, uSize: { value: 1.15 }, uFade: { value: 58.0 },
      uAmount: { value: 0 },
      // gl_PointSize = uSize·uPix / (-mv.z)：uPix 取 90·像素比。
      // uSize 曾为了「雪粒看不见」提到 1.7 —— 真因是粒子坍缩成一簇（见 seedInBox），
      // 修好分布后 1.15 就够：20m 处约 5.2px、60m 处约 1.7px，近大远小且不糊屏。
      uPix: { value: 90 * pixelRatio }, uColor: { value: D(0xfbfdff) },
    },
    vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG,
  });
  const points = new THREE.Points(g, m);
  points.name = 'Snow';
  points.frustumCulled = false;
  points.renderOrder = 900;
  points.visible = false;
  return points;
}

/* ======================= 控制器 ======================= */

export function createWeather({ scene, renderer, sky, sun, hemi, pixelRatio = 1 }) {

  const rain = makeRain(6000);
  const snow = makeSnow(4200, pixelRatio);
  const group = new THREE.Group();
  group.name = 'Weather';
  group.add(rain, snow);
  scene.add(group);

  /* 夜间发光的窗：GLB 里窗洞是 `Window deep recess`，本来就靠暗色读出「这是个洞」，
   * 夜里给它加自发光就是点亮的窗。**不加新的灯**（见文件头约束 1）。 */
  const windowMats = [];
  for (const m of injectedMaterials()) {
    if (/^Window deep recess$/i.test(normName(m.name || ''))) windowMats.push(m);
  }
  const windowBaseEnv = windowMats.map((m) => m.envMapIntensity);

  /* 记录每套预设的 envMapIntensity 基准，天气只按倍率缩放，
   * 不去改每个材质自己的 DISPATCH 值（改了就没法干净地切回去）。 */
  const mats = injectedMaterials();
  const baseEnv = mats.map((m) => m.envMapIntensity);

  const state = clonePreset(PRESETS.clear);
  const from = clonePreset(PRESETS.clear);
  const to = clonePreset(PRESETS.clear);
  let mixT = 1;              // 0 = from，1 = to
  let current = 'clear';
  let elapsed = 0;
  const TRANSITION = 2.2;    // 秒
  let envDirty = true;
  let envTimer = 0;

  const sunTargetPos = TUNE.sun.target.clone();
  const sunDir = new THREE.Vector3();

  /* 环境贴图重烘。切天气过程中不每帧烘（PMREM fromScene 不便宜），
   * 过渡结束时烘一次，中途靠 envIntensity 跟随。 */
  function rebakeEnvironment() {
    const old = scene.environment;
    const env = { color: state.envGroundColor, lift: state.envGroundLift };
    scene.environment = buildEnvironment(renderer, sky, env);
    if (old && old.dispose) old.dispose();
    envDirty = false;
  }

  function applyState() {
    // 太阳
    const az = THREE.MathUtils.degToRad(state.sunAzimDeg);
    const el = THREE.MathUtils.degToRad(state.sunElevDeg);
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    sun.position.copy(sunDir).multiplyScalar(TUNE.sun.distance).add(sunTargetPos);
    sun.target.position.copy(sunTargetPos);
    sun.target.updateMatrixWorld();
    sun.color.copy(state.sunColor);
    sun.intensity = state.sunIntensity;

    hemi.color.copy(state.hemiSky);
    hemi.groundColor.copy(state.hemiGround);
    hemi.intensity = state.hemiIntensity;
    /* 阴天与夜里的「影子变淡」不是靠压阴影强度实现的 ——
     * **r160 的 LightShadow 根本没有 intensity 这个字段**（r166 才加的）。
     * 物理上正确的做法是压太阳、抬天光：阴天的光主要来自整个天空穹顶，
     * 所以 hemiIntensity 0.30 → 0.62/0.95、sunIntensity 3.55 → 0.55/0.95，
     * 阴影与亮部的比值自己就下来了，而且比硬调阴影更真。 */

    scene.fog.color.copy(state.fogColor);
    scene.fog.density = state.fogDensity;
    renderer.toneMappingExposure = state.exposure;

    applySkyWeather(sky, { ...state, sunDir });

    setWeatherUniforms({ wet: state.wet, snow: state.snow, snowColor: state.snowColor });

    for (let i = 0; i < mats.length; i++) mats[i].envMapIntensity = baseEnv[i] * state.envIntensity;

    for (let i = 0; i < windowMats.length; i++) {
      windowMats[i].emissive.setRGB(1.00, 0.60, 0.24, THREE.LinearSRGBColorSpace)
        .multiplyScalar(state.windowGlow * 1.35);
      windowMats[i].envMapIntensity = windowBaseEnv[i] * state.envIntensity * (1 - state.windowGlow * 0.4);
    }

    /* 粒子用**浓度**淡入淡出，不做「到点突变」。
     * 突变在过场里非常扎眼 —— 一半屏的雨条突然出现。 */
    const rA = Math.max(0, state.rainAmount);
    const sA = Math.max(0, state.snowAmount);
    rain.visible = rA > 0.002;
    snow.visible = sA > 0.002;
    rain.material.uniforms.uAmount.value = rA;
    snow.material.uniforms.uAmount.value = sA;
  }

  function set(name, { instant = false } = {}) {
    if (!PRESETS[name] || name === current) return false;
    /* **必须是 clonePreset(state)，不能是 Object.assign(from, state)。**
     * Object.assign 是浅拷贝：from 里的 Color 会直接指向 state 的那些实例，
     * 于是 `from` 不是快照而是被 state 拖走的别名 ——
     * 逐帧 `state.x.copy(from.x).lerp(to.x,k)` 实际变成
     * `state.x.copy(state.x).lerp(to.x,k)`，每帧都以「上一帧的结果」为起点，
     * 曲线被顶快、smoothstep 白写了（终值仍对，所以肉眼看不出来）。
     * 这就是「同一个数自己暴露了错误」的另一个形态。 */
    Object.assign(from, clonePreset(state));
    Object.assign(to, clonePreset(PRESETS[name]));
    current = name;
    mixT = instant ? 1 : 0;
    if (instant) {
      Object.assign(state, clonePreset(PRESETS[name]));
      applyState();
      rebakeEnvironment();
      /* instant 也必须置位。`shadowMap.autoUpdate = false`，而 instant 一帧就跳完了，
       * 不置位的话影子还是**上一套天气的太阳方向**烘的 ——
       * 探针逐天气取像素时尤其致命：晴天/雨天的影子方向只差几度，
       * 夜里差 30°，量到的「夜比晴暗」里就混着「影子没跟着转」这一项。
       * （踩过一次：判据全绿，但画面里是正午的影子配着夜里的曝光。） */
      renderer.shadowMap.needsUpdate = true;
    } else {
      // 阴影只在**切换的第一帧和最后一帧**重烘。
      // `autoUpdate=false`，needsUpdate 每帧置位就是每帧重画 4096² —— 软件光栅下
      // 一次要几百毫秒，2.2s 的过场会变成 2.2s 卡死。中途方向只差几度，
      // 影子略微滞后反而比卡顿真实得多。
      renderer.shadowMap.needsUpdate = true;
    }
    return true;
  }

  function update(dt) {
    elapsed += dt;
    rain.material.uniforms.uTime.value = elapsed;
    snow.material.uniforms.uTime.value = elapsed;

    if (mixT < 1) {
      const prev = mixT;
      mixT = Math.min(1, mixT + dt / TRANSITION);
      const k = mixT * mixT * (3 - 2 * mixT);        // smoothstep，避免起手一顿
      lerpPreset(state, from, to, k);
      applyState();
      envTimer += dt;
      // 过渡途中每 0.5s 烘一次环境贴图（PMREM 不便宜），最后一次在结束时。
      if (envTimer >= 0.5) { envTimer = 0; rebakeEnvironment(); }
      if (prev < 1 && mixT >= 1) {
        rebakeEnvironment();
        renderer.shadowMap.needsUpdate = true;      // 终帧：方向已定，重烘一次阴影
      }
    } else if (envDirty) {
      rebakeEnvironment();
    }
  }

  rebakeEnvironment();
  applyState();

  return {
    group,
    names: WEATHER_NAMES.slice(),
    label: (n) => (PRESETS[n] ? PRESETS[n].label : ''),
    set,
    /* QA 钩子：**只改材质 uniform，完全不动灯光/雾/曝光。**
     *
     * 为什么必须有它：第一版像素判据写的是「雨对竖直面几乎不变」，
     * 实测 Δ竖直 −0.1366 反而略大于 Δ朝上 −0.1345，判红。
     * 但那个量根本不是湿 uniform 造成的 —— 雨把太阳从 3.55 压到 0.55、
     * 雾密度从 0.0017 拉到 0.0062，**全局光照一变，竖直的向阳墙面当然跟着暗**。
     * 判据问的是「湿有没有蹭到竖直面」，量的却是「阴天把画面压暗了多少」。
     *
     * ⇒ 这不是阈值太紧，是**问题问错了**。把两个变量拆开量才问得对。
     *   调阈值让它变绿 = 判据被数据迁就，等于把这条腿锯掉。
     *
     * 用法：先 `set('clear', {instant:true})` 锁住光照，再
     *   `override({ wet: 1 })` 量「纯湿效应」，然后 `override({ wet: 0, snow: 1 })` 量「纯雪效应」。
     * 效果持续到下一次 `set()`（`set()` 会经 `applyState()` 用预设值覆盖回去）。
     */
    override(params = {}) {
      const wet = params.wet !== undefined ? params.wet : state.wet;
      const snow = params.snow !== undefined ? params.snow : state.snow;
      if (params.debugNrm !== undefined) setDebugNormalView(!!params.debugNrm);
      setWeatherUniforms({ wet, snow, snowColor: params.snowColor || state.snowColor });
      return { wet, snow, debugNrm: !!params.debugNrm };
    },
    get current() { return current; },
    get transitioning() { return mixT < 1; },
    update,
    stats: () => ({
      current,
      transitioning: mixT < 1,
      mix: +mixT.toFixed(3),
      precip: state.precip,
      precipVisible: [rain.visible, snow.visible],
      rainDrawCalls: rain.visible ? 1 : 0,
      snowDrawCalls: snow.visible ? 1 : 0,
      particleCounts: { rain: rain.geometry.attributes.aSeed.count / 2, snow: snow.geometry.attributes.aSeed.count },
      windowMaterials: windowMats.length,
      sunElevDeg: state.sunElevDeg, sunAzimDeg: state.sunAzimDeg,
      sunIntensity: +state.sunIntensity.toFixed(3),
      sunColor: '#' + sun.color.getHexString(),
      hemiIntensity: +hemi.intensity.toFixed(3),
      fogColor: '#' + scene.fog.color.getHexString(),
      fogDensity: +scene.fog.density.toFixed(5),
      exposure: +renderer.toneMappingExposure.toFixed(3),
      wet: +state.wet.toFixed(3), snow: +state.snow.toFixed(3),
      windowGlow: +state.windowGlow.toFixed(3),
      overcast: state.overcast, stars: state.stars,
      skySunY: +sunDir.y.toFixed(4),
      skyOvercastUniform: +sky.material.uniforms.uOvercast.value.toFixed(3),
      skyStarsUniform: +sky.material.uniforms.uStars.value.toFixed(3),
      envIntensity: +state.envIntensity.toFixed(3),
      envIntensitySample: +(mats[0] ? mats[0].envMapIntensity : 0).toFixed(3),
      /* 这三个是**实测注入值**，不是预设里的声明值 ——
       * 用来证明 uniform 真的被驱动了（声明改了但没接上是最常见的静默失败）。 */
      uniformWet: mats.length ? uniformValue(mats[0], 'uWet') : null,
      uniformSnow: mats.length ? uniformValue(mats[0], 'uSnow') : null,
      windowEmissive: windowMats.length
        ? [windowMats[0].emissive.r, windowMats[0].emissive.g, windowMats[0].emissive.b].map((v) => +v.toFixed(3))
        : null,
    }),
  };
}

/** 从注入材质的 uniform 表里读一个实际值（探针自证用）。 */
function uniformValue(mat, name) {
  const u = getUniforms(mat);
  if (!u || !u[name]) return null;
  const v = u[name].value;
  return typeof v === 'number' ? +v.toFixed(3) : (v && v.isColor ? [v.r, v.g, v.b].map((x) => +x.toFixed(3)) : null);
}

/* ======================= 预设的克隆 / 插值 ======================= */

const COLORS = ['sunColor', 'hemiSky', 'hemiGround', 'skyTop', 'skyMid', 'skyHaze', 'skyGround',
  'skyHazeLow', 'skySunColor', 'flatTint', 'horizonGlow', 'envGroundColor', 'snowColor'];
const NUMS = ['sunElevDeg', 'sunAzimDeg', 'sunIntensity', 'hemiIntensity', 'hazeTop', 'midTop',
  'overcast', 'stars', 'horizonGlowAmt', 'fogDensity', 'exposure', 'envIntensity', 'envGroundLift',
  'wet', 'snow', 'windowGlow', 'rainAmount', 'snowAmount'];

function clonePreset(p) {
  const o = {};
  for (const k of Object.keys(p)) {
    if (COLORS.includes(k)) {
      /* **守卫：显式报出是哪个键、什么类型。**
       * 踩过：预设里 `sunColor: 0xffeccd` 写成了裸 hex 数字，
       * 而它在 COLORS 表里，于是 `p[k].clone()` 抛
       * `p[k].clone is not a function` ——
       * boot 直接中止、页面停在加载层、**零未捕获异常**，
       * 探针日志里只有一整屏空字段，看上去像「服务挂了」。
       * 同样的病在 `Node` 里也能静态查出来（见 tests/check-presets.mjs），
       * 但线上必须有一条会喊的守卫。 */
      const v = p[k];
      if (!v || typeof v.clone !== 'function') {
        throw new Error(
          `clonePreset: 预设字段 "${k}" 被 COLORS 表声明为颜色，但实际是 ` +
          `${v === null ? 'null' : typeof v}（${JSON.stringify(v)}）。` +
          `颜色字段必须写成 L(...) 或 D(...)，不能写裸 hex。`
        );
      }
      o[k] = v.clone();
    } else if (k === 'fogColor') o[k] = new THREE.Color(p.fogColor);
    else o[k] = p[k];
  }
  return o;
}

function lerpPreset(out, a, b, t) {
  for (const k of COLORS) out[k].copy(a[k]).lerp(b[k], t);
  for (const k of NUMS) out[k] = a[k] + (b[k] - a[k]) * t;
  out.fogColor.copy(a.fogColor).lerp(b.fogColor, t);
  return out;
}
