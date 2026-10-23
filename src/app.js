/**
 * Monteriggioni · 查看器主体
 * ---------------------------------------------------------------------------
 * 职责：renderer / 场景 / 机位补间 / 加载进度 / __QA__ 验收钩子。
 * 光照参数在 lighting.js，材质注入在 materials.js，贴图烘焙在 textures.js。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { TUNE, setupLighting, sunDirection } from './lighting.js';
import { createSky, buildEnvironment } from './sky.js';
import { buildRecipes, bakeAll } from './textures.js';
import { applyMaterials, tintLookupFor } from './materials.js';
import { buildWallWalk } from './wallwalk.js';
import { buildWallStairs } from './wallstair.js';
import { buildCrowd } from './crowd.js';
import { buildSurrounds } from './surrounds.js';
import { createWeather, WEATHER_NAMES } from './weather.js';
import { buildWalkable, collectBlockerBoxes, createPlayer } from './player.js';
import { createJoystick, isCoarsePointer } from './joystick.js';

const VIEW_NAMES = ['aerial', 'town', 'gate', 'plan'];

/** 阴影贴图是否已经烘焙完成。首帧刻意不烘，见 boot 里的注释。 */
let shadowsReady = false;


export async function boot({ app, loadingEl, errEl, onProgress }) {
  /* ---------------- renderer ---------------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TUNE.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // 太阳是静止的：关掉每帧重画 4096² 阴影，加载完成后手动 needsUpdate 一次。
  renderer.shadowMap.autoUpdate = false;
  app.append(renderer.domElement);

  /* ---------------- scene / camera / controls ---------------- */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 12000);
  camera.position.set(-150, 170, 190);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.autoRotate = false;              // 规格要求关闭：它会持续破坏构图与截图可比性
  controls.maxPolarAngle = Math.PI * 0.495;

  const { sun, hemi, dir } = setupLighting(scene);

  /* ---------------- 阴影预算：按实际 GPU 能力定档 ----------------
   * 4096² 阴影贴图在独显上是好画质，在软件光栅 / 集显 / 虚拟机里是一次几十秒到
   * 几分钟的同步阻塞，页面会一直停在「烘焙阴影 96%」看起来像死了。
   * 所以这里读实际渲染器名，弱 GPU 自动降档；需要高清的人可以用 ?shadow=4096 手动拉回来。
   */
  const gpuName = (() => {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    } catch { return ''; }
  })();
  const softGPU = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(gpuName);
  const urlShadow = Number(new URLSearchParams(location.search).get('shadow'));
  const shadowSize = urlShadow >= 512 && urlShadow <= 8192
    ? (urlShadow & (urlShadow - 1) === 0 ? urlShadow : TUNE.sun.shadowMapSize)
    : (softGPU ? 1024 : TUNE.sun.shadowMapSize);
  if (shadowSize !== sun.shadow.mapSize.x) {
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }

  /* ---------------- 验收钩子（必须先于任何 await 发布） ----------------
   * tests/shots.mjs 在页面 load 后 2s 就会读 window.__asset。
   * 若等到 boot() 全部跑完再挂 __asset，截图工具会读到 undefined 直接抛错。
   * 所以这里立刻挂一个「未就绪」版本：camera / controls 是真实对象，
   * setView 先记账，模型就位后统一应用。 */
  let VIEWS = null;
  let pendingView = 'aerial';
  let bounds = null;
  let stats = { count: 0, tinted: 0, leafFixed: 0 };
  let casters = 0, receivers = 0;
  let size = new THREE.Vector3();
  let center = new THREE.Vector3();
  let radius = 1;

  function applyView(name) {
    if (!VIEWS || !VIEWS[name]) return;
    camera.position.copy(VIEWS[name].pos);
    controls.target.copy(VIEWS[name].target);
    controls.update();
    markActive(name);
  }
  function setView(name) {
    if (!VIEW_NAMES.includes(name)) return false;
    pendingView = name;
    if (VIEWS) applyView(name);
    return true;
  }

  window.__asset = {
    camera, controls, scene, renderer, THREE,
    bounds: null,
    setView,
    views: VIEW_NAMES.slice(),
  };
  window.__QA__ = {
    ready: false,
    setView,
    diag: () => ({
      ready: false, phase: 'loading', view: pendingView,
      camera: [camera.position.x, camera.position.y, camera.position.z].map((v) => +v.toFixed(1)),
    }),
  };

  /* ---------------- 天空 + IBL ---------------- */
  const sky = createSky();
  scene.add(sky);
  scene.background = null;
  scene.environment = buildEnvironment(renderer, sky);

  /* ---------------- 加载模型 ---------------- */
  onProgress({ phase: 'model', ratio: 0, label: '正在载入 27.6 MB 城镇模型……' });

  const town = await new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      './Monteriggioni.glb',
      (gltf) => resolve(gltf.scene),
      (evt) => {
        if (evt.total) {
          onProgress({ phase: 'model', ratio: evt.loaded / evt.total * 0.6, label: `正在载入模型 ${(evt.loaded / 1048576).toFixed(1)} / ${(evt.total / 1048576).toFixed(1)} MB` });
        }
      },
      undefined,
      (err) => reject(err)
    );
  });
  scene.add(town);

  /* ---------------- 人物资产（character.glb）----------------
   * **独立于镇子那份**：8 批的 `Monteriggioni.glb` 是冻结交付物，零改动。
   * 29KB 的 9 件刚性分件人物由 `scripts/character.py` 产出，
   * 人群（40 个）与玩家小人（1 个）都从这一份取几何。
   *
   * 必须在 buildCrowd / createPlayer **之前** await 完：
   * `partGeometries(char)` 挑不到部件就抛错，而那两处都在 boot 的同步段里，
   * 抛错会变成半屏白屏而不是一条能读懂的报错。
   */
  const character = await new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      './assets/character.glb',
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err)
    );
  });

  const box = new THREE.Box3().setFromObject(town);
  size = box.getSize(new THREE.Vector3());
  center = box.getCenter(new THREE.Vector3());
  radius = Math.max(size.x, size.z) * 0.5;

  // 阴影投射/接收：glTF 不带这个信息，GLTFLoader 默认全 false，不开就没有影子。
  town.traverse((obj) => {
    if (!obj.isMesh) return;
    const prefix = (Array.isArray(obj.material) ? obj.material[0] : obj.material)?.name || '';
    const flat = /^Land \|/.test(prefix);      // 地形圆盘自身不需要投影，省一大截阴影开销
    obj.castShadow = !flat;
    obj.receiveShadow = true;
    if (obj.castShadow) casters++; else receivers++;
  });

  /* ---------------- 烘焙程序化贴图 ---------------- */
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tintOf = tintLookupFor(town);
  const recipes = buildRecipes(tintOf);

  const tex = await bakeAll(recipes, aniso, (ratio, key) => {
    onProgress({ phase: 'texture', ratio: 0.6 + ratio * 0.34, label: `正在烘焙程序化材质 ${Math.round(ratio * 100)}% · ${key}` });
  });

  const stats2 = applyMaterials(town, tex);
  stats = stats2;

  /* ---------------- 天气系统（晴天 / 夜晚 / 雨天 / 雪天）----------------
   * 必须在 applyMaterials 之后：它要拿那 92 个**已注入三平面**的材质实例，
   * 靠改 `uWet` / `uSnow` 两个 uniform 值驱动全场景表面（湿变暗变滑 / 雪只积在朝上面）。
   * 早挂会拿到还没注入的白模，材质改了不起作用。
   */
  const weather = createWeather({
    scene, renderer, sky, sun, hemi,
    pixelRatio: Math.min(devicePixelRatio, 2),
  });
  const weatherStats = weather.stats;

  /* ---------------- 镇外原野（第五批 ④：地台边缘圆盘感）----------------
   * 必须挂在 applyMaterials 之后：它要复用 GLB 地形那个**已经被三平面注入过**的
   * 材质实例，另造一个裸 MeshStandardMaterial 会掉回无贴图原色。
   *
   * 挂在 scene 而不是 town：crowd.js 会遍历 town 建地面高度场，
   * 把这片远景混进去会把人物的贴地判定带偏。挂 scene 就互不干扰。
   */
  const surrounds = buildSurrounds({ town });
  scene.add(surrounds.mesh);
  const surStats = surrounds.stats();

  /* ---------------- 城墙步道（规格第 2 节）----------------
   * 必须挂在 applyMaterials 之后：新构件要复用已经被 DISPATCH 注入过三平面投影的材质实例，
   * 挂早了会拿到没注入的材质，退回白模。
   *
   * ⚠ 第四批：`obstacles` 必须在 `buildWalkable` **之前**收 ——
   *   规格 §1.6 的净空判据（「落位点背后 across 2.25~3.25 那条带里有没有 13~18m 连续空地」）
   *   在 `buildWallWalk` 内部就要跑，而高程场要等 `WallWalk_Paving` 建完才能建。
   *   盒子收集用 `player.js` 的 `collectBlockerBoxes()`，**不重写一遍正则**
   *   （两份正则迟早分叉，分叉之后净空判据报出来的数就是假的）。
   */
  const obstacles = collectBlockerBoxes([town]);
  const wall = buildWallWalk({ town, obstacles });
  const wallStats = wall.stats();
  /* ---------------- 人物系统（规格第 3 节）----------------
   * 必须在 buildWallWalk 之后：三条路径里有一条是「环城墙道」，直接复用
   * wallwalk 已经提取好的 436 点中心线（`wall.centerline`），不重新解一遍。
   * 人群材质也必须是 applyMaterials 之后才拿得到（people.js 要克隆已注入三平面的实例）。
   */
  const crowd = buildCrowd({ town, wall, renderer, char: character });

  /* ---------------- 玩家小人（第三人称行走）----------------
   * 必须在 buildCrowd 之后：行走面的禁区盒沿用 crowd 那套墙体正则，
   * 而 player.js 要复用 people.js 的几何与 people.js 的注入材质（都在 town 就位之后）。
   *
   * roots 要给**两个**：`surrounds.mesh` 是镇外原野，直接 add 在 scene 上、
   * 不在 town 子树里，只给 town 会让 buildWalkable 抛「找不到地面网」而白屏。
   *
   * ⚠ 第四批：墙道组也要显式进 roots。`WallWalk_Paving` 是 `GROUND_MESHES` 的一员，
   *   不进高程场的话墙顶 20.82~23.52m 在场里不存在，人在墙道上会被判「掉崖」弹回街面。
   *   （`buildWalkable` 内部按网格对象去重，所以 `wall.group` 本来就挂在 town 下也**不会**重复光栅化。）
   */
  const walkable = buildWalkable({ roots: [town, wall.group, surrounds.mesh], center });

  /* ---------------- 城墙阶梯（第四批）----------------
   * 必须在 `buildWalkable` **之后**：`groundAt` 要用真实高程场把梯脚所在的街面高度量回来
   * —— 规格 §1.1 的「街面约 14.0~14.4m」只是初值，而**级数与沿墙长都由这个实测爬升现算**
   * （`riserM = rise / round(rise / 0.17)`），初值差 1.6m 就是级数差 9 级、长度差 3m。
   *
   * 阶梯**不进高程场也不进禁区盒**：
   *   · 不进高程场：踏面 0.34m 比高程场 0.5m 的格子还窄，splat 进去必然糊成斜坡；
   *     它改由 `walkable.attachStairs()` 装的**解析面**接管自己 footprint 里的高度。
   *   · 不进禁区盒：它是可行走面，不是墙。
   * 装解析面也必须在 `buildWalkable` 之后（高程场先建好，解析面只做前置查询）。
   */
  const wallStairs = buildWallStairs({
    town, plan: wall.stairs, centerline: wall.centerline, groundAt: walkable.sampleField,
  });
  const stairStats = wallStairs.stats();
  if (!walkable.attachStairs(wallStairs.footprint)) {
    throw new Error('app: 阶梯解析面装不上（footprint 是空的？）—— 玩家会踩空');
  }

  const player = createPlayer({
    town, scene, camera, controls, renderer, walkable, center, char: character,
    // 墙道横向走廊夹紧要用中心线（player.js 的 TUNE.corridor）
    centerline: wall.centerline,
    onModeChange: (on) => {
      document.body.classList.toggle('walking', on);
      const b = document.querySelector('.walk button[data-walk]');
      if (b) b.setAttribute('aria-pressed', String(on));
    },
  });
  player.figure.setVisible(false);   // 默认不进行走模式，先让机位预览保持原样

  /* 进/出行走模式的唯一入口。切机位时必须先退出来：
   * 否则相机目标会同时被机位补间和「跟随小人」两个东西拉扯，画面会抖。 */
  let walkReturnView = null;
  function setWalk(on) {
    const want = !!on;
    if (want === player.active) return player.active;
    if (want) {
      walkReturnView = activeView;
      player.enter();
      // 进场是一段**相机补间**，不是硬切：位置与目标点一起动。
      // 只挪 target 不挪 position 同样是硬切（那会当场转朝向），两者一起动才对。
      const cp = player.cameraPose();
      startTween(cp.pos, cp.target, 900, () => player.suspendFollow(false));
    } else {
      player.exit();
      if (walkReturnView) glideTo(walkReturnView);
      walkReturnView = null;
    }
    return player.active;
  }
  const toggleWalk = () => setWalk(!player.active);

  const walkBtn = document.querySelector('.walk button[data-walk]');
  if (walkBtn) walkBtn.addEventListener('click', toggleWalk);
  const walkBox = document.querySelector('.walk');
  if (walkBox) walkBox.hidden = false;
  else console.warn('app: 找不到 .walk 容器，「行走」按钮没接上');
  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      toggleWalk();
    }
  });

  /* ---------------- 触屏摇杆（行走模式的移动输入）----------------
   * 只在 coarse pointer 设备上建：桌面有 WASD，常驻圆盘是噪音。
   * 显隐交给 CSS（body.walking），这里只管把摇杆量喂给 player ——
   * 非行走状态下 player.update 直接早退，摇杆残留值不起作用，
   * 而且 exit() 里已把 stick 归零，不会带着旧值进下一次行走。 */
  if (isCoarsePointer()) {
    const joy = createJoystick({
      onStick: (x, y, run) => player.setStick(x, y, run),
    });
    document.body.append(joy.el);
  }

  /* ---------------- 全屏（渐进增强）----------------
   * iPhone Safari 至今不给非 video 元素 requestFullscreen —— 探测不到就整颗按钮隐藏，
   * 不留一颗按了没反应的按钮在界面上。 */
  const fsBtn = document.querySelector('.walk button[data-fs]');
  if (fsBtn) {
    if (document.documentElement.requestFullscreen) {
      fsBtn.hidden = false;
      fsBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
      });
      document.addEventListener('fullscreenchange', () => {
        const on = !!document.fullscreenElement;
        fsBtn.setAttribute('aria-pressed', String(on));
        fsBtn.textContent = on ? '退出全屏' : '全屏';
      });
    }
  }

  /* ---------------- 机位 ---------------- */
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const GATE_TARGET = V(-2, 8.5, 80);
  VIEWS = {
    aerial: { pos: V(center.x - radius * 0.85, radius * 0.95, center.z + radius * 1.05), target: center.clone() },
    town:   { pos: V(center.x - radius * 0.22, radius * 0.22, center.z + radius * 0.62), target: center.clone() },
    gate:   { pos: V(25, 15.5, 117), target: GATE_TARGET.clone() },
    plan:   { pos: V(center.x, radius * 2.6, center.z + 0.01), target: center.clone() },
  };

  let activeView = pendingView;
  let tween = null;

  function markActive(name) {
    activeView = name;
    document.querySelectorAll('.views button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.view === name));
    });
  }

  /**
   * 起一段相机补间。**位置与目标点一起动** —— 只动其一就是硬切。
   * @param onDone 走完后的回调（进场补间用它把「跟随权」还给 player）。
   */
  function startTween(toPos, toTgt, dur, onDone) {
    tween = {
      t0: performance.now(), dur,
      fromPos: camera.position.clone(), fromTgt: controls.target.clone(),
      toPos: toPos.clone(), toTgt: toTgt.clone(), onDone,
    };
    return tween;
  }

  /** 平滑补间（约 700ms），给 UI 按钮 / 键盘用。 */
  function glideTo(name) {
    if (!VIEWS[name]) return false;
    // 切机位 = 退出行走模式。相机目标点不能同时被机位补间和「跟随小人」拉扯，
    // 两个东西写同一个 controls.target，画面会来回抖。
    if (player.active) { player.exit(); document.body.classList.remove('walking'); }
    markActive(name);
    startTween(VIEWS[name].pos, VIEWS[name].target, 700, null);
    return true;
  }

  function stepTween(now) {
    if (!tween) return;
    const k = Math.min(1, (now - tween.t0) / tween.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTgt, tween.toTgt, e);
    if (k >= 1) {
      const done = tween.onDone;
      tween = null;
      if (done) done();
    }
  }

  document.querySelectorAll('.views button').forEach((b) => {
    b.addEventListener('click', () => glideTo(b.dataset.view));
  });
  addEventListener('keydown', (e) => {
    /* 界面按数字键 1–4 切机位：e.key 是 '1'..'4'，不是机位名 */
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < VIEW_NAMES.length) glideTo(VIEW_NAMES[i]);
  });
  document.querySelector('.views').hidden = false;

  /* ---------------- 天气切换 ----------------
   * Q/W/E/R → 晴天/夜晚/雨天/雪天。切完按钮的高亮要跟着走，
   * 否则键盘切了之后 UI 还停在旧天气上，看不出到底切没切。 */
  const WEATHER_KEYS = ['q', 'w', 'e', 'r'];
  function markWeather(name) {
    document.querySelectorAll('.weather button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.weather === name));
    });
  }
  /* opts 透传给 weather.set。
   * 存在的理由不只是方便：验收工具必须走**这条产品路径**，
   * 而不是直接调 weather.set() —— 早前的截图就是这么拍的，
   * 结果 16 张夜景/雨雪图里高亮的按钮全是「晴天」，
   * 因为 markWeather() 被绕过了。**绕过产品路径的截图会骗人。** */
  function setWeather(name, opts) {
    const ok = weather.set(name, opts);
    if (ok) markWeather(name);
    return ok;
  }
  document.querySelectorAll('.weather button').forEach((b) => {
    b.addEventListener('click', () => setWeather(b.dataset.weather));
  });
  addEventListener('keydown', (e) => {
    // **行走模式下只让位 W**：W 同时是「夜晚」和「前进」，按 W 走路不能顺手换天。
    // Q/E/R 与移动键不冲突，行走中照常可用 —— 四个键全让位是上一版的过度保守，
    // 结果是走在镇子里想看夜景/雨天必须停下走去点按钮。
    const k = e.key.toLowerCase();
    if (player.active && k === 'w') return;
    const i = WEATHER_KEYS.indexOf(k);
    if (i >= 0 && WEATHER_NAMES[i]) setWeather(WEATHER_NAMES[i]);
  });
  document.querySelector('.weather').hidden = false;
  markWeather(weather.current);

  applyView(pendingView);

  /* ---------------- 首帧 + 阴影 ----------------
   * 教训（实测踩到）：把阴影烘焙和首帧画在**同一次同步 render** 里，会把整个 boot 堵死。
   * 4096² 阴影贴图 + 260 万三角面这一次调用，在软件光栅或弱 GPU 上要几十秒到几分钟，
   * 加载层就永远停在「正在烘焙阴影与环境光 96%」，看上去像页面死了。
   *
   * 改法：首帧**不烘**阴影，先把镇子画出来让加载层退掉；
   * 烘焙推到首帧之后，变成「画面已经出来之后的一次短暂停顿」。
   */
  onProgress({ phase: 'shadow', ratio: 0.96, label: '正在合成光照……' });
  renderer.render(scene, camera);       // 首帧：无阴影，立即返回

  bounds = { center: center.clone(), radius, size: size.clone() };
  Object.assign(window.__asset, {
    bounds, glideTo, sun, hemi, texKeys: Object.keys(tex),
    /** 墙道步道模块（第一批）；第二批人物系统会直接复用它的 centerline。 */
    wall,
    /** 城墙阶梯（第四批）：group / meshes / nodes / footprint / stats()。
     *  `footprint` 就是玩家 `walkable.sample()` 的解析面来源。 */
    wallStairs,
    /** 人物系统（第三批）：group / stats() / gaitProbe() / update(dt) / refreshShadows() */
    crowd,
    /** 第三人称小人：enter/exit/toggle/update/teleport/cameraPose/stats()/walkable */
    player,
    /** 进出行走模式的唯一入口。验收工具必须走它，不许直接调 player.enter() ——
     *  直接调会跳过进场补间，拍出来的第一张图是硬切后的机位。 */
    setWalk, walkable,
    /** 镇外原野（第五批 ④）：mesh / stats() */
    surrounds,
    /** 天气系统：set(name) / current / update(dt) / stats() */
    weather,
    setWeather,
    /**
     * 开发期探针（tests/probe.mjs 用）：把每张烘出来的 albedo 缩到 32² 读回均值，
     * 直接对比「贴图里的颜色」与「GLB 原始 baseColor」，避免靠肉眼猜色调。
     * detail 贴图存的是高度，不是颜色，所以只统计 albedo。
     */
    texMean() {
      const out = {};
      for (const [k, v] of Object.entries(tex)) {
        const c = document.createElement('canvas');
        c.width = c.height = 48;
        const cx = c.getContext('2d');
        cx.drawImage(v.map.image, 0, 0, 48, 48);
        const d = cx.getImageData(0, 0, 48, 48).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        out[k] = [r / n, g / n, b / n].map((x) => Math.round(x));
      }
      return out;
    },
    /**
     * 开发期探针：把某张烘出来的贴图原样导出成 PNG。
     * 判据纪律里说「不要用 canvas.toDataURL 判断 WebGL 画面是否为空」——
     * 那条针对的是 WebGL 画布（未开 preserveDrawingBuffer 恒为全黑）。
     * 这里取的是我们自己 new 出来的 2D canvas，读到的是真实像素，可以放心用。
     */
    texDump(key) {
      const t = tex[key];
      if (!t) return null;
      return { map: t.map.image.toDataURL('image/png'), detail: t.detail.image.toDataURL('image/png') };
    },
    /**
     * 开发期探针：每张 albedo 的亮度分布（min / p1 / 均值 / p99 / max）。
     * 用来判断「贴图本身的动态范围」和「渲染出来的动态范围」差多少 ——
     * 贴图 p99 只有 0.8 却在画面里被烧成纯白，就说明问题不在贴图。
     */
    texStats() {
      const out = {};
      for (const [k, v] of Object.entries(tex)) {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const cx = c.getContext('2d');
        cx.drawImage(v.map.image, 0, 0, 128, 128);
        const d = cx.getImageData(0, 0, 128, 128).data;
        const L = new Float64Array(128 * 128);
        let sum = 0;
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          L[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          sum += L[p];
        }
        const s = Array.from(L).sort((x, y) => x - y);
        out[k] = {
          min: +s[0].toFixed(3),
          p01: +s[(s.length * 0.01) | 0].toFixed(3),
          mean: +(sum / s.length).toFixed(3),
          p99: +s[(s.length * 0.99) | 0].toFixed(3),
          max: +s[s.length - 1].toFixed(3),
        };
      }
      return out;
    },
    /** 查一个材质当前实际生效的着色参数（前缀匹配，容忍 ` | GLB` 尾巴）。 */
    matInfo(name) {
      const key = String(name).replace(/\s*\|\s*GLB\s*$/, '').trim();
      const found = new Map();
      town.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          const k = String(m.name || '').replace(/\s*\|\s*GLB\s*$/, '').trim();
          if (k === key || k.startsWith(key)) found.set(m.uuid, m);
        }
      });
      return [...found.values()].map((m) => ({
        name: m.name,
        color: [m.color.r, m.color.g, m.color.b].map((v) => +v.toFixed(3)),
        rough: m.roughness, metal: m.metalness, env: m.envMapIntensity,
        bump: m.bumpScale, map: m.map ? `${m.map.image.width}²` : null,
        mapUuid: m.map ? m.map.uuid : null,
        detail: m.bumpMap ? `${m.bumpMap.image.width}²` : null,
      }));
    },
    /** 开发期探针：把场景里所有用过各张 albedo 贴图的材质列出来（查贴图是否被串用）。 */
    texOwners() {
      const use = {};
      for (const [k, v] of Object.entries(tex)) use[v.map.uuid] = k;
      const rows = new Map();
      town.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          const k = m.map && use[m.map.uuid];
          if (!k) continue;
          const key = `${k}  ::  ${m.name}`;
          rows.set(key, (rows.get(key) || 0) + 1);
        }
      });
      return [...rows.entries()].map(([k, n]) => `${n}×  ${k}`).sort();
    },
  });
  /* `ready` 的语义是「场景 + 贴图 + **阴影** 都到位」。
     首帧故意不烘阴影（见下方注释），所以这里先给 false，
     等延迟烘焙真正被主循环消费掉之后才翻 true——
     否则 tests/shots.mjs 会在阴影还没画出来时就截图，拍到一张无影的假通过图。 */
  Object.assign(window.__QA__, {
    ready: shadowsReady,
    glideTo,
    views: VIEW_NAMES.slice(),
    diag() {
      const r = renderer.info.render;
      const m = renderer.info.memory;
      const d = sunDirection();
      const cs = crowd.stats();
      const ws = weatherStats();
      return {
        ready: shadowsReady,
        view: activeView,
        triangles: r.triangles,
        calls: r.calls,
        lines: r.lines,
        points: r.points,
        frame: renderer.info.render.frame,
        geometries: m.geometries,
        textures: m.textures,
        programs: renderer.info.programs ? renderer.info.programs.length : -1,
        materials: stats.count,
        tintedMaterials: stats.tinted,
        leafMaterialsFixed: stats.leafFixed,
        proceduralTextures: Object.keys(tex).length * 2,
        shadowCasters: casters,
        shadowReceivers: receivers,
        shadowsEnabled: renderer.shadowMap.enabled,
        shadowMapAutoUpdate: renderer.shadowMap.autoUpdate,
        shadowMapSize: sun.shadow.mapSize.x,
        shadowBaked: !!sun.shadow.map,
        gpu: gpuName || '(未暴露)',
        softGPU,
        shadowRadius: TUNE.sun.shadowRadius,
        shadowBias: sun.shadow.bias,
        shadowNormalBias: sun.shadow.normalBias,
        sunAzimuthDeg: TUNE.sun.azimuthDeg,
        sunElevDeg: TUNE.sun.elevationDeg,
        sunIntensity: sun.intensity,
        hemiIntensity: hemi.intensity,
        fogType: scene.fog.type,
        fogDensity: scene.fog.density,
        exposure: renderer.toneMappingExposure,
        toneMapping: renderer.toneMapping,
        environment: !!scene.environment,
        skyRadius: TUNE.sky.radius,
        bounds: { size: [size.x, size.y, size.z], radius },
        sunDir: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)],
        /* ---- 城墙步道（wallwalk.js）---- */
        wallwalkCenterlinePoints: wallStats.centerlinePoints,
        wallwalkSpacingM: wallStats.centerlineSpacingM,
        wallwalkPerimeterM: wallStats.centerlinePerimeterM,
        wallwalkRuns: wallStats.runs,
        wallwalkWalkSegments: wallStats.walkSegments,
        wallwalkMerlons: wallStats.merlons,
        wallwalkMerlonsSkippedAtGate: wallStats.merlonSkippedAtGate,
        wallwalkParapetSegments: wallStats.parapetSegments,
        wallwalkGates: wallStats.gates,
        wallwalkNewTriangles: wallStats.newTriangles,
        wallwalkDrawCalls: wallStats.newDrawCalls,
        wallwalkMeshes: wallStats.meshes,
        wallwalkBands: {
          merlon: wallStats.merlonDepthM,
          walkway: wallStats.walkwayWidthM,
          parapet: wallStats.parapetThickM,
          sum: wallStats.bandSumM,
          coping: wallStats.copingWidthM,
        },
        wallwalkPaving: { bedDepth: wallStats.walkwayBedDepthM, topProud: wallStats.walkwayTopProudM },
        /* ---- 护墙豁口 + 阶梯落位（第四批）---- */
        wallwalkParapetSkippedInGap: wallStats.parapetSkippedInGap,
        wallwalkStairGaps: wallStats.stairGaps,
        wallwalkStairGapHalfWidthM: wallStats.stairGapHalfWidthM,
        wallwalkStairGapOpenM: wallStats.stairGapOpenM,
        wallwalkStairsClearBoxes: wallStats.stairsClearBoxes,
        wallwalkStairsClearChecked: wallStats.stairsClearChecked,
        wallwalkStairPlan: wallStats.stairPlan,
        /* ---- 城墙阶梯（wallstair.js）---- */
        stairCount: stairStats.stairs,
        stairRiserTargetM: stairStats.riserTargetM,
        stairRiserRangeM: stairStats.riserRangeM,
        stairCountRange: stairStats.countRange,
        stairTreadM: stairStats.treadM,
        stairWidthM: stairStats.widthM,
        stairLandingM: stairStats.landingM,
        stairTotalAlongRangeM: stairStats.totalAlongRangeM,
        stairMaterials: stairStats.materials,
        stairNewTriangles: stairStats.newTriangles,
        stairDrawCalls: stairStats.newDrawCalls,
        stairMeshes: stairStats.meshes,
        stairPerStair: stairStats.perStair,
        /* ---- 人物系统（crowd.js）---- */
        crowdPeople: cs.people,
        crowdDrawCalls: cs.drawCalls,
        crowdTriangles: cs.triangles,
        crowdInstances: cs.instances,
        crowdByGroup: cs.byGroup,
        crowdSpeedMps: cs.speedMps,
        crowdHeightM: cs.heightM,
        crowdPaths: {
          wall: `${cs.paths.wall.runs} 段 / ${cs.paths.wall.lengthM}m / 剔除 ${cs.paths.wall.rejected} 点`,
          street: `${cs.paths.street.runs} 段 / ${cs.paths.street.lengthM}m / 剔除 ${cs.paths.street.rejected} 点`,
          piazza: `${cs.paths.piazza.runs} 段 / ${cs.paths.piazza.lengthM}m / 剔除 ${cs.paths.piazza.rejected} 点`,
        },
        crowdGait: cs.gait,
        crowdShadow: cs.shadows,
        crowdBlockers: cs.blockers,
        crowdMaterial: cs.material.name,
        crowdColorways: cs.colorways,
        /* ---- 镇外原野（surrounds.js）---- */
        surrounds: {
          rimRMin: surStats.rimRMin, rimRMax: surStats.rimRMax,
          rimYMin: surStats.rimYMin, rimYMax: surStats.rimYMax,
          edgeSlopeMin: surStats.edgeSlopeMin, edgeSlopeMax: surStats.edgeSlopeMax,
          plainY: surStats.plainY,
          boundaryLoopVerts: surStats.boundaryLoopVerts,
          seamRadialMaxM: surStats.seamRadialMaxM,
          seamHeightMaxM: surStats.seamHeightMaxM,
          rings: surStats.rings, reachM: surStats.reachM,
          newTriangles: surStats.newTriangles, newDrawCalls: surStats.newDrawCalls,
          material: surStats.material,
          detailFade: surStats.detailFade,
          heightRange: surStats.heightRange,
        },
        /* ---- 天气系统（weather.js）---- */
        weather: ws,
        /* ---- 第三人称小人（player.js）---- */
        player: player.stats(),
      };
    },
  });

  /* ---------------- 主循环 ----------------
   * dt 上限 0.25s：切标签页回来时 rAF 会给一个几秒的巨帧，不夹住的话人群会瞬移。
   * 夹住也顺带给 crowd 的阴影重烘提供了可信的「帧代价」信号（见 crowd.js 文件头）。
   */
  let lastNow = 0;
  function tick(now) {
    const dt = lastNow ? Math.min(0.25, Math.max(0, (now - lastNow) / 1000)) : 0;
    lastNow = now;
    stepTween(now);
    // 顺序要紧：player 先把相机**整体平移**到小人身上，
    // controls.update() 再在新的相对偏移上施加阻尼 ⇒ 鼠标转出来的视角被完整保留。
    player.update(dt);
    crowd.update(dt);
    weather.update(dt);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ---------------- 延后烘焙阴影 ----------------
   * 首帧已经在屏幕上了，这一帧才去画阴影贴图。
   * `shadowMap.autoUpdate` 是关的，所以 needsUpdate 只被消费一次，
   * 主循环后面每帧都不会再重画这张 4096²（或降档后的）贴图。
   */
  setTimeout(() => {
    renderer.shadowMap.needsUpdate = true;
    // needsUpdate 由主循环的下一帧消费掉。等两帧再翻 ready，
    // 保证验收工具截图时阴影贴图确实已经画在屏幕上了。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      shadowsReady = true;
      window.__QA__.ready = true;
    }));
  }, 250);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  return window.__QA__;
}
