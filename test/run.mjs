/**
 * VBox provider 冒烟：直连 provider 验证 list / 截图 / 光标，
 * 再走 FrameServer HTTP 验证状态面、帧面、CORS 与暂停闸门循环。
 * 不做真实点击/打字注入，避免污染客户机桌面。
 */
import { FrameServer, VdeskControl, VboxProvider, defaultConfig } from './build/entry.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8891;
const cfg = {
  ...defaultConfig,
  framePort: PORT,
  framePortMax: PORT,
  frameDir: path.join(os.tmpdir(), 'dshv-smoke'),
  webOrigin: 'http://127.0.0.1:3080',
};

const provider = new VboxProvider(cfg);
const control = new VdeskControl();
const server = await FrameServer.start({
  supervisor: provider,
  control,
  cfg,
  log: (m) => console.log('[srv]', m),
});

const base = `http://127.0.0.1:${server.port}`;
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const state = async () => (await fetch(`${base}/vdesk/state`)).json();
const postControl = async (action) =>
  (await fetch(`${base}/vdesk/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })).json();

// 1. provider 直连：桌面列表 / 截图 / 光标
const list = await provider.call('desktop.list', {});
check('desktop.list 含客户机', list.desktops?.includes(cfg.vmName), JSON.stringify(list));
// 启动清扫语义：现存桌面先记为已关闭，snapshot 才不会把未 attach 的 VM 算成 running。
control.markClosed(cfg.vmName);

const shot = await provider.call('capture.shot', {});
check('截图有宽高', shot.width > 0 && shot.height > 0, `${shot.width}x${shot.height}`);
check('截图文件落盘', fs.existsSync(shot.out), shot.out);

const cur = await provider.call('capture.cursor', {});
check('光标坐标可读', Number.isFinite(cur.x) && Number.isFinite(cur.y), JSON.stringify(cur));

// 2. HTTP 状态面
let s = await state();
check('初始 phase=idle', s.phase === 'idle', s.phase);
check('初始未暂停', s.paused === false);

const desks = await (await fetch(`${base}/vdesk/desktops`)).json();
check('HTTP desktops 含客户机', desks.desktops?.includes(cfg.vmName), JSON.stringify(desks));

control.attach(cfg.vmName);
s = await state();
check('attach 后 phase=running', s.phase === 'running', s.phase);

// 3. 帧面
const frame = await fetch(`${base}/vdesk/frame?desktop=${cfg.vmName}&t=${Date.now()}`);
check('帧 HTTP 200', frame.status === 200, String(frame.status));
check('帧头带宽度', Number(frame.headers.get('X-Frame-Width')) > 0, frame.headers.get('X-Frame-Width'));
check('帧头带高度', Number(frame.headers.get('X-Frame-Height')) > 0, frame.headers.get('X-Frame-Height'));

// 4. 冲突接管 → 闸门拦截
await postControl('conflict');
s = await state();
check('conflict 后 phase=conflict', s.phase === 'conflict', s.phase);
check('conflict 后 code=VDESK_PAUSED', s.code === 'VDESK_PAUSED');

let threw = null;
try {
  control.assertCanAct();
} catch (e) {
  threw = e;
}
check('暂停期间 assertCanAct 抛错', threw !== null && threw.code === 'VDESK_PAUSED');

// 5. 冲突态下 user 暂停不降级原因
await postControl('pause');
s = await state();
check('conflict 不被 user 覆盖', s.pauseReason === 'conflict', s.pauseReason);

// 6. 继续
await postControl('resume');
let okAfterResume = true;
try {
  control.assertCanAct();
} catch {
  okAfterResume = false;
}
check('resume 后闸门放行', okAfterResume);

// 7. 停止不可撤销
await postControl('stop');
s = await state();
check('stop 后 phase=stopped', s.phase === 'stopped', s.phase);
await postControl('resume');
s = await state();
check('stop 后 resume 无效', s.phase === 'stopped', s.phase);

// 8. CORS：回环任意端口放行，外部 origin 拒绝
const cors = await fetch(`${base}/vdesk/state`, {
  headers: { Origin: 'http://127.0.0.1:65291' },
});
check('随机回环端口 CORS 放行', cors.headers.get('access-control-allow-origin') === 'http://127.0.0.1:65291',
  String(cors.headers.get('access-control-allow-origin')));
const evil = await fetch(`${base}/vdesk/state`, { headers: { Origin: 'https://evil.example' } });
check('外部 origin 被拒', evil.ok === false, String(evil.status));

// 9. 收尾：detach 后面板收回
control.markClosed(cfg.vmName);
control.detach();
s = await state();
check('close 后 phase=idle', s.phase === 'idle', s.phase);
check('close 后 code 清空', s.code === null, String(s.code));

await server.close();
await provider.shutdown();
await new Promise((r) => setTimeout(r, 300));
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
