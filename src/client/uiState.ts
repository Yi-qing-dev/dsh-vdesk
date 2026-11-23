/**
 * UI 状态机（纯函数，零依赖，可在 node 里穷举测试）。
 *
 * 形态：hidden / panel / ball，由单一 view 字段表示。
 * 「仅隐藏」与「退出运行」的区别：
 *   - 仅隐藏：userHidden=true，任务继续，界面全消失，等 agent 用 vdesk_show 唤回
 *   - 退出运行：exitRequested=true，任务终止，桌面一并关闭
 */

export type View = 'hidden' | 'panel' | 'ball';

export type Phase = 'idle' | 'running' | 'paused' | 'conflict' | 'stopped';

export interface UiState {
  phase: Phase;
  view: View;
  /** 用户点了「退出运行」，等服务端确认 stopped 后清掉 */
  exitRequested: boolean;
  /** 用户点了「仅隐藏」：界面全消失但任务继续，agent 可用 vdesk_show 唤回 */
  userHidden: boolean;
  fullscreen: boolean;
  confirm: boolean;
  inputOpen: boolean;
  size: { w: number; h: number };
  pos: { x: number; y: number } | null;
  ballPos: { x: number; y: number } | null;
}

export type UiEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'minimize' }
  | { type: 'expand' }
  | { type: 'show' }
  | { type: 'toggleFullscreen' }
  | { type: 'requestClose' }
  | { type: 'confirmHide' }
  | { type: 'confirmExit' }
  | { type: 'cancelClose' }
  | { type: 'toggleInput' }
  | { type: 'agentActed' }
  | { type: 'moveTo'; pos: { x: number; y: number } }
  | { type: 'moveBall'; pos: { x: number; y: number } }
  | { type: 'resize'; size: { w: number; h: number } }
  | { type: 'resetPlacement' };

/**
 * 16:10 —— 与虚拟桌面源分辨率一致，contain 缩放后四周没有黑边，
 * 也不会像 cover 那样把桌面图标和任务栏裁掉。
 *
 * 尺寸不再写死：按视口算一个舒服的默认值，换台电脑也不会过大过小。
 */
export const ASPECT = 16 / 10;
export const MIN_WIDTH = 360;
export const MAX_WIDTH = 900;

export function defaultSize(): { w: number; h: number } {
  let vw = 1280;
  try {
    if (typeof window !== 'undefined' && window.innerWidth) vw = window.innerWidth;
  } catch {
    /* 非浏览器环境用兜底值 */
  }
  const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(vw * 0.42)));
  return { w, h: Math.round(w / ASPECT) };
}

export const DEFAULT_SIZE = { w: 512, h: 320 };

export const initialState: UiState = {
  phase: 'idle',
  view: 'hidden',
  exitRequested: false,
  userHidden: false,
  fullscreen: false,
  confirm: false,
  inputOpen: false,
  size: defaultSize(),
  pos: null,
  ballPos: null,
};

export function isActive(phase: Phase): boolean {
  return phase !== 'idle';
}

