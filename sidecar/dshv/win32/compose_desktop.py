"""
合成完整桌面画面：桌面视图层（壁纸+图标）+ 应用窗口 + 任务栏 + 系统托盘。

核心教训（都是实测踩出来的）：
  1. PrintWindow 必须画到 CreateCompatibleBitmap 的 **DDB** 上；
     画到 CreateDIBSection 的 DIB 上会只出一部分或全黑（图标丢半屏、任务栏黑条）。
  2. 隔离桌面上的 explorer 要 11~15 秒才把 shell 加载完（任务栏/托盘）。
  3. WindowFromPoint 跨桌面不可靠，定位控件要自己遍历。

调用线程须已 SetThreadDesktop(目标桌面)。
"""
import ctypes
import ctypes.wintypes as w
import struct
import zlib

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

PW_RENDERFULLCONTENT = 2
WS_VISIBLE = 0x10000000
WS_MINIMIZE = 0x20000000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TRANSPARENT = 0x00000020


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", w.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", w.WORD),
        ("biBitCount", w.WORD),
        ("biCompression", w.DWORD),
        ("biSizeImage", w.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", w.DWORD),
        ("biClrImportant", w.DWORD),
    ]


# 不参与"应用窗口"叠加的类：桌面层已画、任务栏/托盘单独画，
# 其余是系统浮层/输入法/提示条，画上去只会盖住真实窗口。
SKIP_CLASSES = {
    "Progman",
    "WorkerW",
    "Windows.UI.Core.CoreWindow",
    "ApplicationFrameWindow",
    "Windows.UI.Composition.DesktopWindowContentBridge",
    "UAC_InputIndicatorOverlayWnd",
    "UAC Input Indicator",
    "Touch Tooltip Window",
    "tooltips_class32",
    "IME",
    "MSCTFIME UI",
    "CiceroUIWndFrame",
    "Sogou_TSF_UI",
    "SoPY_UI",
    "SoPY_Hint",
    "SoPY_Status",
    "SystemTray_Main",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "TrayNotifyWnd",
    "MS_WebcheckMonitor",
    "BluetoothNotificationAreaIconWindowClass",
    "MiracastConnectionWindow",
    "TabletPenServiceHelperClass",
    "DDEMLEvent",
    "DDEMLMom",
    "CicLoaderWndClass",
    "GDI+ Hook Window Class",
    "InputNonClientPointerSource",
    "Microsoft.UI.Content.DesktopChildSiteBridge",
}

TASKBAR_CLASSES = ("Shell_TrayWnd", "Shell_SecondaryTrayWnd")


def _bind():
    # 线程级 DPI 感知：不开的话 GetWindowRect 返回逻辑像素（1707），
    # 而 explorer 的窗口实际是物理像素（2560），画布按逻辑尺寸建就会裁掉右侧。
    try:
        user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    user32.FindWindowExW.argtypes = [w.HWND, w.HWND, w.LPCWSTR, w.LPCWSTR]
    user32.FindWindowExW.restype = w.HWND
    user32.PrintWindow.argtypes = [w.HWND, w.HDC, w.UINT]
    user32.PrintWindow.restype = w.BOOL
    user32.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
    user32.GetWindowRect.restype = w.BOOL
    user32.GetWindowLongW.argtypes = [w.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.GetTopWindow.argtypes = [w.HWND]
    user32.GetTopWindow.restype = w.HWND
    user32.GetWindow.argtypes = [w.HWND, w.UINT]
    user32.GetWindow.restype = w.HWND
    user32.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    user32.GetSystemMetrics.restype = ctypes.c_int
    user32.GetWindowDC.argtypes = [w.HWND]
    user32.GetWindowDC.restype = w.HDC
    user32.ReleaseDC.argtypes = [w.HWND, w.HDC]
    user32.ReleaseDC.restype = ctypes.c_int
    gdi32.CreateCompatibleDC.argtypes = [w.HDC]
    gdi32.CreateCompatibleDC.restype = w.HDC
    gdi32.DeleteDC.argtypes = [w.HDC]
    gdi32.DeleteDC.restype = w.BOOL
    gdi32.DeleteObject.argtypes = [w.HGDIOBJ]
    gdi32.DeleteObject.restype = w.BOOL
    gdi32.SelectObject.argtypes = [w.HDC, w.HGDIOBJ]
    gdi32.SelectObject.restype = w.HGDIOBJ
    gdi32.CreateCompatibleBitmap.argtypes = [w.HDC, ctypes.c_int, ctypes.c_int]
    gdi32.CreateCompatibleBitmap.restype = w.HBITMAP
    gdi32.GetDIBits.argtypes = [
        w.HDC, w.HBITMAP, w.UINT, w.UINT, ctypes.c_void_p,
        ctypes.POINTER(BITMAPINFOHEADER), w.UINT,
    ]
    gdi32.GetDIBits.restype = ctypes.c_int


def _new_dib(width, height):
    """画布用 DIB section（便于整块读像素）。"""
    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(bmi)
    bmi.biWidth = width
    bmi.biHeight = -height
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0
    hdc = gdi32.CreateCompatibleDC(None)
    ptr = ctypes.c_void_p()
    gdi32.CreateDIBSection.argtypes = [
        w.HDC, ctypes.POINTER(BITMAPINFOHEADER), w.UINT,
        ctypes.POINTER(ctypes.c_void_p), w.HANDLE, w.DWORD,
    ]
    gdi32.CreateDIBSection.restype = w.HBITMAP
    hbmp = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(ptr), None, 0)
    gdi32.SelectObject(hdc, hbmp)
    return hdc, hbmp, ptr


