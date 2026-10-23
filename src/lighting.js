/**
 * Monteriggioni · 光照与大气
 * ---------------------------------------------------------------------------
 * 全部参数集中在 TUNE，改这里就能整体调光，不用翻别的文件。
 * r160 纪律：只用 DirectionalLight / HemisphereLight / FogExp2，
 * 不碰 r162+ 的 AgX/Neutral 色调映射，不碰 r163+ 的 environmentIntensity。
 */

import * as THREE from 'three';

export const TUNE = {
  /* --- 太阳：托斯卡纳午后约 15:00，高度角 42° --- */
  sun: {
    // 方位角按机位重排过一轮：航拍机位方位 -39°、town 机位 -19.5°，
    // 原来的 14° 对这两个都是「几乎正对相机的顺光」，墙面被拍平、砌缝读不出来。
    // 68° 对航拍是 107° 侧后光、对 town 是 87.5° 正侧光，两者都能拉出长投影。
    //
    // 城门机位没有一起修好，而且这是无解的：三个机位的相机方位是
    // -39° / -19.5° / +36.1°，跨度 55.6°；要求三者同时落在 70–110° 的侧光区间，
    // 方程无解。68° 是保 town + aerial、让出 gate 的折中，已经定夺，不再动。
    // 城门那面墙（法线方位 0°，探针实测 NdotL 0.28–0.37）本身不是顺光，
    // 只是相机离太阳只有 32°，属于「从相机肩上打过来」，所以它只验材质不验戏剧性投影。
    azimuthDeg: 68,        // 方位角：0° = +Z，逆时针为正
    elevationDeg: 42,      // 高度角
    distance: 520,         // 只影响阴影相机 near/far 与视锥位置，不影响方向
    color: 0xffeccd,
    intensity: 3.55,
    shadowRadius: 155,     // 正交阴影相机半宽（米）。场景半径 181m，镇体 ±85m
    shadowMapSize: 4096,
    bias: -0.00035,
    normalBias: 0.16,
    target: new THREE.Vector3(0, 6, 0),
  },

  /* --- 补光：只负责让阴影面「中性偏暖」，不负责提亮 --- */
  // sky 色不是纯天空蓝：围墙小镇里从上方来的环境光本来就该被四周晒亮的
  // 石灰岩墙体和屋顶暖化。强度 0.30 一动没动，只把色相从 #9cbde2 往中性暖挪。
  hemi: { sky: 0xb5b2a4, ground: 0xb59468, intensity: 0.30 },

  /* --- 只进 PMREM 的暖地面（用户看不到，只改环境光） ---
   * 数值是按物理估的，不是按感觉调的：
   *   地面辐照度 ≈ 3.55 × sin42° = 2.375（乘太阳色）
   *   地面反照率（实测草地 .48 / 原野 .46 / 土壤 .47）→ 线性约 0.19
   *   辐出亮度 L = E × albedo / π ≈ 2.375 × 0.19 / 3.1416 ≈ 0.144
   * 约在天顶蓝 (0.055,0.150,0.400) 与地平线暖霾 (0.910,…) 之间，
   * 比直射暗一个数量级以上 —— 地面反射的能量本来就远低于直射。
   * lift = 地面穹顶包到地平线以上多少（cos）。水平面只收地平线略上方那圈，
   * 那是「围墙外晒亮的托斯卡纳坡地」，平躺的广场靠它才有暖回弹。 */
  envGround: {
    color: new THREE.Color().setRGB(0.205, 0.150, 0.092, THREE.LinearSRGBColorSpace),
    lift: 0.10,
  },

  /* --- 天空球渐变（线性空间，给 PMREM 用） ---
   * 暖霾带刻意压得很窄：航拍 / 城镇机位俯角很大，画面里其实只能看到地平线以上
   * 十几度角的一条窄天空，暖霾一旦铺得太高，整幅画会全变成米色。
   * 地平线**以下**是另一段三段渐变（hazeHi → hazeMid → hazeLow），
   * 见 sky.js：那里是「阳光下的远方原野」，不能是一整块闷土黄。 */
  sky: {
    radius: 4000,
    top: new THREE.Color().setRGB(0.055, 0.150, 0.400, THREE.LinearSRGBColorSpace),
    mid: new THREE.Color().setRGB(0.235, 0.410, 0.680, THREE.LinearSRGBColorSpace),
    haze: new THREE.Color().setRGB(0.910, 0.805, 0.620, THREE.LinearSRGBColorSpace),
    ground: new THREE.Color().setRGB(0.420, 0.395, 0.290, THREE.LinearSRGBColorSpace),
    hazeLow: new THREE.Color().setRGB(0.235, 0.252, 0.270, THREE.LinearSRGBColorSpace),
    sunColor: new THREE.Color().setRGB(2.60, 2.10, 1.42, THREE.LinearSRGBColorSpace),
    discSize: 0.99968,     // cos 角半径；0.99968 ≈ 1.4°
    haloPow: 900,
    glowPow: 12,
    hazeTop: 0.085,        // 暖霾带到此为止，往上交给中段蓝
    midTop: 0.55,
  },

  /* --- 大气：与天空地平线同色，形成空气透视 --- */
  fog: {
    color: 0xd3c5a8,       // 显示空间的目标色（雾在色调映射之后混合，所以按显示值给）
    density: 0.00170,      // FogExp2；场景半径 181m。略密是为了让地形圆盘的边缘也吃进雾里
  },

  exposure: 0.86,
};

export function sunDirection(out = new THREE.Vector3()) {
  const az = THREE.MathUtils.degToRad(TUNE.sun.azimuthDeg);
  const el = THREE.MathUtils.degToRad(TUNE.sun.elevationDeg);
  return out.set(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  ).normalize();
}

export function setupLighting(scene) {
  const dir = sunDirection();

  const hemi = new THREE.HemisphereLight(TUNE.hemi.sky, TUNE.hemi.ground, TUNE.hemi.intensity);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(TUNE.sun.color, TUNE.sun.intensity);
  sun.position.copy(dir).multiplyScalar(TUNE.sun.distance).add(TUNE.sun.target);
  sun.target.position.copy(TUNE.sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(TUNE.sun.shadowMapSize, TUNE.sun.shadowMapSize);

  const R = TUNE.sun.shadowRadius;
  const cam = sun.shadow.camera;
  cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
  cam.near = 1; cam.far = TUNE.sun.distance * 2.4;
  cam.updateProjectionMatrix();

  sun.shadow.bias = TUNE.sun.bias;
  sun.shadow.normalBias = TUNE.sun.normalBias;
  scene.add(sun);
  scene.add(sun.target);

  scene.fog = new THREE.FogExp2(TUNE.fog.color, TUNE.fog.density);

  return { sun, hemi, dir };
}