export function reduce(state: UiState, event: UiEvent): UiState {
  switch (event.type) {
    case 'phase': {
      const phase = event.phase;
      if (!isActive(phase)) {
        return {
          ...state,
          phase,
          view: 'hidden',
          exitRequested: false,
          userHidden: false,
          confirm: false,
          inputOpen: false,
          fullscreen: false,
          pos: null,
          ballPos: null,
          size: defaultSize(),
        };
      }
      if (state.exitRequested && phase === 'stopped') {
        return {
          ...state,
          phase,
          view: 'hidden',
          exitRequested: false,
          userHidden: false,
          confirm: false,
          inputOpen: false,
          fullscreen: false,
          ballPos: null,
        };
      }
      // 主动隐藏 / 请求退出期间：phase 事件不得把界面拉回来
      if (state.userHidden || state.exitRequested) return { ...state, phase };
      // 只有「原本没有在跑」→「有任务在跑」才自动弹面板。
      // running↔stopped 之间的抖动（关闭桌面时会发生）绝不能把隐藏的面板拉回来，
      // 那正是"点了终止，过一会儿自己又弹出来"的根因；但真的开了新任务要能弹出来。
      const wasLive = state.phase === 'running' || state.phase === 'paused' || state.phase === 'conflict';
      const isLive = phase === 'running' || phase === 'paused' || phase === 'conflict';
      if (!wasLive && isLive) {
        return { ...state, phase, view: 'panel' };
      }
      return { ...state, phase };
    }
    case 'minimize':
      if (!isActive(state.phase)) return state;
      return { ...state, view: 'ball', confirm: false, inputOpen: false, fullscreen: false };
    case 'expand':
      if (!isActive(state.phase)) return state;
      return { ...state, view: 'panel', userHidden: false };
    case 'show':
      // agent 主动唤回：无论之前是隐藏还是收成球，都回到面板
      if (!isActive(state.phase)) return state;
      return { ...state, view: 'panel', userHidden: false, ballPos: null };
    case 'toggleFullscreen':
      if (!isActive(state.phase)) return state;
      return { ...state, fullscreen: !state.fullscreen };
    case 'requestClose':
      return state.view === 'panel' ? { ...state, confirm: true } : state;
    case 'confirmHide':
      if (!isActive(state.phase)) return state;
      // 用户要的是"整个界面都看不见"，不是缩成球
      return { ...state, view: 'hidden', userHidden: true, confirm: false, inputOpen: false };
    case 'confirmExit':
      // 终止 = 立即消失；桌面由 client 侧调 close_desktop 一并关闭
      return {
        ...state,
        view: 'hidden',
        confirm: false,
        inputOpen: false,
        fullscreen: false,
        ballPos: null,
        exitRequested: true,
        userHidden: false,
      };
    case 'cancelClose':
      return { ...state, confirm: false };
    case 'toggleInput':
      if (!isActive(state.phase) || state.view !== 'panel') return state;
      return { ...state, inputOpen: !state.inputOpen };
    case 'agentActed':
      if (!isActive(state.phase)) return state;
      // 用户主动隐藏时不打扰；agent 只回应用 vdesk_show
      if (state.userHidden) return state;
      if (state.exitRequested) return { ...state, exitRequested: false, view: 'panel' };
      // 只有任务真的还在跑，才把隐藏的面板拉回来；已停止的不再打扰
      {
        const live =
          state.phase === 'running' || state.phase === 'paused' || state.phase === 'conflict';
        return live && state.view === 'hidden' ? { ...state, view: 'panel' } : state;
      }
    case 'moveTo':
      return { ...state, pos: event.pos };
    case 'moveBall':
      return { ...state, ballPos: event.pos };
    case 'resize':
      return { ...state, size: event.size };
    case 'resetPlacement':
      return { ...state, pos: null, ballPos: null, size: defaultSize() };
    default:
      return state;
  }
}

/** 不变式：每次 reduce 之后都要成立，测试里逐条断言。空数组 = 健康。 */
export function checkInvariants(state: UiState): string[] {
  const bad: string[] = [];
  // I1：任务在跑时必须留出口 —— 除了用户主动隐藏/主动终止（那时隐藏是期望行为）
  if (
    state.phase !== 'idle' &&
    state.phase !== 'stopped' &&
    !state.exitRequested &&
    !state.userHidden &&
    state.view === 'hidden'
  ) {
    bad.push(`phase=${state.phase} 但 view=hidden：用户没有任何入口`);
  }
  if (state.confirm && state.view !== 'panel') {
    bad.push(`confirm=true 但 view=${state.view}：弹窗不可见`);
  }
  if (state.inputOpen && state.view !== 'panel') {
    bad.push(`inputOpen=true 但 view=${state.view}：输入框无处可挂`);
  }
  if (state.phase === 'idle' && state.view !== 'hidden') {
    bad.push(`phase=idle 但 view=${state.view}：没有桌面却还挂着 UI`);
  }
  if (!(state.size.w > 0 && state.size.h > 0)) {
    bad.push(`非法尺寸 ${state.size.w}x${state.size.h}`);
  }
  const ratio = state.size.w / state.size.h;
  if (Math.abs(ratio - ASPECT) > 0.01) {
    bad.push(`比例漂移 ${ratio.toFixed(3)} != ${ASPECT.toFixed(3)}`);
  }
  return bad;
}
