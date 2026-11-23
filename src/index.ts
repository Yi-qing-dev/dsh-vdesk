import type { Context } from '@deepseek-ai/cordis';
import { defaultConfig, type VDesktopConfig } from './config.js';
import { SidecarSupervisor } from './supervisor.js';
import { FrameServer } from './frameServer.js';
import { registerTools } from './tools/index.js';
import { VdeskControl } from './control.js';
import { attachModelGuard } from './modelGuard.js';
import { attachEvents } from './events.js';
import { sweepOnBoot } from './orphanSweep.js';
import { GUIDANCE } from './guidance.js';

export const name = 'dsh-vdesk';
export const inject = ['tools'];

export function apply(ctx: Context, raw: Partial<VDesktopConfig> = {}): void {
  const cfg: VDesktopConfig = { ...defaultConfig, ...raw };
  const supervisor = new SidecarSupervisor(cfg);
  // 人工输入优先闸门：工具面与 HTTP 控制面共用一个实例
  const control = new VdeskControl();

  registerTools({ ctx, supervisor, control });

  attachModelGuard(ctx);
  attachEvents(ctx);
  void sweepOnBoot(supervisor, control);

  // 宿主 HTTP 帧数据面（面板轮询 + 接管控制）。fail fast：端口全占只记 error。
  const frameReady = FrameServer
    .start({
      supervisor,
      control,
      cfg: cfg as Required<VDesktopConfig>,
      log: (m) => ctx.logger?.info?.(m),
    })
    .then((f) => {
      ctx.logger?.info?.(`[dsh-vdesk] frame data plane ready: 127.0.0.1:${f.port}`);
      return f;
    })
    .catch((e) => {
      ctx.logger?.error?.(`[dsh-vdesk] frame data plane unavailable: ${String(e)}`);
    });

  ctx.effect(() => async () => {
    const frame = await frameReady;
    await Promise.all([frame?.close(), supervisor.shutdown()]);
  });

  ctx.logger?.info?.(
    `[dsh-vdesk] provider=sidecar sidecar=${cfg.sidecarPath} guidance=${GUIDANCE.length}B`,
  );
}

// Cordis reads dependency metadata from the resolved default export.
export default Object.assign(apply, { inject });
