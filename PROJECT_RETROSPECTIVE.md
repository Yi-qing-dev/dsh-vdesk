# PROJECT RETROSPECTIVE — dsh-vdesk

> 项目：DSH Windows 虚拟桌面插件
> 周期：2026-11-21 ～ 2026-11-23
> 状态：**归档暂停**

---

# 第一部分：技术复盘

## 1. 项目起点

**原始目标**：解决 DSH 操作本机桌面时的「人机抢鼠标」矛盾——AI 一动键鼠，用户就没法用电脑。

**对标对象**：豆包「工作模式」的虚拟电脑（隔离桌面 + 悬浮窗预览 + 悬浮窗内直接操作）。

**初始判断**：做一个 DSH 插件，用 `CreateDesktopW` 开隔离桌面，画面流到悬浮窗，用户在悬浮窗里点。

---

## 2. 两条技术路线

### 2.1 路线一：CreateDesktopW 轻量桌面（本仓库）

**架构**

```
DSH(主进程)
 ├─ SidecarSupervisor ── JSON-RPC/stdio ──▶ python -m dshv（纯 ctypes sidecar）
 ├─ FrameServer 127.0.0.1:8790+ ◀── HTTP 轮询 ── Web 面板
 └─ 6 个 vdesk_* 工具
```

**画面抓取的四层合成**

这是整个项目里调试成本最高的部分。最初的实现是单次 `PrintWindow(桌面窗口)`，结果：

- 右侧一整列桌面图标不见了
- 任务栏是一条黑
- 换 150% 缩放的环境后，只有左半屏

三层根因逐一定位：

| 现象 | 根因 | 修复 |
|---|---|---|
| 右侧图标列丢失 | `PrintWindow` 画到 `CreateDIBSection`（DIB）上只渲染部分 | 改画到 `CreateCompatibleBitmap`（DDB），再 `BitBlt` 拷进画布 |
| 任务栏整条黑 | 同上；且 `PrintWindow(Shell_TrayWnd)` 在非活动桌面渲染不完整 | DDB + 单独补抓 `TrayNotifyWnd` 合成托盘 |
| 只有左半屏 | DPI 混用：`GetSystemMetrics` 返回逻辑像素 1707，explorer 的 rect 是物理像素 2560 | 进程级 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，画布尺寸取 `DefView` 真实 rect |
| 图标层本身空 | `SysListView32` 才是真正绘制图标那个子窗口 | 抓 `SysListView32` 而不是 `SHELLDLL_DefView` |

**最终层序**：`SysListView32`（桌面+图标）→ 最顶层应用窗口 → `Shell_TrayWnd` → `TrayNotifyWnd`。

### 2.2 路线二：VirtualBox 虚拟机（已验证，代码未并入本仓库）

**实现方式**（源码在历史归档 `dsh-vdesk-plugin/src/vbox/provider.ts`，16688 字节）：

| 能力 | 实现 |
|---|---|
| 截图 | `VBoxManage controlvm <vm> screenshotpng <png>` |
| 客户机命令 | `VBoxManage guestcontrol <vm> run ...`（落在交互式会话 1） |
| 鼠标 | 会话 1 内 PowerShell 调 `SetCursorPos` + `mouse_event` |
| 键盘 | 可打印文本用 `controlvm keyboardputstring`；按键/热键用 scancode |
| 文件 | `guestcontrol copyto/copyfrom` |

`VboxProvider` 与旧 `SidecarSupervisor` **接口同形**（`call(method, params, timeoutMs)` + `shutdown()`），设计上让 `frameServer` / `tools` / `orphanSweep` / `control` 一行都不用改。

**已完成部分**：Win11 虚拟机部署、provider 对接、HTTP 帧面、系统级输入注入（鼠标点击、键盘输入、全程序可用）、状态机、坐标归一化、DPI 适配——功能层全部跑通。

**未完成部分**：未接入插件主流程（`index.ts` 仍用 `SidecarSupervisor`，`lib/index.js` 里 `VboxProvider` 命中数为 0），未整合定制 UI。

---

## 3. 注入通道：逐条验证记录

这是项目最核心、也最消耗时间的部分。

### 3.1 SendInput

```
SendInput returned 0 of 3 (winerror=5)
```

非活动桌面上系统直接拒绝。即使 `SetThreadDesktop` 到目标桌面也一样——**输入队列绑定在活动桌面上**。

### 3.2 WH_JOURNALPLAYBACK

用户提出的方案：用 journal 钩子把输入「回放」到后台桌面。

实测（同线程、同进程、管理员权限）：

