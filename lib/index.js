// src/config.ts
var defaultConfig = {
  sidecarPath: "python",
  sidecarArgs: ["-m", "dshv", "--rpc", "stdio"],
  sidecarCwd: "",
  callTimeoutMs: 3e4,
  framePort: 8790,
  framePortMax: 8799,
  webOrigin: "http://127.0.0.1:3080",
  frameDir: "",
  vboxManage: "C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe",
  vmName: "dsh-vdesk",
  guestUser: "vuser",
  guestPass: ""
};

// src/transport/stdioJsonRpc.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
var seq = 0;
var StdioJsonRpc = class extends EventEmitter {
  proc = null;
  pending = /* @__PURE__ */ new Map();
  opts;
  starting = null;
  stopped = false;
  constructor(opts) {
    super();
    this.opts = opts;
  }
  get alive() {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null;
  }
  async start() {
    if (this.stopped) throw new Error("sidecar transport is closed");
    if (this.alive) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const proc = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env ?? {} },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.proc = proc;
      proc.once("error", (e) => {
        this.starting = null;
        if (proc.pid === void 0) this.proc = null;
        reject(e);
      });
      proc.once("spawn", () => {
        this.starting = null;
        resolve();
      });
      proc.once("exit", (code, signal) => {
        this.proc = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`sidecar exited code=${code} signal=${signal}`));
          this.pending.delete(id);
        }
        this.emit("exit", { code, signal });
      });
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          this.emit("stderr", `bad json: ${trimmed}`);
          return;
        }
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`${msg.error.code ?? ""} ${msg.error.message ?? "rpc error"}`));
          else p.resolve(msg.result);
        } else {
          this.emit("notify", msg);
        }
      });
      proc.stderr.on("data", (b) => this.emit("stderr", String(b)));
    });
    return this.starting;
  }
  async call(method, params, timeoutMs) {
    if (this.stopped) throw new Error("sidecar transport is closed");
    if (!this.alive) await this.start();
    const proc = this.proc;
    if (!proc) throw new Error("sidecar not started");
    const id = ++seq;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
    const wait = timeoutMs ?? this.opts.defaultTimeoutMs ?? 6e4;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method} after ${wait}ms`));
      }, wait);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }
  async stop() {
    this.stopped = true;
    if (!this.proc) return;
    const proc = this.proc;
    await new Promise((resolve) => {
      const killT = setTimeout(() => proc.kill("SIGKILL"), 2e3);
      proc.once("close", () => {
        clearTimeout(killT);
        resolve();
      });
      proc.stdin.end();
    });
    this.proc = null;
  }
};

// src/supervisor.ts
var SidecarSupervisor = class {
  rpc;
  constructor(cfg) {
    const c = { ...defaultConfig, ...cfg };
    this.rpc = new StdioJsonRpc({
      command: c.sidecarPath,
      args: c.sidecarArgs,
      cwd: c.sidecarCwd,
      defaultTimeoutMs: c.callTimeoutMs
    });
  }
  async call(method, params, timeoutMs) {
    if (!this.rpc.alive) await this.rpc.start();
    try {
      return await this.rpc.call(method, params, timeoutMs);
    } catch (e) {
      if (!this.rpc.alive) {
        await this.rpc.start();
        return this.rpc.call(method, params, timeoutMs);
      }
      throw e;
    }
  }
  async shutdown() {
    await this.rpc.stop();
  }
};

// src/frameServer.ts
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
var PORT_BASE_DEFAULT = 8790;
var FrameServer = class _FrameServer {
  constructor(server, supervisor, control, webOrigin, frameDir, log) {
    this.server = server;
    this.supervisor = supervisor;
    this.control = control;
    this.webOrigin = webOrigin;
    this.frameDir = frameDir;
    this.log = log;
  }
  /** 探测端口并启动；全占则 fail fast（不降端口、不随机）。 */
  static async start(opts) {
    const base = opts.cfg.framePort || PORT_BASE_DEFAULT;
    const max = opts.cfg.framePortMax || base + 9;
    const frameDir = opts.cfg.frameDir ? path.resolve(opts.cfg.frameDir) : path.join(os.tmpdir(), "dshv", "frames");
    await mkdir(frameDir, { recursive: true });
    const fs = new _FrameServer(
      null,
      opts.supervisor,
      opts.control,
      opts.cfg.webOrigin,
      frameDir,
      opts.log
    );
    let lastErr = null;
    for (let port = base; port <= max; port++) {
      try {
        fs.server = await fs.listenOne(port);
        opts.log(`[dsh-vdesktop] frame server listening on 127.0.0.1:${port}`);
        return fs;
      } catch (e) {
        lastErr = e;
        if (e?.code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error(
      `frame server: ports ${base}-${max} all in use (${String(lastErr)})`
    );
  }
  get port() {
    return this.server.address()?.port ?? 0;
  }
  close() {
    return new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      this.server.closeAllConnections();
    });
  }
  listenOne(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.dispatch(req, res).catch((e) => {
          this.log(`[dsh-vdesktop] frame dispatch error: ${String(e)}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(e) }));
          } else {
            res.end();
          }
        });
      });
      server.requestTimeout = 15e3;
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE") {
          server.close();
          reject(e);
        } else {
          reject(e);
        }
      });
      server.listen(port, "127.0.0.1");
      server.once("listening", () => resolve(server));
    });
  }
  // 跨域 fetch 只暴露 safelisted 响应头；帧/输入面的自定义头必须显式
  // Expose，否则浏览器端 resp.headers.get('X-Frame-Width') = null →
  // 客户端 0x0 + 黑屏（大脑 6eab42eb5c8a 确认主因）。服务端实际产出的
  // 全部自定义头白名单（不产的头不加；X-Frame-Format 当前不产）。
  static EXPOSE_HEADERS = [
    "X-Frame-Width",
    "X-Frame-Height",
    "X-Source-Width",
    "X-Source-Height",
    "X-Channel",
    "X-Total-Ms",
    "X-Black",
    "X-Black-Reason",
    "X-Cursor-X",
    "X-Cursor-Y",
    "X-Cursor-Visible"
  ].join(", ");
  /**
   * 允许的来源：显式配置的 webOrigin、Desktop 的 dsh-app:// 外壳，以及任意本地
   * 回环端口。DSH Desktop 每次启动换随机端口，写死一个端口等于把面板锁死
   * （浏览器侧全是 403，画面永远黑）。只放行 127.0.0.1/localhost，不放行 *。
   */
  isAllowedOrigin(origin) {
    if (!origin) return false;
    if (origin === "dsh-app://app" || origin === this.webOrigin) return true;
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(origin);
  }
  corsHeaders(origin) {
    const h = {};
    if (this.isAllowedOrigin(origin)) {
      h["Access-Control-Allow-Origin"] = origin;
      h["Vary"] = "Origin";
      h["Access-Control-Expose-Headers"] = _FrameServer.EXPOSE_HEADERS;
    }
    return h;
  }
  async dispatch(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cors = this.corsHeaders(req.headers.origin);
    if (req.headers.host !== `127.0.0.1:${this.port}` || req.headers.origin !== void 0 && !cors["Access-Control-Allow-Origin"] || !req.headers.origin && req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === "OPTIONS") {
      Object.assign(cors, {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600"
      });
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/vdesk/desktops") {
      return this.handleDesktops(cors, res);
    }
    if (req.method === "GET" && url.pathname === "/vdesk/state") {
      return this.handleState(cors, res);
    }
    if (req.method === "POST" && url.pathname === "/vdesk/control") {
      return this.handleControl(req, cors, res);
    }
    if (req.method === "GET" && url.pathname === "/vdesk/frame") {
      return this.handleFrame(url, cors, res);
    }
    if (req.method === "POST" && url.pathname === "/vdesk/input") {
      return this.handleInput(req, cors, res);
    }
    if (req.method === "GET" && url.pathname === "/vdesk/processes") {
      return this.handleProcesses(url, cors, res);
    }
    if (req.method === "POST" && url.pathname === "/vdesk/launch") {
      return this.handleForward(req, cors, res, "desktop.launch");
    }
    if (req.method === "POST" && url.pathname === "/vdesk/activate") {
      return this.handleForward(req, cors, res, "desktop.activate");
    }
    if (req.method === "POST" && url.pathname === "/vdesk/close_window") {
      return this.handleForward(req, cors, res, "desktop.close_window");
    }
    if (req.method === "POST" && url.pathname === "/vdesk/close_desktop") {
      return this.handleCloseDesktop(req, cors, res);
    }
    res.writeHead(404, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
  async handleDesktops(cors, res) {
    try {
      const r = await this.supervisor.call("desktop.list", {});
      const desktops = Array.isArray(r?.desktops) ? r.desktops : [];
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ desktops }));
    } catch (e) {
      res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  }
  async handleFrame(url, cors, res) {
    const desktop = url.searchParams.get("desktop");
    if (!desktop) {
      res.writeHead(400, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "desktop required" }));
      return;
    }
    const slug = desktop.replace(/[^A-Za-z0-9._-]/g, "_");
    const dirResolved = path.resolve(this.frameDir);
    const out = path.resolve(dirResolved, `vdesk-${slug}.png`);
    if (!out.startsWith(dirResolved)) {
      res.writeHead(400, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad desktop slug" }));
      return;
    }
    let result;
    let cursorInfo = {};
    try {
      const c = await this.supervisor.call("capture.cursor", { desktop }, 3e3);
      if (c && typeof c.x === "number" && typeof c.y === "number") {
        cursorInfo = { x: c.x, y: c.y, visible: c.visible !== false };
      }
    } catch {
    }
    try {
      result = await this.supervisor.call("capture.shot", {
        desktop,
        out,
        fmt: "png",
        maxLongEdge: 1280,
        // M7（用户裁决）：完整 Windows 桌面（壁纸+任务栏）为默认帧；
        // 旧行为可用 ?channel=printwindow 请求
        channel: url.searchParams.get("channel") || "desktop"
      }, 3e4);
    } catch (e) {
      res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
      return;
    }
    if (result.black) {
      res.writeHead(204, {
        ...cors,
        "Cache-Control": "no-store",
        "X-Black": "1",
        "X-Black-Reason": String(result.blackInfo?.reason ?? ""),
        "X-Cursor-X": String(cursorInfo.x ?? -1),
        "X-Cursor-Y": String(cursorInfo.y ?? -1),
        "X-Cursor-Visible": cursorInfo.visible ? "1" : "0"
      });
      res.end();
      return;
    }
    const file = result.out ?? out;
    if (!file) {
      res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no frame on disk" }));
      return;
    }
    let data;
    try {
      data = await readFile(file);
    } catch {
      res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no frame on disk" }));
      return;
    }
    const t = result.timing ?? {};
    res.writeHead(200, {
      ...cors,
      "Content-Type": "image/png",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      "X-Frame-Width": String(result.width ?? 0),
      "X-Frame-Height": String(result.height ?? 0),
      "X-Source-Width": String(result.sourceWidth || result.width || 0),
      "X-Source-Height": String(result.sourceHeight || result.height || 0),
      "X-Channel": String(result.channel ?? ""),
      "X-Total-Ms": String(t.totalMs ?? 0),
      "X-Cursor-X": String(cursorInfo.x ?? -1),
      "X-Cursor-Y": String(cursorInfo.y ?? -1),
      "X-Cursor-Visible": cursorInfo.visible ? "1" : "0"
    });
    res.end(data);
  }
  async handleProcesses(url, cors, res) {
    const desktop = url.searchParams.get("desktop");
    if (!desktop) {
      res.writeHead(400, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "desktop required" }));
      return;
    }
    try {
      const r = await this.supervisor.call("desktop.processes", { desktop }, 15e3);
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  }
  /**
   * 关闭桌面并把它从「活着」的列表里摘掉。
   *
   * sidecar 的 desktop.close 只杀进程、不断句柄，desktop.list 仍会返回它，
   * 于是 phase 在 idle / running 之间抖动，客户端会把它当成新任务把面板弹回来
   * （用户看到的就是"点了终止，过一会儿自己又出来"）。
   * 这里 close 之后补一次记名 + 单桌面 sweep，保证真的消失。
   */
  async handleCloseDesktop(req, cors, res) {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", async () => {
      let name2 = "";
      try {
        const parsed = JSON.parse(body || "{}");
        name2 = String(parsed.name ?? parsed.desktop ?? "");
      } catch {
        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      if (!name2) {
        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "name required" }));
        return;
      }
      let closed = null;
      try {
        closed = await this.supervisor.call("desktop.close", { name: name2 }, 2e4);
      } catch (e) {
        closed = { error: String(e) };
      }
      this.control.markClosed(name2);
      this.control.detach();
      try {
        const l = await this.supervisor.call("desktop.list", {}, 5e3);
        const others = (l?.desktops ?? []).filter((d) => d !== name2);
        if (others.length === 0) await this.supervisor.call("desktop.sweep", {}, 1e4);
      } catch {
      }
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ closed: true, name: name2, result: closed }));
    });
  }
  async handleForward(req, cors, res, method) {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on("end", async () => {
      let params;
      try {
        params = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      try {
        const r = await this.supervisor.call(method, params, 2e4);
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }
  async handleState(cors, res) {
    let desktops = [];
    try {
      const r = await this.supervisor.call("desktop.list", {}, 5e3);
      desktops = Array.isArray(r?.desktops) ? r.desktops : [];
    } catch {
    }
    res.writeHead(200, {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(this.control.snapshot(desktops)));
  }
  async handleControl(req, cors, res) {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", async () => {
      let action;
      try {
        const parsed = JSON.parse(body || "{}");
        action = String(parsed.action ?? "");
      } catch {
        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      switch (action) {
        case "pause":
          this.control.pause("user");
          break;
        case "conflict":
          this.control.pause("conflict");
          break;
        case "resume":
          this.control.resume();
          break;
        case "stop":
          this.control.stop();
          break;
        case "show":
          this.control.note("show", "\u91CD\u65B0\u6253\u5F00\u9762\u677F");
          break;
        default:
          res.writeHead(400, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `unknown action: ${action}` }));
          return;
      }
      let desktops = [];
      try {
        const r = await this.supervisor.call("desktop.list", {}, 5e3);
        desktops = Array.isArray(r?.desktops) ? r.desktops : [];
      } catch {
      }
      this.log(`[dsh-vdesk] control ${action} \u2192 ${this.control.reason ?? "running"}`);
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify(this.control.snapshot(desktops)));
    });
  }
  async handleInput(req, cors, res) {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on("end", async () => {
      let params;
      try {
        params = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      try {
        const r = await this.supervisor.call("input_event", params, 15e3);
        this.control.note("manual", String(params.kind ?? "input"));
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }
};

// src/tools/index.ts
var GATED_TOOLS = /* @__PURE__ */ new Set([
  "vdesk_type",
  "vdesk_click",
  "vdesk_keyboard",
  "vdesk_mouse"
]);
var ACTION_DETAIL = {
  vdesk_type: (p) => `${String(p?.text ?? "").length} \u5B57\u7B26`,
  vdesk_click: (p) => `(${p?.x ?? "?"}, ${p?.y ?? "?"})`,
  vdesk_keyboard: (p) => p?.action === "type" ? `${String(p?.text ?? "").length} \u5B57\u7B26` : String(p?.key ?? (p?.keys ?? []).join("+") ?? ""),
  vdesk_mouse: (p) => `${p?.action} (${p?.x ?? "?"}, ${p?.y ?? "?"})`
};
var renderJson = (_args, value) => [
  { type: "text", text: JSON.stringify(value ?? null) }
];
var OUTPUT_SPEC = { schema: { type: "object" }, render: renderJson };
function buildTools(supervisor, control) {
  return [
    {
      name: "vdesk_desktop_create",
      description: "\u5728\u865A\u62DF\u684C\u9762\u4F1A\u8BDD\u91CC\u521B\u5EFA\u4E00\u4E2A\u9694\u79BB\u684C\u9762\u5E76\u542F\u52A8\u4E00\u4E2A GUI \u5E94\u7528\uFF0C\u8FD4\u56DE\u684C\u9762\u53E5\u67C4\u3001PID \u4E0E\u9876\u5C42\u7A97\u53E3 HWND\u3002",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "\u684C\u9762\u540D\uFF0C\u5EFA\u8BAE\u4EE5 dshv- \u524D\u7F00\uFF0C\u5982 dshv-e2e" },
          exe: { type: "string", description: "\u53EF\u6267\u884C\u6587\u4EF6\u5B8C\u6574\u8DEF\u5F84\uFF0C\u4F8B\u5982 C:WindowsSystem32\notepad.exe" },
          args: { type: "string", description: "\u53EF\u9009\u547D\u4EE4\u884C\u53C2\u6570\uFF08\u5355\u4E2A\u5B57\u7B26\u4E32\uFF09" }
        },
        required: ["name", "exe"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("desktop.create", p)
    },
    {
      name: "vdesk_desktop_close",
      description: "\u5173\u95ED\u6307\u5B9A\u7684\u865A\u62DF\u684C\u9762\u5E76\u7EC8\u6B62\u5176\u4E0A\u7684\u8FDB\u7A0B\u3002",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "\u8981\u5173\u95ED\u7684\u684C\u9762\u540D" }
        },
        required: ["name"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("desktop.close", p)
    },
    {
      name: "vdesk_desktop_list",
      description: "\u5217\u51FA\u5F53\u524D\u6240\u6709 dshv-* \u865A\u62DF\u684C\u9762\u3002",
      parameters: { type: "object", properties: {} },
      output: OUTPUT_SPEC,
      execute: async () => supervisor.call("desktop.list", {})
    },
    {
      name: "vdesk_screenshot",
      description: "\u5BF9\u6307\u5B9A\u865A\u62DF\u684C\u9762\u622A\u56FE\u5E76\u4FDD\u5B58\u5230 out \u8DEF\u5F84\uFF0C\u8FD4\u56DE\u56FE\u50CF\u6587\u4EF6\u4FE1\u606F\uFF1B\u6A21\u578B\u53EF\u636E\u8FD4\u56DE\u503C\u8BFB\u53D6\u753B\u9762\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" },
          out: { type: "string", description: "\u622A\u56FE\u8F93\u51FA\u6587\u4EF6\u8DEF\u5F84\uFF08\u5EFA\u8BAE jpg\uFF09" },
          fmt: { type: "string", description: "\u53EF\u9009 jpeg \u6216 png\uFF0C\u9ED8\u8BA4 jpeg" },
          quality: { type: "number", description: "\u53EF\u9009 JPEG \u8D28\u91CF 1-100\uFF0C\u9ED8\u8BA4 80" }
        },
        required: ["desktop", "out"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("capture.shot", p, 12e4)
    },
    {
      name: "vdesk_type",
      description: "\u5411\u865A\u62DF\u684C\u9762\u7684\u76EE\u6807\u7A97\u53E3\u5199\u5165\u6587\u672C\uFF08\u5F53\u524D\u73AF\u5883\u4E3A SetWindowTextW \u66FF\u6362\u6574\u6BB5\u6587\u672C\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" },
          text: { type: "string" }
        },
        required: ["desktop", "text"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("input.type", p)
    },
    {
      name: "vdesk_click",
      description: "\u5411\u865A\u62DF\u684C\u9762\u7684\u76EE\u6807\u7A97\u53E3\u53D1\u9001\u9F20\u6807\u70B9\u51FB\uFF08\u5F53\u524D\u73AF\u5883\u4E3A postmessage \u5BA2\u6237\u533A\u5750\u6807\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", description: "left \u6216 right\uFF0C\u9ED8\u8BA4 left" }
        },
        required: ["desktop", "x", "y"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("input.click", p)
    },
    {
      name: "vdesk_read_text",
      description: "\u8BFB\u53D6\u865A\u62DF\u684C\u9762\u76EE\u6807\u7A97\u53E3\u7684\u6587\u672C\uFF08\u4F18\u5148\u8BFB Edit \u5B50\u7A97\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" }
        },
        required: ["desktop"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("input.read_text", p)
    },
    {
      name: "vdesk_save_file",
      description: "\u8BFB\u53D6\u5F53\u524D\u684C\u9762\u76EE\u6807\u7A97\u53E3\u6587\u672C\u5E76\u5199\u5165\u5230\u6307\u5B9A\u6587\u4EF6\u8DEF\u5F84\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" },
          path: { type: "string", description: "\u76EE\u6807\u6587\u4EF6\u8DEF\u5F84\uFF0C\u4F8B\u5982 D:	est.txt" }
        },
        required: ["desktop", "path"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("save.file", p)
    },
    {
      name: "vdesk_show",
      description: "\u628A\u865A\u62DF\u684C\u9762\u9762\u677F\u91CD\u65B0\u663E\u793A\u51FA\u6765\u3002\u7528\u6237\u70B9\u8FC7\u300C\u4EC5\u9690\u85CF\u300D\u540E\u754C\u9762\u4F1A\u5B8C\u5168\u6D88\u5931\uFF0C\u7528\u8FD9\u4E2A\u5DE5\u5177\u5524\u56DE\u3002",
      parameters: { type: "object", properties: {} },
      output: OUTPUT_SPEC,
      execute: async () => {
        control.note("show", "\u91CD\u65B0\u6253\u5F00\u9762\u677F");
        return { ok: true, shown: true };
      }
    },
    {
      name: "vdesk_orphan_sweep",
      description: "\u6E05\u7406\u6240\u6709\u5B64\u513F dshv-* \u865A\u62DF\u684C\u9762\u3002",
      parameters: { type: "object", properties: {} },
      output: OUTPUT_SPEC,
      execute: async () => supervisor.call("desktop.sweep", {})
    },
    {
      name: "vdesk_keyboard",
      description: "\u952E\u76D8\u52A8\u4F5C\uFF1Atype \u5199\u5165\u6587\u672C\uFF1Bpress \u6309\u4E0B\u5355\u952E\uFF08\u5982 Enter/F5/F12\uFF09\uFF1Bhotkey \u7EC4\u5408\u952E\uFF08\u5982 ctrl+s / ctrl+shift+i\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" },
          action: { type: "string", description: "type \u6216 press \u6216 hotkey" },
          text: { type: "string", description: "\u4EC5 type \u7528" },
          key: { type: "string", description: "\u4EC5 press \u7528\uFF0C\u5982 enter/escape/f5/f12" },
          keys: { type: "array", items: { type: "string" }, description: '\u4EC5 hotkey \u7528\uFF0C\u5982 ["ctrl","s"]' },
          repeat: { type: "number" },
          perCharDelayMs: { type: "number" }
        },
        required: ["desktop", "action"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("input.keyboard", p, 3e4)
    },
    {
      name: "vdesk_mouse",
      description: "\u9F20\u6807\u52A8\u4F5C\uFF1Amove/click/double_click/right_click/middle_click/drag/scroll\u3002\u5750\u6807\u4E3A\u684C\u9762\u7269\u7406\u50CF\u7D20\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" },
          action: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          x2: { type: "number", description: "drag \u7EC8\u70B9 x" },
          y2: { type: "number", description: "drag \u7EC8\u70B9 y" },
          steps: { type: "number" },
          delta: { type: "number", description: "scroll \u6EDA\u52A8\u91CF\uFF0C\u6B63\u4E3A\u5411\u4E0A" }
        },
        required: ["desktop", "action"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("input.mouse", p, 3e4)
    },
    {
      name: "vdesk_zoom",
      description: "\u5BF9\u6307\u5B9A\u684C\u9762\u533A\u57DF\u505A 1x-4x \u653E\u5927\u622A\u56FE\u5E76\u843D\u76D8\uFF0C\u8FD4\u56DE\u56FE\u50CF\u6587\u4EF6\u4FE1\u606F\u3002region=[x,y,w,h] \u4E3A\u684C\u9762\u7269\u7406\u50CF\u7D20\u77E9\u5F62\u3002",
      parameters: {
        type: "object",
        properties: {
          desktop: { type: "string" },
          out: { type: "string", description: "\u8F93\u51FA\u6587\u4EF6\u8DEF\u5F84\uFF08\u5EFA\u8BAE png\uFF09" },
          region: { type: "array", items: { type: "number" }, description: "[x,y,w,h]" },
          scale: { type: "number", description: "1.0-4.0\uFF0C\u9ED8\u8BA4 2.0" },
          fmt: { type: "string", description: "png \u6216 jpeg\uFF0C\u9ED8\u8BA4 png" }
        },
        required: ["desktop", "out", "region"]
      },
      output: OUTPUT_SPEC,
      execute: async (p) => supervisor.call("capture.zoom", p, 3e4)
    }
  ];
}
function registerTools({ ctx, supervisor, control }) {
  try {
    const computerUse = ctx.computerUse;
    if (computerUse && typeof computerUse.register === "function") {
      computerUse.register("vdesktop");
    }
  } catch (e) {
    ctx.logger?.warn?.("[dsh-vdesk] computerUse slot skipped: " + String(e));
  }
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== "function") {
    throw new Error("ctx.tools.register unavailable");
  }
  for (const t of buildTools(supervisor, control)) {
    const run = t.execute;
    if (GATED_TOOLS.has(t.name)) {
      t.execute = async (p) => {
        control.assertCanAct();
        const r = await run(p);
        control.note(t.name.replace(/^vdesk_/, ""), ACTION_DETAIL[t.name]?.(p) ?? "");
        return r;
      };
    } else if (t.name === "vdesk_desktop_create") {
      t.execute = async (p) => {
        const r = await run(p);
        control.attach(String(p?.name ?? ""));
        return r;
      };
    } else if (t.name === "vdesk_desktop_close") {
      t.execute = async (p) => {
        const name2 = String(p?.name ?? "");
        const r = await run(p);
        control.markClosed(name2);
        control.detach();
        try {
          const l = await supervisor.call("desktop.list", {}, 5e3);
          const others = (l?.desktops ?? []).filter((d) => d !== name2);
          if (others.length === 0) await supervisor.call("desktop.sweep", {}, 1e4);
        } catch {
        }
        return r;
      };
    } else if (t.name === "vdesk_desktop_sweep") {
      t.execute = async () => {
        try {
          const l = await supervisor.call("desktop.list", {}, 5e3);
          for (const name2 of l?.desktops ?? []) control.markClosed(name2);
        } catch {
        }
        const r = await run(void 0);
        control.detach();
        return r;
      };
    }
    tools.register(t);
  }
}

