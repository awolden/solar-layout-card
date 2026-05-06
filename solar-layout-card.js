/*!
 * solar-layout-card
 * A small suite of Lovelace cards for Home Assistant + Enphase microinverter systems.
 * Ships three custom elements:
 *   - <solar-layout-card>  heat-mapped roof layout
 *   - <solar-stats-card>   live chip strip (now / today / month / lifetime / savings)
 *   - <solar-flow-card>    production / consumption / exported flow visualization
 * https://github.com/awolden/solar-layout-card
 * MIT License.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const VERSION = "0.4.0";

const DEFAULTS = {
  inverter_power_entity: "sensor.inverter_{serial}",
  inverter_kwh_entity:   "sensor.inverter_{serial}_energy_production_today",
  production_entity: null,        // auto-detect
  consumption_entity: null,       // auto-detect
  max_w: 460,                     // peak inverter rating, used as heatmap top in "now" mode
  max_kwh_per_day: 3.0,           // heatmap top in "today" mode (typical residential panel)
  history_hours: 12,
  history_days: 14,
  panel_short: 100,               // panel module-frame short axis
  panel_long: 198,                // long axis (matches typical Enphase 199-unit row spacing)
  gap: 1.5,                       // hairline between adjacent panels
};

// ---------- geometry ---------------------------------------------------------
function rot(x, y, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

// Accept the raw Enphase shape (modules with nested {inverter:{serial_num}})
// and return a flat list of {sn, last4, cx, cy, w, h, array}.
function buildPanels(layout, opts) {
  const { panel_short, panel_long } = opts;
  const panels = [];
  for (const arr of layout.arrays || []) {
    const angle = (arr.azimuth ?? 180) - 180;
    const swap = Math.abs(angle) % 180 === 90;
    for (const m of arr.modules || []) {
      const sn = m.sn || m.inverter?.serial_num || m.serial_num;
      if (!sn) continue;
      const [rx, ry] = rot(m.x ?? 0, m.y ?? 0, angle);
      const cx = (arr.x ?? 0) + rx;
      const cy = (arr.y ?? 0) + ry;
      let mw, mh;
      if ((m.rotation ?? 0) === 0) { mw = panel_short; mh = panel_long; }
      else                          { mw = panel_long;  mh = panel_short; }
      const w = swap ? mh : mw;
      const h = swap ? mw : mh;
      panels.push({
        sn: String(sn),
        last4: String(sn).slice(-4),
        cx, cy, w, h,
        array: arr.label ?? "",
      });
    }
  }
  return panels;
}

// ---------- color ramp -------------------------------------------------------
function colorForT(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.0,  [245, 247, 251]],   // near-white
    [0.35, [255, 213, 107]],   // amber
    [0.7,  [255, 138,  76]],   // orange
    [1.0,  [255,  58,  44]],   // red
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function inkFor([r, g, b]) {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? "dark" : "light";
}

// ---------- card -------------------------------------------------------------
class SolarLayoutCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._mode = "now";
    this._viewOffset = 0;
    this._history = { w: Object.create(null), kwh: Object.create(null) };
    this._wFetched = false;
    this._kwhFetched = false;
  }

  static get version() { return VERSION; }

  static getStubConfig() {
    return {
      layout: {
        arrays: [
          {
            label: "Example",
            x: 0, y: 0, azimuth: 180,
            modules: [
              { rotation: 0, x: 0, y: 0,   inverter: { serial_num: "REPLACE_ME_1" } },
              { rotation: 0, x: 100, y: 0, inverter: { serial_num: "REPLACE_ME_2" } },
            ],
          },
        ],
      },
    };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("solar-layout-card: config must be an object");
    }
    if (!config.layout || !Array.isArray(config.layout.arrays) || !config.layout.arrays.length) {
      throw new Error("solar-layout-card: 'layout.arrays' is required (paste your Enphase array JSON)");
    }
    this._config = { ...DEFAULTS, ...config };
    this._panels = buildPanels(this._config.layout, this._config);
    if (!this._panels.length) {
      throw new Error("solar-layout-card: layout has no modules with serial numbers");
    }
    this._tightBBox = this._computeTightBBox();
    this._VB = null;
    // Tear down existing UI so it'll rebuild on next hass set
    this.shadowRoot.innerHTML = "";
    this._stage = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._panels) return;
    if (first || !this._stage) {
      this._resolveEnvoyEntities();
      this._build();
    }
    if (!this._wFetched && this._hass) {
      this._wFetched = true;
      this._fetchWHistory().catch(e => console.error("[solar-layout-card] W history fetch failed", e));
    }
    this._render();
  }

  getCardSize() { return 8; }

  // Try config first, otherwise scan for sensor.envoy_*_current_power_(production|consumption).
  _resolveEnvoyEntities() {
    if (this._config.production_entity && this._config.consumption_entity) return;
    const states = this._hass?.states || {};
    if (!this._config.production_entity) {
      this._config.production_entity = Object.keys(states)
        .find(id => /^sensor\.envoy_[^_]+_current_power_production$/.test(id)) || null;
    }
    if (!this._config.consumption_entity) {
      this._config.consumption_entity = Object.keys(states)
        .find(id => /^sensor\.envoy_[^_]+_current_power_consumption$/.test(id)) || null;
    }
  }

  _powerEntity(sn) {
    return this._config.inverter_power_entity.replace("{serial}", sn);
  }
  _kwhEntity(sn) {
    return this._config.inverter_kwh_entity.replace("{serial}", sn);
  }

  // ---------- bbox ----------------------------------------------------------
  _computeTightBBox() {
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const p of this._panels) {
      xMin = Math.min(xMin, p.cx - p.w / 2);
      yMin = Math.min(yMin, p.cy - p.h / 2);
      xMax = Math.max(xMax, p.cx + p.w / 2);
      yMax = Math.max(yMax, p.cy + p.h / 2);
    }
    return { xMin, yMin, xMax, yMax };
  }

  // ---------- DOM build -----------------------------------------------------
  _build() {
    const bb = this._tightBBox;
    const PAD = 60;
    const VBX = bb.xMin - PAD, VBY = bb.yMin - PAD;
    const VBW = bb.xMax - bb.xMin + 2 * PAD;
    const VBH = bb.yMax - bb.yMin + 2 * PAD;
    this._view = { x: VBX, y: VBY, w: VBW, h: VBH };
    this._VB = { x: VBX, y: VBY, w: VBW, h: VBH };

    const MAX_W = this._config.max_w;
    const MAX_KWH = this._config.max_kwh_per_day;
    const HISTORY_HOURS = this._config.history_hours;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --slc-ink-1: var(--primary-text-color, #f5f7fb);
          --slc-ink-2: var(--secondary-text-color, rgba(255,255,255,0.55));
          --slc-ink-3: rgba(255,255,255,0.2);
          --slc-bg-0: var(--card-background-color, #08090f);
          --slc-bg-stage:
            radial-gradient(circle at 20% 0%, rgba(40,52,90,0.55) 0%, transparent 55%),
            radial-gradient(circle at 100% 100%, rgba(70,30,80,0.4) 0%, transparent 60%),
            linear-gradient(180deg, #11141d 0%, #0a0c14 100%);
          --slc-accent: #ff8a4c;
          --slc-accent-2: #ff3a2c;
          display: block;
        }
        ha-card {
          padding: 16px 18px;
          color: var(--slc-ink-1);
          font-family: var(--paper-font-body1_-_font-family, -apple-system, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif);
          -webkit-font-smoothing: antialiased;
          display: grid;
          grid-template-rows: auto auto auto auto;
          gap: 12px;
          container-type: inline-size;
          container-name: solar;
        }
        header {
          display: flex; justify-content: space-between; align-items: center;
          gap: 16px; flex-wrap: wrap;
        }
        .total .label {
          font-size: 10px; letter-spacing: 0.22em;
          color: var(--slc-ink-3); font-weight: 700; text-transform: uppercase;
        }
        .total .num { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }
        .total .unit { font-size: 14px; color: var(--slc-ink-2); font-weight: 600; margin-left: 4px; }
        .mode-toggle {
          display: inline-flex;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px;
          padding: 3px;
          gap: 2px;
        }
        .mode {
          background: transparent; border: 0;
          color: var(--slc-ink-2); padding: 7px 14px;
          border-radius: 8px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.16em; text-transform: uppercase; cursor: pointer;
          transition: background 0.15s, color 0.15s;
          font-family: inherit;
        }
        .mode:hover { color: var(--slc-ink-1); }
        .mode.active {
          background: linear-gradient(135deg, var(--slc-accent), var(--slc-accent-2));
          color: #1a1010;
          box-shadow: 0 4px 10px rgba(255,90,40,0.25);
        }
        .legend {
          display: flex; align-items: center; gap: 10px;
          font-size: 11px; color: var(--slc-ink-2); font-weight: 600;
        }
        .legend .bar {
          width: 160px; height: 8px; border-radius: 4px;
          background: linear-gradient(90deg, #f5f7fb 0%, #ffd56b 35%, #ff8a4c 70%, #ff3a2c 100%);
        }
        .time-row {
          display: flex; align-items: center; gap: 14px;
          padding: 10px 12px;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 10px;
          flex-wrap: wrap;
        }
        .time-slider-wrap { flex: 1 1 220px; min-width: 0; }
        @container solar (max-width: 620px) {
          .time-row {
            display: grid;
            grid-template-columns: auto 1fr;
            grid-template-areas: "pill readout" "slider slider";
            row-gap: 10px; column-gap: 12px;
          }
          .time-pill    { grid-area: pill; }
          .time-readout { grid-area: readout; min-width: 0; }
          .time-slider-wrap { grid-area: slider; flex: unset; }
        }
        @media (pointer: coarse) {
          input[type=range] { height: 10px; }
          input[type=range]::-webkit-slider-thumb { width: 22px; height: 22px; }
          input[type=range]::-moz-range-thumb    { width: 22px; height: 22px; }
        }
        .time-pill {
          background: linear-gradient(135deg, var(--slc-accent), var(--slc-accent-2));
          border: 0; color: #1a1010;
          font-size: 10px; font-weight: 800; letter-spacing: 0.16em;
          padding: 6px 11px; border-radius: 7px; cursor: pointer;
          flex-shrink: 0; font-family: inherit;
        }
        .time-pill:not(.live) {
          background: rgba(255,255,255,0.06);
          color: var(--slc-ink-2); box-shadow: none;
        }
        input[type=range] {
          width: 100%; height: 6px; -webkit-appearance: none; appearance: none;
          background: linear-gradient(90deg,
            rgba(255,255,255,0.05) 0%, rgba(255,138,76,0.4) 80%, rgba(255,90,40,0.7) 100%);
          border-radius: 3px; outline: none; direction: rtl;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none; width: 16px; height: 16px;
          border-radius: 50%; background: #fff;
          border: 2px solid var(--slc-accent);
          box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: ew-resize;
        }
        input[type=range]::-moz-range-thumb {
          width: 16px; height: 16px; border-radius: 50%; background: #fff;
          border: 2px solid var(--slc-accent);
          box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: ew-resize;
        }
        .time-readout {
          font-size: 12px; font-weight: 700;
          min-width: 130px; text-align: right;
          font-variant-numeric: tabular-nums; flex-shrink: 0;
        }
        .time-readout.historical { color: #ffb273; }
        .stage {
          position: relative;
          border-radius: 14px;
          background: var(--slc-bg-stage);
          border: 1px solid rgba(255,255,255,0.06);
          box-shadow: 0 16px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04);
          overflow: hidden;
          aspect-ratio: ${VBW} / ${VBH};
          width: 100%;
          touch-action: pan-y pan-x;  /* let page scroll on single-finger touch */
        }
        .zoom-hint {
          position: absolute;
          bottom: 10px; left: 50%;
          transform: translateX(-50%);
          background: rgba(0,0,0,0.7);
          color: #fff;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 11px;
          letter-spacing: 0.06em;
          font-weight: 600;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.25s ease;
          backdrop-filter: blur(8px);
        }
        .zoom-hint.visible { opacity: 1; }
        .stage svg {
          width: 100%; height: 100%; display: block;
          cursor: grab; user-select: none;
        }
        .stage svg:active { cursor: grabbing; }
        .panel-tile { transition: filter 0.15s ease; }
        .panel-tile:hover { filter: brightness(1.18); }
        .array-label {
          font-weight: 800; font-size: 120px;
          fill: rgba(255,255,255,0.07);
          letter-spacing: 0.05em; pointer-events: none;
        }
        .panel-num {
          font-weight: 800; fill: rgba(0,0,0,0.85);
          paint-order: stroke fill; stroke: rgba(255,255,255,0.2); stroke-width: 0.5;
        }
        .panel-num.dark { fill: #fff; stroke: rgba(0,0,0,0.4); }
        footer {
          display: flex; justify-content: space-between; align-items: center;
          color: var(--slc-ink-3); font-size: 10px;
          letter-spacing: 0.1em; text-transform: uppercase; padding: 0 4px;
        }
        .reset-btn {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.08);
          color: var(--slc-ink-1); padding: 5px 10px; border-radius: 7px;
          font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
          text-transform: uppercase; cursor: pointer;
          font-family: inherit;
        }
        .reset-btn:hover { background: rgba(255,255,255,0.1); }
        .empty {
          padding: 24px; text-align: center; color: var(--slc-ink-2); font-size: 13px;
        }
      </style>
      <ha-card>
        <header>
          <div class="total">
            <div class="label" id="totalLabel">Roof · Now</div>
            <div><span class="num" id="total">—</span><span class="unit" id="totalUnit">W</span></div>
          </div>
          <div class="mode-toggle">
            <button class="mode active" data-mode="now">Now · W</button>
            <button class="mode" data-mode="today">Today · kWh</button>
          </div>
          <div class="legend">
            <span>0</span><div class="bar"></div><span id="legendMax">${MAX_W} W</span>
          </div>
        </header>

        <div class="time-row">
          <button id="liveBtn" class="time-pill live">● LIVE</button>
          <div class="time-slider-wrap">
            <input id="timeSlider" type="range" min="0" max="${HISTORY_HOURS * 60}" step="5" value="0" />
          </div>
          <div class="time-readout" id="timeReadout">now</div>
        </div>

        <div class="stage">
          <svg id="stage" xmlns="${SVG_NS}" viewBox="${VBX} ${VBY} ${VBW} ${VBH}"></svg>
          <div class="zoom-hint" id="zoomHint">⌘ / Ctrl + scroll to zoom</div>
        </div>

        <footer>
          <button class="reset-btn" id="resetBtn">Reset view</button>
          <span style="text-transform:none;letter-spacing:0.04em;">v${VERSION} · ${this._panels.length} panels · ${this._config.layout.arrays.length} arrays</span>
        </footer>
      </ha-card>
    `;

    this._stage = this.shadowRoot.getElementById("stage");
    this._slider = this.shadowRoot.getElementById("timeSlider");
    this._readout = this.shadowRoot.getElementById("timeReadout");
    this._liveBtn = this.shadowRoot.getElementById("liveBtn");
    this._resetBtn = this.shadowRoot.getElementById("resetBtn");
    this._hintEl = this.shadowRoot.getElementById("zoomHint");

    this.shadowRoot.querySelectorAll(".mode").forEach(btn => {
      btn.addEventListener("click", () => {
        this._mode = btn.dataset.mode;
        this.shadowRoot.querySelectorAll(".mode").forEach(b =>
          b.classList.toggle("active", b === btn));
        this._configureSlider();
        if (this._mode === "today" && !this._kwhFetched) {
          this._kwhFetched = true;
          this._fetchKwhHistory().catch(e => console.error("[solar-layout-card] kWh history fetch failed", e));
        }
        this._render();
      });
    });

    this._slider.addEventListener("input", () => {
      this._viewOffset = parseInt(this._slider.value, 10);
      const live = this._viewOffset === 0;
      this._liveBtn.classList.toggle("live", live);
      this._liveBtn.textContent = live
        ? (this._mode === "now" ? "● LIVE" : "● TODAY")
        : "JUMP TO PRESENT";
      this._readout.textContent = this._fmtViewLabel();
      this._readout.classList.toggle("historical", !live);
      this._render();
    });
    this._liveBtn.addEventListener("click", () => {
      this._slider.value = "0";
      this._slider.dispatchEvent(new Event("input"));
    });
    this._resetBtn.addEventListener("click", () => {
      this._view = { ...this._VB };
      this._applyView();
    });

    this._installPanZoom();
    this._configureSlider();
  }

  _installPanZoom() {
    // Wheel zoom requires Ctrl/Cmd modifier so plain scrolling passes through
    // to the page when the mouse is over the canvas.
    this._stage.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) {
        // Show a brief hint that zoom needs the modifier
        this._showHint();
        return;
      }
      e.preventDefault();
      const rect = this._stage.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const sx = this._view.x + (mx / rect.width) * this._view.w;
      const sy = this._view.y + (my / rect.height) * this._view.h;
      const factor = Math.exp(e.deltaY * 0.0018);
      const newW = this._view.w * factor;
      const newH = this._view.h * factor;
      const minW = this._VB.w * 0.05, maxW = this._VB.w * 4;
      if (newW < minW || newW > maxW) return;
      this._view.x = sx - (mx / rect.width) * newW;
      this._view.y = sy - (my / rect.height) * newH;
      this._view.w = newW; this._view.h = newH;
      this._applyView();
    }, { passive: false });

    let dragging = false, lastX = 0, lastY = 0;
    this._stage.addEventListener("mousedown", (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
    });
    const move = (e) => {
      if (!dragging) return;
      const rect = this._stage.getBoundingClientRect();
      const dx = (e.clientX - lastX) / rect.width * this._view.w;
      const dy = (e.clientY - lastY) / rect.height * this._view.h;
      this._view.x -= dx; this._view.y -= dy;
      lastX = e.clientX; lastY = e.clientY;
      this._applyView();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", () => { dragging = false; });

    // Touch: only two-finger pinch interacts with the canvas.
    // Single-finger touchmove must pass through so the page can scroll.
    let touchStart = null;
    this._stage.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const cx = (a.clientX + b.clientX) / 2;
        const cy = (a.clientY + b.clientY) / 2;
        touchStart = { dist, cx, cy, view: { ...this._view } };
      } else {
        touchStart = null;
      }
    }, { passive: true });
    this._stage.addEventListener("touchmove", (e) => {
      if (!touchStart || e.touches.length !== 2) return;
      e.preventDefault();
      const rect = this._stage.getBoundingClientRect();
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const factor = touchStart.dist / dist;
      const newW = touchStart.view.w * factor;
      const newH = touchStart.view.h * factor;
      const minW = this._VB.w * 0.05, maxW = this._VB.w * 4;
      if (newW < minW || newW > maxW) return;
      const mx = touchStart.cx - rect.left, my = touchStart.cy - rect.top;
      const sx = touchStart.view.x + (mx / rect.width) * touchStart.view.w;
      const sy = touchStart.view.y + (my / rect.height) * touchStart.view.h;
      this._view.x = sx - (mx / rect.width) * newW;
      this._view.y = sy - (my / rect.height) * newH;
      this._view.w = newW; this._view.h = newH;
      this._applyView();
    }, { passive: false });
    this._stage.addEventListener("touchend", () => { touchStart = null; });
  }

  _showHint() {
    if (!this._hintEl) return;
    this._hintEl.classList.add("visible");
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this._hintEl?.classList.remove("visible"), 1500);
  }

  _applyView() {
    if (!this._stage) return;
    const v = this._view;
    this._stage.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  }

  _configureSlider() {
    const cfg = this._mode === "now"
      ? { min: 0, max: this._config.history_hours * 60, step: 5 }
      : { min: 0, max: this._config.history_days - 1, step: 1 };
    this._slider.min  = cfg.min;
    this._slider.max  = cfg.max;
    this._slider.step = cfg.step;
    this._slider.value = "0";
    this._viewOffset = 0;
    this._liveBtn.classList.add("live");
    this._liveBtn.textContent = this._mode === "now" ? "● LIVE" : "● TODAY";
    this._readout.textContent = this._fmtViewLabel();
    this._readout.classList.remove("historical");
  }

  _fmtViewLabel() {
    if (this._mode === "now") {
      const min = this._viewOffset;
      if (min === 0) return "now";
      const t = new Date(Date.now() - min * 60 * 1000);
      const hh = t.getHours().toString().padStart(2, "0");
      const mm = t.getMinutes().toString().padStart(2, "0");
      const rel = min < 60 ? `${min}m ago` : `${(min / 60).toFixed(min % 60 === 0 ? 0 : 1)}h ago`;
      return `${hh}:${mm} · ${rel}`;
    } else {
      const days = this._viewOffset;
      if (days === 0) return "today";
      if (days === 1) return "yesterday";
      const d = new Date(); d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - days);
      const dow = d.toLocaleDateString(undefined, { weekday: "short" });
      const md  = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `${dow} ${md} · ${days}d ago`;
    }
  }

  // ---------- state lookup --------------------------------------------------
  _liveStateFor(sn) {
    if (!this._hass) return { w: 0, kwh: 0 };
    const wState = this._hass.states[this._powerEntity(sn)];
    const kState = this._hass.states[this._kwhEntity(sn)];
    let w = wState ? parseFloat(wState.state) : NaN;
    let kwh = kState ? parseFloat(kState.state) : NaN;
    // Normalize units
    if (wState?.attributes?.unit_of_measurement === "kW")  w *= 1000;
    if (kState?.attributes?.unit_of_measurement === "Wh")  kwh /= 1000;
    if (kState?.attributes?.unit_of_measurement === "MWh") kwh *= 1000;
    return {
      w: Number.isNaN(w) ? 0 : w,
      kwh: Number.isNaN(kwh) ? 0 : kwh,
    };
  }

  _lookupHist(sn, key, t) {
    const arr = this._history[key]?.[sn];
    if (!arr || !arr.length) return 0;
    if (t <= arr[0].t) return arr[0].v;
    if (t >= arr[arr.length - 1].t) return arr[arr.length - 1].v;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return arr[lo].v;
  }

  _kwhForDay(sn, daysBack) {
    if (daysBack === 0) return this._liveStateFor(sn).kwh;
    const arr = this._history.kwh[sn];
    if (!arr || !arr.length) return 0;
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const dayStart = today0.getTime() - daysBack * 86400000;
    const dayEnd   = today0.getTime() - (daysBack - 1) * 86400000;
    let max = 0;
    for (const r of arr) {
      if (r.t >= dayStart && r.t < dayEnd && r.v > max) max = r.v;
      else if (r.t >= dayEnd) break;
    }
    return max;
  }

  _viewStateFor(sn) {
    if (this._mode === "now") {
      if (this._viewOffset === 0) return this._liveStateFor(sn);
      const t = Date.now() - this._viewOffset * 60 * 1000;
      return { w: this._lookupHist(sn, "w", t), kwh: 0 };
    }
    return { w: 0, kwh: this._kwhForDay(sn, this._viewOffset) };
  }

  // ---------- history fetch -------------------------------------------------
  async _fetchHistoryFor(key, entityIds, startISO, opts = {}) {
    const result = await this._hass.callWS({
      type: "history/history_during_period",
      start_time: startISO,
      entity_ids: entityIds,
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: opts.significantOnly ?? false,
    });
    const unitFor = sn => this._hass.states[
      key === "w" ? this._powerEntity(sn) : this._kwhEntity(sn)
    ]?.attributes?.unit_of_measurement;
    for (const [eid, rows] of Object.entries(result)) {
      let sn = null;
      for (const p of this._panels) {
        const want = key === "w" ? this._powerEntity(p.sn) : this._kwhEntity(p.sn);
        if (eid === want) { sn = p.sn; break; }
      }
      if (!sn) continue;
      const unit = unitFor(sn);
      let scale = 1;
      if (key === "w"   && unit === "kW")  scale = 1000;
      if (key === "kwh" && unit === "Wh")  scale = 1 / 1000;
      if (key === "kwh" && unit === "MWh") scale = 1000;
      const series = [];
      for (const r of rows) {
        const v = parseFloat(r.s);
        if (Number.isNaN(v)) continue;
        const t = (r.lu ?? 0) * 1000;
        series.push({ t, v: v * scale });
      }
      series.sort((a, b) => a.t - b.t);
      this._history[key][sn] = series;
    }
  }

  async _fetchWHistory() {
    if (!this._hass) return;
    const start = new Date(Date.now() - this._config.history_hours * 60 * 60 * 1000).toISOString();
    const ents = this._panels.map(p => this._powerEntity(p.sn));
    await this._fetchHistoryFor("w", ents, start);
    this._render();
  }

  async _fetchKwhHistory() {
    if (!this._hass) return;
    const start = new Date(Date.now() - this._config.history_days * 24 * 60 * 60 * 1000).toISOString();
    const ents = this._panels.map(p => this._kwhEntity(p.sn));
    await this._fetchHistoryFor("kwh", ents, start, { significantOnly: true });
    this._render();
  }

  // ---------- render --------------------------------------------------------
  _render() {
    if (!this._stage) return;
    this._stage.innerHTML = "";

    const defs = document.createElementNS(SVG_NS, "defs");
    defs.innerHTML = `
      <filter id="panel-shadow" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.4"/>
      </filter>
      <linearGradient id="panel-sheen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,0.15)"/>
        <stop offset="50%" stop-color="rgba(255,255,255,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0.15)"/>
      </linearGradient>
    `;
    this._stage.appendChild(defs);

    // Array watermarks
    const arrayCentroids = {};
    for (const p of this._panels) {
      const a = arrayCentroids[p.array] = arrayCentroids[p.array] || { sx: 0, sy: 0, n: 0 };
      a.sx += p.cx; a.sy += p.cy; a.n++;
    }
    for (const [label, a] of Object.entries(arrayCentroids)) {
      if (!label) continue;
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", a.sx / a.n);
      t.setAttribute("y", a.sy / a.n);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dominant-baseline", "middle");
      t.setAttribute("class", "array-label");
      t.textContent = label;
      this._stage.appendChild(t);
    }

    const MAX_W   = this._config.max_w;
    const MAX_KWH = this._config.max_kwh_per_day;
    const GAP     = this._config.gap;

    let totalW = 0, totalKwh = 0;
    for (const p of this._panels) {
      const s = this._viewStateFor(p.sn);
      totalW += s.w; totalKwh += s.kwh;
      const t = this._mode === "now" ? (s.w / MAX_W) : (s.kwh / MAX_KWH);
      const rgb = colorForT(t);
      const ink = inkFor(rgb);
      const primary = this._mode === "now"
        ? { val: String(Math.round(s.w)), unit: "W", suffixScale: 0.5 }
        : { val: s.kwh < 10 ? s.kwh.toFixed(1) : Math.round(s.kwh).toString(), unit: "kWh", suffixScale: 0.42 };

      const x = p.cx - p.w / 2 + GAP / 2;
      const y = p.cy - p.h / 2 + GAP / 2;
      const w_ = p.w - GAP, h_ = p.h - GAP;
      const radius = Math.min(w_, h_) * 0.05;

      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("panel-tile");
      g.setAttribute("data-sn", p.sn);
      g.addEventListener("click", () => this._fireMoreInfo(this._powerEntity(p.sn)));
      g.style.cursor = "pointer";

      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", x); rect.setAttribute("y", y);
      rect.setAttribute("width", w_); rect.setAttribute("height", h_);
      rect.setAttribute("rx", radius); rect.setAttribute("ry", radius);
      rect.setAttribute("fill", `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
      rect.setAttribute("stroke", "rgba(0,0,0,0.35)");
      rect.setAttribute("stroke-width", "1");
      rect.setAttribute("filter", "url(#panel-shadow)");
      g.appendChild(rect);

      const sheen = document.createElementNS(SVG_NS, "rect");
      sheen.setAttribute("x", x); sheen.setAttribute("y", y);
      sheen.setAttribute("width", w_); sheen.setAttribute("height", h_);
      sheen.setAttribute("rx", radius); sheen.setAttribute("ry", radius);
      sheen.setAttribute("fill", "url(#panel-sheen)");
      sheen.setAttribute("pointer-events", "none");
      g.appendChild(sheen);

      // Dynamic font sizing fits text within panel width.
      const charWidth = 0.55;
      const charBudget = primary.val.length + 0.4 + primary.suffixScale * (primary.unit.length + 0.4);
      const widthCap = (w_ * 0.86) / (charBudget * charWidth);
      const heightCap = h_ * 0.55;
      const numSize = Math.max(8, Math.min(widthCap, heightCap));

      const pText = document.createElementNS(SVG_NS, "text");
      pText.setAttribute("x", p.cx);
      pText.setAttribute("y", p.cy);
      pText.setAttribute("text-anchor", "middle");
      pText.setAttribute("dominant-baseline", "central");
      pText.setAttribute("class", `panel-num ${ink === "dark" ? "" : "dark"}`);
      pText.setAttribute("font-size", numSize);
      const pVal = document.createElementNS(SVG_NS, "tspan");
      pVal.textContent = primary.val;
      pText.appendChild(pVal);
      const pUnit = document.createElementNS(SVG_NS, "tspan");
      pUnit.textContent = ` ${primary.unit}`;
      pUnit.setAttribute("font-size", numSize * primary.suffixScale);
      pUnit.setAttribute("font-weight", "600");
      pUnit.setAttribute("opacity", "0.7");
      pText.appendChild(pUnit);
      g.appendChild(pText);

      this._stage.appendChild(g);
    }

    const totalEl = this.shadowRoot.getElementById("total");
    const totalUnit = this.shadowRoot.getElementById("totalUnit");
    const totalLabel = this.shadowRoot.getElementById("totalLabel");
    const legendMax = this.shadowRoot.getElementById("legendMax");
    if (this._mode === "now") {
      totalEl.textContent = Math.round(totalW).toLocaleString();
      totalUnit.textContent = "W";
      totalLabel.textContent = this._viewOffset === 0 ? "Roof · Now" : "Roof · Snapshot";
      legendMax.textContent = `${MAX_W} W`;
    } else {
      totalEl.textContent = totalKwh.toFixed(1);
      totalUnit.textContent = "kWh";
      const dayLbl = this._viewOffset === 0
        ? "Today"
        : this._viewOffset === 1 ? "Yesterday" : `${this._viewOffset}d ago`;
      totalLabel.textContent = `Roof · ${dayLbl}`;
      legendMax.textContent = `${MAX_KWH.toFixed(1)} kWh`;
    }
  }

  _fireMoreInfo(entityId) {
    // Canonical path in HA 2023.7+: dispatch a hass-action event.
    this.dispatchEvent(new CustomEvent("hass-action", {
      bubbles: true, composed: true,
      detail: {
        config: { entity: entityId, tap_action: { action: "more-info" } },
        action: "tap",
      },
    }));
  }
}

