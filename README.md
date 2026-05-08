# Solar Cards

> Heat-mapped Enphase roof, live stats, and energy-flow chart — three Lovelace cards in one HACS install.

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge&logo=home-assistant)](https://github.com/hacs/integration)
[![GitHub release](https://img.shields.io/github/v/release/awolden/lovelace-enphase-cards?style=for-the-badge)](https://github.com/awolden/lovelace-enphase-cards/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=awolden&repository=lovelace-enphase-cards&category=plugin)

A small suite of Lovelace cards for [Home Assistant](https://www.home-assistant.io/) + [Enphase](https://enphase.com/) microinverter systems. One HACS install registers three custom elements:

| Card | What it shows |
|---|---|
| [`solar-layout-card`](#solar-layout-card) | Heat-mapped roof, panel-by-panel. Time-travel slider. Tap-to-detail. |
| [`solar-stats-card`](#solar-stats-card) | Live chip strip — Now / House / Export / Today / 7-day / Lifetime. |
| [`solar-flow-card`](#solar-flow-card) | 24h flow chart — production vs consumption vs exported. |

![Solar dashboard — stats chips, 24h flow chart, panel layout](docs/screenshots/full-dashboard.png)

<sub>Stats chips on top, 24h flow chart, and roof layout — all three cards in a single Lovelace view. Mobile responsive (stats and flow stack vertically, slider gets its own row, layout panels reflow):</sub>

<p align="center">
  <img src="docs/screenshots/mobile.jpg" alt="Mobile view" width="280" />
</p>

---

## Quick start

1. **Install** the official [Enphase Envoy HA integration](https://www.home-assistant.io/integrations/enphase_envoy/) if you haven't already.
2. **HACS → ⋮ → Custom repositories** → URL `https://github.com/awolden/lovelace-enphase-cards`, Type **Dashboard** → Download.
3. **Grab your roof's panel layout JSON** from Enlighten — see [docs/getting-layout-json.md](docs/getting-layout-json.md). Takes about a minute.
4. **Drop the cards** into a Lovelace view. Minimal, with all three:

   ```yaml
   panel: true
   cards:
     - type: vertical-stack
       cards:
         - type: custom:solar-stats-card
         - type: custom:solar-flow-card
           show_stats: false
           show_title: false
         - type: custom:solar-layout-card
           layout:
             arrays: [...]   # paste your Enlighten JSON here
   ```

   See [examples/full-dashboard.yaml](examples/full-dashboard.yaml) for a copy-pasteable view.

---

## Requirements

- Home Assistant **2024.4** or later
- Official [Enphase Envoy](https://www.home-assistant.io/integrations/enphase_envoy/) integration, configured and producing per-microinverter entities (`sensor.inverter_<serial>`)
- Recommended: enable the per-inverter `*_energy_production_today` entities (Settings → Devices → your Envoy → bulk-enable) — required for `solar-layout-card`'s **Today · kWh** mode

## Install

### HACS (recommended)

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=awolden&repository=lovelace-enphase-cards&category=plugin)

Click the button above (it'll prompt your HA instance to add this repo to HACS as a Dashboard plugin), then **Download**. The Lovelace resource auto-registers for storage-mode dashboards — no restart needed.

Manual route, if the button doesn't work:
1. HACS sidebar → menu (⋮) → **Custom repositories**
2. URL: `https://github.com/awolden/lovelace-enphase-cards` · Type: **Dashboard**
3. Click the entry, then **Download**

### Manual

Download `solar-layout-card.js` from the [latest release](https://github.com/awolden/lovelace-enphase-cards/releases), drop it in `<config>/www/`, register `/local/solar-layout-card.js` as a JavaScript-module resource (Settings → Dashboards → ⋮ → Resources).

---

## solar-layout-card

Heat-mapped roof layout. Each panel is colored by its current W output (or today's kWh — toggle in the header). Tap a panel → opens that inverter's history dialog.

### Required: layout JSON

Coordinates only live in Enphase **cloud** (Enlighten). Grab the JSON from the browser:

**Easy mode — paste this snippet** into the DevTools console while signed into <https://enlighten.enphaseenergy.com>, then navigate to your system's Array view. The snippet auto-detects the layout response and copies it to your clipboard, ready to paste under `arrays:` in the card config:

```js
// docs/devtools-snippet.js — full source in the repo
(()=>{const o=window.fetch;let c=false;window.fetch=async function(...a){const r=await o.apply(this,a);if(c)return r;try{const d=await r.clone().json();if(d?.arrays?.length&&d.arrays[0].modules){c=true;await navigator.clipboard.writeText(JSON.stringify(d.arrays,null,2));console.log("%c✅ Captured solar layout JSON","color:#43a047;font-weight:700;font-size:14px");window.fetch=o;}}catch(_){}return r;};console.log("%c👀 Watching for layout JSON…","color:#1e88e5;font-weight:600");})();
```

The full annotated version is at [`docs/devtools-snippet.js`](docs/devtools-snippet.js); it's tested in [`docs/test-snippet.spec.mjs`](docs/test-snippet.spec.mjs).

**Manual mode**:
1. Sign in to <https://enlighten.enphaseenergy.com/> as the system owner
2. Navigate to your system's **Array** view
3. DevTools → **Network** → filter `XHR / Fetch` → reload
4. Find a JSON response with `arrays`, `modules`, `serial_num`, `azimuth` — copy the response body

Full walkthrough with screenshots: [docs/getting-layout-json.md](docs/getting-layout-json.md)

### Pan / zoom controls (v0.4.0+)

- **Wheel** passes through to page scroll (default)
- **Ctrl/⌘ + wheel** zooms the canvas
- **Click and drag** pans (desktop)
- **Two-finger pinch** zooms, **two-finger drag** pans (touch)
- **Single-finger touch** passes through so mobile scrolling still works
- **Reset view** button bottom-left

### Config

Minimum config — paste your captured `arrays` array directly:

```yaml
type: custom:solar-layout-card
arrays:
  - label: MP1
    x: 183
    y: 357
    azimuth: 270
    modules:
      - rotation: 0
        x: 300
        y: 107
        inverter: { serial_num: "542546078538" }
      # ... rest of your modules
```

(You can also nest the whole Enphase JSON object under `layout:` if you'd rather paste it verbatim — `arrays:` is just a shortcut that skips the wrapper.)

Full schema with defaults:

```yaml
type: custom:solar-layout-card
arrays: [...]                 # required — your captured array layout

# Everything below is optional.
inverter_power_entity: "sensor.inverter_{serial}"
inverter_kwh_entity:   "sensor.inverter_{serial}_energy_production_today"
production_entity: null     # auto: sensor.envoy_*_current_power_production
consumption_entity: null
max_w: 460                  # peak inverter watts (heatmap top)
max_kwh_per_day: 3.0        # peak per-panel daily kWh
history_hours: 12           # "Now" slider lookback
history_days: 14            # "Today" slider lookback
panel_short: 100            # short axis in module-frame units
panel_long:  198            # long axis (matches Enphase's ~199-unit row spacing)
gap: 1.5                    # hairline gap between adjacent panels
```

Working example: [examples/basic-layout.yaml](examples/basic-layout.yaml)

---

## solar-stats-card

Live chip strip. Auto-discovers Envoy entities; falls back to a manual `metrics:` list if you want custom values.

### Default behavior — zero config

```yaml
type: custom:solar-stats-card
```

Auto-discovers and renders chips for:

**Live group:**
- **Now** (`sensor.envoy_*_current_power_production`, kW)
- **House** (`sensor.envoy_*_current_power_consumption`, kW)
- **Export** (computed: `max(0, production − consumption)`, kW)

**History group:**
- **Today** (`sensor.envoy_*_energy_production_today`, kWh)
- **7 days** (`sensor.envoy_*_energy_production_last_seven_days`, kWh)
- **Lifetime** (`sensor.envoy_*_lifetime_energy_production`, auto-scales kWh ↔ MWh)

A subtle vertical divider separates the two groups. House and Export only appear if both production and consumption sensors are detected. Tap any chip → opens that entity's `more-info` dialog.

### Custom metrics

Override entirely:

```yaml
type: custom:solar-stats-card
metrics:
  - entity: sensor.envoy_482518016187_current_power_production
    label: Solar
    icon: mdi:solar-power
    target_unit: kW
    fixed: 2
    group: live              # chips with the same `group` cluster together;
                             # divider auto-inserts between groups
  - value: exported          # derived: production - consumption
    label: Export
    icon: mdi:transmission-tower-export
    color: "#43a047"
    target_unit: kW
    group: live
  - entity: sensor.envoy_482518016187_lifetime_energy_production
    label: Lifetime
    icon: mdi:counter
    target_unit: kWh
    auto_unit: true          # auto-scales kWh → MWh past 1000
    group: history
  - entity: sensor.solar_savings_today
    label: Saved today
    icon: mdi:cash-plus
    color: "#43a047"
    group: history
```

Each metric supports either `entity:` (read state from a specific entity) or `value:` (derived from auto-detected production/consumption: `production`, `consumption`, `exported`, `imported`, `self_consumed`).

Plus: `label`, `icon`, `target_unit` (W / kW / Wh / kWh / MWh), `fixed` (decimal places), `auto_unit` (true to auto-scale kWh→MWh), `color` (icon color), `group` (string used to insert dividers between chip groups).

Example: [examples/stats-card.yaml](examples/stats-card.yaml)

---

## solar-flow-card

Energy flow at a glance: optional live header (production / consumption / exported) plus a 24-hour SVG chart showing all three. Production filled (amber), consumption overlaid as a line (blue), exported filled green where production exceeds demand.

### Config

```yaml
type: custom:solar-flow-card
# Everything is optional. Auto-detects Envoy entities.
production_entity: null     # auto: sensor.envoy_*_current_power_production
consumption_entity: null    # auto: sensor.envoy_*_current_power_consumption
history_hours: 24           # window
bin_minutes: 5              # aggregation step
show_stats: true            # set false to hide the live header (chart only)
show_title: true            # set false to hide the small "Energy Flow · 24h" caption
```

Header values are live entity states (no averaging gotchas). Chart uses `bin_minutes` averaging for smoothing — exported is computed per-bin as `max(0, prod - cons)` so the math is consistent within the chart.

If you're already using `solar-stats-card` (which has its own live `Solar / House / Export` chips by default), pair them and set `show_stats: false` and `show_title: false` on the flow card to avoid duplication. That gives you one row of chips on top and the chart full-width below — see [examples/full-dashboard.yaml](examples/full-dashboard.yaml).

Example: [examples/flow-card.yaml](examples/flow-card.yaml)

---

## Full dashboard preset

A complete Solar view combining all three cards lives at [examples/full-dashboard.yaml](examples/full-dashboard.yaml).

```yaml
title: Solar
path: solar
icon: mdi:solar-power
panel: true
cards:
  - type: vertical-stack
    cards:
      - type: custom:solar-stats-card
      - type: custom:solar-flow-card
        show_stats: false
        show_title: false
      - type: custom:solar-layout-card
        layout:
          arrays: [...]   # your JSON
```

## Troubleshooting

**Card error: "'layout.arrays' is required"** — you didn't paste your Enphase JSON, or you pasted only a sub-tree. The JSON Enlighten returns has a top-level `arrays` array; the whole object goes under `layout:`.

**Stats card says "No Enphase entities found"** — your Envoy entities don't match `sensor.envoy_*_current_power_production`. Either rename them to match or set `metrics:` manually with the entity IDs you have.

**Layout panels are all white / blank** — your inverter entity IDs don't match `sensor.inverter_{serial}`. Override `inverter_power_entity:` with whatever pattern you have (the `{serial}` placeholder is replaced with each module's `serial_num`).

**Today · kWh mode shows zeros on the layout** — the per-inverter `*_energy_production_today` entities are disabled by default in HA. Bulk-enable them under Settings → Devices → your Envoy → Entities. Until they have a few minutes of data, totals will be 0.

**Layout looks mirrored or rotated** — the `azimuth` field in your Enphase JSON drives the rotation. Each value is in compass degrees (180 = south, 270 = west, 90 = east, 0 = north). If a specific array looks wrong, double-check the azimuth Enlighten serves.

**Layout view captures my scroll wheel** — it shouldn't, since v0.4.0. Plain wheel passes through to page scroll; hold **Ctrl/⌘** to zoom. If it's still happening, you may have an older cached copy of the JS — HACS → Solar Layout → Redownload (latest), then hard-refresh the dashboard.

## Versions / changelog

See the [Releases page](https://github.com/awolden/lovelace-enphase-cards/releases) for the full changelog. Highlights:

- **v0.4.0** — `solar-stats-card` group divider; `solar-layout-card` no longer hijacks page scroll (Ctrl/⌘ required for wheel zoom).
- **v0.3.0** — `solar-stats-card` adds live flow chips (House, Export); `solar-flow-card` adds `show_stats` / `show_title` for chart-only embedding.
- **v0.2.0** — bundle adds `solar-stats-card` and `solar-flow-card` alongside the layout card.
- **v0.1.0** — initial release: `solar-layout-card`.

## Contributing

Issues and PRs welcome. Single self-contained JS file, no build step — clone, edit, hard-refresh.

## License

[MIT](LICENSE)