// src/control.ts
var PAUSED_CODE = "VDESK_PAUSED";
var REASON_TEXT = {
  user: "\u7528\u6237\u624B\u52A8\u6682\u505C",
  conflict: "\u68C0\u6D4B\u5230\u4EBA\u5DE5\u8F93\u5165\uFF0C\u5DF2\u8BA9\u51FA\u63A7\u5236\u6743",
  stop: "\u7528\u6237\u5DF2\u7EC8\u6B62\u4EFB\u52A1"
};
var VdeskControl = class {
  pauseReason = null;
  lastAction = null;
  startedAt = 0;
  desktop = null;
  /**
   * 已关闭但 OS 侧尚未真正销毁的桌面。
   * sidecar 的 desktop.close 只杀进程、不断句柄，CloseDesktop 会因残留引用
   * 而未生效（desktop.list 仍能看到），直到 desktop.sweep 才消失。
   * 我们清楚自己关掉了谁，所以在这里过滤掉，UI 才能立刻收起。
   */
  closed = /* @__PURE__ */ new Set();
  /** 记录一次 Agent 动作（供右下角状态胶囊显示）。 */
  note(kind, detail = "") {
    this.lastAction = { kind, detail, at: Date.now() };
  }
  /** 新建桌面或重新开始任务时复位闸门。 */
  attach(desktop) {
    this.desktop = desktop;
    this.closed.delete(desktop);
    this.pauseReason = null;
    this.startedAt = Date.now();
    this.note("launch", desktop);
  }
  markClosed(desktop) {
    this.closed.add(desktop);
  }
  /** 关闭桌面后复位；与 snapshot 里的兜底共用，保证面板一定收得起来。 */
  detach() {
    this.desktop = null;
    this.pauseReason = null;
    this.startedAt = 0;
    if (this.lastAction && this.lastAction.kind !== "detach") this.note("detach", "\u684C\u9762\u5DF2\u5173\u95ED");
  }
  /**
   * 让出控制权。优先级：stop > conflict > user。
   * 已是 stop 时任何暂停请求都无效（终止不可撤销）。
   */
  pause(reason) {
    if (this.pauseReason === "stop") return;
    if (this.pauseReason === "conflict" && reason === "user") return;
    this.pauseReason = reason;
    this.note("pause", REASON_TEXT[reason]);
  }
  /** 只有用户显式动作才能走到这里，不存在自动恢复路径。 */
  resume() {
    if (this.pauseReason === "stop") return;
    this.pauseReason = null;
    this.note("resume", "\u7528\u6237\u6062\u590D\u6267\u884C");
  }
  stop() {
    this.pauseReason = "stop";
    this.note("stop", REASON_TEXT.stop);
  }
  get paused() {
    return this.pauseReason !== null;
  }
  get reason() {
    return this.pauseReason;
  }
  /** 工具入口闸门：暂停期间拒绝一切键鼠注入。 */
  assertCanAct() {
    if (this.pauseReason === null) return;
    const err = new Error(
      `${PAUSED_CODE}: ${REASON_TEXT[this.pauseReason]}\u3002Agent \u4E0D\u5F97\u7EE7\u7EED\u6CE8\u5165\u8F93\u5165\uFF1B\u8BF7\u7B49\u5F85\u7528\u6237\u5728\u865A\u62DF\u684C\u9762\u9762\u677F\u70B9\u51FB\u300C\u7EE7\u7EED\u300D\uFF0C\u7528 vdesk_screenshot \u89C2\u5BDF\u5F53\u524D\u753B\u9762\u5373\u53EF\u3002`
    );
    err.code = PAUSED_CODE;
    throw err;
  }
  snapshot(desktops) {
    const live = desktops.filter((d) => !this.closed.has(d));
    const orphaned = this.pauseReason !== null && live.length === 0;
    const reason = orphaned ? null : this.pauseReason;
    const phase = reason === "stop" ? "stopped" : reason === "conflict" ? "conflict" : reason === "user" ? "paused" : live.length > 0 ? "running" : "idle";
    return {
      phase,
      paused: reason !== null,
      pauseReason: reason,
      lastAction: this.lastAction,
      desktop: this.desktop ?? (live[0] ?? null),
      desktops: live,
      startedAt: this.startedAt,
      code: reason === null ? null : PAUSED_CODE
    };
  }
};

