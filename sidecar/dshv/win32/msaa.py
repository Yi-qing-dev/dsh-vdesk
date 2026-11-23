"""
MSAA（IAccessible）后台点击 —— 不切桌面、不抢焦点。

实测结论（决定这段代码的依据）：
  - SendInput 只往「激活的输入桌面」送，非活动桌面一律 winerror=5；
  - PostMessage 的 WM_LBUTTONDOWN 不走系统鼠标捕获，Button 收不到 WM_COMMAND；
  - WindowFromPoint 跨桌面会返回父窗口，不可靠；
  - 自己遍历 FindWindowEx + GetWindowRect 定位到具体控件，
    再对它的 IAccessible 调 accDoDefaultAction(SELF)，才能真正触发点击。
  - accDoDefaultAction 对纯输入控件会返回 S_OK 但什么都不做，要跳过。
"""
import ctypes
import ctypes.wintypes as w

user32 = ctypes.windll.user32
oleacc = ctypes.windll.oleacc

OBJID_CLIENT = 0xFFFFFFFC
VT_I4 = 3
VT_DISPATCH = 9
CHILDID_SELF = 0
SELFLAG_TAKEFOCUS = 0x1
SELFLAG_TAKESELECTION = 0x2


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


IID_IAccessible = GUID(
    0x618736E0, 0x3C3D, 0x11CF, (ctypes.c_ubyte * 8)(0x81, 0x0C, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
)


class VARIANT(ctypes.Structure):
    # 64 位 VARIANT = 16 字节：4 个 ushort 头 + 8 字节 union。
    # 多写 pad 会写越界，accHitTest 的结果就不可靠。
    _fields_ = [
        ("vt", ctypes.c_ushort),
        ("wReserved1", ctypes.c_ushort),
        ("wReserved2", ctypes.c_ushort),
        ("wReserved3", ctypes.c_ushort),
        ("llVal", ctypes.c_longlong),
    ]


VT_RELEASE = 2
VT_ACC_HITTEST = 24
VT_ACC_SELECT = 21
VT_ACC_DODEFAULTACTION = 25

_TEXT_CLASSES = (
    "Edit",
    "RichEdit20W",
    "RichEdit50W",
    "RichEditD2DPT",
    "NotepadTextBox",
    "Scintilla",
)


def _vtable(p):
    return ctypes.cast(p, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents


def accessible_from_window(hwnd):
    pacc = ctypes.c_void_p()
    oleacc.AccessibleObjectFromWindow.argtypes = [
        w.HWND,
        w.DWORD,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    oleacc.AccessibleObjectFromWindow.restype = ctypes.c_long
    hr = oleacc.AccessibleObjectFromWindow(
        w.HWND(hwnd), w.DWORD(OBJID_CLIENT), ctypes.byref(IID_IAccessible), ctypes.byref(pacc)
    )
    return (pacc if hr >= 0 else None), hr


def release(pacc):
    try:
        fn = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(_vtable(pacc)[VT_RELEASE])
        fn(pacc)
    except Exception:
        pass


def acc_do_default_action(pacc, var):
    try:
        fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(VARIANT)
        )(_vtable(pacc)[VT_ACC_DODEFAULTACTION])
        return fn(pacc, ctypes.byref(var)) >= 0
    except Exception:
        return False


def acc_select(pacc, var, flags=SELFLAG_TAKEFOCUS | SELFLAG_TAKESELECTION):
    try:
        fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(VARIANT), ctypes.c_long
        )(_vtable(pacc)[VT_ACC_SELECT])
        return fn(pacc, ctypes.byref(var), flags) >= 0
    except Exception:
        return False


def acc_hit_test(pacc, sx, sy):
    """屏幕坐标命中测试。返回 VARIANT（vt=VT_I4 是 child id，VT_DISPATCH 是子对象）。

    WinUI/UWP 没有独立子 hwnd，坐标 → 元素只能靠这个。
    """
    try:
        fn = ctypes.WINFUNCTYPE(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.c_long,
            ctypes.c_long,
            ctypes.POINTER(VARIANT),
        )(_vtable(pacc)[VT_ACC_HITTEST])
        out = VARIANT()
        hr = fn(pacc, int(sx), int(sy), ctypes.byref(out))
        if hr >= 0:
            return out
    except Exception:
        pass
    return None


def child_variant(child):
    """把 accHitTest 结果转成可直接传回 accDoDefaultAction 的 VARIANT。"""
    v = VARIANT()
    v.vt = child.vt
    v.llVal = child.llVal
    return v


def _class_of(hwnd):
    try:
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
        user32.GetClassNameW(hwnd, buf, 64)
        return buf.value
    except Exception:
        return ""


# 系统覆盖层：透明/全屏/不接收点击，命中它们等于点空。
# UAC_InputIndicatorOverlayWnd 实测是对话框的【子窗口】，所以顶层和子层都要过滤。
_SKIP_CLASSES = {
    "UAC_InputIndicatorOverlayWnd",
    "UAC Input Indicator",
    "Touch Tooltip Window",
    "tooltips_class32",
    "IME",
    "MSCTFIME UI",
    "CiceroUIWndFrame",
    "MS_WebcheckMonitor",
    "BluetoothNotificationAreaIconWindowClass",
    "MiracastConnectionWindow",
    "TabletPenServiceHelperClass",
    "InputNonClientPointerSource",
    "Windows.UI.Core.CoreWindow",
    "Windows.UI.Composition.DesktopWindowContentBridge",
}


def _controls_at(top_hwnd, sx, sy):
    """收集所有包含该屏幕坐标的控件，按深度从深到浅排序。"""
    user32.FindWindowExW.argtypes = [w.HWND, w.HWND, w.LPCWSTR, w.LPCWSTR]
    user32.FindWindowExW.restype = w.HWND
    user32.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
    found = []
    stack = [(top_hwnd, 0)]
    while stack:
        hh, d = stack.pop()
        r = w.RECT()
        if not user32.GetWindowRect(hh, ctypes.byref(r)):
            continue
        if not (r.left <= sx <= r.right and r.top <= sy <= r.bottom):
            continue
        found.append((d, hh))
        child = None
        while True:
            child = user32.FindWindowExW(hh, child, None, None)
            if not child:
                break
            if _class_of(child) in _SKIP_CLASSES:
                continue
            stack.append((child, d + 1))
    found.sort(key=lambda x: -x[0])
    return found


def find_control_at(top_hwnd, sx, sy):
    """找包含屏幕坐标 (sx,sy) 的最深子控件。返回 (hwnd, depth)。"""
    cands = _controls_at(top_hwnd, sx, sy)
    if not cands:
        return top_hwnd, 0
    return cands[0][1], cands[0][0]


def click_point(top_hwnd, sx, sy):
    """坐标点击的无闪烁实现。

    三条路径按可靠性排序：
      1. accHitTest 命中具体元素 → 对它做默认动作（WinUI/UWP 只有这条路）
      2. 遍历子控件找到 depth>=1 的真实控件 → BM_CLICK / accDoDefaultAction
      3. 都没有就失败（不假装成功：对顶层窗口调默认动作会返回 S_OK 但什么也不做）
    """
    # 路径 1：accHitTest —— 必须打在【最深控件】上。
    # 对顶层窗口（Progman）或其容器（SHELLDLL_DefView）调默认动作会返回
    # S_OK 但什么都不做（实测点桌面图标没反应）；真正的图标项在
    # SysListView32 底下。
    deep = _controls_at(top_hwnd, sx, sy)
    hit_targets = []
    if deep:
        hit_targets.append(deep[0][1])       # 最深控件优先
    if top_hwnd not in hit_targets:
        hit_targets.append(top_hwnd)         # 再退回顶层
    for ht in hit_targets:
        pacc, _hr = accessible_from_window(ht)
        if not pacc:
            continue
        try:
            hit = acc_hit_test(pacc, sx, sy)
            if hit is not None and hit.vt != 0:
                var = child_variant(hit)
                if acc_do_default_action(pacc, var):
                    return {
                        "ok": True,
                        "method": "msaa-hit-default",
                        "hwnd": ht,
                        "vt": hit.vt,
                        "class": _class_of(ht),
                    }
                if acc_select(pacc, var):
                    return {
                        "ok": True,
                        "method": "msaa-hit-select",
                        "hwnd": ht,
                        "vt": hit.vt,
                        "class": _class_of(ht),
                    }
        finally:
            release(pacc)

    cands = deep if deep else _controls_at(top_hwnd, sx, sy)
    if not cands:
        return {"ok": False, "method": "msaa", "error": "no control at point"}
    tried = []
    for depth, ctrl in cands:
        # 顶层窗口本身没有"默认动作"，对它调用是假阳性，跳过
        if depth < 1:
            continue
        cls = _class_of(ctrl)
        tried.append({"hwnd": int(ctrl), "depth": depth, "class": cls})
        is_text = cls in _TEXT_CLASSES
        # Button 类控件用标准 BM_CLICK（accDoDefaultAction 对它返回 S_OK 却不触发）
        if cls in ("Button", "SysButton"):
            try:
                user32.SendMessageW.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_uint,
                    ctypes.c_size_t,
                    ctypes.c_ssize_t,
                ]
                user32.SendMessageW.restype = ctypes.c_ssize_t
                user32.SendMessageW(ctrl, 0x00F5, 0, 0)  # BM_CLICK
                return {
                    "ok": True,
                    "method": "bm-click",
                    "hwnd": ctrl,
                    "depth": depth,
                    "class": cls,
                }
            except Exception:
                pass
        pacc2, _hr2 = accessible_from_window(ctrl)
        if not pacc2:
            continue
        try:
            var = VARIANT()
            var.vt = VT_I4
            var.llVal = CHILDID_SELF
            if not is_text and acc_do_default_action(pacc2, var):
                return {
                    "ok": True,
                    "method": "msaa-default-action",
                    "hwnd": ctrl,
                    "depth": depth,
                    "class": cls,
                }
            if acc_select(pacc2, var):
                return {
                    "ok": True,
                    "method": "msaa-select",
                    "hwnd": ctrl,
                    "depth": depth,
                    "class": cls,
                }
        finally:
            release(pacc2)
    return {"ok": False, "method": "msaa", "error": "no actionable control", "tried": tried[:6]}