def _blit_ddb(hwnd, canvas_dc, sw, sh):
    """用 DDB 抓一个窗口并 BitBlt 进画布。返回 (ok, rect, class)。

    DDB 是关键：PrintWindow 对 DIB section 只画一部分（图标丢半屏、任务栏黑条）。
    拷贝用 BitBlt 而不是 GetDIBits —— 对 DDB 调 GetDIBits 会受
    设备位图配额限制，大尺寸任务栏读回来是黑的。
    """
    r = w.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return False, None, ""
    ww, hh = r.right - r.left, r.bottom - r.top
    if ww <= 0 or hh <= 0:
        return False, None, ""
    src_dc = user32.GetWindowDC(hwnd)
    if not src_dc:
        return False, None, ""
    mem_dc = gdi32.CreateCompatibleDC(src_dc)
    ddb = gdi32.CreateCompatibleBitmap(src_dc, ww, hh)
    old_obj = gdi32.SelectObject(mem_dc, ddb)
    ok = bool(user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT))
    if ok:
        # 目标区域裁剪到画布内
        dx = max(0, r.left)
        dy = max(0, r.top)
        sx = dx - r.left
        sy = dy - r.top
        cw = min(ww - sx, sw - dx)
        ch = min(hh - sy, sh - dy)
        if cw > 0 and ch > 0:
            gdi32.BitBlt.argtypes = [
                w.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                w.HDC, ctypes.c_int, ctypes.c_int, w.DWORD,
            ]
            gdi32.BitBlt(canvas_dc, dx, dy, cw, ch, mem_dc, sx, sy, 0x00CC0020)  # SRCCOPY
    gdi32.SelectObject(mem_dc, old_obj)
    gdi32.DeleteObject(ddb)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(hwnd, src_dc)
    return ok, r, _class_of(hwnd)


def write_png(path, width, height, raw_bgra):
    rows = []
    for y in range(height):
        row = raw_bgra[y * width * 4 : (y + 1) * width * 4]
        rgb = bytearray()
        for x in range(width):
            i = x * 4
            rgb += bytes((row[i + 2], row[i + 1], row[i]))
        rows.append(b"\x00" + bytes(rgb))
    data = b"".join(rows)

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(data, 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def _class_of(hwnd):
    try:
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buf, 64)
        return buf.value
    except Exception:
        return ""


def _window_ok(hwnd):
    style = user32.GetWindowLongW(hwnd, -16) & 0xFFFFFFFF
    ex = user32.GetWindowLongW(hwnd, -20) & 0xFFFFFFFF
    if not (style & WS_VISIBLE):
        return False
    if style & WS_MINIMIZE:
        return False
    if ex & WS_EX_TOOLWINDOW or ex & WS_EX_TRANSPARENT:
        return False
    r = w.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return False
    return (r.right - r.left) > 0 and (r.bottom - r.top) > 0


