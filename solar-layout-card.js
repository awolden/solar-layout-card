/*!
 * solar-layout-card
 * Heat-mapped roof layout for Home Assistant + Enphase microinverter systems.
 * https://github.com/awolden/solar-layout-card
 * MIT License.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const VERSION = "0.1.0";

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
        }
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
    this._stage.addEventListener("wheel", (e) => {
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

    // Touch pinch-to-zoom + drag-to-pan
    let touchStart = null;
    this._stage.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        touchStart = { type: "pan", x: e.touches[0].clientX, y: e.touches[0].clientY, view: { ...this._view } };
      } else if (e.touches.length === 2) {
        const [a, b] = e.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const cx = (a.clientX + b.clientX) / 2;
        const cy = (a.clientY + b.clientY) / 2;
        touchStart = { type: "pinch", dist, cx, cy, view: { ...this._view } };
      }
    }, { passive: true });
    this._stage.addEventListener("touchmove", (e) => {
      if (!touchStart) return;
      e.preventDefault();
      const rect = this._stage.getBoundingClientRect();
      if (touchStart.type === "pan" && e.touches.length === 1) {
        const dx = (e.touches[0].clientX - touchStart.x) / rect.width * touchStart.view.w;
        const dy = (e.touches[0].clientY - touchStart.y) / rect.height * touchStart.view.h;
        this._view.x = touchStart.view.x - dx;
        this._view.y = touchStart.view.y - dy;
        this._applyView();
      } else if (touchStart.type === "pinch" && e.touches.length === 2) {
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
      }
    }, { passive: false });
    this._stage.addEventListener("touchend", () => { touchStart = null; });
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

customElements.define("solar-layout-card", SolarLayoutCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "solar-layout-card",
  name: "Solar Layout",
  description: "Heat-mapped roof layout for Enphase microinverter systems. Live W and daily kWh, with time-travel slider and pan/zoom.",
  preview: false,
  documentationURL: "https://github.com/awolden/solar-layout-card",
});

console.info(
  `%c SOLAR-LAYOUT-CARD %c v${VERSION} `,
  "color:#1a1010;background:linear-gradient(135deg,#ff8a4c,#ff3a2c);font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#fff;background:#11141d;font-weight:600;border-radius:0 3px 3px 0;padding:2px 6px"
);
