# dsh-vdesk 维护手册（给 Agent 看）

> 目标读者：接手这个 fork 的 Agent。读完应能独立改完下面两个问题并自证。
> 所有路径都是绝对路径，直接可用。

## 0. 上下文速查

| 项 | 值 |
|---|---|
| fork 源码 | 本仓库根目录（归档副本） |
| 包名 | `@lws31/dsh-vdesk`（v0.1.0，MIT，fork 自 dsh-vdesktop 0.2.3） |
| 注册方式 | `link:` 依赖，已写入 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` |
| 服务端入口 | `src/index.ts` → `lib/index.js`（esbuild 打包） |
| 客户端入口 | `src/client/index.ts` → `lib/client.js`（IIFE，`window.__ModuleLoader__`） |
| 构建 | `cd <fork>; npm run build`（先 `tsc --noEmit` 类型检查，再 esbuild 出两个产物） |
| 生效条件 | **必须重启 DSH**。改 `lib/` 不会热重载 |
| HTTP 数据面 | `http://127.0.0.1:8790/vdesk/{state,control,frame,input,desktops}`（端口冲突时 8790→8799 顺延） |
| 冒烟测试 | `cd <fork>; npx esbuild test/entry.ts --bundle --platform=node --format=esm --outfile=test/build/entry.mjs; node test/run.mjs` |

冒烟测试当前覆盖 13 项：状态机迁移、暂停闸门、stop 不可撤销、CORS 放行/拒绝。**改动 control.ts 或 frameServer.ts 后必须重跑且全绿。**

---

## 1. 问题一：底部提示重复两遍

### 现象

面板底部同时出现：

- 左栏灰字：`检测到人工输入，已让出控制权`
- 右下胶囊：`暂停 检测到人工输入，已让出控制权`

同一句话，挤在一行里，且把画面压得更窄。

### 根因（两处独立来源）

1. **左栏 `hint`**：`src/client/index.ts:360-367` 在 `phase === 'conflict' | 'paused' | 'stopped'` 时渲染 locale 文案（`conflictHint` / `pausedHint` / `stoppedHint`）。
2. **胶囊 `pill`**：`src/client/index.ts:358` 取 `state.lastAction`，而服务端 `src/control.ts` 的 `pause()` 会把 `REASON_TEXT[reason]` 写进 `lastAction.detail`。于是胶囊经 `actionLabel()`（`src/client/index.ts:158` 附近）拼出「暂停 + 同一句原因」。

### 改法（推荐，改动最小）

**a) 左栏只保留 `stopped` 的说明**——其余状态由画面遮罩和胶囊已经表达清楚。

`src/client/index.ts:360`：

```ts
const hint = phase === 'stopped' ? t('stoppedHint') : '';
```

**b) 胶囊对生命周期动作只显示动词，不重复 detail。**

在 `actionLabel` 旁边加一个判定，或直接改 `actionLabel`：

```ts
const LIFECYCLE = new Set(['pause', 'resume', 'stop']);

function actionLabel(a: LastAction | null): string {
  if (!a) return '';
  const map: Record<string, string> = { /* 保持原样 */ };
  const label = map[a.kind] ?? a.kind;
  // 生命周期事件的原因已由画面遮罩/左栏表达，胶囊不重复
  if (LIFECYCLE.has(a.kind)) return label;
  return a.detail ? `${label} ${a.detail}` : label;
}
```

改完预期：冲突态下左栏为空，胶囊只显示「暂停」。

### 不要这样做

- 不要只删 `pill`：注入类动作（`click (120,340)`、`输入 18 字符`）是胶囊的核心价值，必须保留。
- 不要改服务端把 `REASON_TEXT` 从 `lastAction` 里去掉：`/vdesk/state` 的消费者可能依赖它，而且改服务端要连带改测试断言。

### 验收

1. `npm run build` 通过（tsc 无错）。
2. 重启 DSH，`vdesk_desktop_create` 建一个桌面。
3. 鼠标移入面板触发冲突。
4. 检查：底部只有一行胶囊「暂停」，**没有**重复的长句；画面遮罩仍显示「已暂停：人工接管中」。
5. 点「继续」→ 胶囊变「继续」，左栏仍为空。
6. 点「停止」→ 左栏出现「任务已停止，桌面仍保留供回查」（唯一保留 hint 的状态）。

---

## 2. 问题二：残留桌面让面板关不掉

### 现象

`vdesk_desktop_close` 之后 `/vdesk/state` 仍返回 `phase: "running"`，面板不收起。极端情况下重启 DSH 后，历史残留仍会让面板一启动就误弹。

### 根因链（已确认，不要重新调查）

1. sidecar 的 `desktop.close`（`sidecar/dshv/rpc_stdio.py` 的 `handle_desktop_close`）调用 `user32.CloseDesktop(h)` 并返回成功。
2. 但 **sidecar 的 input worker 线程调用过 `SetThreadDesktop(hdesk)` 并一直 attach 在该桌面上**（`input.type` / `input.click` 时产生）。线程不释放 → 桌面引用计数不归零 → `CloseDesktop` 实际不销毁。
3. 结果：`desktop.list` 仍能枚举到该桌面，`sweep` 在**同一进程内**也清不掉。
4. **新进程里 sweep 是有效的**（已验证：用户重启后 `desktops` 为空）。

