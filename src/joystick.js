/**
 * Monteriggioni · 触屏虚拟摇杆
 * ---------------------------------------------------------------------------
 * 左下角固定圆盘，Pointer Events + setPointerCapture 实现：
 *   · 按下圆盘内任意一点即开始（不必精确按在杆头上）；
 *   · **模拟量**：幅值经过死区后直接调制行走速度（轻推慢走、推满全速），
 *     与 `player.js` 的 `setStick(x, y, run)` 对接；
 *   · 推到 ≥92% 外圈切奔跑 —— 触屏没有 Shift，跑就用「推到底」表达；
 *   · pointerup / pointercancel / 页面切走 一律归零，不产生「幽灵移动」。
 *
 * 只有 coarse pointer（触屏为主）设备才建它 —— 桌面有 WASD，
 * 常驻一个圆盘只是噪音。判定放 `isCoarsePointer()`，由 app.js 决定建不建。
 *
 * y 的口径：输出**上为 +1**（屏幕 -y），与「W = 前进」同向，
 * app.js 里直接 `forward * y + right * x`，不需要再翻一次符号。
 */

/** 是否触屏为主的设备。iPad 外接键鼠时 pointer 仍算 coarse，摇杆照建（无害）。 */
export function isCoarsePointer() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * 建一个摇杆。
 *
 * @param {object} o
 * @param {(x:number, y:number, run:boolean)=>void} o.onStick 摇杆值变化回调
 *   （x 右为正、y 上为正，范围 [-1,1]，松手回调 (0,0,false)）
 * @param {number} [o.radius=46] 杆头可移动半径（px），也是归一化分母
 * @param {number} [o.dead=0.14] 死区（归一化幅值），以内视为 0 —— 防手指微颤
 * @param {number} [o.runAt=0.92] 奔跑阈值：有效幅值达到即 run
 * @returns {{ el:HTMLElement, reset():void }} el 挂到 body 即可用
 */
export function createJoystick({ radius = 46, dead = 0.14, runAt = 0.92, onStick }) {
  const el = document.createElement('div');
  el.className = 'joystick';
  el.innerHTML = '<div class="base"></div><div class="knob"></div>';
  const knob = el.querySelector('.knob');

  let pid = -1;                 // 当前捕获的 pointerId；-1 = 空闲
  let cx = 0, cy = 0;           // 圆盘中心（屏幕坐标，pointerdown 时量）
  const st = { x: 0, y: 0, run: false };

  const emit = () => { onStick && onStick(st.x, st.y, st.run); };

  function reset() {
    pid = -1;
    st.x = 0; st.y = 0; st.run = false;
    knob.style.transform = 'translate(-50%, -50%)';
    emit();
  }

  function handleMove(e) {
    // 偏移按半径归一：raw = 手指离圆心几个半径（可以 >1，手指滑出圆盘很正常）。
    let dx = (e.clientX - cx) / radius;
    let dy = (e.clientY - cy) / radius;
    const raw = Math.hypot(dx, dy);
    // 单位方向先于夹紧算 —— 夹紧后的 (dx,dy) 长度是 min(raw,1)，
    // 拿它当方向分母在 raw>1 时会把向量再缩小一次（走过这个坑）。
    const ux = raw > 1e-6 ? dx / raw : 0;
    const uy = raw > 1e-6 ? dy / raw : 0;
    const cl = Math.min(1, raw);

    // 视觉杆头钉在圆盘内。
    knob.style.transform =
      `translate(calc(-50% + ${(ux * cl * radius).toFixed(1)}px), calc(-50% + ${(uy * cl * radius).toFixed(1)}px))`;

    // 死区之后线性铺满 [0,1]：死区里摸不出速度变化，摊给全程才有「轻推慢走」。
    const m = cl <= dead ? 0 : (cl - dead) / (1 - dead);
    st.x = +(ux * m).toFixed(4);
    st.y = +(-uy * m).toFixed(4);      // 屏幕向下为 +y，翻成「上 = 前进」
    st.run = m >= runAt;
    emit();
  }

  el.addEventListener('pointerdown', (e) => {
    if (pid !== -1) return;            // 已经有一根手指在控制
    e.preventDefault();
    pid = e.pointerId;
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    el.setPointerCapture(pid);         // 手指滑出圆盘仍然跟着走
    handleMove(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    handleMove(e);
  });
  el.addEventListener('pointerup', (e) => { if (e.pointerId === pid) reset(); });
  el.addEventListener('pointercancel', (e) => { if (e.pointerId === pid) reset(); });
  // 长按弹系统菜单会打断 pointer 流，先按掉；touch-action:none 管滚动。
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // 页面被切到后台（来电、下拉通知中心）时 pointer 事件可能再也回不来。
  document.addEventListener('visibilitychange', () => { if (document.hidden && pid !== -1) reset(); });

  return { el, reset };
}