// src/modelGuard.ts
var TEXT_ONLY_CODE = -32070;
var TEXT_ONLY_MSG = "\u5F53\u524D preset \u4E3A\u7EAF\u6587\u672C\u6A21\u578B\uFF0C\u4E0D\u652F\u6301\u622A\u56FE\uFF1B\u8BF7\u5207\u6362\u5230 deepseek-official/deepseek-flash \u540E\u91CD\u8BD5\u3002";
function attachModelGuard(ctx) {
  const ev = ctx.events ?? ctx;
  ev.on?.("model.before-call", (e) => {
    if (e?.provider === "vdesktop" && e?.capability === "image") {
      if (e?.modelPreset === "local-qwen") {
        const err = new Error(TEXT_ONLY_MSG);
        err.code = TEXT_ONLY_CODE;
        throw err;
      }
    }
  });
}

// src/events.ts
function attachEvents(_ctx) {
}

// src/orphanSweep.ts
async function sweepOnBoot(supervisor, control) {
  try {
    const before = await supervisor.call("desktop.list", {}, 5e3);
    for (const name2 of before?.desktops ?? []) control.markClosed(name2);
    await supervisor.call("desktop.sweep", {});
  } catch {
  }
}

// src/guidance.ts
var GUIDANCE = "vdesktop\uFF1A\u865A\u62DF\u684C\u9762\u63D2\u4EF6\u3002\u652F\u6301\u521B\u5EFA/\u5173\u95ED\u684C\u9762\u3001\u622A\u56FE\u3001\u8F93\u5165\u3001\u70B9\u51FB\u3001\u8BFB\u6587\u672C\u3001\u5B64\u513F\u6E05\u626B\u3002\u622A\u56FE\u8FD4\u56DE\u56FE\u50CF\uFF1B\u7EAF\u6587\u672C preset \u4E0B\u4F1A\u8FD4\u56DE -32070\u3002";

