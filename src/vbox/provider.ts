/**
 * VboxProvider —— 替换旧 Python sidecar 的本地后端。
 *
 * 与 SidecarSupervisor 保持同形接口：`call(method, params, timeoutMs)` + `shutdown()`，
 * frameServer / tools / orphanSweep / control 一行都不用改。
 *
 * 通道（均已在客户机 dsh-vdesk 上实测）：
 *  - 截图：`VBoxManage controlvm <vm> screenshotpng <png>`，PNG IHDR 读宽高。
 *  - 命令：`VBoxManage guestcontrol <vm> run ...`，派生进程落在交互式会话 1。
 *  - 鼠标：会话 1 内 PowerShell 调 user32 SetCursorPos + mouse_event。
 *  - 键盘：可打印文本走 `controlvm keyboardputstring`；按键/热键走 scancode。
 *  - 文件：截图落宿主 frameDir；guestcontrol 通道按需 copyto/copyfrom。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VdeskConfig } from '../config.js';

const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Set 1 扫描码表（make）；break = make ^ 0x80。 */
const SCANCODE: Record<string, number> = {
  enter: 0x1c, return: 0x1c, tab: 0x0f, esc: 0x01, escape: 0x01, backspace: 0x0e,
  space: 0x39, up: 0x48, down: 0x50, left: 0x4b, right: 0x4d,
  shift: 0x2a, lshift: 0x2a, rshift: 0x36, ctrl: 0x1d, lctrl: 0x1d, alt: 0x38, lalt: 0x38,
  win: 0x5b, meta: 0x5b, delete: 0x53, del: 0x53, home: 0x47, end: 0x4f,
  pageup: 0x49, pagedown: 0x51, insert: 0x52, ins: 0x52, capslock: 0x3a,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40, f7: 0x41, f8: 0x42,
  f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
  a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23, i: 0x17,
  j: 0x24, k: 0x25, l: 0x26, m: 0x32, n: 0x31, o: 0x18, p: 0x19, q: 0x10, r: 0x13,
  s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d, y: 0x15, z: 0x2c,
  '0': 0x0b, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07,
  '7': 0x08, '8': 0x09, '9': 0x0a,
  '-': 0x0c, '=': 0x0d, '[': 0x1a, ']': 0x1b, ';': 0x27, "'": 0x28, '`': 0x29,
  ',': 0x33, '.': 0x34, '/': 0x35, '\\': 0x2b,
};

function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

function base64Utf16(text: string): string {
  return Buffer.from(text, 'utf16le').toString('base64');
}

/** 后端统一接口：旧 Python sidecar 与 VBox provider 都满足该形状。 */
export interface Provider {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  shutdown(): Promise<void>;
}

export class VboxProvider implements Provider {
  private cfg: VdeskConfig;
  private stopped = false;

  constructor(cfg: VdeskConfig) {
    this.cfg = cfg;
  }

  // ---- 底层进程调用 ----

  private async vbox(args: string[], timeoutMs?: number): Promise<ExecResult> {
    if (this.stopped) throw new Error('vbox provider is closed');
    const timeout = timeoutMs ?? this.cfg.callTimeoutMs;
    try {
      return await execFileAsync(this.cfg.vboxManage, args, {
        windowsHide: true,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e: any) {
      const msg = e?.stderr || e?.message || 'vboxmanage failed';
      throw new Error(`vbox ${args.join(' ')}: ${String(msg).slice(0, 300)}`);
    }
  }

  private async vmState(): Promise<string> {
    const r = await this.vbox(['showvminfo', this.cfg.vmName, '--machinereadable'], 10_000);
    const m = /^VMState="([^"]+)"/m.exec(r.stdout);
    return m?.[1] ?? 'unknown';
  }

  /** 在客户机会话 1 里跑一段 PowerShell，返回 stdout。 */
  private async guestPwsh(script: string, timeoutMs?: number): Promise<string> {
    const exe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const args = [
      'guestcontrol', this.cfg.vmName, 'run',
      '--exe', exe,
      '--username', this.cfg.guestUser,
      '--password', this.cfg.guestPass,
      '--wait-stdout', '--wait-stderr',
      '--', exe, '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', base64Utf16(script),
    ];
    const r = await this.vbox(args, timeoutMs ?? this.cfg.callTimeoutMs);
    return r.stdout;
  }