// ============================================================================
// shared utilities used by stats + flow cards
// ============================================================================

// Find first hass.states entity matching a regex.
function findEnvoyEntity(hass, regex) {
  if (!hass?.states) return null;
  for (const id of Object.keys(hass.states)) if (regex.test(id)) return id;
  return null;
}

// Read entity state, normalize to {value, unit}. Honors common Enphase units.
function readState(hass, entityId, opts = {}) {
  const target = opts.target_unit;  // e.g. "W" or "kWh"
  const s = hass?.states?.[entityId];
  if (!s) return { value: null, unit: null, missing: true };
  const v = parseFloat(s.state);
  if (Number.isNaN(v)) return { value: null, unit: s.attributes?.unit_of_measurement || null, missing: true };
  let value = v;
  const unit = s.attributes?.unit_of_measurement || null;
  if (target === "W") {
    if (unit === "kW") value *= 1000;
    if (unit === "MW") value *= 1_000_000;
  } else if (target === "kWh") {
    if (unit === "Wh")  value /= 1000;
    if (unit === "MWh") value *= 1000;
  }
  return { value, unit: target || unit };
}

// Format a number with smart precision.
function fmtNumber(value, opts = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (opts.fixed != null) return value.toFixed(opts.fixed);
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 100)  return value.toFixed(0);
  if (abs >= 10)   return value.toFixed(1);
  return value.toFixed(2);
}

