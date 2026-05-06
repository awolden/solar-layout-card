# Solar Cards

A small suite of Lovelace cards for [Home Assistant](https://www.home-assistant.io/) + [Enphase](https://enphase.com/) microinverter systems. One HACS install registers three custom elements:

- [`solar-layout-card`](#solar-layout-card) — heat-mapped roof layout, time-travel slider
- [`solar-stats-card`](#solar-stats-card) — live chip strip (now / today / 7-day / lifetime)
- [`solar-flow-card`](#solar-flow-card) — production vs consumption vs exported, 24h

```
[ screenshots — drop into docs/screenshots/ ]
```

## Why

Enphase customers usually have the official [Enphase Envoy](https://www.home-assistant.io/integrations/enphase_envoy/) HA integration installed. It exposes per-microinverter and Envoy-level entities, but the dashboard side is left as an exercise. These cards close that gap with zero apex/mushroom dependencies — just install via HACS, point them at your Enphase entities (auto-discovered in most cases), and ship.

## Requirements

- Home Assistant **2024.4** or later
- Official [Enphase Envoy](https://www.home-assistant.io/integrations/enphase_envoy/) integration, configured and producing per-inverter entities (`sensor.inverter_<serial>`)
- Recommended: enable the per-inverter `*_energy_production_today` entities (Settings → Devices → your Envoy → bulk-enable) so `solar-layout-card`'s **Today · kWh** mode has data

## Install

### HACS

1. HACS → menu (⋮) → **Custom repositories**
2. URL: `https://github.com/awolden/solar-layout-card` · Type: **Dashboard**
3. Click **Solar Layout** in the list, then **Download**

The Lovelace resource auto-registers for storage-mode dashboards. No restart.

### Manual

Download `solar-layout-card.js` from the [latest release](https://github.com/awolden/solar-layout-card/releases), drop it in `<config>/www/`, register `/local/solar-layout-card.js` as a JavaScript-module resource.

---

## solar-layout-card

Heat-mapped roof layout. Each panel is colored by its current W output (or today's kWh, toggle in the header). Tap a panel → opens that inverter's history.

### Required: layout JSON

Coordinates only live in Enphase **cloud** (Enlighten). Grab the JSON from the browser:

1. Sign in to <https://enlighten.enphaseenergy.com/> as the system owner
2. Navigate to your system's **Array** view
3. DevTools → **Network** → filter `XHR / Fetch` → reload
4. Find a JSON response with `arrays`, `modules`, `serial_num`, `azimuth` — copy the response body

Full walkthrough: [docs/getting-layout-json.md](docs/getting-layout-json.md)

### Config

```yaml
type: custom:solar-layout-card
layout:
  arrays: [...]   # paste the JSON you captured

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
- **Now** (`sensor.envoy_*_current_power_production`, kW)
- **Today** (`sensor.envoy_*_energy_production_today`, kWh)
- **7 days** (`sensor.envoy_*_energy_production_last_seven_days`, kWh)
- **Lifetime** (`sensor.envoy_*_lifetime_energy_production`, auto-scales kWh ↔ MWh)

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
  - entity: sensor.solar_savings_today
    label: Saved today
    icon: mdi:cash-plus
    color: "#43a047"
  - entity: sensor.solar_savings_this_month
    label: Saved this month
    icon: mdi:cash-multiple
    color: "#43a047"
```

Each metric supports: `entity` (required), `label`, `icon`, `target_unit` (W / kW / Wh / kWh / MWh), `fixed` (decimal places), `auto_unit` (true to auto-scale kWh→MWh), `color` (icon color).

Tap any chip → opens the entity's `more-info` dialog.

Example: [examples/stats-card.yaml](examples/stats-card.yaml)

---

## solar-flow-card

Energy flow at a glance: live header (production / consumption / exported) plus a 24-hour SVG chart showing all three. Production is filled (amber), consumption overlaid as a line (blue), exported is filled green where production exceeds demand.

### Config

```yaml
type: custom:solar-flow-card
# Everything is optional. Auto-detects Envoy entities.
production_entity: null     # auto: sensor.envoy_*_current_power_production
consumption_entity: null    # auto: sensor.envoy_*_current_power_consumption
history_hours: 24           # window
bin_minutes: 5              # aggregation step
```

Header values are live entity states (no averaging gotchas). Chart uses `bin_minutes` averaging for smoothing — exported is computed per-bin as `max(0, prod - cons)` so the math is consistent within the chart.

Example: [examples/flow-card.yaml](examples/flow-card.yaml)

---

## Full dashboard preset

A complete Solar view combining all three cards: [examples/full-dashboard.yaml](examples/full-dashboard.yaml).

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
      - type: custom:solar-layout-card
        layout:
          arrays: [...]   # your JSON
```

## Troubleshooting

**Card error: "'layout.arrays' is required"** — you didn't paste your Enphase JSON, or pasted only a sub-tree. The JSON Enlighten returns has a top-level `arrays` array.

**Stats card says "No Enphase entities found"** — your Envoy entities don't match `sensor.envoy_*_current_power_production`. Set `metrics:` manually with the entity IDs you have.

**Layout panels are all white** — your inverter entity IDs don't match `sensor.inverter_{serial}`. Override `inverter_power_entity:`.

**Today · kWh mode shows zeros** — the per-inverter `*_energy_production_today` entities are disabled by default. Bulk-enable them under Settings → Devices → your Envoy → Entities.

**Layout looks mirrored or rotated** — the `azimuth` field in your JSON controls panel rotation. Re-check what you pasted.

## Contributing

Issues and PRs welcome. Single self-contained JS file, no build step — clone, edit, hard-refresh.

## License

[MIT](LICENSE)