```
is_admin = True
attach:   True
JOURNALPLAYBACK:  hook=0    err=5    ← 被拒
JOURNALRECORD:    hook=0    err=5    ← 被拒
KEYBOARD_LL:      hook=685642129     ← 成功
MOUSE_LL:         hook=685707665     ← 成功
```

**同一线程里，低层钩子能装，journal 家族全被拒**。这不是权限问题（已是管理员），是 Win11 对该钩子家族的系统级禁用。

### 3.3 InjectTouchInput

```
InitializeTouchInjection -> 1        （成功）
InjectTouchInput（不 attach 桌面）-> 1   （注入了活动桌面）
InjectTouchInput（attach 目标桌面）-> 0  （失败）
```

结论：同样只认活动桌面。

### 3.4 PostMessage / SendMessage

消息能发出去，目标程序不响应点击：
- `PostMessage(WM_LBUTTONDOWN)` → 不触发 `WM_COMMAND`（无鼠标捕获）
- `SendMessage(WM_CHAR)` → 文本能进一些程序，但非活动桌面的目标程序普遍不响应

### 3.5 MSAA / UIA

- `accDoDefaultAction` 对 `Button` 返回 `S_OK` 但**不执行**（假阳性）→ 改用 `BM_CLICK`
- `accHitTest` 能定位控件，但 WinUI3/UWP 控件不是独立 hwnd，打不到
- `SysListView32` 的 item 用 `accDoDefaultAction` 返回成功但不生效

### 3.6 SwitchDesktop

技术上可用（`SwitchDesktop` 普通权限即可），实现过完整闭环（切过去 → 操作 → 热键切回）。但：

- 用户明确否决：「这不是我要的东西，还把我卡住了」
- 有过卡在虚拟桌面里出不来的事故（最终重启电脑才恢复）

**已全部移除。**

### 3.7 最终结论

> `CreateDesktopW` 隔离桌面在非活动状态下，Win11 用户态拿不到任何系统级输入权限。
> SendInput / journal / InjectTouchInput / PostMessage 全部走不通。
> MSAA 只能触达标准 Win32 控件的一个极小子集。
> **这是输入栈的设计边界，不是代码质量问题。**

---

## 4. 其他技术问题与修复

### 4.1 插件目录被反复清空（发生 3 次以上）

在 `~/.dsh/profiles/<profile>/node_modules/<plugin>/` 内改代码、跑 `npm install`，触发 DSH 目录监听清理，**整个插件目录被删除**，连带 `package.json` 里的登记条目也被剥离。

**修复**：所有开发、构建、自测在独立工作区完成；只有最终产物一次性复制进插件目录（复制前关闭 DSH）。

### 4.2 两个插件同名注册，十几轮改动全部无效

`node_modules` 里同时存在 `dsh-vdesktop`（原版）和 `dsh-vdesk`（改版），两者的 `cordis.patch.yml` 都是 `id: vdesktop`，原版后加载覆盖了改版。

**后果**：改了十几轮代码、发了一堆版本，运行的一直是老版本，所有改动都没进到实际运行环境。

**识别信号**（当时一直在眼前）：工具列表里出现只属于老版本的工具（`vdesk_zoom`、`vdesk_save_file`），而新加的工具（`vdesk_show`）不出现。

**修复**：删除残留包，确认 `patch` 的 `name` 指向正确包名。

### 4.3 透明覆盖层吃掉所有点击

`UAC_InputIndicatorOverlayWnd` 是透明全屏窗口，既是顶层窗口、又是对话框的子窗口。所有坐标点击都命中它，表现是「点哪儿都没反应」。

**修复**：`_hit_test_window`（顶层枚举）和 `_controls_at`（子窗口枚举）都过滤系统浮层类名。

### 4.4 协议不匹配 + 错误被静默吞掉

前端发归一化坐标 `nx/ny`，服务端要 `frameWidth/frameHeight`，服务端直接返回 `frameWidth required`，而前端 `.catch(() => {})` 把错误吞了。

**表现**：「点了完全没反应，也没有任何错误提示」——排查了很久。

**修复**：协议对齐；**关键是不再静默吞错**，失败必须打到 console。

### 4.5 自启动与残留清扫竞态

`void sweepOnBoot(...)` 和自启动建桌面都是 fire-and-forget。`sweep` 内部的 `detach()` 有时晚于 `attach()` 执行，把刚绑定的桌面清成 `null` → `phase` 变 `finished` → 面板永远不出现。

**修复**：`await sweepOnBoot(...)` 严格串行后再自启动。