// Auto-pick a friendly unit/scale for energy: kWh < 1000, otherwise MWh.
function autoScaleEnergy(valueKwh) {
  if (valueKwh == null) return { value: null, unit: "kWh" };
  if (Math.abs(valueKwh) >= 1000) return { value: valueKwh / 1000, unit: "MWh" };
  return { value: valueKwh, unit: "kWh" };
}

// ============================================================================
// solar-stats-card
// Live chip strip. Auto-discovers Envoy stats entities; users can override
// with a custom `metrics:` list of {entity, label?, icon?, unit?, decimals?}.
// ============================================================================

// "pattern" entries are looked up directly in hass.states.
// "value" entries are derived: "consumption", "exported", "imported", "self_consumed".
// "group" tags chips so a divider can be inserted between groups in the strip.
const STATS_AUTO = [
  { key: "now",      group: "live",    label: "Now",      icon: "mdi:solar-power",            color: "#ffb300",
    pattern: /^sensor\.envoy_[^_]+_current_power_production$/, target_unit: "kW", fixed: 2 },
  { key: "house",    group: "live",    label: "House",    icon: "mdi:home-lightning-bolt",    color: "#1e88e5",
    value: "consumption", target_unit: "kW", fixed: 2 },
  { key: "export",   group: "live",    label: "Export",   icon: "mdi:transmission-tower-export", color: "#43a047",
    value: "exported", target_unit: "kW", fixed: 2 },
  { key: "today",    group: "history", label: "Today",    icon: "mdi:weather-sunny",
    pattern: /^sensor\.envoy_[^_]+_energy_production_today$/, target_unit: "kWh", fixed: 1 },
  { key: "seven",    group: "history", label: "7 days",   icon: "mdi:calendar-week",
    pattern: /^sensor\.envoy_[^_]+_energy_production_last_seven_days$/, target_unit: "kWh", fixed: 0 },
  { key: "lifetime", group: "history", label: "Lifetime", icon: "mdi:counter",
    pattern: /^sensor\.envoy_[^_]+_lifetime_energy_production$/, target_unit: "kWh", auto_unit: true },
];

