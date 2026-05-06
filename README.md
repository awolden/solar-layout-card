# Solar Layout Card

A custom Lovelace card for [Home Assistant](https://www.home-assistant.io/) that renders a heat-mapped, true-to-roof layout of an [Enphase](https://enphase.com/) microinverter system. Live per-panel power, daily-energy mode, time-travel slider, pan/zoom.

```
[ screenshot here — drop the PNG into docs/screenshots/ once you have one ]
```

## Why

The official Enphase HA integration gives you per-microinverter `sensor.inverter_<serial>` entities — but they're flat, anonymous, and you have no idea which serial sits in which corner of the roof. The Enlighten app shows a panel layout, but it's locked in a phone app and doesn't tie back to your dashboards.

This card asks you to paste the same layout JSON that Enlighten already serves to your browser, then heat-maps it onto a clickable, scrollable, zoomable canvas in HA — using the entities your existing Enphase integration already exposes.

## Requirements

- Home Assistant **2024.4** or later
- The official [Enphase Envoy](https://www.home-assistant.io/integrations/enphase_envoy/) integration, configured and producing per-microinverter entities (`sensor.inverter_<serial>`)
- Optional but recommended: enable the per-inverter `*_energy_production_today` entities in HA's Entities settings — required for the **Today · kWh** view

## Install

### HACS (recommended)

Until the card is in the HACS default list:

1. HACS → menu (⋮) → **Custom repositories**
2. URL: `https://github.com/awolden/solar-layout-card` · Type: **Dashboard**
3. Click **Solar Layout** in the list, then **Download**

The Lovelace resource is auto-registered for storage-mode dashboards. No restart needed.

### Manual

1. Download `solar-layout-card.js` from the [latest release](https://github.com/awolden/solar-layout-card/releases)
2. Drop it in `<config>/www/solar-layout-card.js`
3. Add the resource (Settings → Dashboards → menu → Resources):
   - URL: `/local/solar-layout-card.js`
   - Resource type: JavaScript module

## Get your layout JSON

The layout coordinates only live in the Enphase **cloud** (Enlighten). The local Envoy and the v4 developer API don't expose panel positions. You'll grab the JSON from your browser:

1. Sign in to <https://enlighten.enphaseenergy.com/> as the **system owner**
2. Navigate to your system's **Array** view (the page that shows your panels in their physical positions)
3. Open browser **DevTools** (Cmd+Opt+I on macOS, Ctrl+Shift+I on Windows/Linux) → **Network** tab → filter `XHR / Fetch`
4. Reload the page
5. Look for a JSON response containing `arrays`, `modules`, `serial_num`, `azimuth`, etc. (often a request to a path containing `array_layout` or similar)
6. Right-click → Copy → Copy response (or save as JSON)

Paste the body verbatim into the card's `layout:` config — see [Configuration](#configuration). The card accepts the raw Enphase shape; nested `modules[].inverter.serial_num` is read automatically.

More detail and screenshots: [docs/getting-layout-json.md](docs/getting-layout-json.md)

## Configuration

Minimum config:

```yaml
type: custom:solar-layout-card
layout:
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
        # ... rest of your panels
```

Full schema with defaults:

```yaml
type: custom:solar-layout-card

# REQUIRED: Enphase array layout JSON (paste straight from Enlighten)
layout:
  arrays: [...]

# Entity templates — {serial} is replaced with each module's serial_num.
# Defaults match the official Enphase HA integration's entity naming.
inverter_power_entity: "sensor.inverter_{serial}"
inverter_kwh_entity:   "sensor.inverter_{serial}_energy_production_today"

# Total power production / consumption sensors. Auto-detected from
# sensor.envoy_*_current_power_(production|consumption) if left null.
production_entity: null
consumption_entity: null

# Heatmap upper bounds
max_w: 460             # peak inverter watts
max_kwh_per_day: 3.0   # peak per-panel daily energy

# Time-travel slider windows
history_hours: 12      # for "Now · W" mode lookback
history_days: 14       # for "Today · kWh" mode lookback

# Panel rendering tweaks (rarely needed)
panel_short: 100       # short axis in module-frame units
panel_long:  198       # long axis (matches Enphase's ~199-unit row spacing)
gap: 1.5               # hairline visible gap between adjacent panels
```

A working example: [examples/basic.yaml](examples/basic.yaml).

## Features

- **Heat-mapped panels** — white at 0, deep red at peak. Each panel's color is its own current value.
- **Two modes**, toggled in the header:
  - `Now · W` — live power output per panel (~5-min cadence per Enphase microinverter reporting)
  - `Today · kWh` — accumulated energy today, per panel
- **Time-travel slider** — drag back up to 12 hours in `Now` mode (5-min step), up to 14 days in `Today` mode (1-day step)
- **Pan / zoom** the roof canvas with scroll-wheel + click-drag (or pinch + drag on touch)
- **Tap a panel** → opens that inverter's `more-info` dialog with HA's native history graph
- **Auto-fits** to the layout's bounding box — works for any system size from 2 panels to 50+
- **Theme-aware** — uses HA's CSS custom properties; respects light/dark themes
- **Mobile-friendly** — slider gets its own row on narrow screens; bigger touch targets

## Troubleshooting

**Card error: "'layout.arrays' is required"** — you forgot the `layout:` key, or pasted only a sub-tree of the JSON. The top-level object Enphase returns has an `arrays` array; that's what goes under `layout:`.

**Panels are all white / no values** — your inverter entity IDs probably don't match the default `sensor.inverter_{serial}` pattern. Check Developer Tools → States, find one of your inverter sensors, then set `inverter_power_entity:` accordingly.

**Today · kWh mode shows zeros** — the per-inverter `*_energy_production_today` entities are disabled by default in HA. Settings → Devices → your Envoy → bulk-enable them. Until they have a few minutes of data, totals will be 0.

**Layout looks mirrored or rotated** — the array's `azimuth` field controls rotation. Check the JSON you pasted is from your own system. Each `azimuth` value is in compass degrees (180 = south, 270 = west, etc.).

**Per-array gaps are too big or panels overlap** — `panel_short` / `panel_long` defaults assume Enphase's standard module-frame units (≈1 cm per unit, panels ~100×198 units). For unusual layouts, tweak those numbers.

## Contributing

Issues and PRs welcome. The card is a single self-contained JS file with no build step — clone, edit, hard-refresh.

## License

[MIT](LICENSE)