  /** GUI 程序分离启动：cmd /c start 立即返回，避免 guestcontrol 挂到进程退出。 */
  private async guestLaunch(exe: string, timeoutMs?: number): Promise<void> {
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const args = [
      'guestcontrol', this.cfg.vmName, 'run',
      '--exe', cmd,
      '--username', this.cfg.guestUser,
      '--password', this.cfg.guestPass,
      '--wait-stdout', '--wait-stderr',
      '--', cmd, '/c', 'start', '""', exe,
    ];
    await this.vbox(args, timeoutMs ?? this.cfg.callTimeoutMs);
  }

  private async guestRun(exe: string, exeArgs: string[], timeoutMs?: number, detach = false): Promise<ExecResult> {
    const args = [
      'guestcontrol', this.cfg.vmName, 'run',
      '--exe', exe,
      '--username', this.cfg.guestUser,
      '--password', this.cfg.guestPass,
      // GUI 程序不退出：detach 时不等进程结束，否则会一直挂到超时。
      detach ? '--no-wait-stdout' : '--wait-stdout',
      detach ? '--no-wait-stderr' : '--wait-stderr',
      '--', exe, ...exeArgs,
    ];
    return this.vbox(args, timeoutMs ?? this.cfg.callTimeoutMs);
  }

  // ---- RPC 分发（与旧 sidecar 方法名/返回形状对齐） ----

  async call<T = unknown>(method: string, params?: any, timeoutMs?: number): Promise<T> {
    const p = params ?? {};
    switch (method) {
      case 'desktop.list': {
        const state = await this.vmState();
        return { desktops: state === 'running' ? [this.cfg.vmName] : [] } as T;
      }
      case 'desktop.create': {
        const state = await this.vmState();
        if (state !== 'running') throw new Error(`VM ${this.cfg.vmName} 未运行（state=${state}）`);
        if (p.exe) await this.guestLaunch(String(p.exe), timeoutMs);
        return { name: this.cfg.vmName, desktop: this.cfg.vmName, hDesktop: 1, pid: 1 } as T;
      }
      case 'desktop.close':
        // 虚拟桌面 = 整台 VM：只解绑，不关机。
        return { closed: true, desktop: this.cfg.vmName } as T;
      case 'desktop.sweep':
        return { swept: [] } as T;
      case 'desktop.processes':
        return { processes: [] } as T;
      case 'desktop.activate':
        return { ok: true } as T;
      case 'desktop.close_window':
        return { ok: true } as T;
      case 'desktop.launch': {
        const exe: string = p.exe ?? p.path ?? '';
        if (!exe) throw new Error('launch 缺少 exe 路径');
        await this.guestLaunch(exe, timeoutMs);
        return { ok: true, pid: 0 } as T;
      }
      case 'capture.shot':
        return this.captureShot(p, timeoutMs) as Promise<T>;
      case 'capture.zoom':
        return this.captureShot(p, timeoutMs) as Promise<T>;
      case 'capture.cursor':
        return this.captureCursor() as Promise<T>;
      case 'input_event': {
        // 面板 HTTP 入口：kind=type 走打字，其余按点击处理。
        if (p.kind === 'type') {
          await this.typeText(String(p.text ?? ''), timeoutMs);
        } else {
          await this.injectClick(p, timeoutMs);
        }
        return { ok: true } as T;
      }
      case 'input.click':
        await this.injectClick(p, timeoutMs);
        return { ok: true } as T;
      case 'input.mouse':
        await this.injectMouse(p, timeoutMs);
        return { ok: true } as T;
      case 'input.keyboard':
        await this.injectKeyboard(p, timeoutMs);
        return { ok: true } as T;
      case 'input.type':
        await this.typeText(String(p.text ?? ''), timeoutMs);
        return { ok: true } as T;
      case 'input.read_text':
        return { text: '' } as T;
      case 'save.file':
        return { ok: true, path: '' } as T;
      default:
        throw new Error(`vbox provider 未实现方法: ${method}`);
    }
  }

  // ---- 截图 / 光标 ----

  private frameDir(): string {
    return this.cfg.frameDir || os.tmpdir();
  }

