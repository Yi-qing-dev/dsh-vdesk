# OOBE 阻塞交接（2026-11-22 晚更新）

## 当前状态
- VM `dsh-vdesk` running，Win11 专业版 26300.9974，OOBE 卡在 Microsoft 账户登录环节。
- 设备名 `vdesk`；本地用户名/文件夹名计划 `vdesk`；密码尚未设定（待拍板）。
- NIC1 已在宿主侧断开：`VBoxManage controlvm dsh-vdesk setlinkstate1 off`（保持断开，直到本地账户建好）。
- Shift+F10 已呼出管理员 cmd（`C:\Windows\System32>`），但**自动化注入键盘进不了 cmd**：
  - `keyboardputscancode` 回车/字母不落字；
  - cu 桌面控制点击 cmd 区域后 `cu.type` 也不落字（宿主 SendInput 路径同样被 OOBE 前台拦截）；
  - 客户机鼠标箭头能进 cmd，但 cmd 窗口在 OOBE 下抢不到输入焦点。
- 虚假账户 `no@thankyou.com` + 乱密码路线在 26300 上已堵死：走到身份验证 → 个人数据导出许可 → 退回邮箱页，无本地账户入口。

## 2026-11-22 晚：OOBE 已完成，进入桌面
- 注册表 `BypassNRO=1` 写入并验证；用户授权后由助手在 cmd 发 `shutdown /r /t 0` 重启。
- 重启后 OOBE 重走国家/键盘/断网页，「我没有 Internet 连接」正常出现，进入本地账户流程。
- **最终账户信息（隔离 VM 专用，归档时已删除该 VM，密码不再保留）**：
  - 电脑名：`vdesk`
  - 本地账户名：`vuser`（不能与电脑同名，故不是 vdesk）
  - 密码：见当时本地会话记录，未随仓库发布
  - 安全问题答案：见当时本地会话记录
- 桌面已进入：回收站、Edge，任务栏正常；图形控制器 VBoxSVGA，帧缓冲出图正常。
- 网卡仍为断开状态（cableconnected1=off），装 GA 时先从宿主挂 GA ISO，不依赖联网；GA 装好后再按需连网。
- vuser 经 UAC 提权成功，判定为管理员组。
- GA 7.2.22 r175245 已装完；**无需重启即达到 RunLevel=3**，五项 facility 全部 50 在线：Base Driver / System Service / Desktop Integration / Seamless Mode / Graphics Mode。
- 安装收尾后曾自动锁屏一次；注入回车 → 输客户机密码 → 欢迎界面回桌面。

## 2026-11-22 晚：注入通道全部验证通过（实测记录）
- **guestcontrol 命令执行**：`run whoami` → `vdesk\vuser`；派生进程落在**会话 1（交互式桌面）**，不是 session 0（SESSIONNAME 环境变量为空具误导性，以进程 SessionId=1 为准）；vuser 在 administrators 组。
- **鼠标通道（guestcontrol 路径，已实测）**：会话 1 内 PowerShell 调 user32 `SetCursorPos` + `mouse_event`（LEFTDOWN 0x0002 / LEFTUP 0x0004）；坐标回读一致；左键点击任务栏搜索框，开始搜索面板真实弹出，点击落点有效。
  - 测试脚本：宿主 `docs/mouse_test.ps1`，客户机 `C:\Users\vuser\mouse_test.ps1`（参数 -X -Y -Action move|click）。
  - 注意：7.2.22 controlvm 仍**无鼠标事件子命令**；GA guestcontrol 也不暴露鼠标 API，鼠标注入=guestcontrol 起会话 1 进程调 Windows API。VRDE 兜底通道尚未实现（Extension Pack 未装）。
- **自适应分辨率**：`controlvm setvideomodehint 1280 800 32` → 客户机 1278×798，宿主 VideoMode 同步，画面重绘正常。
- **文件双向**：`copyto` 宿主→客户机、`copyfrom` 客户机→宿主均通（目标须给文件全路径；--target-directory 在 7.2.22 报"目录已存在"错误）。
- **键盘注入**：scancode / putstring 正常（GA 后 Esc 关面板、解锁登录均落字）。
- **截图**：`controlvm screenshotpng` 出图正常，像素与客户机 bounds 1:1。
- **网络**：NIC1 NAT 已 `setlinkstate1 on`，客户机 IPv4 10.0.2.15 / 网关 10.0.2.2，DHCP 正常。
- 已知小问题：会话列表里有一条残留 `Session #0 ... Status=[error] Name=Rebooting guest`，不影响新会话创建。