### 已完成的一半

`src/control.ts` 有 `private closed = new Set<string>()` + `markClosed()`：

- `snapshot()` 会从 `desktops` 里过滤掉 `closed` 集合中的名字（`src/control.ts:126` 起）
- 若 `desktop.list` 里已经没有该名字了，自动从集合里移除（自愈）
- `vdesk_desktop_close` 的工具包装（`src/tools/index.ts` 里 `t.name === 'vdesk_desktop_close'` 分支）已调用 `markClosed` + 只剩单桌面时补一次 `sweep`

**所以当前进程内 UI 是对的**——`close` 后 `state` 会立刻回 `idle`（已实测）。

### 缺的一半：跨重启

`closed` 是内存集合，重启后为空。历史残留会重新出现在 `desktop.list` 里，`phase` 被算成 `running`，面板误弹。

### 改法

**a) `src/orphanSweep.ts` 换成这个**（接收 control，先记账再清）：

```ts
import type { SidecarSupervisor } from './supervisor.js';
import type { VdeskControl } from './control.js';

export async function sweepOnBoot(
  supervisor: SidecarSupervisor,
  control: VdeskControl,
): Promise<void> {
  try {
    const before = await supervisor.call<{ desktops?: string[] }>('desktop.list', {}, 5_000);
    // 先把现存桌面全部当成已关闭：即使 sweep 因句柄未释放而失败，
    // UI 也不会把它们算成 running。
    for (const name of before?.desktops ?? []) control.markClosed(name);
    await supervisor.call('desktop.sweep', {});
  } catch {
    /* 启动期清扫失败不阻塞插件挂载 */
  }
}
```

**b) `src/index.ts` 调用处改成**：

```ts
void sweepOnBoot(supervisor, control);
```

（`control` 已在 `apply()` 里创建，直接传。）

### 为什么不改 Python

`handle_desktop_close` 清理 input worker 线程需要在 Python 侧做线程生命周期管理（让 worker 退出或 `SetThreadDesktop(Default)`），有死锁风险，且上游将来升级会冲突。**用启动期兜底更安全**，代价只是进程存活期内会攒空桌面（无进程，重启即清）。

### 验收

1. `npm run build` + 冒烟测试全绿。
2. 重启 DSH。
3. 立刻查 `GET http://127.0.0.1:8790/vdesk/state` → 必须是 `{"phase":"idle","desktops":[]}`（历史残留不应出现）。
4. `vdesk_desktop_create` → `state.phase === "running"`。
5. `vdesk_desktop_close` → 1 秒内 `state.phase === "idle"` 且 `desktops` 为空。
6. **再重启一次**，重复第 3 步，确认残留不再冒出来（这一条是本次修复的关键证据，不要省）。

---

## 3. 安全边界（改之前必须看）

- **不要**改 `sidecar/` 下的 Python，除非你准备承担线程/句柄语义的风险。它是上游代码，已实测可用。
- **不要**用 `desktop.sweep` 清理单个桌面：它会无差别清掉所有 `dshv-*`，多任务并存时会误伤。单桌面清理走 `desktop.close`。
- **不要**在 `lib/` 里手改代码。`lib/` 是构建产物，下次 `npm run build` 会覆盖。改 `src/`。
- **不要**为了调试去改 profile 的 `cordis.patch.yml` 来换 sidecar 路径；默认值已指向包内 `sidecar/`。
- 改完必须**重启 DSH** 才生效；不要用 `dsh plugin` 的热更新去验证 UI。

## 4. 常用命令

```powershell
# 构建
cd <本仓库根目录>; npm run build

# 冒烟测试（13 项）
cd <本仓库根目录>
npx esbuild test/entry.ts --bundle --platform=node --format=esm --outfile=test/build/entry.mjs
node test/run.mjs

# 查状态
(Invoke-WebRequest http://127.0.0.1:8790/vdesk/state -UseBasicParsing).Content

# 手工暂停/恢复（模拟人工接管）
Invoke-WebRequest http://127.0.0.1:8790/vdesk/control -Method POST -Body '{"action":"conflict"}' -ContentType 'application/json' -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8790/vdesk/control -Method POST -Body '{"action":"resume"}' -ContentType 'application/json' -UseBasicParsing

# 直查 sidecar（绕过 state 的 closed 过滤，看真实桌面）
cd <本仓库根目录>\sidecar
python -c "import sys,subprocess,json; p=subprocess.Popen([sys.executable,'-m','dshv','--rpc','stdio'],cwd='.',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8'); p.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':'desktop.list','params':{}})+chr(10)); p.stdin.flush(); print(p.stdout.readline().strip()); p.terminate()"
```

## 5. 回滚

```powershell
dsh plugin --profile desktop remove @lws31/dsh-vdesk
dsh plugin --profile desktop add dsh-vdesktop
```

回滚后需重启 DSH。
