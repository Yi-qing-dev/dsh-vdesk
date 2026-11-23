/**
 * @lws31/dsh-vdesk 客户端：静默挂载 + 人工输入优先。
 *
 * 所有形态决策都走 uiState.ts 的 reducer（已用 90/1620/3645 步穷举测试锁住死锁路径）。
 * 这里只负责：轮询状态、把事件翻译成 dispatch、把 state 渲染成 DOM。
 */
import { VDesktopPanel } from './VDesktopPanel.js';
import {
  reduce,
  initialState,
  DEFAULT_SIZE,
  ASPECT,
  type UiState,
  type UiEvent,
  type Phase,
} from './uiState.js';

const PORT_BASE = 8790;
const PORT_COUNT = 10;
const POLL_MS = 1200;

interface VdeskState {
  phase: Phase;
  paused: boolean;
  pauseReason: 'user' | 'conflict' | 'stop' | null;
  lastAction: { kind: string; detail: string; at: number } | null;
  desktop: string | null;
  desktops: string[];
  startedAt: number;
}

interface PluginCtx {
  slots: {
    inject: (name: string, fn: () => unknown) => void;
    register: (
      meta: { name: string; id: string; locale?: string },
      render: (props: { t: (k: string) => string }) => unknown,
    ) => void;
  };
  locale: { register: (ns: string, entries: Record<string, Record<string, string>>) => void };
  effect: (fn: () => void | Promise<void>) => void;
}

async function probePort(): Promise<number | null> {
  for (let i = 0; i < PORT_COUNT; i++) {
    const port = PORT_BASE + i;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/vdesk/state`, {
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (r.ok) return port;
    } catch {
      /* 该端口没服务 */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function getState(port: number): Promise<VdeskState | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/vdesk/state`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as VdeskState;
  } catch {
    return null;
  }
}

