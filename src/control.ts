/**
 * 会话控制面：人工输入优先的状态机。
 *
 * 状态迁移（对齐豆包虚拟桌面的执行语义）：
 *   idle → running（有虚拟桌面）
 *   running → conflict（用户在面板上按下鼠标 / 移入画面）
 *   running|conflict → paused（用户主动点「暂停」）
 *   paused|conflict → running（用户显式点「继续」，绝不自动恢复）
 *   任意 → stopped（用户点「停止」，此后 AI 不可再注入）
 *
 * 「冻结注入队列」在这里落地为工具入口的 assertCanAct() 闸门：
 * Agent 的每一次键鼠注入都要先过闸，暂停期间直接抛 VDESK_PAUSED，
 * 不存在"把队列跑完再停"的窗口。
 */

export type PauseReason = 'user' | 'conflict' | 'stop';

export type VdeskPhase = 'idle' | 'running' | 'paused' | 'conflict' | 'stopped';

export interface VdeskAction {
  kind: string;
  detail: string;
  at: number;
}

export interface VdeskState {
  phase: VdeskPhase;
  paused: boolean;
  pauseReason: PauseReason | null;
  lastAction: VdeskAction | null;
  desktop: string | null;
  desktops: string[];
  startedAt: number;
  /** 冻结期间 Agent 收到的错误码，客户端据此显示提示。 */
  code: string | null;
}

export const PAUSED_CODE = 'VDESK_PAUSED';

const REASON_TEXT: Record<PauseReason, string> = {
  user: '用户手动暂停',
  conflict: '检测到人工输入，已让出控制权',
  stop: '用户已终止任务',
};

export class VdeskControl {
  private pauseReason: PauseReason | null = null;
  private lastAction: VdeskAction | null = null;
  private startedAt = 0;
  private desktop: string | null = null;
  /**
   * 已关闭但 OS 侧尚未真正销毁的桌面。
   * sidecar 的 desktop.close 只杀进程、不断句柄，CloseDesktop 会因残留引用
   * 而未生效（desktop.list 仍能看到），直到 desktop.sweep 才消失。
   * 我们清楚自己关掉了谁，所以在这里过滤掉，UI 才能立刻收起。
   */
  private closed = new Set<string>();

  /** 记录一次 Agent 动作（供右下角状态胶囊显示）。 */
  note(kind: string, detail = ''): void {
    this.lastAction = { kind, detail, at: Date.now() };
  }

  /** 新建桌面或重新开始任务时复位闸门。 */
  attach(desktop: string): void {
    this.desktop = desktop;
    this.closed.delete(desktop);
    this.pauseReason = null;
    this.startedAt = Date.now();
    this.note('launch', desktop);
  }

  markClosed(desktop: string): void {
    this.closed.add(desktop);
  }

  /** 关闭桌面后复位；与 snapshot 里的兜底共用，保证面板一定收得起来。 */
  detach(): void {
    this.desktop = null;
    this.pauseReason = null;
    this.startedAt = 0;
    if (this.lastAction && this.lastAction.kind !== 'detach') this.note('detach', '桌面已关闭');
  }

  /**
   * 让出控制权。优先级：stop > conflict > user。
   * 已是 stop 时任何暂停请求都无效（终止不可撤销）。
   */
  pause(reason: PauseReason): void {
    if (this.pauseReason === 'stop') return;
    if (this.pauseReason === 'conflict' && reason === 'user') return;
    this.pauseReason = reason;
    this.note('pause', REASON_TEXT[reason]);
  }

  /** 只有用户显式动作才能走到这里，不存在自动恢复路径。 */
  resume(): void {
    if (this.pauseReason === 'stop') return;
    this.pauseReason = null;
    this.note('resume', '用户恢复执行');
  }

  stop(): void {
    this.pauseReason = 'stop';
    this.note('stop', REASON_TEXT.stop);
  }

  get paused(): boolean {
    return this.pauseReason !== null;
  }

  get reason(): PauseReason | null {
    return this.pauseReason;
  }

  /** 工具入口闸门：暂停期间拒绝一切键鼠注入。 */
  assertCanAct(): void {
    if (this.pauseReason === null) return;
    const err = new Error(
      `${PAUSED_CODE}: ${REASON_TEXT[this.pauseReason]}。` +
        `Agent 不得继续注入输入；请等待用户在虚拟桌面面板点击「继续」，` +
        `用 vdesk_screenshot 观察当前画面即可。`,
    ) as Error & { code?: string };
    err.code = PAUSED_CODE;
    throw err;
  }

  snapshot(desktops: string[]): VdeskState {
    // 过滤掉本方已关闭但 OS 还未回收的桌面。残留可能一直留在 list 里，
    // 所以只靠过滤不够——闸门的释放放在工具层（close / detach），这里只做显示。
    const live = desktops.filter((d) => !this.closed.has(d));
    // 有暂停原因但没有在跑的桌面 = 桌面已关、残余暂停态，闸门应当放开。
    // 不依赖 snapshot 被调用（测试里有直接断言 assertCanAct 的路径）。
    const orphaned = this.pauseReason !== null && live.length === 0;
    const reason = orphaned ? null : this.pauseReason;
    const phase: VdeskPhase =
      reason === 'stop'
        ? 'stopped'
        : reason === 'conflict'
          ? 'conflict'
          : reason === 'user'
            ? 'paused'
            : live.length > 0
              ? 'running'
              : 'idle';
    return {
      phase,
      paused: reason !== null,
      pauseReason: reason,
      lastAction: this.lastAction,
      desktop: this.desktop ?? (live[0] ?? null),
      desktops: live,
      startedAt: this.startedAt,
      code: reason === null ? null : PAUSED_CODE,
    };
  }
}
