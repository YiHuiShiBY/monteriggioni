/**
 * Monteriggioni · 天空球 + IBL 环境
 * ---------------------------------------------------------------------------
 * r=4000 的 BackSide 天空球，用 ShaderMaterial 直接画垂直渐变 + 太阳盘 + 地平线暖霾。
 * 同一个球先被 PMREMGenerator.fromScene() 烘成 environment（方向正确的 IBL），
 * 再留在主场景里当背景（能看到太阳盘，且随相机俯仰正确变化）。
 *
 * 天空球本身不过雾（材质不声明 fog），否则 r=4000 会被雾整片吃掉。
 */

import * as THREE from 'three';
import { TUNE, sunDirection } from './lighting.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHaze;
uniform vec3 uGround;
uniform vec3 uHazeLow;
uniform vec3 uSunColor;
uniform vec3 uSun;
uniform float uDisc;
uniform float uHaloPow;
uniform float uGlowPow;
uniform float uHazeTop;
uniform float uMidTop;
uniform float uOvercast;
uniform vec3  uFlatTint;
uniform float uStars;
uniform vec3  uHorizonGlow;
uniform float uHorizonGlowAmt;
varying vec3 vDir;

/* 便宜的三维哈希，给夜空撒星。不用贴图。 */
float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}

void main() {
  vec3 d = normalize( vDir );
  float h = d.y;
  float mu = dot( d, uSun );
  float m = max( mu, 0.0 );

  // 天顶 → 中段 → 地平线暖霾。暖霾带刻意压得很窄：俯视机位能看到的
  // 只有地平线以上十几度角的一条窄天空，暖霾铺太高整幅画会全变成米色。
  vec3 above = mix( uHaze, uMid, smoothstep( -0.012, uHazeTop, h ) );
  above = mix( above, uTop, smoothstep( uHazeTop * 1.5, uMidTop, h ) );

  // 地平线以下不是「天空」，是**阳光下的远方原野 + 雾霭**。
  // 航拍机位俯角 ~35°，真地平线根本不在画面里 —— 那一大片背景全落在这里，
  // 所以必须分三段：贴着地平线是被太阳照亮的暖白雾，往下转中调原野，
  // 再往下转冷转暗。之前只用 haze→ground 两段、而且两端都是暖色，
  // 整幅背景糊成一块发闷的土黄（航拍图左上角那一大片）。
  vec3 hazeHi  = uHaze * 1.16;                       // 近地平线：受晒的雾
  vec3 hazeMid = mix( uHaze, uGround, 0.62 );        // 中段：雾里的原野
  vec3 below = mix( hazeHi, hazeMid, smoothstep( 0.02, -0.42, h ) );
  below = mix( below, uHazeLow, smoothstep( -0.40, -0.95, h ) );

  vec3 col = mix( below, above, smoothstep( -0.02, 0.015, h ) );

  // 太阳一侧的方位梯度：规格 §6.2 要求「能看到太阳方向的明暗梯度」。
  // 上下都要有 —— 俯视机位画面里绝大部分背景其实落在地平线以下那一段。
  col = mix( col, col * 1.16 + vec3( 0.022, 0.015, 0.006 ), pow( m, 2.0 ) );

  /* ---- 阴天：把整片天空压向一块无层次的灰穹顶 ----
   * 雨天/雪天的关键不是「更暗」，是**没有方向性**：
   * 渐变被压平、暖霾带消失、太阳盘与光晕被吃掉。
   * 靠一个 mix 就够，不用再写一套阴天着色器。 */
  vec3 flatC = uFlatTint * ( 0.80 + 0.34 * smoothstep( -0.45, 0.40, h ) );
  col = mix( col, flatC, uOvercast );

  float disc = smoothstep( uDisc, uDisc + 0.00012, mu );
  float halo = pow( m, uHaloPow );
  float glow = pow( m, uGlowPow );

  // 阴天时太阳盘的贡献按 (1 - uOvercast) 一起收掉，否则灰穹顶上会浮一个白点。
  float sunVis = 1.0 - uOvercast;
  col += uSunColor * ( halo * 0.85 + glow * 0.09 ) * sunVis;
  col = mix( col, uSunColor * 1.8, disc * sunVis );

  // 太阳一侧的地平线暖带
  float band = exp( - abs( h ) * 26.0 ) * smoothstep( -0.1, 0.55, uSun.y );
  col += vec3( 0.13, 0.082, 0.030 ) * band * sunVis;

  /* ---- 夜间：地平线附近的暖辉光 ----
   * 镇子亮着窗，那圈暖光会从地平线方向漏出来一点。纯靠提亮 hemi 是不够的 ——
   * 那只会让整幅画均匀变亮，没有「光从哪儿来」的方向感。 */
  col += uHorizonGlow * uHorizonGlowAmt * exp( - abs( h ) * 7.0 );

  /* ---- 夜空星点 ----
   * 按方向量化成格子后取哈希：格子尺寸固定 ⇒ 星星不随相机平移而游动。
   * smoothstep 把地平线以下压掉，否则星星会落到地里的远山上。
   *
   * 一格 1/300 弧度在屏幕上约 3.4px（俯拍机位更小、城内机位更大）。
   * 只用 step 会把**整格**点亮 —— 目视验收看到的就是一片 3~7px 的白色
   * 小方砖，不是星点。所以再加一层格内距离衰减：亮核 + 软边盘，
   * 峰值仍然是 1.0（不整体变暗），但形状收成圆的。 */
  if ( uStars > 0.001 ) {
    vec3 cf = d * 300.0;
    vec3 cell = floor( cf );
    vec3 f = cf - cell - 0.5;                    // 格内坐标，中心在 0
    float r = hash13( cell );
    float twinkle = 0.55 + 0.45 * hash13( cell + 7.13 );
    float dd2 = dot( f, f );
    float core = exp( -dd2 * 160.0 );
    float disc = 1.0 - smoothstep( 0.02, 0.17, dd2 );
    float star = step( 0.9977, r ) * twinkle * ( 0.55 * core + 0.45 * disc );
    col += vec3( 0.86, 0.90, 1.0 ) * star * uStars * smoothstep( -0.005, 0.13, h );
  }

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSky() {
  const dir = sunDirection();
  const material = new THREE.ShaderMaterial({
    name: 'TuscanSky',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: TUNE.sky.top },
      uMid: { value: TUNE.sky.mid },
      uHaze: { value: TUNE.sky.haze },
      uGround: { value: TUNE.sky.ground },
      uHazeLow: { value: TUNE.sky.hazeLow },
      uSunColor: { value: TUNE.sky.sunColor },
      uSun: { value: dir.clone() },
      uDisc: { value: TUNE.sky.discSize },
      uHaloPow: { value: TUNE.sky.haloPow },
      uGlowPow: { value: TUNE.sky.glowPow },
      uHazeTop: { value: TUNE.sky.hazeTop },
      uMidTop: { value: TUNE.sky.midTop },
      uOvercast: { value: 0 },
      uFlatTint: { value: new THREE.Color(0.30, 0.31, 0.33) },
      uStars: { value: 0 },
      uHorizonGlow: { value: new THREE.Color(0.30, 0.17, 0.06) },
      uHorizonGlowAmt: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(TUNE.sky.radius, 64, 40), material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/**
 * 天气驱动天空球。所有 uniform 直接改 `material.uniforms.xxx.value` ——
 * 这是 ShaderMaterial 改值的正规途径，不触发重编译。
 */
export function applySkyWeather(skyMesh, w) {
  const u = skyMesh.material.uniforms;
  u.uSun.value.copy(w.sunDir);
  u.uSunColor.value.copy(w.skySunColor);
  u.uTop.value.copy(w.skyTop);
  u.uMid.value.copy(w.skyMid);
  u.uHaze.value.copy(w.skyHaze);
  u.uHazeLow.value.copy(w.skyHazeLow);
  u.uGround.value.copy(w.skyGround);
  u.uHazeTop.value = w.hazeTop;
  u.uMidTop.value = w.midTop;
  u.uOvercast.value = w.overcast;
  u.uFlatTint.value.copy(w.flatTint);
  u.uStars.value = w.stars;
  u.uHorizonGlow.value.copy(w.horizonGlow);
  u.uHorizonGlowAmt.value = w.horizonGlowAmt;
}

/**
 * 用天空球烘一张 PMREM，给所有 PBR 材质提供方向正确的 IBL。
 *
 * 关键：envScene 里除了天空球，还要放一层**被太阳晒暖的地面**（envGround）。
 * 只烘天空球的话，任何背光面拿到的环境光全是天顶蓝，广场和墙脚的阴影会发藏青。
 * 真实托斯卡纳的阴影之所以是「中性偏暖」，靠的是周围晒亮的石灰岩和土地的回弹。
 * 这层地面**只存在于 envScene**，主场景背景仍然只有天空球 —— 用户看到的天空不变。
 */
export function buildEnvironment(renderer, skyMesh, env = TUNE.envGround) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();

  const envScene = new THREE.Scene();
  const clone = new THREE.Mesh(skyMesh.geometry, skyMesh.material);
  clone.frustumCulled = false;
  envScene.add(clone);

  // 地面穹顶：从天底一直包到地平线以上 envLift 那一点。
  // 包到地平线以上是必要的：平躺的面（广场、道路）法线朝上，
  // 只在地平线以下的地面对它 NdotL 为 0，一丝光都收不到；
  // 真正给水平面暖回弹的是「围墙外那圈晒亮的托斯卡纳坡地」—— 它就在地平线略上方。
  // 夜间这一层换成「亮着窗的镇子往上传的暖光」，所以它的颜色必须能随天气改。
  const thetaStart = Math.acos(Math.min(0.999, env.lift));
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(TUNE.sky.radius * 0.9, 48, 24, 0, Math.PI * 2, thetaStart, Math.PI - thetaStart),
    new THREE.MeshBasicMaterial({ color: env.color, side: THREE.BackSide, fog: false })
  );
  dome.frustumCulled = false;
  envScene.add(dome);

  const target = pmrem.fromScene(envScene, 0, 1, TUNE.sky.radius * 2.4);
  pmrem.dispose();
  envScene.remove(clone);
  envScene.remove(dome);
  dome.geometry.dispose();
  dome.material.dispose();
  return target.texture;
}