## 死路清单（勿重复试）
- 7.2.22 controlvm 无鼠标注入子命令；GA 未装，guestcontrol 不可用。
- 仅断开 NIC 不会在当前登录页放出"我没有 Internet 连接"。
- `oobe\bypassnro` 命令在 26300 云端策略下已被弱化，需直接写注册表 BypassNRO=1。
- VMSVGA 对 Win11 客户机会黑屏；当前图形控制器 VBoxSVGA 正常。

## 2026-11-22 深夜：provider 换为 VBox 后端（已落地代码）
- 插件目录：本仓库根目录。旧 Python sidecar 路由保留在 `src/supervisor.ts` / `sidecar/`，但已不被引用。
- 新增 `src/vbox/provider.ts`（`VboxProvider`，与 SidecarSupervisor 同形 `call/shutdown`）；`src/index.ts` 改用它，frameServer/tools/orphanSweep 类型放宽为 `Provider` 接口，HTTP/状态机/工具面未动。
- 通道落地：
  - 截图：`controlvm screenshotpng <out>`，读 PNG IHDR 宽高；E_FAIL 重试 3 拍（300ms）。
  - 命令/鼠标：`guestcontrol run` PowerShell（会话 1），SetCursorPos+mouse_event；动作名归一化 right_click/double_click/middle_click/scroll/drag(x2,y2)。
  - 打字：`controlvm keyboardputstring`；按键/热键走 scancode 表（字母/数字/常用功能键）。
  - GUI 启动：`cmd /c start "" "<exe>"` 分离启动（直接 guestcontrol run GUI 会挂到进程退出；--no-wait-* 也不 detach）。
  - `desktop.close` 只解绑不关机；`processes`/`close_window`/`activate`/`read_text`/`save.file`/`zoom` 为占位 no-op 或全帧返回。
- 配置默认值（config.ts）：vmName=dsh-vdesk，guestUser=vuser，guestPass 见当时本地配置（未随仓库发布），vboxManage 路径默认值；可用插件配置覆盖。
- 测试：`test/build/ui.test.mjs` 状态机全绿；`test/run.mjs` 冒烟全绿（list/截图/光标/帧面/闸门/CORS）。E2E 实测：cmd start 拉起记事本、截图 1280x800、142ms。
- **已知遗留**：
  1. **中文输入法打字串字**：桌面态微软拼音中文模式拦截/拆拼音，putstring 打出乱码；需打字前确保英文模式，或改走 WM_CHAR/SendKeys/剪贴板粘贴通道。未修。
  2. 截图 E_FAIL 根因：客户机显示模式异常（VideoMode bpp=0、pvVRAM=0），重启客户机恢复；疑似 GA 跟随控制台窗口自动改分辨率到 2560x1413 后帧缓冲映射失败。复现时重启 VM 即可。
  3. 截图未做 maxLongEdge/JPEG 压缩，目前全尺寸 PNG；带宽优化待做。
  4. VRDE/Extension Pack 兜底通道未装。
  5. guestcontrol 会话列表残留一条 error 状态会话，不影响使用。
- DSH 已重启：新 VBox provider 在真机加载成功（8790 `/vdesk/desktops` 返回 `dsh-vdesk`；旧 sidecar 此接口为空）。

