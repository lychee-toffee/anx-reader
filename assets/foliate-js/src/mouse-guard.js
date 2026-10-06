// O1 方案 B —— Dart ↔ JS 鼠标事件守卫（Reader Mouse Guard）
//
// 目标：在 Flutter 浮层（文本选择工具栏等）覆盖的区域内，让 WebView 不再处理
// 鼠标事件，从而从源头避免：
//   - onSelectionCleared（选区被清 -> Dart 拆掉浮层）
//   - click-view（Dart onClick -> 翻页 / 重开阅读菜单）
// 触控（pointerType === 'touch'）路径完全不受影响（见 design §5.8）。
//
// 状态真值在顶层 window 的模块作用域，同时暴露到 window.__anxMouseGuard 供取证；
// Dart 通过 window.__anxSetMouseGuard(payload) 下发（见 design §5.1）。

const GUARD_VERSION = 1;
// 闩锁：pointerup 之后继续吞的时长（覆盖实测 +100ms 迟到 click）。
// D2b 修复（design §11.2）：实测选区塌陷会在被守卫按下后 ~350ms 才到达，
// 越过原 250ms 窗口 → 由方案 A 兜底；放宽到 400ms 让 JS 侧自行兜住，
// 取值由用例 13/14/17 反证不误吞（见 design §5.5）。
const COOLDOWN_MS = 400;
const PRESS_SAFETY_MS = 1000; // 兜底：按下后若 pointerup 丢失，最多按住 1s

const state = {
  v: GUARD_VERSION,
  seq: -1,
  active: false,
  scope: 'rects',
  rects: [],
  sources: [],
  updatedAt: 0,
};

// 闩锁：从被守卫的 mouse pointerdown 起，直到 pointerup 后 COOLDOWN_MS 内继续吞。
// rects 是"按下瞬间"的区域快照——即使 Dart 随后撤销区域，迟到的 click 仍会被吞。
const latch = { press: false, until: 0, scope: 'rects', rects: [] };
let pressSafetyTimer = null;

const isNum = (v) => typeof v === 'number' && isFinite(v);
const now = () => Date.now();

const hitRects = (rects, x, y) => {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return true;
  }
  return false;
};

const hit = (scope, rects, x, y) =>
  scope === 'all' || hitRects(rects, x, y);

const regionGuarded = (x, y) =>
  state.active &&
  (state.scope === 'all' || state.rects.length > 0) &&
  hit(state.scope, state.rects, x, y);

const latchGuarded = (x, y) => {
  if (latch.press) return hit(latch.scope, latch.rects, x, y);
  if (latch.until > 0 && now() < latch.until) return hit(latch.scope, latch.rects, x, y);
  return false;
};

const isGuarded = (x, y) => regionGuarded(x, y) || latchGuarded(x, y);

// book.js 的 handleSelectionStateChange 用它在闩锁期间短路 onSelectionCleared。
export const isMouseGuardLatchActive = () =>
  latch.press || (latch.until > 0 && now() < latch.until);

const clearPressSafety = () => {
  if (pressSafetyTimer) {
    clearTimeout(pressSafetyTimer);
    pressSafetyTimer = null;
  }
};

const startLatch = (scope, rects) => {
  latch.press = true;
  latch.until = 0;
  latch.scope = scope;
  latch.rects = rects.slice();
  clearPressSafety();
  pressSafetyTimer = setTimeout(() => {
    pressSafetyTimer = null;
    if (!latch.press) return;
    latch.press = false;
    latch.until = now() + COOLDOWN_MS;
  }, PRESS_SAFETY_MS);
};

const endLatchPress = () => {
  if (!latch.press) return;
  latch.press = false;
  latch.until = now() + COOLDOWN_MS;
  clearPressSafety();
};

const normalizeRects = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!Array.isArray(r) || r.length < 4) continue;
    if (!isNum(r[0]) || !isNum(r[1]) || !isNum(r[2]) || !isNum(r[3])) continue;
    const left = Math.min(r[0], r[2]);
    const right = Math.max(r[0], r[2]);
    const top = Math.min(r[1], r[3]);
    const bottom = Math.max(r[1], r[3]);
    if (right <= left || bottom <= top) continue;
    out.push([left, top, right, bottom]);
  }
  return out;
};

// Dart -> JS 唯一入口；payload 为 JSON 字面量，非法输入静默忽略（fail-open）。
export const setMouseGuard = (payload) => {
  try {
    if (!payload || typeof payload !== 'object') return;
    if (!isNum(payload.seq) || payload.seq <= state.seq) return; // 丢弃陈旧/乱序包
    state.seq = payload.seq;
    state.v = isNum(payload.v) ? payload.v : GUARD_VERSION;
    state.active = payload.active === true;
    state.scope = payload.scope === 'all' ? 'all' : 'rects';
    state.rects = normalizeRects(payload.rects);
    state.sources = Array.isArray(payload.sources) ? payload.sources.map(String) : [];
    state.updatedAt = now();
    // D2 修复（design §5.5）：Dart 撤销区域时**不得**清除闩锁。
    // 闩锁独立于 state.active，只按自身生命周期结束（pointerup + COOLDOWN_MS，
    // 或 PRESS_SAFETY_MS 兜底）；否则"浮层已撤销、迟到 click/塌陷才到"会漏。
  } catch (_) {}
};

