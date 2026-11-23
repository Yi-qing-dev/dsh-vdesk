"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/client/VDesktopPanel.ts
  var SCALE_MODES = ["contain", "cover", "original"];
  var VDesktopPanel = class {
    constructor(root, opts) {
      __publicField(this, "root");
      __publicField(this, "desktop");
      __publicField(this, "frameUrl");
      __publicField(this, "inputUrl");
      __publicField(this, "scaleMode");
      __publicField(this, "pollMinMs");
      __publicField(this, "running", false);
      __publicField(this, "currentBitmap", null);
      __publicField(this, "frameW", 0);
      __publicField(this, "frameH", 0);
      __publicField(this, "srcW", 0);
      __publicField(this, "srcH", 0);
      __publicField(this, "_resizeTimer", null);
      __publicField(this, "_inFlight", false);
      __publicField(this, "_unavailable", false);
      __publicField(this, "modeBar");
      __publicField(this, "container");
      __publicField(this, "canvas");
      __publicField(this, "ctx");
      __publicField(this, "_ro");
      __publicField(this, "_infoLine");
      __publicField(this, "lastInputStatusTs", 0);
      // b1（大脑 50bee53c19f6 段 A）：双槽状态 + 画面滞后灰点 + 追加模式
      __publicField(this, "statusFrameEl", null);
      __publicField(this, "statusInputEl", null);
      __publicField(this, "lagDotEl", null);
      __publicField(this, "lastOkFrameTs", 0);
      // M5a: cursor overlay
      __publicField(this, "cursorX", -1);
      __publicField(this, "startMenuEl", null);
      __publicField(this, "cursorY", -1);
      __publicField(this, "cursorVisible", false);
      // M7（用户裁决）：完整 Windows 桌面帧（壁纸+任务栏+窗口），默认开；
      // 关闭 = 旧行为（黑底+仅应用窗口，channel=printwindow）
      __publicField(this, "fullDesktop", true);
      __publicField(this, "channelBtn", null);
      __publicField(this, "lagTimer", null);
      // b2（大脑 b1 收口裁决 #7）：dpr 变化（浏览器缩放/跨 DPI）matchMedia 监听
      __publicField(this, "dprMediaQuery", null);
      __publicField(this, "dprListener", null);
      __publicField(this, "paused", false);
      __publicField(this, "pauseOverlay");
      this.root = root;
      this.desktop = opts.desktop;
      this.frameUrl = opts.frameUrl || "/vdesk/frame";
      this.inputUrl = opts.inputUrl || "/vdesk/input";
      this.scaleMode = opts.scaleMode || "contain";
      this.pollMinMs = opts.pollMinMs || 200;
      this._build();
      this._buildStatusPills();
      this._installStartMenuKeys();
      this._watchDpr();
    }
    _build() {
      this.root.innerHTML = "";
      Object.assign(this.root.style, {
        display: "flex",
        flexDirection: "column",
        minWidth: "320px",
        minHeight: "240px"
      });
      const bar = document.createElement("div");
      Object.assign(bar.style, {
        // 工具条由外层工具栏接管（@lws31/dsh-vdesk），这里只保留 DOM 供状态灯挂载
        display: "none",
        gap: "6px",
        padding: "4px",
        borderBottom: "1px solid #333",
        background: "#1b1b1b",
        color: "#ddd",
        font: "12px/1.4 system-ui"
      });
      const mk = (label, val) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.dataset.mode = val;
        Object.assign(b.style, {
          padding: "2px 8px",
          background: "#333",
          color: "#eee",
          border: "1px solid #444",
          borderRadius: "3px",
          cursor: "pointer"
        });
        b.onclick = () => {
          this.setScaleMode(val);
        };
        return b;
      };
      bar.appendChild(mk("\u9002\u5E94\u7A97\u53E3", "contain"));
      bar.appendChild(mk("\u586B\u6EE1", "cover"));
      bar.appendChild(mk("\u539F\u59CB\u5C3A\u5BF8", "original"));
      {
        const cb = document.createElement("button");
        cb.textContent = "\u5B8C\u6574\u684C\u9762";
        Object.assign(cb.style, {
          padding: "2px 8px",
          background: "#4a7",
          color: "#111",
          border: "1px solid #4a7",
          borderRadius: "3px",
          cursor: "pointer",
          marginLeft: "auto"
        });
        cb.onclick = () => {
          this.fullDesktop = !this.fullDesktop;
          cb.style.background = this.fullDesktop ? "#4a7" : "#333";
          cb.style.color = this.fullDesktop ? "#111" : "#eee";
          cb.textContent = this.fullDesktop ? "\u5B8C\u6574\u684C\u9762" : "\u4EC5\u7A97\u53E3";
          void this._fetchOne();
        };
        this.channelBtn = cb;
        bar.appendChild(cb);
      }
      this.modeBar = bar;
      this._infoLine = document.createElement("div");
      this._infoLine.textContent = `desktop=${this.desktop}  frame=${this.frameUrl}  input=${this.inputUrl}  shell \u5DF2\u542F\u7528\uFF08\u53D7 DWM \u9650\u5236\uFF0C\u8868\u9762\u6682\u4E0D\u53EF\u50CF\u7D20\u5316\u5448\u73B0\uFF1B\u4EFB\u52A1\u680F\u4ECD\u53EF\u70B9\u51FB\uFF09\uFF1B\u70B9\u51FB=\u903B\u8F91\u5B9A\u4F4D\uFF08\u5149\u6807\u6682\u4E0D\u6E32\u67D3\uFF09\uFF1B\u952E\u76D8\u8F93\u5165\u8BF7\u7528\u5E95\u90E8\u8F93\u5165\u6846\uFF1B\u753B\u9762\u66F4\u65B0\u53D7 DWM \u51BB\u7ED3\u9650\u5236\uFF0C\u8F93\u5165\u751F\u6548\u4EE5\u72B6\u6001\u706F/readback \u4E3A\u51C6`;
      Object.assign(this._infoLine.style, {
        flex: "0 0 auto",
        display: "none",
        padding: "2px 4px",
        background: "#141414",
        color: "#666",
        font: "10px/1.3 ui-monospace, monospace",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis"
      });
      this.container = document.createElement("div");
      Object.assign(this.container.style, {
        flex: "1 1 auto",
        position: "relative",
        overflow: "hidden",
        background: "#000"
      });
      this.canvas = document.createElement("canvas");
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
        display: "block",
        cursor: "crosshair"
      });
      this.container.appendChild(this.canvas);
      this.pauseOverlay = document.createElement("div");
      Object.assign(this.pauseOverlay.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(58,82,201,0.88)",
        color: "#fff",
        font: '11px/1.6 system-ui, "Segoe UI", sans-serif',
        textAlign: "center",
        padding: "2px 8px",
        pointerEvents: "none",
        zIndex: "30"
      });
      this.pauseOverlay.textContent = "AI \u5DF2\u6682\u505C \xB7 \u70B9\u300C\u7EE7\u7EED\u300D\u8BA9 AI \u63A5\u7740\u505A";
      this.container.appendChild(this.pauseOverlay);
      this.startMenuEl = document.createElement("div");
      this.startMenuEl.id = "vdesk-start-menu";
      Object.assign(this.startMenuEl.style, {
        display: "none",
        position: "absolute",
        left: "8px",
        bottom: "48px",
        minWidth: "240px",
        background: "#202020",
        color: "#eee",
        border: "1px solid #444",
        borderRadius: "6px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.55)",
        padding: "6px",
        font: "12px/1.4 system-ui",
        zIndex: "20"
      });
      this.container.appendChild(this.startMenuEl);
      this._buildStartMenuContent();
      this.ctx = this.canvas.getContext("2d");
      this.root.appendChild(bar);
      this.root.appendChild(this._infoLine);
      this.root.appendChild(this.container);
      this._ro = new ResizeObserver(() => {
        if (this._resizeTimer) clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => this._redrawCurrent(), 100);
      });
      this._ro.observe(this.container);
      this.canvas.addEventListener("click", (e) => {
        e.stopPropagation();
        this._onClick(e);
      });
      this._refreshModeButtons();
    }
    _refreshModeButtons() {
      for (const b of Array.from(this.modeBar.querySelectorAll("button"))) {
        b.style.background = b.dataset.mode === this.scaleMode ? "#4a7" : "#333";
      }
    }
    setScaleMode(mode) {
      if (!SCALE_MODES.includes(mode)) return;
      this.scaleMode = mode;
      this._refreshModeButtons();
      this._redrawCurrent();
    }
    /**
     * 暂停 = AI 不再注入，但**人**仍然可以操作画面。
     * 上一版这里把人一起冻住了（点画面直接 return），接管后什么都干不了。
     */
    setPaused(paused) {
      this.paused = paused;
      this.pauseOverlay.style.display = paused ? "flex" : "none";
      this.canvas.style.cursor = "crosshair";
    }
    get isPaused() {
      return this.paused;
    }
    _buildStatusPills() {
      const wrap = document.createElement("div");
      wrap.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:8px",
        "font:12px system-ui,sans-serif",
        "margin-left:auto"
      ].join(";");
      const dot = document.createElement("span");
      dot.style.cssText = [
        "display:inline-block",
        "width:8px",
        "height:8px",
        "border-radius:50%",
        "background:#666",
        "flex:0 0 auto"
      ].join(";");
      dot.title = "\u753B\u9762\u72B6\u6001";
      const frameEl = document.createElement("span");
      frameEl.textContent = "\u5E27 --";
      frameEl.style.cssText = "color:#8a8a8a;flex:0 0 auto;";
      const inputEl = document.createElement("span");
      inputEl.textContent = "";
      inputEl.style.cssText = "color:#7bbf7b;flex:0 0 auto;min-width:0;";
      wrap.appendChild(dot);
      wrap.appendChild(frameEl);
      wrap.appendChild(inputEl);
      this.modeBar.appendChild(wrap);
      this.lagDotEl = dot;
      this.statusFrameEl = frameEl;
      this.statusInputEl = inputEl;
      this.lagTimer = window.setInterval(() => this._updateLagDot(), 1e3);
    }
    _updateLagDot() {
      if (!this.lagDotEl) return;
      const age = Date.now() - this.lastOkFrameTs;
      if (age < 5e3 && this.lastOkFrameTs > 0) {
        this.lagDotEl.style.background = "#4caf50";
        this.lagDotEl.title = "\u753B\u9762\u5B9E\u65F6";
      } else {
        this.lagDotEl.style.background = "#666";
        this.lagDotEl.title = "\u753B\u9762\u53EF\u80FD\u6EDE\u540E\uFF08DWM \u51BB\u7ED3\u9650\u5236\uFF09";
      }
    }
    start() {
      if (this.running) return;
      this.running = true;
      void this._loop();
    }
    stop() {
      this.running = false;
    }
    destroy() {
      this.stop();
      if (this._ro) this._ro.disconnect();
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      if (this.lagTimer !== null) {
        window.clearInterval(this.lagTimer);
        this.lagTimer = null;
      }
      if (this.dprMediaQuery && this.dprListener) {
        this.dprMediaQuery.removeEventListener("change", this.dprListener);
        this.dprMediaQuery = null;
        this.dprListener = null;
      }
      if (this.currentBitmap && this.currentBitmap.close) this.currentBitmap.close();
      this.currentBitmap = null;
      this.root.innerHTML = "";
    }
    async _loop() {
      while (this.running) {
        const t0 = performance.now();
        await this._fetchOne();
        const dt = performance.now() - t0;
        const wait = Math.max(0, this.pollMinMs - dt);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    async _fetchOne() {
      if (this._inFlight) return;
      this._inFlight = true;
      try {
        const url = this.frameUrl + "?desktop=" + encodeURIComponent(this.desktop) + "&channel=" + (this.fullDesktop ? "desktop" : "printwindow") + "&t=" + Date.now();
        const resp = await fetch(url, { cache: "no-store" });
        if (resp.status === 204) {
          this._unavailable = true;
          this._markUnavailable();
          if (this.statusFrameEl) this.statusFrameEl.textContent = "204 \u89C6\u89C9\u4E0D\u53EF\u7528";
          return;
        }
        if (!resp.ok) {
          if (this.statusFrameEl) this.statusFrameEl.textContent = `\u5E27\u9519\u8BEF HTTP ${resp.status}`;
          this._markUnavailable();
          return;
        }
        this.frameW = parseInt(resp.headers.get("X-Frame-Width") || "0", 10);
        this.frameH = parseInt(resp.headers.get("X-Frame-Height") || "0", 10);
        this.srcW = parseInt(
          resp.headers.get("X-Source-Width") || String(this.frameW),
          10
        );
        this.srcH = parseInt(
          resp.headers.get("X-Source-Height") || String(this.frameH),
          10
        );
        const cxHdr = resp.headers.get("X-Cursor-X");
        const cyHdr = resp.headers.get("X-Cursor-Y");
        const cvHdr = resp.headers.get("X-Cursor-Visible");
        if (cxHdr !== null && cyHdr !== null) {
          this.cursorX = parseInt(cxHdr, 10);
          this.cursorY = parseInt(cyHdr, 10);
          this.cursorVisible = cvHdr === "1";
        } else {
          this.cursorVisible = false;
        }
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);
        if (this.currentBitmap && this.currentBitmap.close) {
          this.currentBitmap.close();
        }
        this.currentBitmap = bmp;
        this._unavailable = false;
        if (this.statusFrameEl) this.statusFrameEl.textContent = `\u5E27 OK ${this.frameW}x${this.frameH}`;
        this.lastOkFrameTs = Date.now();
        this.draw();
      } catch (e) {
        if (this.statusFrameEl) this.statusFrameEl.textContent = `\u5E27\u9519\u8BEF\uFF08\u7F51\u7EDC\uFF09${e instanceof Error ? e.message.slice(0, 40) : ""}`;
      } finally {
        this._inFlight = false;
      }
    }
    /**
     * canvas backing store 同步（大脑 def7b21d60b0 根因修复 H4）：
     * canvas 默认 backing store 为 300x150，若从不按显示尺寸设置，CSS
     * 100%x100% 会把 300x150 拉伸到整个舞台，按 clientWidth 计算的目标
     * 矩形落到越界区域被裁 → 整片黑 + 左上角小残影。凡绘制/覆盖层之前
     * 必须先同步 backing store = container 显示尺寸 × dpr。
     */
    syncCanvasBackingSize() {
      const dpr = window.devicePixelRatio || 1;
      const cw = this.container.clientWidth | 0;
      const ch = this.container.clientHeight | 0;
      if (cw <= 0 || ch <= 0) return;
      const w = Math.max(1, Math.round(cw * dpr));
      const h = Math.max(1, Math.round(ch * dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // b2（大脑 b1 收口裁决 #7）：浏览器缩放/跨 DPI 切换时 devicePixelRatio 变化
    // 不触发 ResizeObserver；用 matchMedia('(resolution: Xdppx)') 监听，
    // 变化时重新注册新 dpr 的监听（旧 mq 只在变化时 fire 一次），
    // 并立即同步 backing store + 重绘当前帧。
    _watchDpr() {
      const setup = () => {
        const dpr = window.devicePixelRatio || 1;
        const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
        const onchange = () => {
          if (this.dprMediaQuery && this.dprListener) {
            this.dprMediaQuery.removeEventListener("change", this.dprListener);
          }
          this.syncCanvasBackingSize();
          this._redrawCurrent();
          setup();
        };
        this.dprMediaQuery = mq;
        this.dprListener = onchange;
        mq.addEventListener("change", onchange);
      };
      setup();
    }
    _markUnavailable() {
      const c = this.canvas;
      const ctx = this.ctx;
      this.syncCanvasBackingSize();
      const dpr = window.devicePixelRatio || 1;
      const Wc = c.width / dpr;
      const Hc = c.height / dpr;
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, Wc, Hc);
      ctx.fillStyle = "#888";
      ctx.font = "14px system-ui";
      ctx.fillText("\u4F1A\u8BDD\u89C6\u89C9\u4E0D\u53EF\u7528\uFF08DWM/\u684C\u9762\u51BB\u7ED3\uFF09", 12, 24);
    }
    _redrawCurrent() {
      if (this.currentBitmap) this._draw();
      else if (this._unavailable) this._markUnavailable();
    }
    _computeScaleOffset(Wc, Hc) {
      const Wd = this.frameW || 1;
      const Hd = this.frameH || 1;
      let scale, ox, oy;
      if (this.scaleMode === "original") {
        scale = 1;
        ox = (Wc - Wd) / 2;
        oy = (Hc - Hd) / 2;
      } else if (this.scaleMode === "cover") {
        scale = Math.max(Wc / Wd, Hc / Hd);
        ox = (Wc - Wd * scale) / 2;
        oy = (Hc - Hd * scale) / 2;
      } else {
        scale = Math.min(Wc / Wd, Hc / Hd);
        ox = (Wc - Wd * scale) / 2;
        oy = (Hc - Hd * scale) / 2;
      }
      return { scale, ox, oy };
    }
    draw() {
      this._draw();
    }
    _draw() {
      this.syncCanvasBackingSize();
      const bmp = this.currentBitmap;
      if (!bmp) return;
      const dpr = window.devicePixelRatio || 1;
      const c = this.canvas;
      const ctx = this.ctx;
      const Wc = c.width / dpr;
      const Hc = c.height / dpr;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, Wc, Hc);
      const { scale, ox, oy } = this._computeScaleOffset(Wc, Hc);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, ox, oy, this.frameW * scale, this.frameH * scale);
      this._drawCursor(ctx, scale, ox, oy);
    }
    _drawCursor(ctx, scale, ox, oy) {
      if (!this.cursorVisible || this.cursorX < 0 || this.cursorY < 0) return;
      if (this.srcW <= 0 || this.srcH <= 0 || this.frameW <= 0 || this.frameH <= 0) return;
      const px = this.cursorX * this.frameW / this.srcW * scale + ox;
      const py = this.cursorY * this.frameH / this.srcH * scale + oy;
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(37,99,235,0.95)";
      ctx.fill();
      ctx.restore();
    }
    _toggleStartMenu() {
      if (!this.startMenuEl) return;
      if (this.startMenuEl.style.display === "block") {
        this._hideStartMenu();
      } else {
        this.startMenuEl.style.display = "block";
        void this._refreshProcessList();
      }
    }
    _hideStartMenu() {
      if (this.startMenuEl) this.startMenuEl.style.display = "none";
    }
    _buildStartMenuContent() {
      const el = this.startMenuEl;
      if (!el) return;
      el.innerHTML = "";
      const mk = (label, onClick) => {
        const b = document.createElement("div");
        b.textContent = label;
        Object.assign(b.style, { padding: "6px 10px", cursor: "pointer", borderRadius: "3px" });
        b.onmouseenter = () => {
          b.style.background = "#2f5f9f";
        };
        b.onmouseleave = () => {
          b.style.background = "";
        };
        b.onclick = (ev) => {
          ev.stopPropagation();
          onClick();
        };
        return b;
      };
      const header = (t) => {
        const h = document.createElement("div");
        h.textContent = t;
        Object.assign(h.style, { padding: "4px 10px", color: "#888", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px" });
        return h;
      };
      el.appendChild(header("\u8FD0\u884C\u4E2D\u7A0B\u5E8F"));
      const list = document.createElement("div");
      list.id = "vdesk-start-menu-procs";
      list.textContent = "\uFF08\u52A0\u8F7D\u4E2D\u2026\uFF09";
      Object.assign(list.style, { padding: "4px 10px", color: "#aaa", fontSize: "11px" });
      el.appendChild(list);
      el.appendChild(header("\u5E38\u7528\u7A0B\u5E8F"));
      el.appendChild(mk("\u8BB0\u4E8B\u672C", () => this._launchExe("C:\\Windows\\System32\\notepad.exe")));
      el.appendChild(mk("\u8D44\u6E90\u7BA1\u7406\u5668", () => this._launchExe("C:\\Windows\\explorer.exe")));
      el.appendChild(mk("\u547D\u4EE4\u63D0\u793A\u7B26", () => this._launchExe("C:\\Windows\\System32\\cmd.exe")));
      el.appendChild(header("\u64CD\u4F5C"));
      el.appendChild(mk("\u5173\u95ED\u6B64\u865A\u62DF\u684C\u9762", () => this._closeDesktop()));
    }
    async _refreshProcessList() {
      const el = this.startMenuEl;
      if (!el) return;
      const listEl = el.querySelector("#vdesk-start-menu-procs");
      if (!listEl) return;
      listEl.textContent = "\uFF08\u52A0\u8F7D\u4E2D\u2026\uFF09";
      try {
        const url = this.frameUrl.replace("/vdesk/frame", "/vdesk/processes");
        const r = await fetch(url + "?desktop=" + encodeURIComponent(this.desktop) + "&t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) {
          listEl.textContent = "\uFF08HTTP " + r.status + "\uFF09";
          return;
        }
        const j = await r.json();
        const procs = Array.isArray(j.processes) ? j.processes : [];
        if (procs.length === 0) {
          listEl.textContent = "\uFF08\u65E0\uFF09";
          return;
        }
        listEl.innerHTML = "";
        for (const p of procs) {
          const item = document.createElement("div");
          Object.assign(item.style, { padding: "6px 10px", cursor: "pointer", borderRadius: "3px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" });
          const label = document.createElement("span");
          const _cnMap = { CabinetWClass: "\u8D44\u6E90\u7BA1\u7406\u5668" };
          const _disp = p.title || _cnMap[p.class || ""] || p.class || "(\u65E0\u6807\u9898)";
          label.textContent = _disp + (p.iconic ? " [\u6700\u5C0F\u5316]" : "");
          label.style.flex = "1";
          label.style.overflow = "hidden";
          label.style.textOverflow = "ellipsis";
          label.style.whiteSpace = "nowrap";
          const xbtn = document.createElement("span");
          xbtn.textContent = "\xD7";
          Object.assign(xbtn.style, { padding: "2px 6px", borderRadius: "3px", color: "#ccc", fontWeight: "bold", cursor: "pointer" });
          xbtn.onmouseenter = () => {
            xbtn.style.background = "#a33";
            xbtn.style.color = "#fff";
          };
          xbtn.onmouseleave = () => {
            xbtn.style.background = "";
            xbtn.style.color = "#ccc";
          };
          xbtn.onclick = (ev) => {
            ev.stopPropagation();
            if (xbtn._busy) return;
            xbtn._busy = true;
            xbtn.style.opacity = "0.4";
            window.setTimeout(() => {
              xbtn._busy = false;
              xbtn.style.opacity = "";
            }, 400);
            void this._closeHwnd(p.hwnd, (p.title || p.class || "hwnd=" + p.hwnd).slice(0, 24));
          };
          item.appendChild(label);
          item.appendChild(xbtn);
          item.onmouseenter = () => {
            item.style.background = "#2f5f9f";
          };
          item.onmouseleave = () => {
            item.style.background = "";
          };
          item.onclick = (ev) => {
            ev.stopPropagation();
            this._activateHwnd(p.hwnd);
          };
          listEl.appendChild(item);
        }
      } catch (e) {
        listEl.textContent = "\uFF08\u9519\u8BEF " + String(e).slice(0, 40) + "\uFF09";
      }
    }
    async _launchExe(exe) {
      try {
        const url = this.frameUrl.replace("/vdesk/frame", "/vdesk/launch");
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ desktop: this.desktop, exe })
        });
        this._hideStartMenu();
      } catch {
      }
    }
    async _closeHwnd(hwnd, label = "\u7A97") {
      const setStatus = (msg, ttlMs) => {
        if (!this.statusInputEl) return;
        this.statusInputEl.textContent = msg;
        window.setTimeout(() => {
          if (this.statusInputEl && this.statusInputEl.textContent === msg) {
            this.statusInputEl.textContent = "";
          }
        }, ttlMs);
      };
      const attempt = (url, timeoutMs) => {
        const ac = new AbortController();
        const timer = window.setTimeout(() => ac.abort(), timeoutMs);
        return (async () => {
          try {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ desktop: this.desktop, hwnd }),
              signal: ac.signal
            });
            if (!r.ok) return { ok: false, timeout: false, status: r.status };
            let j = {};
            try {
              j = await r.json();
            } catch {
            }
            return { ok: j.ok !== false, timeout: false, status: r.status };
          } catch (e) {
            return { ok: false, timeout: e && e.name === "AbortError", status: void 0 };
          } finally {
            window.clearTimeout(timer);
          }
        })();
      };
      let res = await attempt(this.frameUrl.replace("/vdesk/frame", "/vdesk/close_window"), 8e3);
      let viaPort = 0;
      if (!res.ok) {
        try {
          const cur = new URL(this.frameUrl);
          let tried = 0;
          for (let port = 8790; port <= 8799 && tried < 3; port++) {
            if (String(port) === cur.port) continue;
            const altBase = `${cur.protocol}//${cur.hostname}:${port}`;
            const pac = new AbortController();
            const ptimer = window.setTimeout(() => pac.abort(), 1500);
            let alive = false;
            try {
              const pr = await fetch(`${altBase}/vdesk/desktops`, { cache: "no-store", signal: pac.signal });
              alive = pr.ok;
            } catch {
              alive = false;
            } finally {
              window.clearTimeout(ptimer);
            }
            if (!alive) continue;
            tried++;
            const r2 = await attempt(`${altBase}/vdesk/close_window`, 3e3);
            if (r2.ok) {
              res = r2;
              viaPort = port;
              break;
            }
          }
        } catch {
        }
      }
      if (res.ok) {
        setStatus(viaPort ? `\u5DF2\u5173\u95ED ${label}\uFF08\u5907\u7528\u7AEF\u53E3 ${viaPort}\uFF09` : `\u5DF2\u5173\u95ED ${label}`, 3e3);
      } else if (res.timeout) {
        setStatus(`\u5173\u95ED\u5931\u8D25 \u8D85\u65F6(8s)${viaPort ? "" : "\uFF08\u5907\u7528\u7AEF\u53E3\u4EA6\u5931\u8D25\uFF09"}`, 5e3);
      } else {
        setStatus(`\u5173\u95ED\u5931\u8D25 HTTP ${res.status ?? "?"}\uFF08\u5907\u7528\u7AEF\u53E3\u4EA6\u5931\u8D25\uFF09`, 5e3);
      }
      setTimeout(() => {
        void this._refreshProcessList();
      }, 400);
    }
    async _activateHwnd(hwnd) {
      try {
        const url = this.frameUrl.replace("/vdesk/frame", "/vdesk/activate");
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ desktop: this.desktop, hwnd })
        });
        this._hideStartMenu();
      } catch {
      }
    }
    async _closeDesktop() {
      try {
        const url = this.frameUrl.replace("/vdesk/frame", "/vdesk/close_desktop");
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ desktop: this.desktop })
        });
        this._hideStartMenu();
      } catch {
      }
    }
    _installStartMenuKeys() {
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.startMenuEl && this.startMenuEl.style.display !== "none") {
          this._hideStartMenu();
        }
      });
    }
    _onClick(ev) {
      if (!this.currentBitmap) return;
      const rect = this.canvas.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const dpr = window.devicePixelRatio || 1;
      const { scale, ox, oy } = this._computeScaleOffset(
        this.canvas.width / dpr,
        this.canvas.height / dpr
      );
      let fx = (cx - ox) / scale;
      let fy = (cy - oy) / scale;
      fx = Math.max(0, Math.min(this.frameW - 1, fx));
      fy = Math.max(0, Math.min(this.frameH - 1, fy));
      this.cursorX = Math.round(fx * (this.srcW || this.frameW) / (this.frameW || 1));
      this.cursorY = Math.round(fy * (this.srcH || this.frameH) / (this.frameH || 1));
      this.cursorVisible = true;
      this._redrawCurrent();
      const sxHit = fx * (this.srcW || this.frameW) / (this.frameW || 1);
      const syHit = fy * (this.srcH || this.frameH) / (this.frameH || 1);
      if (sxHit < 48 && syHit >= 1030) {
        this._toggleStartMenu();
        return;
      }
      if (this.startMenuEl && this.startMenuEl.style.display !== "none") {
        this._hideStartMenu();
      }
      const payload = {
        desktop: this.desktop,
        kind: "click",
        x: Math.round(fx),
        y: Math.round(fy),
        frameWidth: this.frameW,
        frameHeight: this.frameH,
        srcWidth: this.srcW,
        srcHeight: this.srcH
      };
      const on = ev.button === 2;
      if (on) payload.button = "right";
      fetch(this.inputUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(() => {
      });
    }
  };

  // src/client/uiState.ts
  var ASPECT = 16 / 10;
  var MIN_WIDTH = 360;
  var MAX_WIDTH = 900;
  function defaultSize() {
    let vw = 1280;
    try {
      if (typeof window !== "undefined" && window.innerWidth) vw = window.innerWidth;
    } catch {
    }
    const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(vw * 0.42)));
    return { w, h: Math.round(w / ASPECT) };
  }
  var initialState = {
    phase: "idle",
    view: "hidden",
    exitRequested: false,
    userHidden: false,
    fullscreen: false,
    confirm: false,
    inputOpen: false,
    size: defaultSize(),
    pos: null,
    ballPos: null
  };
  function isActive(phase) {
    return phase !== "idle";
  }
  function reduce(state, event) {
    switch (event.type) {
      case "phase": {
        const phase = event.phase;
        if (!isActive(phase)) {
          return {
            ...state,
            phase,
            view: "hidden",
            exitRequested: false,
            userHidden: false,
            confirm: false,
            inputOpen: false,
            fullscreen: false,
            pos: null,
            ballPos: null,
            size: defaultSize()
          };
        }
        if (state.exitRequested && phase === "stopped") {
          return {
            ...state,
            phase,
            view: "hidden",
            exitRequested: false,
            userHidden: false,
            confirm: false,
            inputOpen: false,
            fullscreen: false,
            ballPos: null
          };
        }
        if (state.userHidden || state.exitRequested) return { ...state, phase };
        const wasLive = state.phase === "running" || state.phase === "paused" || state.phase === "conflict";
        const isLive = phase === "running" || phase === "paused" || phase === "conflict";
        if (!wasLive && isLive) {
          return { ...state, phase, view: "panel" };
        }
        return { ...state, phase };
      }
      case "minimize":
        if (!isActive(state.phase)) return state;
        return { ...state, view: "ball", confirm: false, inputOpen: false, fullscreen: false };
      case "expand":
        if (!isActive(state.phase)) return state;
        return { ...state, view: "panel", userHidden: false };
      case "show":
        if (!isActive(state.phase)) return state;
        return { ...state, view: "panel", userHidden: false, ballPos: null };
      case "toggleFullscreen":
        if (!isActive(state.phase)) return state;
        return { ...state, fullscreen: !state.fullscreen };
      case "requestClose":
        return state.view === "panel" ? { ...state, confirm: true } : state;
      case "confirmHide":
        if (!isActive(state.phase)) return state;
        return { ...state, view: "hidden", userHidden: true, confirm: false, inputOpen: false };
      case "confirmExit":
        return {
          ...state,
          view: "hidden",
          confirm: false,
          inputOpen: false,
          fullscreen: false,
          ballPos: null,
          exitRequested: true,
          userHidden: false
        };
      case "cancelClose":
        return { ...state, confirm: false };
      case "toggleInput":
        if (!isActive(state.phase) || state.view !== "panel") return state;
        return { ...state, inputOpen: !state.inputOpen };
      case "agentActed":
        if (!isActive(state.phase)) return state;
        if (state.userHidden) return state;
        if (state.exitRequested) return { ...state, exitRequested: false, view: "panel" };
        {
          const live = state.phase === "running" || state.phase === "paused" || state.phase === "conflict";
          return live && state.view === "hidden" ? { ...state, view: "panel" } : state;
        }
      case "moveTo":
        return { ...state, pos: event.pos };
      case "moveBall":
        return { ...state, ballPos: event.pos };
      case "resize":
        return { ...state, size: event.size };
      case "resetPlacement":
        return { ...state, pos: null, ballPos: null, size: defaultSize() };
      default:
        return state;
    }
  }

  // src/client/index.ts
  var PORT_BASE = 8790;
  var PORT_COUNT = 10;
  var POLL_MS = 1200;
  async function probePort() {
    for (let i = 0; i < PORT_COUNT; i++) {
      const port = PORT_BASE + i;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/vdesk/state`, {
          cache: "no-store",
          signal: ctrl.signal
        });
        if (r.ok) return port;
      } catch {
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
  async function getState(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/vdesk/state`, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }
  function postControl(port, action) {
    void fetch(`http://127.0.0.1:${port}/vdesk/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    }).catch(() => {
    });
  }
  function prefersDark() {
    try {
      if (document.body?.hasAttribute("data-ds-dark-theme")) return true;
    } catch {
    }
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return true;
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/\d+/g);
      if (m && m.length >= 3) {
        const [r, g, b] = m.map(Number);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.55;
      }
    } catch {
    }
    return false;
  }
  function tokens(dark) {
    return dark ? {
      bg: "#17181b",
      bar: "#1e2024",
      border: "#2c2f36",
      text: "#e8e9ec",
      muted: "#8d9199",
      accent: "#4a9eff",
      danger: "#f2545b",
      ok: "#3ecf8e",
      warn: "#f0b429"
    } : {
      bg: "#ffffff",
      bar: "#f5f6f8",
      border: "#e3e6eb",
      text: "#1b1d21",
      muted: "#6b7280",
      accent: "#2563eb",
      danger: "#dc2626",
      ok: "#059669",
      warn: "#b45309"
    };
  }
  var PHASE_LABEL = {
    idle: "\u7A7A\u95F2",
    running: "\u6267\u884C\u4E2D",
    paused: "\u5DF2\u6682\u505C",
    conflict: "AI \u5DF2\u6682\u505C",
    stopped: "\u5DF2\u505C\u6B62"
  };
  function phaseColor(phase, tk) {
    if (phase === "running") return tk.ok;
    if (phase === "paused") return tk.warn;
    if (phase === "conflict") return tk.accent;
    if (phase === "stopped") return tk.danger;
    return tk.muted;
  }
  function install(loader) {
    loader.load({
      id: "@lws31/dsh-vdesk",
      factory: (require2) => {
        const React = require2("react");
        const h = React.createElement;
        const ReactDOM = (() => {
          try {
            const rd = require2("react-dom");
            return rd && typeof rd.createPortal === "function" ? rd : null;
          } catch {
            return null;
          }
        })();
        const toBody = (node) => ReactDOM && node ? ReactDOM.createPortal(node, document.body) : node;
        return {
          inject: ["slots", "locale"],
          apply(ctx) {
            ctx.effect(
              () => ctx.locale.register("vdesk", {
                zh: {
                  title: "\u865A\u62DF\u684C\u9762",
                  minimize: "\u6536\u6210\u60AC\u6D6E\u7403\uFF08\u4E0D\u505C\u6B62\u4EFB\u52A1\uFF09",
                  close: "\u5173\u95ED\u865A\u62DF\u684C\u9762",
                  closeTitle: "\u5173\u95ED\u865A\u62DF\u684C\u9762",
                  hideOnly: "\u4EC5\u9690\u85CF",
                  exitRun: "\u9000\u51FA\u8FD0\u884C",
                  hideNote: "\u9690\u85CF\u540E\u53EF\u968F\u65F6\u8BA9\u6211\u91CD\u65B0\u6253\u5F00\u3002",
                  exitNote: "\u76F4\u63A5\u7ED3\u675F\uFF0C\u865A\u62DF\u684C\u9762\u4E00\u5E76\u5173\u95ED\uFF0C\u4E0D\u53EF\u6062\u590D\u3002",
                  cancel: "\u53D6\u6D88",
                  fullscreen: "\u5168\u5C4F",
                  restore: "\u8FD8\u539F",
                  send: "\u53D1\u9001",
                  keyboard: "\u4EBA\u5DE5\u6253\u5B57",
                  placeholder: "\u8F93\u5165\u6587\u5B57\u540E\u56DE\u8F66",
                  resume: "\u7EE7\u7EED\u6267\u884C",
                  pause: "\u6682\u505C\u6267\u884C"
                },
                en: {
                  title: "Virtual Desktop",
                  minimize: "Minimize to floating ball",
                  close: "Close virtual desktop",
                  closeTitle: "Close virtual desktop",
                  hideOnly: "Hide only",
                  exitRun: "Exit run",
                  hideNote: "Hidden. Ask me to reopen it anytime.",
                  exitNote: "Ends the task and closes the virtual desktop. Cannot be undone.",
                  cancel: "Cancel",
                  fullscreen: "Fullscreen",
                  restore: "Restore",
                  send: "Send",
                  keyboard: "Type",
                  placeholder: "Manual take-over: type and press Enter",
                  resume: "Resume",
                  pause: "Pause"
                }
              })
            );
            ctx.slots.inject(
              "shell.overlay",
              () => ctx.slots.register(
                { name: "shell.overlay", id: "@lws31/dsh-vdesk", locale: "vdesk" },
                ({ t }) => {
                  const [port, setPort] = React.useState(null);
                  const [remote, setRemote] = React.useState(null);
                  const [ui, setUi] = React.useState(initialState);
                  const [dark, setDark] = React.useState(prefersDark());
                  const [inputText, setInputText] = React.useState("");
                  const [inputOpen, setInputOpen] = React.useState(false);
                  const rootRef = React.useRef(null);
                  const shellRef = React.useRef(null);
                  const panelRef = React.useRef(null);
                  const remoteRef = React.useRef(null);
                  const portRef = React.useRef(null);
                  const touchedAtRef = React.useRef(0);
                  const lastActionRef = React.useRef(0);
                  const conflictSentRef = React.useRef(0);
                  const ballMovedRef = React.useRef(false);
                  remoteRef.current = remote;
                  portRef.current = port;
                  const dispatch = (e) => setUi((s) => reduce(s, e));
                  const touch = () => {
                    touchedAtRef.current = Date.now();
                  };
                  React.useEffect(() => {
                    let stop = false;
                    let timer = null;
                    let resolved = port;
                    const tick = async () => {
                      if (stop) return;
                      if (resolved === null) {
                        resolved = await probePort();
                        if (stop) return;
                        if (resolved !== null) setPort(resolved);
                      }
                      if (resolved !== null) {
                        const s = await getState(resolved);
                        if (stop) return;
                        if (s) setRemote(s);
                      }
                      timer = setTimeout(tick, resolved === null ? 4e3 : POLL_MS);
                    };
                    void tick();
                    return () => {
                      stop = true;
                      if (timer) clearTimeout(timer);
                    };
                  }, [port]);
                  React.useEffect(() => {
                    if (!remote) return;
                    if (remote.phase !== ui.phase) dispatch({ type: "phase", phase: remote.phase });
                  }, [remote?.phase]);
                  React.useEffect(() => {
                    const at = remote?.lastAction?.at ?? 0;
                    if (at > lastActionRef.current) {
                      lastActionRef.current = at;
                      dispatch(remote?.lastAction?.kind === "show" ? { type: "show" } : { type: "agentActed" });
                    }
                  }, [remote?.lastAction?.at]);
                  React.useEffect(() => {
                    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
                    const sync = () => setDark(prefersDark());
                    mq?.addEventListener?.("change", sync);
                    const obs = new MutationObserver(sync);
                    if (document.body) {
                      obs.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
                    }
                    return () => {
                      mq?.removeEventListener?.("change", sync);
                      obs.disconnect();
                    };
                  }, []);
                  React.useEffect(() => {
                    const host = rootRef.current;
                    const desktop = remote?.desktop;
                    if (ui.view !== "panel" || !host || !port || !desktop) return;
                    const mount = document.createElement("div");
                    mount.style.cssText = "position:absolute;inset:0;display:flex;";
                    host.appendChild(mount);
                    const p = new VDesktopPanel(mount, {
                      desktop,
                      frameUrl: `http://127.0.0.1:${port}/vdesk/frame`,
                      inputUrl: `http://127.0.0.1:${port}/vdesk/input`,
                      scaleMode: "contain",
                      pollMinMs: 300
                    });
                    p.start();
                    p.setPaused(!!remoteRef.current?.paused);
                    panelRef.current = p;
                    return () => {
                      p.destroy();
                      panelRef.current = null;
                      if (mount.parentNode === host) host.removeChild(mount);
                    };
                  }, [ui.view, port, remote?.desktop]);
                  React.useEffect(() => {
                    panelRef.current?.setPaused(!!remote?.paused);
                  }, [remote?.paused]);
                  React.useEffect(() => {
                    if (ui.view !== "ball") return;
                    const timer = setInterval(() => {
                      const s = remoteRef.current;
                      if (!s || s.phase === "idle" || s.phase === "stopped") return;
                      const mark = Math.max(s.lastAction?.at ?? 0, s.startedAt ?? 0, touchedAtRef.current);
                      if (Date.now() - mark < 5 * 6e4) return;
                      void fetch(`http://127.0.0.1:${portRef.current}/vdesk/close_desktop`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: s.desktop })
                      }).catch(() => {
                      });
                    }, 15e3);
                    return () => clearInterval(timer);
                  }, [ui.view]);
                  const tk = tokens(dark);
                  const phase = remote?.phase ?? "idle";
                  const desktopName = remote?.desktop ?? "\u865A\u62DF\u684C\u9762";
                  if (ui.view === "hidden") return null;
                  const onEnterSurface = () => {
                    if (!port || phase !== "running") return;
                    if (conflictSentRef.current === remote?.startedAt) return;
                    conflictSentRef.current = remote?.startedAt ?? 0;
                    postControl(port, "conflict");
                  };
                  const sendInput = async () => {
                    const text = inputText;
                    if (!port || !remote?.desktop || !text.trim()) return;
                    setInputText("");
                    await fetch(`http://127.0.0.1:${port}/vdesk/input`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ desktop: remote.desktop, kind: "type", text })
                    }).catch(() => {
                    });
                    touch();
                  };
                  if (ui.view === "ball") {
                    const startBallDrag = (e) => {
                      const sx = e.clientX;
                      const sy = e.clientY;
                      const base = ui.ballPos ?? { x: window.innerWidth - 62, y: window.innerHeight - 62 };
                      let moved = false;
                      ballMovedRef.current = false;
                      const move = (ev) => {
                        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
                        moved = true;
                        ballMovedRef.current = true;
                        dispatch({
                          type: "moveBall",
                          pos: {
                            x: Math.max(4, Math.min(base.x + (ev.clientX - sx), window.innerWidth - 50)),
                            y: Math.max(4, Math.min(base.y + (ev.clientY - sy), window.innerHeight - 50))
                          }
                        });
                      };
                      const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                      e.preventDefault();
                    };
                    return toBody(h(
                      "div",
                      { style: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147483e3 } },
                      h(
                        "style",
                        null,
                        "@keyframes vdesk-ball-pulse{0%,100%{box-shadow:0 5px 14px rgba(58,82,201,.32)}50%{box-shadow:0 5px 20px rgba(58,82,201,.55)}}"
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          title: `${desktopName} \xB7 ${PHASE_LABEL[phase]} \xB7 \u70B9\u51FB\u5C55\u5F00`,
                          onClick: () => {
                            if (ballMovedRef.current) {
                              ballMovedRef.current = false;
                              return;
                            }
                            touch();
                            dispatch({ type: "expand" });
                          },
                          onPointerDown: startBallDrag,
                          style: {
                            position: "fixed",
                            left: ui.ballPos ? ui.ballPos.x : void 0,
                            top: ui.ballPos ? ui.ballPos.y : void 0,
                            right: ui.ballPos ? "auto" : 20,
                            bottom: ui.ballPos ? "auto" : 110,
                            width: 42,
                            height: 42,
                            borderRadius: "50%",
                            border: "none",
                            padding: 0,
                            pointerEvents: "auto",
                            cursor: "pointer",
                            background: "linear-gradient(140deg, #3A52C9 0%, #5C74E0 100%)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            animation: "vdesk-ball-pulse 2.6s ease-in-out infinite",
                            touchAction: "none",
                            opacity: 0.94
                          }
                        },
                        h(
                          "svg",
                          { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none" },
                          h("path", {
                            d: "M4 15.2c3.6 3 9.2 3.4 13-1.4",
                            stroke: "#fff",
                            strokeWidth: 2,
                            strokeLinecap: "round"
                          }),
                          h("circle", { cx: 16.6, cy: 9.2, r: 1.7, fill: "#fff" })
                        )
                      )
                    ));
                  }
                  const iconBtn = (label, title, onClick) => h(
                    "button",
                    {
                      type: "button",
                      title,
                      onClick,
                      style: {
                        background: "transparent",
                        border: "none",
                        color: tk.muted,
                        cursor: "pointer",
                        font: "13px/1 inherit",
                        padding: "3px 5px",
                        borderRadius: 4
                      }
                    },
                    label
                  );
                  const switchEl = (on) => h(
                    "button",
                    {
                      type: "button",
                      role: "switch",
                      "aria-checked": on,
                      title: on ? t("pause") : t("resume"),
                      disabled: phase === "stopped",
                      onClick: () => {
                        if (!port || phase === "stopped") return;
                        touch();
                        postControl(port, on ? "pause" : "resume");
                      },
                      style: {
                        width: 34,
                        height: 18,
                        borderRadius: 9,
                        border: "none",
                        padding: 0,
                        position: "relative",
                        cursor: phase === "stopped" ? "default" : "pointer",
                        background: phase === "stopped" ? "#555b66" : on ? "#3A52C9" : "#8a8f99",
                        opacity: phase === "stopped" ? 0.45 : 1,
                        transition: "background .18s",
                        flex: "0 0 auto"
                      }
                    },
                    h("span", {
                      style: {
                        position: "absolute",
                        top: 2,
                        left: on ? 18 : 2,
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        background: "#fff",
                        transition: "left .18s"
                      }
                    })
                  );
                  const beginResize = (e, hx, hy) => {
                    const sx = e.clientX;
                    const sy = e.clientY;
                    const sw = ui.size.w;
                    const sp = ui.pos ?? { x: window.innerWidth - 20 - sw, y: window.innerHeight - 20 - ui.size.h };
                    const maxW = () => Math.min(window.innerWidth - 40, (window.innerHeight - 100) * ASPECT);
                    const move = (ev) => {
                      const delta = ((ev.clientX - sx) * hx + (ev.clientY - sy) * hy * ASPECT) / 2;
                      const w = Math.max(320, Math.min(sw + delta * 2, maxW()));
                      const hh = w / ASPECT;
                      dispatch({ type: "resize", size: { w, h: hh } });
                      if (hx < 0) dispatch({ type: "moveTo", pos: { x: sp.x + (sw - w), y: sp.y + (ui.size.h - hh) } });
                    };
                    const up = () => {
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                    e.preventDefault();
                    e.stopPropagation();
                  };
                  const resizeZones = () => {
                    const z = (style, hx, hy) => h("div", {
                      onPointerDown: (e) => beginResize(e, hx, hy),
                      style: { position: "absolute", pointerEvents: "auto", zIndex: 5, ...style }
                    });
                    return [
                      z({ left: 0, top: 0, width: 6, height: "100%", cursor: "ew-resize" }, -1, 0),
                      z({ right: 0, top: 0, width: 6, height: "100%", cursor: "ew-resize" }, 1, 0),
                      z({ left: 0, top: 0, width: "100%", height: 6, cursor: "ns-resize" }, 0, -1),
                      z({ left: 0, bottom: 0, width: "100%", height: 6, cursor: "ns-resize" }, 0, 1),
                      z({ right: 0, bottom: 0, width: 14, height: 14, cursor: "nwse-resize" }, 1, 1)
                    ];
                  };
                  const panelStyle = ui.fullscreen ? {
                    position: "fixed",
                    top: "max(8px, var(--dsh-frame-chrome-top, 0px))",
                    left: 8,
                    right: 8,
                    bottom: 8,
                    display: "flex",
                    flexDirection: "column",
                    background: tk.bg,
                    border: `1px solid ${tk.border}`,
                    borderRadius: 10,
                    overflow: "hidden",
                    pointerEvents: "auto",
                    color: tk.text,
                    font: '12px/1.45 system-ui, "Segoe UI", sans-serif'
                  } : {
                    position: "fixed",
                    left: ui.pos ? ui.pos.x : void 0,
                    top: ui.pos ? ui.pos.y : void 0,
                    right: ui.pos ? "auto" : 20,
                    bottom: ui.pos ? "auto" : inputOpen ? 90 : 20,
                    boxSizing: "border-box",
                    width: ui.size.w,
                    height: ui.size.h,
                    display: "flex",
                    flexDirection: "column",
                    background: tk.bg,
                    border: `1px solid ${tk.border}`,
                    borderRadius: 10,
                    boxShadow: dark ? "0 12px 32px rgba(0,0,0,0.5)" : "0 12px 32px rgba(15,23,42,0.16)",
                    overflow: "hidden",
                    pointerEvents: "auto",
                    color: tk.text,
                    font: '12px/1.45 system-ui, "Segoe UI", sans-serif'
                  };
                  return toBody(h(
                    "div",
                    { style: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147482e3 } },
                    h(
                      "div",
                      {
                        ref: shellRef,
                        style: panelStyle
                      },
                      // 顶栏
                      h(
                        "div",
                        {
                          onPointerDown: ui.fullscreen ? void 0 : (e) => {
                            const el = shellRef.current;
                            if (!el) return;
                            const rect = el.getBoundingClientRect();
                            const ox = e.clientX - rect.left;
                            const oy = e.clientY - rect.top;
                            const move = (ev) => {
                              dispatch({
                                type: "moveTo",
                                pos: {
                                  x: Math.max(4, Math.min(ev.clientX - ox, window.innerWidth - rect.width - 4)),
                                  y: Math.max(4, Math.min(ev.clientY - oy, window.innerHeight - 80))
                                }
                              });
                            };
                            const up = () => {
                              window.removeEventListener("pointermove", move);
                              window.removeEventListener("pointerup", up);
                            };
                            window.addEventListener("pointermove", move);
                            window.addEventListener("pointerup", up);
                            e.preventDefault();
                          },
                          style: {
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "5px 8px",
                            background: tk.bar,
                            borderBottom: `1px solid ${tk.border}`,
                            cursor: ui.fullscreen ? "default" : "grab",
                            userSelect: "none",
                            flex: "0 0 auto"
                          }
                        },
                        h("span", {
                          style: {
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: phaseColor(phase, tk),
                            flex: "0 0 auto"
                          }
                        }),
                        h(
                          "span",
                          {
                            style: {
                              fontWeight: 600,
                              maxWidth: 140,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap"
                            },
                            title: desktopName
                          },
                          desktopName
                        ),
                        h("span", { style: { color: tk.muted, flex: "0 0 auto" } }, PHASE_LABEL[phase]),
                        h("span", { style: { flex: 1 } }),
                        switchEl(phase === "running"),
                        iconBtn("\u2328", t("keyboard"), () => {
                          touch();
                          setInputOpen((v) => !v);
                        }),
                        iconBtn("\u2212", t("minimize"), () => {
                          touch();
                          setInputOpen(false);
                          dispatch({ type: "minimize" });
                        }),
                        iconBtn(ui.fullscreen ? "\u2750" : "\u25A1", ui.fullscreen ? t("restore") : t("fullscreen"), () => {
                          touch();
                          dispatch({ type: "toggleFullscreen" });
                        }),
                        iconBtn("\u2715", t("close"), () => {
                          touch();
                          dispatch({ type: "requestClose" });
                        })
                      ),
                      // 画面
                      h(
                        "div",
                        {
                          ref: rootRef,
                          onPointerEnter: onEnterSurface,
                          onMouseDown: onEnterSurface,
                          style: {
                            flex: "1 1 auto",
                            minHeight: 0,
                            minWidth: 0,
                            position: "relative",
                            background: "#000"
                          }
                        },
                        ...!ui.fullscreen ? resizeZones() : []
                      )
                    ),
                    // 输入浮层：独立卡片，与主窗隔 8px，宽度跟随
                    inputOpen && h(
                      "div",
                      {
                        style: ui.fullscreen ? {
                          position: "fixed",
                          left: "50%",
                          transform: "translateX(-50%)",
                          bottom: 20,
                          width: 640,
                          display: "flex",
                          gap: 6,
                          background: tk.bg,
                          border: `1px solid ${tk.border}`,
                          borderRadius: 10,
                          boxShadow: dark ? "0 10px 26px rgba(0,0,0,.5)" : "0 10px 26px rgba(15,23,42,.16)",
                          padding: 8,
                          pointerEvents: "auto",
                          zIndex: 2147482500
                        } : {
                          position: "fixed",
                          left: ui.pos ? ui.pos.x : void 0,
                          top: ui.pos ? ui.pos.y + ui.size.h + 8 : void 0,
                          right: ui.pos ? "auto" : 20,
                          bottom: ui.pos ? "auto" : 8,
                          boxSizing: "border-box",
                          width: ui.size.w,
                          display: "flex",
                          gap: 6,
                          background: tk.bg,
                          border: `1px solid ${tk.border}`,
                          borderRadius: 10,
                          boxShadow: dark ? "0 10px 26px rgba(0,0,0,.5)" : "0 10px 26px rgba(15,23,42,.16)",
                          padding: 8,
                          pointerEvents: "auto",
                          zIndex: 2147482500,
                          font: '12px/1.45 system-ui, "Segoe UI", sans-serif'
                        }
                      },
                      h("input", {
                        value: inputText,
                        placeholder: t("placeholder"),
                        autoFocus: true,
                        onChange: (e) => setInputText(e.target.value),
                        onKeyDown: (e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void sendInput();
                          }
                          if (e.key === "Escape") setInputOpen(false);
                        },
                        style: {
                          flex: "1 1 auto",
                          minWidth: 0,
                          background: dark ? "#202226" : "#fff",
                          color: tk.text,
                          border: `1px solid ${tk.border}`,
                          borderRadius: 6,
                          padding: "5px 8px",
                          font: "12px/1.45 inherit",
                          outline: "none"
                        }
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          onClick: () => void sendInput(),
                          style: {
                            flex: "0 0 auto",
                            background: "#3A52C9",
                            color: "#fff",
                            border: "none",
                            borderRadius: 6,
                            padding: "5px 12px",
                            cursor: "pointer",
                            font: "12px/1.45 inherit"
                          }
                        },
                        t("send")
                      )
                    ),
                    // 关闭确认弹窗
                    ui.confirm && h(
                      "div",
                      {
                        style: {
                          position: "fixed",
                          inset: 0,
                          background: "rgba(0,0,0,.45)",
                          pointerEvents: "auto",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          zIndex: 2147484e3
                        },
                        onClick: () => dispatch({ type: "cancelClose" })
                      },
                      h(
                        "div",
                        {
                          onClick: (e) => e.stopPropagation(),
                          style: {
                            width: 340,
                            background: tk.bg,
                            border: `1px solid ${tk.border}`,
                            borderRadius: 12,
                            boxShadow: dark ? "0 16px 40px rgba(0,0,0,.6)" : "0 16px 40px rgba(15,23,42,.2)",
                            padding: 16,
                            color: tk.text,
                            font: '12px/1.55 system-ui, "Segoe UI", sans-serif'
                          }
                        },
                        h("div", { style: { fontWeight: 600, fontSize: 13, marginBottom: 10 } }, t("closeTitle")),
                        h(
                          "button",
                          {
                            type: "button",
                            onClick: () => {
                              touch();
                              setInputOpen(false);
                              dispatch({ type: "confirmHide" });
                            },
                            style: {
                              width: "100%",
                              textAlign: "left",
                              background: dark ? "#202226" : "#f5f6f8",
                              border: `1px solid ${tk.border}`,
                              borderRadius: 8,
                              padding: "8px 10px",
                              cursor: "pointer",
                              color: tk.text,
                              font: "12px/1.55 inherit",
                              marginBottom: 8
                            }
                          },
                          h("div", { style: { fontWeight: 600 } }, t("hideOnly")),
                          h("div", { style: { color: tk.muted } }, t("hideNote"))
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            onClick: () => {
                              touch();
                              setInputOpen(false);
                              dispatch({ type: "confirmExit" });
                              if (port) {
                                postControl(port, "stop");
                                if (remote?.desktop) {
                                  void fetch(`http://127.0.0.1:${port}/vdesk/close_desktop`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ name: remote.desktop })
                                  }).catch(() => {
                                  });
                                }
                              }
                            },
                            style: {
                              width: "100%",
                              textAlign: "left",
                              background: "transparent",
                              border: `1px solid ${tk.danger}`,
                              borderRadius: 8,
                              padding: "8px 10px",
                              cursor: "pointer",
                              color: tk.danger,
                              font: "12px/1.55 inherit",
                              marginBottom: 10
                            }
                          },
                          h("div", { style: { fontWeight: 600 } }, t("exitRun")),
                          h("div", { style: { color: tk.muted } }, t("exitNote"))
                        ),
                        h(
                          "div",
                          { style: { display: "flex", justifyContent: "flex-end" } },
                          h(
                            "button",
                            {
                              type: "button",
                              onClick: () => dispatch({ type: "cancelClose" }),
                              style: {
                                background: "transparent",
                                border: `1px solid ${tk.border}`,
                                color: tk.muted,
                                borderRadius: 6,
                                padding: "4px 12px",
                                cursor: "pointer",
                                font: "12px/1.45 inherit"
                              }
                            },
                            t("cancel")
                          )
                        )
                      )
                    )
                  ));
                }
              )
            );
          }
        };
      }
    });
  }
  if (typeof window !== "undefined" && window.__ModuleLoader__) {
    install(window.__ModuleLoader__);
  }
})();
//# sourceMappingURL=client.js.map