### 4.6 面板比例对但有黑边

`TOPBAR_H` 写 37px，实测顶栏渲染约 30px，画面区比源比例高 7px → 底部黑边。

**修复**：`TOPBAR_H` 改成实测值。

### 4.7 僵尸桌面导致黑屏

`CreateDesktopW` 建出来的桌面对象要等**所有句柄关闭**才销毁。进程被 kill 后桌面对象仍是空壳，`EnumDesktops` 照样列出来。面板盯上它就是黑屏。

**修复**：`desktop.list` 只返回**真的有窗口**的桌面。

---

## 5. 最终交付能力

| 能力 | 状态 |
|---|---|
| 桌面创建 / 销毁 / 列表 / 孤儿清理 | ✅ |
| 完整画面渲染（壁纸 / 图标 / 应用窗口 / 任务栏 / 托盘） | ✅ |
| 2560×1600 @150% 缩放正确 | ✅ |
| 面板拖拽移动 + 边缘缩放（比例联动） | ✅ |
| 呼吸球入口（拖动 / 点击展开） | ✅ |
| 仅隐藏 / 退出运行 | ✅ |
| 六状态机 | ✅ |
| **任何输入注入**（点击 / 键盘 / 快捷键） | ❌ 系统限制 |

---

# 第二部分：项目心得

## 第一次用「豆包工作模式 + DSH」做多 Agent 协作开发

这是第一次尝试用豆包工作模式配合 DSH 做多 Agent 协作开发。体验了主 Agent 调度执行、探针验证、分步迭代的完整开发流程，学到了很多新的开发模式——比如先用最小探针验证一个 API 能不能用，再决定要不要往上搭功能，而不是一上来就写完整实现。

## 补齐了 Windows 桌面开发的认知边界

过程中接触并理解了大量底层概念：沙盒、虚拟机、桌面会话（Desktop / Window Station）、输入注入、UIPI 权限隔离、DPI 适配、DDB 与 DIB 的区别、WM_NCHITTEST、MSAA/UIA 无障碍接口……

这些以前都是模糊的概念，这次是被实际问题一个个逼着搞清楚的。

## 反思：不能盲目对标大厂产品直接复刻

**最大的教训**：应该先搞清楚普通开发者的技术天花板和系统规则，再定合理目标。

前期因为对豆包的实现原理、系统权限边界认知不足，默认「它能做我也能做」，直接照着它的产品形态复刻，走了很多弯路，消耗了大量时间和成本。

中间还因为对产品形态的误判，在虚拟机路线上绕了很久圈子——先做了虚拟机，觉得太重放弃，又回到轻量桌面，最后发现轻量桌面也到不了终点。

## 认知：大厂客户端有普通第三方插件无法比拟的先天条件

大厂客户端具备：**数字签名、高系统权限、官方底层接口支持**。

这些是普通第三方 DSH 插件完全不具备的。轻量桌面方案在 Win11 下有明确的技术天花板，**不是代码写得好不好就能突破的**。

豆包能做到「悬浮窗内操作不切屏」，大概率是因为它底层不是 `CreateDesktopW`（独立 VM 或系统级合作），不是靠调 API 调出来的。

## 心态：多次想放弃

开发过程中多次出现方向偏差，甚至出现两次黑屏卡死事故（卡在虚拟桌面里出不来，最后重启电脑才恢复）。

有过烦躁、觉得这是个无底洞的时刻，也有过自暴自弃的情绪。

但最终还是理智选择及时止损——在确认「输入注入是系统级天花板」之后，没有再继续无意义地消耗下去，而是把能保住的部分（画面渲染、UI 交互）做成一个稳定的只读预览版收尾。

## 收获

哪怕最终没有做出 100% 完美的版本，也完整走完了从**需求 → 设计 → 技术验证 → 反复调试 → 止损 → 复盘**的全流程。

踩过的坑、验证过的可行与不可行路径，都是宝贵的经验。尤其是那批「不可行路径」的验证记录——它们有明确的技术证据（错误码、对照实验），以后任何人想重启这个方向，可以直接跳过这些死路。

---

## 给后来者的建议

1. **先验证最核心的那个不确定性**（这里是「非活动桌面能不能注入输入」），验证不过就不要往下做 UI 和功能
2. **不要在插件目录里开发**，DSH 的目录监听会把你的工作清空
3. **失败要留证据**（错误码、对照实验），不要只留结论
4. 如果目标真的是「AI 在隔离环境里操作电脑」，直接用**虚拟机**，不要在 `CreateDesktopW` 上浪费时间