const ENVOY_PROD_PATTERN = /^sensor\.envoy_[^_]+_current_power_production$/;
const ENVOY_CONS_PATTERN = /^sensor\.envoy_[^_]+_current_power_consumption$/;

class SolarStatsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  static getStubConfig() { return {}; }

  setConfig(config) {
    this._config = config || {};
    this._metrics = null;        // resolved on first hass set
    this.shadowRoot.innerHTML = "";
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._metrics) this._resolveMetrics();
    if (!this._built) this._build();
    this._render();
  }

  getCardSize() { return 1; }

  _resolveMetrics() {
    // Auto-detect Envoy production / consumption for derived "value:" metrics.
    this._prodE = this._config.production_entity
      || findEnvoyEntity(this._hass, ENVOY_PROD_PATTERN);
    this._consE = this._config.consumption_entity
      || findEnvoyEntity(this._hass, ENVOY_CONS_PATTERN);

    if (Array.isArray(this._config.metrics) && this._config.metrics.length) {
      this._metrics = this._config.metrics.map(m => ({ ...m, _custom: true }));
      return;
    }
    // Auto-discover defaults
    this._metrics = [];
    for (const def of STATS_AUTO) {
      if (def.pattern) {
        const eid = findEnvoyEntity(this._hass, def.pattern);
        if (eid) this._metrics.push({ ...def, entity: eid });
      } else if (def.value) {
        // Skip derived metric if we don't have the source entities
        if (def.value === "consumption" && this._consE) this._metrics.push({ ...def });
        else if ((def.value === "exported" || def.value === "imported" || def.value === "self_consumed")
                 && this._prodE && this._consE) this._metrics.push({ ...def });
        else if (def.value === "production" && this._prodE) this._metrics.push({ ...def });
      }
    }
  }

  _readMetric(m) {
    if (m.entity) {
      return readState(this._hass, m.entity, { target_unit: m.target_unit || m.unit });
    }
    if (m.value) {
      const prod = this._prodE ? readState(this._hass, this._prodE, { target_unit: "kW" }).value : null;
      const cons = this._consE ? readState(this._hass, this._consE, { target_unit: "kW" }).value : null;
      let v = null;
      if (m.value === "production")    v = prod;
      else if (m.value === "consumption") v = cons;
      else if (m.value === "exported"  && prod != null && cons != null) v = Math.max(0, prod - cons);
      else if (m.value === "imported"  && prod != null && cons != null) v = Math.max(0, cons - prod);
      else if (m.value === "self_consumed" && prod != null && cons != null) v = Math.min(prod, cons);
      return { value: v, unit: m.target_unit || "kW" };
    }
    return { value: null, unit: null, missing: true };
  }

  _entityForMetric(m) {
    if (m.entity) return m.entity;
    if (m.value === "production" || m.value === "exported" || m.value === "self_consumed") return this._prodE;
    if (m.value === "consumption" || m.value === "imported") return this._consE;
    return null;
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          padding: 12px 14px;
          font-family: var(--paper-font-body1_-_font-family, -apple-system, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif);
        }
        .strip {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .chip {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 12px;
          background: var(--ha-card-background, rgba(255,255,255,0.04));
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 999px;
          color: var(--primary-text-color, #fff);
          font-size: 13px;
          line-height: 1.1;
          transition: background 0.15s;
        }
        .chip:hover {
          background: rgba(255,255,255,0.08);
          cursor: pointer;
        }
        .chip ha-icon {
          --mdc-icon-size: 18px;
          color: var(--icon-color, #ffb300);
        }
        .chip .label {
          color: var(--secondary-text-color, rgba(255,255,255,0.55));
          font-weight: 600;
          letter-spacing: 0.04em;
          font-size: 11px;
          text-transform: uppercase;
        }
        .chip .value {
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .chip .unit {
          color: var(--secondary-text-color, rgba(255,255,255,0.55));
          font-size: 11px;
          font-weight: 600;
        }
        .divider {
          width: 1px;
          align-self: stretch;
          background: rgba(255,255,255,0.12);
          margin: 4px 4px;
        }
      </style>
      <ha-card>
        <div class="strip" id="strip"></div>
      </ha-card>
    `;
    this._built = true;
  }

  _render() {
    const strip = this.shadowRoot.getElementById("strip");
    if (!strip) return;
    strip.innerHTML = "";
    if (!this._metrics?.length) {
      strip.innerHTML = `<div class="chip" style="color:var(--secondary-text-color)">No Enphase entities found — set <code>metrics:</code> manually.</div>`;
      return;
    }
    let lastGroup = null;
    for (const m of this._metrics) {
      // Visual divider between groups (e.g. live vs history)
      if (m.group && lastGroup !== null && m.group !== lastGroup) {
        const divider = document.createElement("div");
        divider.className = "divider";
        strip.appendChild(divider);
      }
      if (m.group) lastGroup = m.group;

      const { value, unit } = this._readMetric(m);
      let displayValue = value, displayUnit = unit;
      if (m.auto_unit && unit === "kWh") {
        const scaled = autoScaleEnergy(value);
        displayValue = scaled.value;
        displayUnit = scaled.unit;
      }
      const formatted = fmtNumber(displayValue, { fixed: m.fixed });
      const chip = document.createElement("div");
      chip.className = "chip";
      const iconColor = m.color || (m.key === "lifetime" ? "var(--deep-orange-color, #ff7043)" : "#ffb300");
      chip.innerHTML = `
        <ha-icon icon="${m.icon || "mdi:flash"}" style="--icon-color:${iconColor}"></ha-icon>
        <span class="label">${m.label || ""}</span>
        <span class="value">${formatted}</span>
        <span class="unit">${displayUnit || ""}</span>
      `;
      const linkEntity = this._entityForMetric(m);
      if (linkEntity) chip.addEventListener("click", () => this._fireMoreInfo(linkEntity));
      else chip.style.cursor = "default";
      strip.appendChild(chip);
    }
  }

  _fireMoreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-action", {
      bubbles: true, composed: true,
      detail: {
        config: { entity: entityId, tap_action: { action: "more-info" } },
        action: "tap",
      },
    }));
  }
}

// ============================================================================
// solar-flow-card
// Live header (3 numbers, always live entity state) + 24h SVG flow chart.
// Auto-detects Envoy production/consumption entities; computes "exported"
// client-side as max(0, production - consumption) point-by-point.
// ============================================================================

const FLOW_DEFAULTS = {
  production_entity: null,
  consumption_entity: null,
  history_hours: 24,
  bin_minutes: 5,
  show_stats: true,   // hide the live header (3 numbers) when paired with solar-stats-card
  show_title: true,   // hide the small "Energy Flow · 24h" caption
};

class SolarFlowCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._historyFetched = false;
    this._series = { prod: [], cons: [] };
  }

  static getStubConfig() { return {}; }

  setConfig(config) {
    this._config = { ...FLOW_DEFAULTS, ...(config || {}) };
    this.shadowRoot.innerHTML = "";
    this._built = false;
    this._historyFetched = false;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._resolveEntities();
    if (!this._built) this._build();
    if (!this._historyFetched && this._hass) {
      this._historyFetched = true;
      this._fetchHistory().catch(e => console.error("[solar-flow-card] history fetch failed", e));
    }
    this._render();
  }

  getCardSize() { return 4; }

  _resolveEntities() {
    if (!this._config.production_entity) {
      this._config.production_entity = findEnvoyEntity(
        this._hass, /^sensor\.envoy_[^_]+_current_power_production$/
      );
    }
    if (!this._config.consumption_entity) {
      this._config.consumption_entity = findEnvoyEntity(
        this._hass, /^sensor\.envoy_[^_]+_current_power_consumption$/
      );
    }
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          padding: 14px 16px 12px;
          font-family: var(--paper-font-body1_-_font-family, -apple-system, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif);
          color: var(--primary-text-color, #f5f7fb);
        }
        .title {
          font-size: 11px;
          letter-spacing: 0.18em;
          font-weight: 700;
          color: var(--secondary-text-color, rgba(255,255,255,0.55));
          text-transform: uppercase;
          margin-bottom: 10px;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          margin-bottom: 12px;
        }
        .stat .label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--secondary-text-color, rgba(255,255,255,0.55));
          margin-bottom: 4px;
          display: flex; align-items: center; gap: 6px;
        }
        .stat .label .dot {
          width: 8px; height: 8px; border-radius: 50%;
        }
        .stat .num {
          font-size: 22px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }
        .stat .unit {
          font-size: 12px;
          color: var(--secondary-text-color, rgba(255,255,255,0.55));
          font-weight: 600;
          margin-left: 3px;
        }
        .chart {
          width: 100%;
          height: 200px;
          background: linear-gradient(180deg, rgba(255,255,255,0.02), transparent);
          border-radius: 8px;
          position: relative;
        }
        .chart svg {
          width: 100%; height: 100%; display: block;
        }
        .axis-line { stroke: rgba(255,255,255,0.08); stroke-width: 1; }
        .axis-tick { fill: var(--secondary-text-color, rgba(255,255,255,0.4)); font-size: 10px; font-weight: 600; }
        .empty {
          display: flex; align-items: center; justify-content: center;
          height: 200px;
          color: var(--secondary-text-color);
          font-size: 12px;
        }
      </style>
      <ha-card>
        ${this._config.show_title ? `<div class="title" id="title">Energy Flow · ${this._config.history_hours}h</div>` : ""}
        ${this._config.show_stats ? `
        <div class="stats">
          <div class="stat">
            <div class="label"><span class="dot" style="background:#ffb300"></span>Solar generated</div>
            <span class="num" id="solarVal">—</span><span class="unit">kW</span>
          </div>
          <div class="stat">
            <div class="label"><span class="dot" style="background:#1e88e5"></span>House consumption</div>
            <span class="num" id="consVal">—</span><span class="unit">kW</span>
          </div>
          <div class="stat">
            <div class="label"><span class="dot" style="background:#43a047"></span>Exported to grid</div>
            <span class="num" id="expVal">—</span><span class="unit">kW</span>
          </div>
        </div>
        ` : ""}
        <div class="chart" id="chartWrap">
          <svg id="chart" preserveAspectRatio="none" xmlns="${SVG_NS}"></svg>
        </div>
      </ha-card>
    `;
    this._built = true;
  }

  async _fetchHistory() {
    const ents = [this._config.production_entity, this._config.consumption_entity].filter(Boolean);
    if (!ents.length) return;
    const start = new Date(Date.now() - this._config.history_hours * 60 * 60 * 1000).toISOString();
    const result = await this._hass.callWS({
      type: "history/history_during_period",
      start_time: start,
      entity_ids: ents,
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    const unitFor = id => this._hass.states[id]?.attributes?.unit_of_measurement;
    const toKw = (v, unit) => unit === "W" ? v / 1000 : (unit === "MW" ? v * 1000 : v);
    for (const eid of ents) {
      const rows = result[eid] || [];
      const unit = unitFor(eid);
      const series = [];
      for (const r of rows) {
        const v = parseFloat(r.s);
        if (Number.isNaN(v)) continue;
        series.push({ t: (r.lu ?? 0) * 1000, v: toKw(v, unit) });
      }
      series.sort((a, b) => a.t - b.t);
      if (eid === this._config.production_entity)  this._series.prod = series;
      if (eid === this._config.consumption_entity) this._series.cons = series;
    }
    this._render();
  }

  // Bucket series into bins; for each bin compute aligned prod/cons/export.
  _buildBins() {
    const now = Date.now();
    const start = now - this._config.history_hours * 60 * 60 * 1000;
    const binMs = this._config.bin_minutes * 60 * 1000;
    const nBins = Math.ceil((now - start) / binMs);
    const bins = [];
    for (let i = 0; i < nBins; i++) {
      bins.push({ t0: start + i * binMs, t1: start + (i + 1) * binMs, prodSum: 0, prodN: 0, consSum: 0, consN: 0 });
    }
    function fill(series, sumKey, nKey) {
      for (const s of series) {
        const idx = Math.floor((s.t - start) / binMs);
        if (idx < 0 || idx >= nBins) continue;
        bins[idx][sumKey] += s.v;
        bins[idx][nKey] += 1;
      }
    }
    fill(this._series.prod, "prodSum", "prodN");
    fill(this._series.cons, "consSum", "consN");
    // Forward-fill from last known value if a bin has no samples
    let lastProd = 0, lastCons = 0;
    for (const b of bins) {
      b.prod = b.prodN ? b.prodSum / b.prodN : lastProd;
      b.cons = b.consN ? b.consSum / b.consN : lastCons;
      b.exp  = Math.max(0, b.prod - b.cons);
      lastProd = b.prod; lastCons = b.cons;
    }
    return bins;
  }

  _render() {
    if (!this._built) return;
    // Live header values (only if shown)
    if (this._config.show_stats) {
      const liveProd = readState(this._hass, this._config.production_entity, { target_unit: "kW" });
      const liveCons = readState(this._hass, this._config.consumption_entity, { target_unit: "kW" });
      const liveExp = (liveProd.value != null && liveCons.value != null)
        ? Math.max(0, liveProd.value - liveCons.value)
        : null;
      this.shadowRoot.getElementById("solarVal").textContent = fmtNumber(liveProd.value, { fixed: 2 });
      this.shadowRoot.getElementById("consVal").textContent  = fmtNumber(liveCons.value, { fixed: 2 });
      this.shadowRoot.getElementById("expVal").textContent   = fmtNumber(liveExp, { fixed: 2 });
    }

    // SVG chart
    const svg = this.shadowRoot.getElementById("chart");
    const wrap = this.shadowRoot.getElementById("chartWrap");
    if (!svg || !wrap) return;
    const W = wrap.clientWidth || 600;
    const H = wrap.clientHeight || 200;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";

    if (!this._series.prod.length && !this._series.cons.length) {
      const empty = document.createElementNS(SVG_NS, "text");
      empty.setAttribute("x", W / 2);
      empty.setAttribute("y", H / 2);
      empty.setAttribute("text-anchor", "middle");
      empty.setAttribute("class", "axis-tick");
      empty.textContent = "Loading history…";
      svg.appendChild(empty);
      return;
    }

    const bins = this._buildBins();
    const padL = 32, padR = 8, padT = 10, padB = 18;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    let yMax = 0;
    for (const b of bins) {
      if (b.prod > yMax) yMax = b.prod;
      if (b.cons > yMax) yMax = b.cons;
    }
    yMax = Math.max(yMax, 1);
    yMax = Math.ceil(yMax * 1.15 * 4) / 4;  // pad and snap to 0.25 kW

    const xFor = i => padL + (i / (bins.length - 1)) * innerW;
    const yFor = v => padT + (1 - v / yMax) * innerH;

    // Defs: gradients for each filled area
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.innerHTML = `
      <linearGradient id="solar-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffb300" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#ffb300" stop-opacity="0.05"/>
      </linearGradient>
      <linearGradient id="exp-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#43a047" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#43a047" stop-opacity="0.1"/>
      </linearGradient>
    `;
    svg.appendChild(defs);

    // Axes
    for (const t of [0, 0.5, 1]) {
      const yVal = yMax * (1 - t);
      const y = padT + t * innerH;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", padL); line.setAttribute("x2", W - padR);
      line.setAttribute("y1", y); line.setAttribute("y2", y);
      line.setAttribute("class", "axis-line");
      svg.appendChild(line);
      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("x", padL - 4);
      lbl.setAttribute("y", y + 3);
      lbl.setAttribute("text-anchor", "end");
      lbl.setAttribute("class", "axis-tick");
      lbl.textContent = yVal.toFixed(yVal < 10 ? 1 : 0);
      svg.appendChild(lbl);
    }
    // X-axis time ticks at 0h, -6h, -12h, -18h, -24h (or proportionally for shorter windows)
    const hrs = this._config.history_hours;
    const tickCount = 4;
    for (let k = 0; k <= tickCount; k++) {
      const f = k / tickCount;
      const x = padL + f * innerW;
      const hoursAgo = Math.round(hrs * (1 - f));
      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("x", x);
      lbl.setAttribute("y", H - 4);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("class", "axis-tick");
      lbl.textContent = hoursAgo === 0 ? "now" : `-${hoursAgo}h`;
      svg.appendChild(lbl);
    }

    // Build paths
    const buildLine = (key) => {
      const parts = [];
      for (let i = 0; i < bins.length; i++) {
        const x = xFor(i), y = yFor(bins[i][key]);
        parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
      }
      return parts.join(" ");
    };
    const buildArea = (key) => {
      const top = buildLine(key);
      const x0 = xFor(0), x1 = xFor(bins.length - 1);
      const y0 = padT + innerH;
      return `${top} L${x1.toFixed(1)} ${y0} L${x0.toFixed(1)} ${y0} Z`;
    };

    // Solar generation (filled, amber)
    const prodArea = document.createElementNS(SVG_NS, "path");
    prodArea.setAttribute("d", buildArea("prod"));
    prodArea.setAttribute("fill", "url(#solar-grad)");
    svg.appendChild(prodArea);

    // Exported (filled, green) — only the surplus
    const expArea = document.createElementNS(SVG_NS, "path");
    expArea.setAttribute("d", buildArea("exp"));
    expArea.setAttribute("fill", "url(#exp-grad)");
    svg.appendChild(expArea);

    // Consumption line (blue, no fill)
    const consLine = document.createElementNS(SVG_NS, "path");
    consLine.setAttribute("d", buildLine("cons"));
    consLine.setAttribute("fill", "none");
    consLine.setAttribute("stroke", "#1e88e5");
    consLine.setAttribute("stroke-width", "2");
    consLine.setAttribute("stroke-linejoin", "round");
    consLine.setAttribute("stroke-linecap", "round");
    svg.appendChild(consLine);
  }
}

// ============================================================================
// register all three custom elements
// ============================================================================

customElements.define("solar-layout-card", SolarLayoutCard);
customElements.define("solar-stats-card", SolarStatsCard);
customElements.define("solar-flow-card", SolarFlowCard);

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: "solar-layout-card",
    name: "Solar Layout",
    description: "Heat-mapped roof layout for Enphase microinverter systems. Live W and daily kWh, with time-travel slider and pan/zoom.",
    preview: false,
    documentationURL: "https://github.com/awolden/solar-layout-card",
  },
  {
    type: "solar-stats-card",
    name: "Solar Stats",
    description: "Live Enphase metrics chip strip — now / today / 7-day / lifetime. Auto-discovers entities.",
    preview: false,
    documentationURL: "https://github.com/awolden/solar-layout-card#solar-stats-card",
  },
  {
    type: "solar-flow-card",
    name: "Solar Flow",
    description: "Energy flow visualization — solar generated vs consumption vs exported, 24h chart with live header.",
    preview: false,
    documentationURL: "https://github.com/awolden/solar-layout-card#solar-flow-card",
  }
);

console.info(
  `%c SOLAR-CARDS %c v${VERSION} `,
  "color:#1a1010;background:linear-gradient(135deg,#ff8a4c,#ff3a2c);font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#fff;background:#11141d;font-weight:600;border-radius:0 3px 3px 0;padding:2px 6px"
);
