import type { Provider } from './vbox/provider.js';
import type { VdeskControl } from './control.js';

export async function sweepOnBoot(
  supervisor: Provider,
  control: VdeskControl,
): Promise<void> {
  try {
    const before = await supervisor.call<{ desktops?: string[] }>('desktop.list', {}, 5_000);
    // 先把现存桌面全部记成已关闭：即使 sweep 因句柄未释放而失败，
    // UI 也不会把它们算成 running（上一轮进程遗留的空桌面就是这种情况）。
    for (const name of before?.desktops ?? []) control.markClosed(name);
    await supervisor.call('desktop.sweep', {});
  } catch {
    /* 启动期清扫失败不阻塞插件挂载 */
  }
}