  private async captureShot(params: any, timeoutMs?: number): Promise<any> {
    const dir = this.frameDir();
    fs.mkdirSync(dir, { recursive: true });
    // 帧面会传目标路径（按 desktop slug 防穿越），优先用它；否则用默认文件名。
    const out: string = params?.out || path.join(dir, `vdesk-${this.cfg.vmName}.png`);
    const t0 = Date.now();
    // 客户机显示模式切换瞬间 TakeScreenShotToArray 会偶发 E_FAIL，重试两拍再抛。
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.vbox(['controlvm', this.cfg.vmName, 'screenshotpng', out], timeoutMs ?? 15_000);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (lastErr) throw lastErr;
    const buf = fs.readFileSync(out);
    const { width, height } = pngDimensions(buf);
    return {
      out,
      width,
      height,
      sourceWidth: width,
      sourceHeight: height,
      channel: 'desktop',
      black: false,
      timing: { totalMs: Date.now() - t0 },
    };
  }

  private async captureCursor(): Promise<any> {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$p=[System.Windows.Forms.Cursor]::Position',
      `"$($p.X),$($p.Y)"`,
    ].join('\n');
    const out = await this.guestPwsh(script, 10_000);
    const m = /(\d+)\s*,\s*(\d+)/.exec(out);
    if (!m) return { x: -1, y: -1, visible: false };
    return { x: Number(m[1]), y: Number(m[2]), visible: true };
  }

  // ---- 坐标换算：帧坐标 → 客户机源坐标 ----

  private mapSrc(p: any): { sx: number; sy: number } {
    const fx = Number(p.x ?? 0);
    const fy = Number(p.y ?? 0);
    const fw = Number(p.frameWidth || p.frameW || 0) || fx || 1;
    const fh = Number(p.frameHeight || p.frameH || 0) || fy || 1;
    const sw = Number(p.srcWidth || p.sourceWidth || 0) || fw;
    const sh = Number(p.srcHeight || p.sourceHeight || 0) || fh;
    return {
      sx: Math.round((fx * sw) / fw),
      sy: Math.round((fy * sh) / fh),
    };
  }

  // ---- 鼠标注入 ----

  private mouseScript(x: number, y: number, action: string, button: string, clicks: number): string {
    const down = button === 'right' ? '0x0008' : button === 'middle' ? '0x0020' : '0x0002';
    const up = button === 'right' ? '0x0010' : button === 'middle' ? '0x0040' : '0x0004';
    return [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type @"',
      'using System.Runtime.InteropServices;',
      'public class U32v {',
      '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);',
      '}',
      '"@',
      `[U32v]::SetCursorPos(${x}, ${y}) | Out-Null`,
      'Start-Sleep -Milliseconds 120',
    ].concat(
      action === 'move'
        ? ['"MOVE OK"']
        : [
            `$down = ${down}; $up = ${up};`,
            `for ($i = 0; $i -lt ${clicks}; $i++) {`,
            '  [U32v]::mouse_event($down, 0, 0, 0, 0); Start-Sleep -Milliseconds 60;',
            '  [U32v]::mouse_event($up, 0, 0, 0, 0); Start-Sleep -Milliseconds 90;',
            '}',
            '"CLICK OK"',
          ],
    ).join('\n');
  }

  private async injectClick(p: any, timeoutMs?: number): Promise<void> {
    const { sx, sy } = this.mapSrc(p);
    const button: string = p.button === 'right' ? 'right' : 'left';
    const clicks = p.double || p.action === 'double' ? 2 : 1;
    await this.guestPwsh(this.mouseScript(sx, sy, 'click', button, clicks), timeoutMs);
  }

  private async injectMouse(p: any, timeoutMs?: number): Promise<void> {
    let action: string = p.action ?? 'click';
    let button: string = p.button === 'right' ? 'right' : p.button === 'middle' ? 'middle' : 'left';
    // 工具动作名归一化：right_click / double_click / middle_click。
    if (action === 'right_click') { action = 'click'; button = 'right'; }
    else if (action === 'double_click') action = 'double';
    else if (action === 'middle_click') { action = 'click'; button = 'middle'; }

    if (action === 'move') {
      const { sx, sy } = this.mapSrc(p);
      await this.guestPwsh(this.mouseScript(sx, sy, 'move', 'left', 0), timeoutMs);
      return;
    }
    if (action === 'scroll') {
      const wheel = Number(p.delta ?? 0) * 120;
      const script = [
        'Add-Type @"',
        'using System.Runtime.InteropServices;',
        'public class U32w {',
        '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);',
        '}',
        '"@',
        `[U32w]::mouse_event(0x0800, 0, 0, ${wheel}, 0)`,
        '"SCROLL OK"',
      ].join('\n');
      await this.guestPwsh(script, timeoutMs);
      return;
    }
    if (action === 'drag' || action === 'dragTo') {
      const fx = Number(p.x2 ?? p.dragTo?.x ?? 0);
      const fy = Number(p.y2 ?? p.dragTo?.y ?? 0);
      const fw = Number(p.frameWidth || 0) || 1;
      const fh = Number(p.frameHeight || 0) || 1;
      const sw = Number(p.srcWidth || 0) || fw;
      const sh = Number(p.srcHeight || 0) || fh;
      const tx = Math.round((fx * sw) / fw);
      const ty = Math.round((fy * sh) / fh);
      const f0x = Number(p.x ?? p.dragFrom?.x ?? 0);
      const f0y = Number(p.y ?? p.dragFrom?.y ?? 0);
      const script = [
        'Add-Type @"',
        'using System.Runtime.InteropServices;',
        'public class U32d {',
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);',
        '}',
        '"@',
        `[U32d]::SetCursorPos(${f0x}, ${f0y}) | Out-Null`,
        'Start-Sleep -Milliseconds 100',
        '[U32d]::mouse_event(0x0002, 0, 0, 0, 0)',
        'Start-Sleep -Milliseconds 80',
        `[U32d]::SetCursorPos(${tx}, ${ty}) | Out-Null`,
        'Start-Sleep -Milliseconds 120',
        '[U32d]::mouse_event(0x0004, 0, 0, 0, 0)',
        '"DRAG OK"',
      ].join('\n');
      await this.guestPwsh(script, timeoutMs);
      return;
    }
    const { sx, sy } = this.mapSrc(p);
    const clicks = action === 'double' ? 2 : 1;
    await this.guestPwsh(this.mouseScript(sx, sy, 'click', button, clicks), timeoutMs);
  }

  // ---- 键盘注入 ----

  private async typeText(text: string, timeoutMs?: number): Promise<void> {
    if (!text) return;
    await this.vbox(['controlvm', this.cfg.vmName, 'keyboardputstring', text], timeoutMs ?? 10_000);
  }

  private scancodeSeq(key: string): number[] | null {
    const k = String(key ?? '').toLowerCase();
    const code = SCANCODE[k];
    if (code === undefined) return null;
    return [code, code | 0x80];
  }

  private async injectKeyboard(p: any, timeoutMs?: number): Promise<void> {
    const action: string = p.action ?? 'type';
    if (action === 'type' || action === 'text') {
      await this.typeText(String(p.text ?? ''), timeoutMs);
      return;
    }
    if (action === 'press') {
      const seq = this.scancodeSeq(p.key);
      if (!seq) throw new Error(`不支持的按键: ${String(p.key)}`);
      await this.vbox(
        ['controlvm', this.cfg.vmName, 'keyboardputscancode', ...seq.map((b) => b.toString(16))],
        timeoutMs ?? 10_000,
      );
      return;
    }
    if (action === 'hotkey') {
      const keys: string[] = Array.isArray(p.keys) && p.keys.length
        ? p.keys
        : Array.isArray(p.hotkey)
          ? p.hotkey
          : String(p.hotkey ?? p.key ?? '').split('+');
      const seq: number[] = [];
      const makes: number[] = [];
      for (const raw of keys) {
        const seqOne = this.scancodeSeq(raw);
        if (!seqOne) throw new Error(`不支持的热键按键: ${String(raw)}`);
        makes.push(seqOne[0]);
      }
      // 按下顺序，抬起反序。
      seq.push(...makes);
      seq.push(...[...makes].reverse().map((m) => m | 0x80));
      await this.vbox(
        ['controlvm', this.cfg.vmName, 'keyboardputscancode', ...seq.map((b) => b.toString(16))],
        timeoutMs ?? 10_000,
      );
      return;
    }
    throw new Error(`不支持的键盘动作: ${action}`);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
  }
}
