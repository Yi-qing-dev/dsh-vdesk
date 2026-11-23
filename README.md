# dsh-vdesk

> **状态：已归档（Archived）。** 这是一个 DSH（DeepSeek Harness / cordis）Windows 虚拟桌面插件的**个人实验与复盘存档**，当前在 Windows 11 上**不可作为可用的自动化插件直接运行**——核心输入注入能力被系统边界卡死，详见下文。本仓库保留完整的源码、验证记录和踩坑过程，供后来者参考、避坑，也欢迎社区在 Issue / PR 里提供可行的新方案。

---

## 1. 项目初衷

要解决的核心痛点：DSH 直接操作本机桌面时，AI 一动键鼠就和用户**抢鼠标、抢焦点**——AI 跑任务时用户没法正常用电脑，用户一动手又会打断任务。

最初对标桌面端 AI 产品（如豆包工作模式的虚拟电脑）的体验：在一个隔离桌面里跑 GUI 应用，画面流到悬浮窗预览，在悬浮窗内直接操作，全程不打扰用户的主桌面。

## 2. 两条技术路线

项目先后完整验证了两条路线，结论记录如下。

### 2.1 路线一：`CreateDesktopW` 轻量桌面（本仓库主体）

**架构**

```
DSH(主进程)
 ├─ SidecarSupervisor ── JSON-RPC/stdio ──▶ python -m dshv（纯 ctypes sidecar）
 ├─ FrameServer 127.0.0.1:8790+ ◀── HTTP 轮询 ── Web 面板（VDesktopPanel）
 └─ vdesk_* 工具（桌面生命周期 / 截图 / 鼠标 / 键盘 / 读文本等）
```

- **宿主 TS 侧**：`src/`（supervisor、frameServer、工具、状态机 `control.ts`、Web 面板 `client/`），esbuild 打包到 `lib/`。
- **Python sidecar**：`sidecar/dshv/`，纯 ctypes 无第三方依赖，负责虚拟桌面生命周期、GDI 抓帧、缩放编码与输入降级链。

**已跑通的部分**