function postControl(port: number, action: 'pause' | 'conflict' | 'resume' | 'stop'): void {
  void fetch(`http://127.0.0.1:${port}/vdesk/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).catch(() => {});
}

function prefersDark(): boolean {
  // DSH 主题由 body 的 data-ds-dark-theme 属性标记（light/dark/system 解析后写入），
  // 以它为准；属性还没挂上时退回系统偏好，最后才用背景亮度启发式兜底。
  try {
    if (document.body?.hasAttribute('data-ds-dark-theme')) return true;
  } catch {
    /* body 不可用时继续向下兜底 */
  }
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return true;
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    if (m && m.length >= 3) {
      const [r, g, b] = m.map(Number);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.55;
    }
  } catch {
    /* 取不到宿主背景就用系统偏好 */
  }
  return false;
}

interface Tokens {
  bg: string;
  bar: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
  ok: string;
  warn: string;
}

function tokens(dark: boolean): Tokens {
  return dark
    ? {
        bg: '#17181b',
        bar: '#1e2024',
        border: '#2c2f36',
        text: '#e8e9ec',
        muted: '#8d9199',
        accent: '#4a9eff',
        danger: '#f2545b',
        ok: '#3ecf8e',
        warn: '#f0b429',
      }
    : {
        bg: '#ffffff',
        bar: '#f5f6f8',
        border: '#e3e6eb',
        text: '#1b1d21',
        muted: '#6b7280',
        accent: '#2563eb',
        danger: '#dc2626',
        ok: '#059669',
        warn: '#b45309',
      };
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '空闲',
  running: '执行中',
  paused: '已暂停',
  conflict: 'AI 已暂停',
  stopped: '已停止',
};

function phaseColor(phase: Phase, tk: Tokens): string {
  if (phase === 'running') return tk.ok;
  if (phase === 'paused') return tk.warn;
  if (phase === 'conflict') return tk.accent;
  if (phase === 'stopped') return tk.danger;
  return tk.muted;
}

export function install(loader: {
  load: (spec: {
    id: string;
    factory: (require: (m: string) => unknown) => {
      inject: string[];
      apply: (ctx: PluginCtx) => void;
    };
  }) => void;
}): void {
  loader.load({
    id: '@lws31/dsh-vdesk',
    factory: (require: (m: string) => unknown) => {
      const React = require('react') as {
        createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;
        useState: <T>(init: T) => [T, (v: T | ((prev: T) => T)) => void];
        useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
        useRef: <T>(init: T) => { current: T };
      };
      const h = React.createElement;
      /**
       * shell.overlay 的容器带 zIndex:20，在里面设多高都是局部的 —— 实测球被
       * dsh-pet 的 SVG 盖住、点不到（elementFromPoint 返回 svg）。挂到 body
       * 才能拿到真正的顶层。拿不到 react-dom 时退化为原位渲染。
       */
      const ReactDOM = (() => {
        try {
          const rd = require('react-dom') as { createPortal?: unknown } | undefined;
          return rd && typeof rd.createPortal === 'function' ? (rd as { createPortal: (n: unknown, c: Element) => unknown }) : null;
        } catch {
          return null;
        }
      })();
      const toBody = (node: unknown) =>
        ReactDOM && node ? ReactDOM.createPortal(node, document.body) : node;

      return {
        inject: ['slots', 'locale'],
        apply(ctx: PluginCtx) {
          ctx.effect(() =>
            ctx.locale.register('vdesk', {
              zh: {
                title: '虚拟桌面',
                minimize: '收成悬浮球（不停止任务）',
                close: '关闭虚拟桌面',
                closeTitle: '关闭虚拟桌面',
                hideOnly: '仅隐藏',
                exitRun: '退出运行',
                hideNote: '隐藏后可随时让我重新打开。',
                exitNote: '直接结束，虚拟桌面一并关闭，不可恢复。',
                cancel: '取消',
                fullscreen: '全屏',
                restore: '还原',
                send: '发送',
                keyboard: '人工打字',
                placeholder: '输入文字后回车',
                resume: '继续执行',
                pause: '暂停执行',
              },
              en: {
                title: 'Virtual Desktop',
                minimize: 'Minimize to floating ball',
                close: 'Close virtual desktop',
                closeTitle: 'Close virtual desktop',
                hideOnly: 'Hide only',
                exitRun: 'Exit run',
                hideNote: 'Hidden. Ask me to reopen it anytime.',
                exitNote: 'Ends the task and closes the virtual desktop. Cannot be undone.',
                cancel: 'Cancel',
                fullscreen: 'Fullscreen',
                restore: 'Restore',
                send: 'Send',
                keyboard: 'Type',
                placeholder: 'Manual take-over: type and press Enter',
                resume: 'Resume',
                pause: 'Pause',
              },
            }),
          );

          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: '@lws31/dsh-vdesk', locale: 'vdesk' },
              ({ t }) => {
                const [port, setPort] = React.useState<number | null>(null);
                const [remote, setRemote] = React.useState<VdeskState | null>(null);
                const [ui, setUi] = React.useState<UiState>(initialState);
                const [dark, setDark] = React.useState<boolean>(prefersDark());
                const [inputText, setInputText] = React.useState('');
                // 输入浮层的开合用独立 state：实测经 reducer 的 toggleInput 不生效
                // （点击无任何反应），改成组件本地状态，行为可预测。
                const [inputOpen, setInputOpen] = React.useState(false);

                const rootRef = React.useRef<HTMLDivElement | null>(null);
                const shellRef = React.useRef<HTMLDivElement | null>(null);
                const panelRef = React.useRef<VDesktopPanel | null>(null);
                const remoteRef = React.useRef<VdeskState | null>(null);
                const portRef = React.useRef<number | null>(null);
                const touchedAtRef = React.useRef(0);
                const lastActionRef = React.useRef(0);
                const conflictSentRef = React.useRef(0);
                const ballMovedRef = React.useRef(false);

                remoteRef.current = remote;
                portRef.current = port;

                const dispatch = (e: UiEvent) => setUi((s) => reduce(s, e));
                const touch = () => {
                  touchedAtRef.current = Date.now();
                };

                // 端口探测 + 状态轮询
                React.useEffect(() => {
                  let stop = false;
                  let timer: ReturnType<typeof setTimeout> | null = null;
                  let resolved = port;
                  const tick = async () => {
                    if (stop) return;
                    if (resolved === null) {
                      resolved = await probePort();
                      if (stop) return;
                      if (resolved !== null) setPort(resolved);
                    }
                    if (resolved !== null) {
                      const s = await getState(resolved);
                      if (stop) return;
                      if (s) setRemote(s);
                    }
                    timer = setTimeout(tick, resolved === null ? 4000 : POLL_MS);
                  };
                  void tick();
                  return () => {
                    stop = true;
                    if (timer) clearTimeout(timer);
                  };
                }, [port]); // eslint-disable-line react-hooks/exhaustive-deps

                // 服务端 phase → 状态机
                React.useEffect(() => {
                  if (!remote) return;
                  if (remote.phase !== ui.phase) dispatch({ type: 'phase', phase: remote.phase });
                }, [remote?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

                // agent 有新动作：如果 UI 被隐藏且任务还在，拉回来
                React.useEffect(() => {
                  const at = remote?.lastAction?.at ?? 0;
                  if (at > lastActionRef.current) {
                    lastActionRef.current = at;
                    // vdesk_show 是显式唤回，其余动作只在未被用户隐藏时才弹面板
                    dispatch(remote?.lastAction?.kind === 'show' ? { type: 'show' } : { type: 'agentActed' });
                  }
                }, [remote?.lastAction?.at]); // eslint-disable-line react-hooks/exhaustive-deps

                // 主题跟随：DSH 切换 light/dark/system 时会改写 body 的 data-ds-dark-theme，
                // 用 MutationObserver 盯属性变化；同时保留系统偏好监听兜底。
                React.useEffect(() => {
                  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
                  const sync = () => setDark(prefersDark());
                  mq?.addEventListener?.('change', sync);
                  const obs = new MutationObserver(sync);
                  if (document.body) {
                    obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
                  }
                  return () => {
                    mq?.removeEventListener?.('change', sync);
                    obs.disconnect();
                  };
                }, []);

                // 画面实例：只在面板形态下创建，避免隐藏时还在截图。
                // 关键：VDesktopPanel 会对自己挂载的节点做 innerHTML='' + appendChild，
                // 绝不能把 React 渲染出来的节点交给它 —— 那会让 React 的 fiber 记录和
                // 真实 DOM 不一致，卸载时抛 removeChild NotFoundError，整个 slot 崩掉。
                // 所以这里自己建一个 React 不知道的中间节点。
                React.useEffect(() => {
                  const host = rootRef.current;
                  const desktop = remote?.desktop;
                  if (ui.view !== 'panel' || !host || !port || !desktop) return;
                  const mount = document.createElement('div');
                  mount.style.cssText = 'position:absolute;inset:0;display:flex;';
                  host.appendChild(mount);
                  const p = new VDesktopPanel(mount, {
                    desktop,
                    frameUrl: `http://127.0.0.1:${port}/vdesk/frame`,
                    inputUrl: `http://127.0.0.1:${port}/vdesk/input`,
                    scaleMode: 'contain',
                    pollMinMs: 300,
                  });
                  p.start();
                  p.setPaused(!!remoteRef.current?.paused);
                  panelRef.current = p;
                  return () => {
                    p.destroy();
                    panelRef.current = null;
                    if (mount.parentNode === host) host.removeChild(mount);
                  };
                }, [ui.view, port, remote?.desktop]); // eslint-disable-line react-hooks/exhaustive-deps

                React.useEffect(() => {
                  panelRef.current?.setPaused(!!remote?.paused);
                }, [remote?.paused]);

                // 隐藏（收成球）后 5 分钟无动作 → 自动关闭桌面
                React.useEffect(() => {
                  if (ui.view !== 'ball') return;
                  const timer = setInterval(() => {
                    const s = remoteRef.current;
                    if (!s || s.phase === 'idle' || s.phase === 'stopped') return;
                    const mark = Math.max(s.lastAction?.at ?? 0, s.startedAt ?? 0, touchedAtRef.current);
                    if (Date.now() - mark < 5 * 60_000) return;
                    void fetch(`http://127.0.0.1:${portRef.current}/vdesk/close_desktop`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: s.desktop }),
                    }).catch(() => {});
                  }, 15_000);
                  return () => clearInterval(timer);
                }, [ui.view]);

                const tk = tokens(dark);
                const phase = remote?.phase ?? 'idle';
                const desktopName = remote?.desktop ?? '虚拟桌面';

                if (ui.view === 'hidden') return null;

                const onEnterSurface = () => {
                  if (!port || phase !== 'running') return;
                  if (conflictSentRef.current === remote?.startedAt) return;
                  conflictSentRef.current = remote?.startedAt ?? 0;
                  postControl(port, 'conflict');
                };

                const sendInput = async () => {
                  const text = inputText;
                  if (!port || !remote?.desktop || !text.trim()) return;
                  setInputText('');
                  await fetch(`http://127.0.0.1:${port}/vdesk/input`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ desktop: remote.desktop, kind: 'type', text }),
                  }).catch(() => {});
                  touch();
                };

                // ── 呼吸球 ──
                if (ui.view === 'ball') {
                  const startBallDrag = (e: any) => {
                    const sx = e.clientX;
                    const sy = e.clientY;
                    const base = ui.ballPos ?? { x: window.innerWidth - 62, y: window.innerHeight - 62 };
                    let moved = false;
                    ballMovedRef.current = false;
                    const move = (ev: any) => {
                      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
                      moved = true;
                      ballMovedRef.current = true;
                      dispatch({
                        type: 'moveBall',
                        pos: {
                          x: Math.max(4, Math.min(base.x + (ev.clientX - sx), window.innerWidth - 50)),
                          y: Math.max(4, Math.min(base.y + (ev.clientY - sy), window.innerHeight - 50)),
                        },
                      });
                    };
                    const up = () => {
                      window.removeEventListener('pointermove', move);
                      window.removeEventListener('pointerup', up);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', up);
                    e.preventDefault();
                  };

                  return toBody(h(
                    'div',
                    { style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483000 } },
                    h('style', null,
                      '@keyframes vdesk-ball-pulse{0%,100%{box-shadow:0 5px 14px rgba(58,82,201,.32)}50%{box-shadow:0 5px 20px rgba(58,82,201,.55)}}'),
                    h(
                      'button',
                      {
                        type: 'button',
                        title: `${desktopName} · ${PHASE_LABEL[phase]} · 点击展开`,
                        onClick: () => {
                          if (ballMovedRef.current) {
                            ballMovedRef.current = false;
                            return;
                          }
                          touch();
                          dispatch({ type: 'expand' });
                        },
                        onPointerDown: startBallDrag,
                        style: {
                          position: 'fixed',
                          left: ui.ballPos ? ui.ballPos.x : undefined,
                          top: ui.ballPos ? ui.ballPos.y : undefined,
                          right: ui.ballPos ? 'auto' : 20,
                          bottom: ui.ballPos ? 'auto' : 110,
                          width: 42,
                          height: 42,
                          borderRadius: '50%',
                          border: 'none',
                          padding: 0,
                          pointerEvents: 'auto',
                          cursor: 'pointer',
                          background: 'linear-gradient(140deg, #3A52C9 0%, #5C74E0 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          animation: 'vdesk-ball-pulse 2.6s ease-in-out infinite',
                          touchAction: 'none',
                          opacity: 0.94,
                        },
                      },
                      h(
                        'svg',
                        { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none' },
                        h('path', {
                          d: 'M4 15.2c3.6 3 9.2 3.4 13-1.4',
                          stroke: '#fff',
                          strokeWidth: 2,
                          strokeLinecap: 'round',
                        }),
                        h('circle', { cx: 16.6, cy: 9.2, r: 1.7, fill: '#fff' }),
                      ),
                    ),
                  ));
                }

                // ── 面板 ──
                const iconBtn = (label: string, title: string, onClick: () => void) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      title,
                      onClick,
                      style: {
                        background: 'transparent',
                        border: 'none',
                        color: tk.muted,
                        cursor: 'pointer',
                        font: '13px/1 inherit',
                        padding: '3px 5px',
                        borderRadius: 4,
                      },
                    },
                    label,
                  );

                const switchEl = (on: boolean) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'switch',
                      'aria-checked': on,
                      title: on ? t('pause') : t('resume'),
                      disabled: phase === 'stopped',
                      onClick: () => {
                        if (!port || phase === 'stopped') return;
                        touch();
                        postControl(port, on ? 'pause' : 'resume');
                      },
                      style: {
                        width: 34,
                        height: 18,
                        borderRadius: 9,
                        border: 'none',
                        padding: 0,
                        position: 'relative',
                        cursor: phase === 'stopped' ? 'default' : 'pointer',
                        background: phase === 'stopped' ? '#555b66' : on ? '#3A52C9' : '#8a8f99',
                        opacity: phase === 'stopped' ? 0.45 : 1,
                        transition: 'background .18s',
                        flex: '0 0 auto',
                      },
                    },
                    h('span', {
                      style: {
                        position: 'absolute',
                        top: 2,
                        left: on ? 18 : 2,
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: '#fff',
                        transition: 'left .18s',
                      },
                    }),
                  );

                const beginResize = (e: any, hx: number, hy: number) => {
                  const sx = e.clientX;
                  const sy = e.clientY;
                  const sw = ui.size.w;
                  const sp = ui.pos ?? { x: window.innerWidth - 20 - sw, y: window.innerHeight - 20 - ui.size.h };
                  const maxW = () => Math.min(window.innerWidth - 40, (window.innerHeight - 100) * ASPECT);
                  const move = (ev: any) => {
                    const delta = ((ev.clientX - sx) * hx + (ev.clientY - sy) * hy * ASPECT) / 2;
                    const w = Math.max(320, Math.min(sw + delta * 2, maxW()));
                    const hh = w / ASPECT;
                    dispatch({ type: 'resize', size: { w, h: hh } });
                    if (hx < 0) dispatch({ type: 'moveTo', pos: { x: sp.x + (sw - w), y: sp.y + (ui.size.h - hh) } });
                  };
                  const up = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', up);
                  e.preventDefault();
                  e.stopPropagation();
                };

                const resizeZones = () => {
                  const z = (style: any, hx: number, hy: number) =>
                    h('div', {
                      onPointerDown: (e: any) => beginResize(e, hx, hy),
                      style: { position: 'absolute', pointerEvents: 'auto', zIndex: 5, ...style },
                    });
                  return [
                    z({ left: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' }, -1, 0),
                    z({ right: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' }, 1, 0),
                    z({ left: 0, top: 0, width: '100%', height: 6, cursor: 'ns-resize' }, 0, -1),
                    z({ left: 0, bottom: 0, width: '100%', height: 6, cursor: 'ns-resize' }, 0, 1),
                    z({ right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize' }, 1, 1),
                  ];
                };

                const panelStyle = ui.fullscreen
                  ? {
                      position: 'fixed',
                      top: 'max(8px, var(--dsh-frame-chrome-top, 0px))',
                      left: 8,
                      right: 8,
                      bottom: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      background: tk.bg,
                      border: `1px solid ${tk.border}`,
                      borderRadius: 10,
                      overflow: 'hidden',
                      pointerEvents: 'auto',
                      color: tk.text,
                      font: '12px/1.45 system-ui, "Segoe UI", sans-serif',
                    }
                  : {
                      position: 'fixed',
                      left: ui.pos ? ui.pos.x : undefined,
                      top: ui.pos ? ui.pos.y : undefined,
                      right: ui.pos ? 'auto' : 20,
                      bottom: ui.pos ? 'auto' : (inputOpen ? 90 : 20),
                      boxSizing: 'border-box',
                      width: ui.size.w,
                      height: ui.size.h,
                      display: 'flex',
                      flexDirection: 'column',
                      background: tk.bg,
                      border: `1px solid ${tk.border}`,
                      borderRadius: 10,
                      boxShadow: dark ? '0 12px 32px rgba(0,0,0,0.5)' : '0 12px 32px rgba(15,23,42,0.16)',
                      overflow: 'hidden',
                      pointerEvents: 'auto',
                      color: tk.text,
                      font: '12px/1.45 system-ui, "Segoe UI", sans-serif',
                    };

                return toBody(h(
                  'div',
                  { style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147482000 } },
                  h(
                    'div',
                    {
                      ref: shellRef,
                      style: panelStyle,
                    },
                    // 顶栏
                    h(
                      'div',
                      {
                        onPointerDown: ui.fullscreen
                          ? undefined
                          : (e: any) => {
                              const el = shellRef.current;
                              if (!el) return;
                              const rect = el.getBoundingClientRect();
                              const ox = e.clientX - rect.left;
                              const oy = e.clientY - rect.top;
                              const move = (ev: any) => {
                                dispatch({
                                  type: 'moveTo',
                                  pos: {
                                    x: Math.max(4, Math.min(ev.clientX - ox, window.innerWidth - rect.width - 4)),
                                    y: Math.max(4, Math.min(ev.clientY - oy, window.innerHeight - 80)),
                                  },
                                });
                              };
                              const up = () => {
                                window.removeEventListener('pointermove', move);
                                window.removeEventListener('pointerup', up);
                              };
                              window.addEventListener('pointermove', move);
                              window.addEventListener('pointerup', up);
                              e.preventDefault();
                            },
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '5px 8px',
                          background: tk.bar,
                          borderBottom: `1px solid ${tk.border}`,
                          cursor: ui.fullscreen ? 'default' : 'grab',
                          userSelect: 'none',
                          flex: '0 0 auto',
                        },
                      },
                      h('span', {
                        style: {
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: phaseColor(phase, tk),
                          flex: '0 0 auto',
                        },
                      }),
                      h(
                        'span',
                        {
                          style: {
                            fontWeight: 600,
                            maxWidth: 140,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                          title: desktopName,
                        },
                        desktopName,
                      ),
                      h('span', { style: { color: tk.muted, flex: '0 0 auto' } }, PHASE_LABEL[phase]),
                      h('span', { style: { flex: 1 } }),
                      switchEl(phase === 'running'),
                      iconBtn('⌨', t('keyboard'), () => {
                        touch();
                        setInputOpen((v) => !v);
                      }),
                      iconBtn('−', t('minimize'), () => {
                        touch();
                        setInputOpen(false);
                        dispatch({ type: 'minimize' });
                      }),
                      iconBtn(ui.fullscreen ? '❐' : '□', ui.fullscreen ? t('restore') : t('fullscreen'), () => {
                        touch();
                        dispatch({ type: 'toggleFullscreen' });
                      }),
                      iconBtn('✕', t('close'), () => {
                        touch();
                        dispatch({ type: 'requestClose' });
                      }),
                    ),
                    // 画面
                    h('div', {
                      ref: rootRef,
                      onPointerEnter: onEnterSurface,
                      onMouseDown: onEnterSurface,
                      style: {
                        flex: '1 1 auto',
                        minHeight: 0,
                        minWidth: 0,
                        position: 'relative',
                        background: '#000',
                      },
                    },
                    ...(!ui.fullscreen ? resizeZones() : []),
                    ),
                  ),
                  // 输入浮层：独立卡片，与主窗隔 8px，宽度跟随
                  inputOpen &&
                    h(
                      'div',
                      {
                        style: ui.fullscreen
                          ? {
                              position: 'fixed',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              bottom: 20,
                              width: 640,
                              display: 'flex',
                              gap: 6,
                              background: tk.bg,
                              border: `1px solid ${tk.border}`,
                              borderRadius: 10,
                              boxShadow: dark ? '0 10px 26px rgba(0,0,0,.5)' : '0 10px 26px rgba(15,23,42,.16)',
                              padding: 8,
                              pointerEvents: 'auto',
                              zIndex: 2147482500,
                            }
                          : {
                              position: 'fixed',
                              left: ui.pos ? ui.pos.x : undefined,
                              top: ui.pos ? ui.pos.y + ui.size.h + 8 : undefined,
                              right: ui.pos ? 'auto' : 20,
                              bottom: ui.pos ? 'auto' : 8,
                              boxSizing: 'border-box',
                              width: ui.size.w,
                              display: 'flex',
                              gap: 6,
                              background: tk.bg,
                              border: `1px solid ${tk.border}`,
                              borderRadius: 10,
                              boxShadow: dark ? '0 10px 26px rgba(0,0,0,.5)' : '0 10px 26px rgba(15,23,42,.16)',
                              padding: 8,
                              pointerEvents: 'auto',
                              zIndex: 2147482500,
                              font: '12px/1.45 system-ui, "Segoe UI", sans-serif',
                            },
                      },
                      h('input', {
                        value: inputText,
                        placeholder: t('placeholder'),
                        autoFocus: true,
                        onChange: (e: any) => setInputText(e.target.value),
                        onKeyDown: (e: any) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void sendInput();
                          }
                          if (e.key === 'Escape') setInputOpen(false);
                        },
                        style: {
                          flex: '1 1 auto',
                          minWidth: 0,
                          background: dark ? '#202226' : '#fff',
                          color: tk.text,
                          border: `1px solid ${tk.border}`,
                          borderRadius: 6,
                          padding: '5px 8px',
                          font: '12px/1.45 inherit',
                          outline: 'none',
                        },
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => void sendInput(),
                          style: {
                            flex: '0 0 auto',
                            background: '#3A52C9',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            padding: '5px 12px',
                            cursor: 'pointer',
                            font: '12px/1.45 inherit',
                          },
                        },
                        t('send'),
                      ),
                    ),
                  // 关闭确认弹窗
                  ui.confirm &&
                    h(
                      'div',
                      {
                        style: {
                          position: 'fixed',
                          inset: 0,
                          background: 'rgba(0,0,0,.45)',
                          pointerEvents: 'auto',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          zIndex: 2147484000,
                        },
                        onClick: () => dispatch({ type: 'cancelClose' }),
                      },
                      h(
                        'div',
                        {
                          onClick: (e: any) => e.stopPropagation(),
                          style: {
                            width: 340,
                            background: tk.bg,
                            border: `1px solid ${tk.border}`,
                            borderRadius: 12,
                            boxShadow: dark ? '0 16px 40px rgba(0,0,0,.6)' : '0 16px 40px rgba(15,23,42,.2)',
                            padding: 16,
                            color: tk.text,
                            font: '12px/1.55 system-ui, "Segoe UI", sans-serif',
                          },
                        },
                        h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 10 } }, t('closeTitle')),
                        h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => {
                              touch();
                              setInputOpen(false);
                              dispatch({ type: 'confirmHide' });
                            },
                            style: {
                              width: '100%',
                              textAlign: 'left',
                              background: dark ? '#202226' : '#f5f6f8',
                              border: `1px solid ${tk.border}`,
                              borderRadius: 8,
                              padding: '8px 10px',
                              cursor: 'pointer',
                              color: tk.text,
                              font: '12px/1.55 inherit',
                              marginBottom: 8,
                            },
                          },
                          h('div', { style: { fontWeight: 600 } }, t('hideOnly')),
                          h('div', { style: { color: tk.muted } }, t('hideNote')),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => {
                              touch();
                              setInputOpen(false);
                              dispatch({ type: 'confirmExit' });
                              // 终止 = 真的结束：先锁 AI 闸门，再把虚拟桌面一并销毁
                              if (port) {
                                postControl(port, 'stop');
                                if (remote?.desktop) {
                                  void fetch(`http://127.0.0.1:${port}/vdesk/close_desktop`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ name: remote.desktop }),
                                  }).catch(() => {});
                                }
                              }
                            },
                            style: {
                              width: '100%',
                              textAlign: 'left',
                              background: 'transparent',
                              border: `1px solid ${tk.danger}`,
                              borderRadius: 8,
                              padding: '8px 10px',
                              cursor: 'pointer',
                              color: tk.danger,
                              font: '12px/1.55 inherit',
                              marginBottom: 10,
                            },
                          },
                          h('div', { style: { fontWeight: 600 } }, t('exitRun')),
                          h('div', { style: { color: tk.muted } }, t('exitNote')),
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', justifyContent: 'flex-end' } },
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => dispatch({ type: 'cancelClose' }),
                              style: {
                                background: 'transparent',
                                border: `1px solid ${tk.border}`,
                                color: tk.muted,
                                borderRadius: 6,
                                padding: '4px 12px',
                                cursor: 'pointer',
                                font: '12px/1.45 inherit',
                              },
                            },
                            t('cancel'),
                          ),
                        ),
                      ),
                    ),
                ));
              },
            ),
          );
        },
      };
    },
  });
}

declare global {
  interface Window {
    __ModuleLoader__?: {
      load: (spec: {
        id: string;
        factory: (require: (m: string) => unknown) => {
          inject: string[];
          apply: (ctx: PluginCtx) => void;
        };
      }) => void;
    };
  }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  install(window.__ModuleLoader__);
}