// 事件坐标（iframe 视口）-> 顶层 WebView 视口归一化坐标 [0,1]（见 design §5.4）。
const toViewportPoint = (win, e) => {
  try {
    let vx = e.clientX;
    let vy = e.clientY;
    const frameElement = win.frameElement;
    if (frameElement) {
      const frameRect = frameElement.getBoundingClientRect();
      vx += frameRect.left;
      vy += frameRect.top;
    }
    const topWin = win.top;
    const width = topWin.innerWidth || 1;
    const height = topWin.innerHeight || 1;
    return [vx / width, vy / height];
  } catch (_) {
    return null;
  }
};

// 为某个内容文档的 window（或顶层 window）安装 capture 守卫。
// 跨源取不到顶层状态时 fail-open：不安装、记一次 warning（见 design §5.6）。
export const installMouseGuard = (doc) => {
  let win;
  try {
    win = doc && doc.defaultView;
    if (!win) return false;
    // 同源探测：跨源时读取 innerWidth 会抛 SecurityError -> 降级。
    if (typeof win.top.innerWidth !== 'number') throw new Error('inaccessible');
  } catch (_) {
    return false;
  }
  if (win.__anxMouseGuardInstalled) return true;
  win.__anxMouseGuardInstalled = true;

  // 记录最近一次 pointerdown 的类型；MouseEvent（mousedown/click/...）没有
  // pointerType，用它来保证"只吞鼠标、绝不碰触控"。
  let lastPointerType = null;

  const onPointerDown = (e) => {
    lastPointerType = e.pointerType || null;
    if (e.pointerType !== 'mouse') return;
    const p = toViewportPoint(win, e);
    if (!p || !regionGuarded(p[0], p[1])) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    startLatch(state.scope, state.rects);
  };

  const onMouseDown = (e) => {
    if (lastPointerType !== 'mouse') return;
    const p = toViewportPoint(win, e);
    if (!p || !isGuarded(p[0], p[1])) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!latch.press) startLatch(state.scope, state.rects);
  };

  const onPointerUp = (e) => {
    if (e.pointerType) lastPointerType = e.pointerType;
    if (e.pointerType !== 'mouse') return;
    const p = toViewportPoint(win, e);
    const wasPress = latch.press;
    const guardedRegion = p ? regionGuarded(p[0], p[1]) : false;
    if (wasPress) endLatchPress();
    if (!wasPress && !guardedRegion) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onMouseUp = (e) => {
    if (lastPointerType !== 'mouse') return;
    const p = toViewportPoint(win, e);
    const wasPress = latch.press;
    const guardedRegion = p ? regionGuarded(p[0], p[1]) : false;
    if (wasPress) endLatchPress();
    if (!wasPress && !guardedRegion) return;
    e.stopImmediatePropagation();
  };

  const onPointerCancel = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (latch.press) endLatchPress();
  };

  const onSelectStart = (e) => {
    if (lastPointerType !== 'mouse') return;
    if (!latch.press) return;
    e.preventDefault();
  };

  const onClick = (e) => {
    if (lastPointerType !== 'mouse') return;
    const p = toViewportPoint(win, e);
    if (!p || !isGuarded(p[0], p[1])) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onContextMenu = (e) => {
    if (lastPointerType !== 'mouse' && e.pointerType !== 'mouse') return;
    const p = toViewportPoint(win, e);
    if (!p || !isGuarded(p[0], p[1])) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const opts = { capture: true, passive: false };
  win.addEventListener('pointerdown', onPointerDown, opts);
  win.addEventListener('mousedown', onMouseDown, opts);
  win.addEventListener('pointerup', onPointerUp, opts);
  win.addEventListener('mouseup', onMouseUp, opts);
  win.addEventListener('pointercancel', onPointerCancel, opts);
  win.addEventListener('selectstart', onSelectStart, opts);
  win.addEventListener('click', onClick, opts);
  win.addEventListener('dblclick', onClick, opts);
  win.addEventListener('contextmenu', onContextMenu, opts);
  return true;
};

// 顶层 window：暴露 setter/状态，并安装一次顶层守卫
// （覆盖 view.js 里挂在 renderer 上的 click-view 产生点）。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.__anxSetMouseGuard = setMouseGuard;
  window.__anxMouseGuard = state;
  installMouseGuard(document);
}