// src/index.ts
var name = "dsh-vdesk";
var inject = ["tools"];
function apply(ctx, raw = {}) {
  const cfg = { ...defaultConfig, ...raw };
  const supervisor = new SidecarSupervisor(cfg);
  const control = new VdeskControl();
  registerTools({ ctx, supervisor, control });
  attachModelGuard(ctx);
  attachEvents(ctx);
  void sweepOnBoot(supervisor, control);
  const frameReady = FrameServer.start({
    supervisor,
    control,
    cfg,
    log: (m) => ctx.logger?.info?.(m)
  }).then((f) => {
    ctx.logger?.info?.(`[dsh-vdesk] frame data plane ready: 127.0.0.1:${f.port}`);
    return f;
  }).catch((e) => {
    ctx.logger?.error?.(`[dsh-vdesk] frame data plane unavailable: ${String(e)}`);
  });
  ctx.effect(() => async () => {
    const frame = await frameReady;
    await Promise.all([frame?.close(), supervisor.shutdown()]);
  });
  ctx.logger?.info?.(
    `[dsh-vdesk] provider=sidecar sidecar=${cfg.sidecarPath} guidance=${GUIDANCE.length}B`
  );
}
var src_default = Object.assign(apply, { inject });
export {
  apply,
  src_default as default,
  inject,
  name
};
//# sourceMappingURL=index.js.map