## 2026-11-22 23:10 宿主侧 E2E 实测（经插件 HTTP 帧面，非直连 VBoxManage）
- **帧面截图 ✅**：`GET /vdesk/frame?desktop=dsh-vdesk` 200，1280×800 PNG，画面与客户机一致；响应头 `X-Frame-Width/Height`、`X-Cursor-X/Y/Visible` 正常回读。
- **光标回读 ✅**：注入位置 (232,477)，帧头 `X-Cursor-X=232 Y=477 Visible=1` 一致。
- **鼠标点击 ✅**：经 `POST /vdesk/input` kind=click 点任务栏搜索框，开始搜索面板真实弹出；另一处点"开始使用"按钮未落上（坐标偏差，非通道问题）。
- **拉起 GUI ✅/⚠️**：`POST /vdesk/launch` {exe:notepad.exe} 进程确实起来了，但 guestcontrol 管道被子进程继承、调用挂到 15s HTTP 超时才返回（应用已在会话 1）。`cmd /c start` 未真正脱离句柄；待改 PowerShell `Start-Process`（重定向/不继承句柄）或其他 detach 方式。
- **打字 ✅/⚠️ 按 IME 状态分情况**：
  - 微软拼音**中文模式**（任务栏"中"）：`hello vdesk` → `hellov'd'k'se` + 拼音候选"v的苦涩"，确认乱码根因是 IME 拆拼音。
  - **英文模式**（Shift 切到"英"）：`hello vdesk` 干净落字，11 字符无乱码。
  - 修复方向（未做）：打字前确保英文模式（检测/切换 TSF 状态），或改剪贴板+Ctrl+V 通道绕开组词；客户机只留英文键盘布局也是备选。
- **记事本会话恢复坑**：现代 Notepad 崩溃/强杀后会从 `…\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState\*.bin` 恢复旧文档（本次把旧测试垃圾文本带回新窗口）。清理：taskkill notepad.exe 后删该目录 .bin 再拉起。
- **本次 E_FAIL 复发与恢复**：重启 DSH 前 VideoMode 已变 `1280,800,0`（bpp=0），直连截图 E_FAIL；客户机内 `shutdown /r` 干净重启 → 登录后恢复 `1280,800,32`，截图正常。登录流程：锁屏回车 → 客户机密码 putstring + Enter（登录页 ASCII 正常）。
- 产物校验：`lib/client.js` 含 `data-ds-dark-theme`(2)、MutationObserver、蓝色靶心中心(37,99,235)、白环 1.2、contain(15)；`lib/index.js` 含 guestcontrol/VboxProvider。
- **未做的纯客户端目检**：面板/悬浮球要 phase=running 才挂载（初始 hidden）；attach 只走工具 `vdesk_desktop_create`（control.attach），HTTP 帧面无 attach 入口。本轮未能在 DSH 会话里触发工具调用拉起面板，故主题跟随、简约靶心、16:10 自适应的真机视觉效果尚未目检；代码与状态机测试已覆盖。DSH 聊天输入框经 CU 点击/打字未注入（编辑器聚焦或输入法事件不被接受），未继续强推。

- **末次状态（23:20）**：E_FAIL 再次复发，且距上次重启恢复仅约 7 分钟，期间未改分辨率——说明 VBoxSVGA/GA 图形通道本身不稳，不只是窗口改分辨率触发。`setvideomodehint 1280 800 32` 拉不回来（已知死路）。客户机当前 `VideoMode=1280,800,0`，帧面 500 E_FAIL。**本轮重启客户机的命令被系统安全策略阻断，未执行**；下次恢复仍需客户机内 `shutdown /r`（或人工在 VM 窗口重启），进桌面后按锁屏回车→客户机密码登录。
- 待研究的非重启恢复手段（未试）：客户机内禁用/启用 VBoxSVGA 显示适配器、重装 GA 图形驱动、检查 GA Graphics Mode facility 是否掉线。

## 后续待办
- 真机面板目检：在 DSH 会话让 Agent 调 `vdesk_desktop_create` 拉起面板，核对帧画面、简约靶心、深浅色跟随、16:10 无黑边。
- 修打字 IME 通道（英文模式保证/剪贴板粘贴）；修 launch 管道挂死；**排查截图 E_FAIL 复发根因（VBoxSVGA/GA 图形通道，重启只是治标）**；截图压缩；processes/窗口管理补齐；VRDE 兜底。
- 回归测试与收尾记录。

## 关键路径
- VBoxManage: 宿主安装目录下的 `VBoxManage.exe`（默认 `C:\Program Files\Oracle\VirtualBox\VBoxManage.exe`）
- 配置/磁盘/日志: 宿主 VirtualBox 默认机器目录下的 `dsh-vdesk/`（归档时该 VM 已删除）
- ISO: 宿主本地 Win11 安装镜像（归档时已删除）
- 截图目录: 当时 agent workspace 下 guest*.png / dev*.png / reinstall*.png（未随仓库发布）
