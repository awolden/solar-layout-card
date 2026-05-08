# Getting your Enphase array layout JSON

This card needs to know which serial sits where on your roof. Enphase only stores that mapping in **Enlighten** (their cloud). Neither the local Envoy nor the v4 Developer API exposes panel positions, so you'll grab the JSON straight from Enlighten's web UI.

## Easy mode (recommended) — one-click bookmarklet

The repo ships a bookmarklet that captures the JSON for you in a single click. No DevTools, no console.

**One-time setup:**
1. Create a new bookmark in your browser, name it **"Solar layout"** (or whatever).
2. For the URL: open [`bookmarklet.txt`](bookmarklet.txt), copy the entire contents (one giant `javascript:…` URL), and paste it as the bookmark's URL. *Tip:* In Chrome, right-click the bookmarks bar → Add page → paste in the URL field.

**Each capture:**
1. Sign in to <https://enlighten.enphaseenergy.com> as the **system owner**.
2. Navigate to your system's **Array** view (URL contains `/web/<system_id>/array`).
3. Click your "Solar layout" bookmark.
4. A panel pops up on the page with the JSON in a textarea + **Copy** and **Download .json** buttons.
5. Paste under `arrays:` in your card config — done.

### How it works

- Reads `system_id` from the page URL (`/web/<id>/array`)
- Tries the known Enlighten layout endpoints, most-specific first:
  - `/pv/systems/<id>/array_layout_x.json`
  - `/pv/systems/<id>/array_layout.json`
  - `/web/<id>/array.json`
- Falls back to scanning the page's loaded resources (Performance API) for any URL that looks like layout-y JSON
- Refetches the matching endpoint with your existing session cookies, validates the response shape (`arrays[].modules[]`)
- Renders an overlay panel inside a Shadow DOM (so Enlighten's CSS doesn't leak in/out) with the formatted JSON

If the bookmarklet shows an error overlay, the URL pattern probably changed in a future Enlighten update — fall through to the manual mode below.

### Plain DevTools paste (alternative)

Don't want to install a bookmark? The same code works as a DevTools console paste:
1. Open DevTools while on the Array view
2. Paste the contents of [`devtools-snippet.js`](devtools-snippet.js)
3. Hit Enter — same overlay appears

## Manual mode

It takes about a minute.

## Step by step

### 1. Open Enlighten

Sign in to <https://enlighten.enphaseenergy.com/> as the **system owner** (homeowner account). Navigate to your system if you have more than one.

### 2. Find the Array view

In the system menu, open the **Array** view — the page that shows your panels in their physical positions on the roof. The path is usually something like:

`https://enlighten.enphaseenergy.com/web/<SYSTEM_ID>/array`

If your account doesn't show this, you may have a view-only / family-member tier. Use the primary owner account.

### 3. Open browser DevTools

- macOS Chrome / Safari: `Cmd + Option + I`
- Windows / Linux: `Ctrl + Shift + I` or `F12`

Click the **Network** tab. Filter by `XHR` (or `Fetch/XHR` in newer Chrome).

### 4. Reload the page

Refresh while DevTools is open so it captures the layout request.

### 5. Find the JSON response

Scroll the network list. You're looking for a response that's pure JSON and contains keys like:

- `system_id`
- `arrays` (an array of array objects)
- `modules` (with `x`, `y`, `azimuth`, `rotation`)
- `inverter` blocks with `serial_num`

The URL path often contains `array_layout`, `panel_layout`, `arrays`, or similar. Click on candidates and check their **Response** / **Preview** tab.

A correct response looks like:

```json
{
  "system_id": 6277207,
  "rotation": 0,
  "dimensions": { "x_min": -26, "x_max": 1120, "y_min": -56, "y_max": 918 },
  "arrays": [
    {
      "array_id": 8950494,
      "label": "MP1",
      "x": 183, "y": 357, "azimuth": 270,
      "modules": [
        {
          "module_id": 99515279,
          "rotation": 0, "x": 300, "y": 107,
          "inverter": { "inverter_id": 123953859, "serial_num": "542546078538" }
        }
      ]
    }
  ]
}
```

### 6. Copy the response

Right-click the request → **Copy** → **Copy response** (Chrome / Edge), or use the **Response** tab and select-all + copy. You now have your layout JSON on the clipboard.

### 7. Paste into the card config

In Lovelace, edit the dashboard YAML and put the response under `layout:`:

```yaml
type: custom:solar-layout-card
layout:
  # paste the entire JSON object here (the bit starting with "system_id":)
  system_id: 6277207
  arrays: [ ... ]
```

YAML accepts the JSON shape directly — you don't need to convert to YAML syntax (JSON is valid YAML).

## Caveats

- **Enphase doesn't publish this endpoint.** The URL pattern can change without warning. If a future Enlighten redesign breaks discovery, the JSON shape itself is still what the card needs — capture from whatever XHR replaces it.
- **Editing the layout** in Enlighten is largely an installer-tool feature; homeowners can usually only view. The GET should still work for view-only accounts.
- **Re-export when you change the system.** If panels are added, removed, or repositioned (rare for residential), grab the JSON again.

## Why not the Developer API?

The [Enphase v4 Developer API](https://developer-v4.enphase.com/) exposes per-system inverter and meter data, but **none of its endpoints return x/y coordinates or array groupings** — only flat lists of serials. Useful for verifying serials match, useless for layout.

## Why not the local Envoy?

The local Envoy (the box on your wall) only knows what microinverters it can talk to. Panel positions are an Enlighten-only concept; they don't roundtrip to the gateway.