- 隔离桌面的创建 / 销毁 / 列表 / 孤儿清理；
- 完整画面渲染：壁纸、图标、应用窗口、任务栏、系统托盘；
- 高 DPI 适配（进程级 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`）；
- 面板拖拽移动、边缘缩放（比例联动）、呼吸球入口、仅隐藏 / 退出运行；
- 六态状态机（idle / running / conflict / paused / stopped）。

**最终结论：非活动桌面拿不到任何系统级输入权限**

在 Win11 上，`CreateDesktopW` 开出的隔离桌面处于非活动状态时，用户态所有可行的注入路径均被系统拒绝，逐条验证结果：

| 注入路径 | 结果 | 说明 |
|---|---|---|
| `SendInput` | ❌ `winerror=5` 权限拒绝 | 输入队列绑定在活动桌面上，`SetThreadDesktop` 到目标桌面也无效 |
| `WH_JOURNALPLAYBACK`（日记钩子） | ❌ `err=5` | Win11 已对该钩子家族系统级禁用，同线程管理员权限下低层钩子能装、journal 全被拒 |
| `InjectTouchInput` | ❌ attach 目标桌面失败 | 同样只认活动桌面 |
| `PostMessage` / `SendMessage` | ❌ 消息发出、目标不响应点击 | 无鼠标捕获，`WM_LBUTTONDOWN` 不触发 `WM_COMMAND`；`WM_CHAR` 仅个别程序收得到 |
| MSAA / UIA | ❌ 只能触达标准 Win32 控件的极小子集 | `accDoDefaultAction` 存在假阳性；WinUI3 / UWP 控件不是独立 hwnd，打不到 |
| `SwitchDesktop` 切整屏 | ⚠️ 技术可用但已否决 | 会把用户整屏切进隔离桌面，曾出现卡住出不来的事故；**代码已全部移除** |

> 这是 Windows 输入栈的设计边界，**不是代码质量问题**。轻量桌面路线在当前普通第三方插件权限下，做不到后台不切屏、悬浮窗内真实操作本机程序。

### 2.2 路线二：VirtualBox 虚拟机（可行性已验证，代码部分收录）

**架构**：本地 VirtualBox 虚拟机作为完整独立的真桌面，输入经 VBox API / guestcontrol 注入，不经过宿主 Windows 的桌面输入队列，因此不存在路线一的注入限制。

**已验证通过的核心链路**（`src/vbox/provider.ts`，`VboxProvider` 与旧 `SidecarSupervisor` 接口同形：`call(method, params, timeoutMs)` + `shutdown()`）：

| 能力 | 实现 |
|---|---|
| 截图 | `VBoxManage controlvm <vm> screenshotpng <png>` |
| 客户机命令 | `guestcontrol <vm> run ...`（落在交互式会话 1） |
| 鼠标 | 会话 1 内 PowerShell 调 `SetCursorPos` + `mouse_event` |
| 键盘 | 可打印文本用 `keyboardputstring`；按键 / 热键走 scancode |
| 文件 | `guestcontrol copyto/copyfrom` |

实测：鼠标点击、键盘输入、文件双向、截图、自适应分辨率均可用；悬浮窗内操作手感与真实桌面一致，全程不切屏、不抢宿主焦点。

**未完成 / 已知遗留**：

- 未接入插件主流程（`src/index.ts` 仍默认走 `SidecarSupervisor`），未整合定制 UI；
- 中文输入法（IME）在拼音模式下会拆拼音串字，需保证英文模式或改剪贴板粘贴通道；
- 截图 E_FAIL 偶发（VBoxSVGA / GA 图形通道不稳，客户机重启可恢复）；
- 截图未做压缩、VRDE / Extension Pack 兜底通道未装；
- 代价：启动慢（十几秒）、占 2–4GB 内存、客户机是独立系统，不能直接复用本机已装的软件和文件。

**归档说明**：开发时使用的虚拟机磁盘、Win11 ISO 已在本地清理；仓库内保留了 `src/vbox/provider.ts` 等宿主侧源码，客户机配置与凭据未随仓库发布。重启该方向时可在这套 provider / 状态机 / 帧服务骨架上继续。

## 3. 踩坑记录（部分）

完整调试记录见 `docs/` 与 `PROJECT_RETROSPECTIVE.md`。这里列出几个反复消耗时间、且容易被后来者重新踩到的坑：

1. **插件目录被反复清空**：在 `node_modules/<plugin>/` 内改代码 / 跑安装会触发 DSH 目录监听清理，整个目录被删除。开发必须在独立工作区完成，只把最终产物一次性拷入。
2. **两个插件同名注册，改动全部无效**：`node_modules` 里同时残留上游 `dsh-vdesktop` 和改版 `dsh-vdesk`，`cordis.patch.yml` 同名导致后加载的原版覆盖改版，十几轮改动都没进运行环境。识别信号：工具列表里出现只属于旧版本的工具。
3. **透明覆盖层吃掉所有点击**：`UAC_InputIndicatorOverlayWnd` 是透明全屏窗口，既是顶层窗口又是对话框子窗口，所有坐标点击都命中它。需要在顶层枚举和子窗口枚举两处都过滤系统浮层类名。
4. **协议不匹配 + 错误被静默吞掉**：前端发归一化坐标 `nx/ny`，服务端要 `frameWidth/frameHeight`，前端 `.catch(() => {})` 吞掉错误，表现为「点了没反应也没提示」。失败必须打到 console。
5. **自启动与残留清扫竞态**：fire-and-forget 的 `sweepOnBoot` 内部 `detach()` 晚于 `attach()`，把刚绑定的桌面清成 null，面板永不出现。需 `await` 严格串行。
6. **DPI 混用导致坐标错位 / 半屏**：逻辑像素与物理像素混用（1707 vs 2560），需进程级 DPI 感知，画布尺寸取 `DefView` 真实 rect。
7. **僵尸桌面导致黑屏**：进程被 kill 后桌面对象仍是空壳，`EnumDesktops` 照样列出；桌面列表应只返回真正有窗口的桌面。

## 4. 仓库结构

```
├── src/                  # TS 插件主体
│   ├── client/           # VDesktopPanel Web UI
│   ├── tools/            # vdesk_* 工具定义
│   ├── transport/        # JSON-RPC over stdio
│   ├── vbox/             # VirtualBox provider（路线二）
│   ├── control.ts        # 人工输入优先状态机
│   ├── frameServer.ts    # 宿主 HTTP 帧数据面
│   └── ...
├── lib/                  # esbuild 构建产物（可由 npm run build 重新生成）
├── sidecar/dshv/         # Python 纯 ctypes sidecar（抓帧 / 桌面生命周期 / 输入降级链）
├── test/                 # 状态机 / 冒烟测试
├── scripts/              # 构建脚本
├── docs/                 # 开发期交接手册、实测记录、测试脚本（含已脱敏的本机路径与凭据）
├── PROJECT_RETROSPECTIVE.md  # 技术复盘 + 个人项目心得
├── cordis.patch.yml      # cordis 服务声明
├── package.json / tsconfig.json / esbuild.config.mjs
└── LICENSE
```

## 5. 环境与构建（参考）

| 组件 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（本项目在 Windows 11 验证） |
| 运行时 | Node.js LTS |
| Python | 3.11+（sidecar 纯 ctypes，无 pip 依赖） |
| 宿主 | DSH（含 cordis 插件机制） |

```powershell
npm run build            # TS 侧 esbuild → lib/
cd sidecar
python -m py_compile dshv\rpc_stdio.py   # sidecar 语法自检
```

> 注意：受第 2.1 节的系统边界限制，按本仓库代码在 Win11 上运行，只能完成桌面创建与画面预览，输入注入不会真正生效。

## 6. 已知限制

- 轻量桌面路线：**任何输入注入（点击 / 键盘 / 快捷键）在非活动桌面均不生效**；
- WinUI3 / UWP 程序控件不是独立窗口，MSAA 无法触达；
- 高 DPI / 非 100% 缩放下的坐标映射未做系统级回归；
- 路线二（VM）的 provider 未接入主流程，中文输入法、截图稳定性等遗留问题见 2.2。

## 7. 欢迎参与

如果有办法在**普通第三方插件、不降低系统安全等级、不开内核驱动**的前提下，实现后台隔离桌面的真实输入注入，或者对 VirtualBox 路线的完善有建议，欢迎提 Issue / PR。尤其是：

- 非活动桌面的合规输入注入路径；
- Win11 各版本下 UIPI / 桌面会话权限的新变化；
- VM 路线的输入法、截图稳定性与帧带宽优化。

## License

[MIT](LICENSE)。fork 自上游 `dsh-vdesktop`（MIT，DescartHsu），保留其版权声明。