def _find_defview(hdesk, enumerate_fn):
    """桌面图标视图。优先 SysListView32（真正画图标那个），回退 DefView。

    只抓 SHELLDLL_DefView 时右侧那列图标画不出来，抓它内部的
    SysListView32 才完整。
    """
    for hh in enumerate_fn(hdesk) or []:
        if _class_of(hh) != "Progman":
            continue
        dv = user32.FindWindowExW(hh, None, "SHELLDLL_DefView", None)
        if not dv:
            continue
        lv = user32.FindWindowExW(dv, None, "SysListView32", None)
        return (lv or dv), bool(lv)
    return 0, False


def compose(hdesk, out_path, enumerate_fn):
    """合成一帧完整桌面。层序（下→上）：桌面图标 → 应用窗口 → 任务栏 → 托盘。"""
    _bind()

    # 画布尺寸必须用桌面视图的【真实 rect】。
    # GetSystemMetrics 给的是逻辑像素（2560 屏幕在 150% 缩放下返回 1707），
    # 而 explorer 的窗口 rect 是物理像素（2560x1600）；按 1707 建画布会把
    # 右侧一整列图标裁掉。
    icons_view, is_listview = _find_defview(hdesk, enumerate_fn)
    sw = sh = 0
    if icons_view:
        r = w.RECT()
        if user32.GetWindowRect(icons_view, ctypes.byref(r)):
            sw, sh = r.right - r.left, r.bottom - r.top
    if sw <= 0 or sh <= 0:
        sw = user32.GetSystemMetrics(0)
        sh = user32.GetSystemMetrics(1)
    if sw <= 0 or sh <= 0:
        return {"ok": False, "error": "cannot determine desktop size"}

    canvas, canvas_bmp, canvas_ptr = _new_dib(sw, sh)
    canvas_dc = canvas
    layers = []

    # 1) 桌面视图层：壁纸 + 全部桌面图标。
    if icons_view:
        ok, _r, _c = _blit_ddb(icons_view, canvas_dc, sw, sh)
        if ok:
            layers.append({"layer": "desktop", "hwnd": int(icons_view), "listview": is_listview})

    # 2) 应用窗口：只叠最上面那一个真实应用窗口，避免 Z 序错位
    top = user32.GetTopWindow(None)
    stack = []
    while top:
        stack.append(top)
        top = user32.GetWindow(top, 2)
    picked = None
    for hwnd in reversed(stack):
        if not _window_ok(hwnd):
            continue
        if _class_of(hwnd) in SKIP_CLASSES:
            continue
        picked = hwnd
    if picked:
        ok, _r, cls = _blit_ddb(picked, canvas_dc, sw, sh)
        if ok:
            layers.append({"layer": "window", "hwnd": int(picked), "class": cls})

    # 3) 任务栏
    tray_wnd = 0
    for hh in enumerate_fn(hdesk) or []:
        cls = _class_of(hh)
        if cls in TASKBAR_CLASSES:
            ok, _r, _c = _blit_ddb(hh, canvas_dc, sw, sh)
            if ok:
                layers.append({"layer": "taskbar", "hwnd": int(hh)})
            child = None
            while True:
                child = user32.FindWindowExW(hh, child, None, None)
                if not child:
                    break
                if _class_of(child) == "TrayNotifyWnd":
                    tray_wnd = child
                    break

    # 4) 系统托盘（任务栏整体 PrintWindow 时右侧常画不出来）
    if tray_wnd:
        ok, _r, _c = _blit_ddb(tray_wnd, canvas_dc, sw, sh)
        if ok:
            layers.append({"layer": "tray", "hwnd": int(tray_wnd)})

    raw = ctypes.string_at(canvas_ptr, sw * sh * 4)
    size = write_png(out_path, sw, sh, raw)

    gdi32.DeleteObject(canvas_bmp)
    gdi32.DeleteDC(canvas)

    return {
        "ok": True,
        "imagePath": out_path,
        "bytes": size,
        "width": sw,
        "height": sh,
        "sourceWidth": sw,
        "sourceHeight": sh,
        "layers": layers,
        "channel": "compose",
    }
