// Two ways to use this:
//
// (A) Bookmarklet (recommended, one-click forever):
//     - Create a new bookmark in your browser, name it "Solar layout"
//     - Paste the contents of docs/bookmarklet.txt as the URL
//     - On enlighten.enphaseenergy.com Array view, click the bookmark
//
// (B) DevTools paste (one-shot):
//     - Open DevTools console while on the Array view
//     - Paste the contents of THIS file, hit Enter
//
// Either way, the snippet pulls your system_id out of the page URL, fetches
// the layout JSON with your existing session cookies, then opens an overlay
// on the page itself with the JSON in a textarea + a "Copy" button + a
// "Download" button. No console output, no event listeners.
//
// Repo: https://github.com/awolden/lovelace-enphase-cards

(async () => {
  // ---------- overlay -----------------------------------------------------
  const overlayId = "solar-layout-export-overlay";
  document.getElementById(overlayId)?.remove();
  const overlay = document.createElement("div");
  overlay.id = overlayId;
  overlay.attachShadow({ mode: "open" }).innerHTML = `
    <style>
      :host {
        position: fixed; inset: 0; z-index: 2147483647;
        font-family: -apple-system, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif;
      }
      .backdrop {
        position: absolute; inset: 0;
        background: rgba(8, 9, 15, 0.72);
        backdrop-filter: blur(6px);
      }
      .panel {
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: min(720px, 92vw); max-height: 86vh;
        background: linear-gradient(180deg, #1a1f2e 0%, #11141d 100%);
        color: #f5f7fb;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        box-shadow: 0 30px 60px rgba(0,0,0,0.6);
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      header h3 {
        margin: 0; font-size: 14px; font-weight: 800;
        letter-spacing: 0.18em; text-transform: uppercase;
      }
      header .meta {
        font-size: 11px; color: rgba(255,255,255,0.55); font-weight: 600;
      }
      .body {
        padding: 16px 20px; overflow: hidden;
        display: flex; flex-direction: column; gap: 12px; min-height: 0;
      }
      textarea {
        flex: 1; min-height: 280px;
        background: rgba(0,0,0,0.4);
        color: #f5f7fb;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        padding: 12px;
        font-family: ui-monospace, "JetBrains Mono", Consolas, monospace;
        font-size: 12px; line-height: 1.5;
        resize: vertical;
      }
      footer {
        display: flex; gap: 8px; justify-content: flex-end; align-items: center;
        padding: 12px 20px;
        border-top: 1px solid rgba(255,255,255,0.06);
        background: rgba(0,0,0,0.2);
      }
      button {
        background: rgba(255,255,255,0.06);
        color: #f5f7fb;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 8px 14px;
        font-size: 12px; font-weight: 700;
        letter-spacing: 0.06em;
        cursor: pointer;
        font-family: inherit;
      }
      button:hover { background: rgba(255,255,255,0.1); }
      button.primary {
        background: linear-gradient(135deg, #ff8a4c, #ff3a2c);
        color: #1a1010; border-color: transparent;
        box-shadow: 0 4px 10px rgba(255,90,40,0.25);
      }
      button.primary:hover { filter: brightness(1.08); }
      .err { color: #ff7a7a; font-size: 13px; padding: 24px 20px; }
      .err code { background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 4px; }
      .hint { font-size: 11px; color: rgba(255,255,255,0.5); }
      .toast {
        position: absolute; bottom: 16px; right: 16px;
        background: #43a047; color: #fff;
        padding: 6px 12px; border-radius: 6px;
        font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
        opacity: 0; transition: opacity 0.2s;
      }
      .toast.visible { opacity: 1; }
    </style>
    <div class="backdrop"></div>
  `;
  document.body.appendChild(overlay);
  const root = overlay.shadowRoot;
  // Click on backdrop closes the overlay. Clicks inside the panel don't reach
  // here because the panel is positioned absolute over the backdrop and does
  // not bubble through it.
  root.querySelector(".backdrop").addEventListener("click", () => overlay.remove());

  function showError(html) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <header><h3>❌ Couldn't capture layout</h3>
        <button class="close">Close</button>
      </header>
      <div class="err">${html}</div>
    `;
    root.appendChild(panel);
    panel.querySelector(".close").addEventListener("click", () => overlay.remove());
  }

  function showSuccess(json, sourceUrl, arrays, modules) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <header>
        <h3>☀ Solar Layout JSON</h3>
        <span class="meta">${arrays} array(s) · ${modules} module(s)</span>
      </header>
      <div class="body">
        <textarea spellcheck="false"></textarea>
        <div class="hint">Source: <code>${sourceUrl}</code> · paste under <code>arrays:</code> in your card config</div>
      </div>
      <footer>
        <button class="close">Close</button>
        <button class="dl">Download .json</button>
        <button class="copy primary">Copy to clipboard</button>
      </footer>
      <div class="toast" id="toast">COPIED</div>
    `;
    root.appendChild(panel);
    const ta = panel.querySelector("textarea");
    ta.value = json;
    ta.focus();
    ta.select();
    panel.querySelector(".close").addEventListener("click", () => overlay.remove());
    panel.querySelector(".copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(json);
      const t = panel.querySelector("#toast");
      t.classList.add("visible");
      setTimeout(() => t.classList.remove("visible"), 1400);
    });
    panel.querySelector(".dl").addEventListener("click", () => {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "enphase-layout.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  // ---------- fetch -------------------------------------------------------
  const m = location.pathname.match(/\/(?:web|systems)\/(\d+)/);
  if (!m) {
    showError(
      "Couldn't find your <code>system_id</code> in the page URL.<br><br>" +
      "Navigate to your system's Array view (URL like " +
      "<code>https://enlighten.enphaseenergy.com/web/&lt;system_id&gt;/array</code>) and try again."
    );
    return;
  }
  const systemId = m[1];

  const directUrls = [
    `/pv/systems/${systemId}/array_layout_x.json`,
    `/pv/systems/${systemId}/array_layout.json`,
    `/web/${systemId}/array.json`,
  ];
  const scannedUrls = performance.getEntriesByType("resource")
    .map(r => r.name)
    .filter(u => {
      try { return new URL(u).origin === location.origin; } catch { return false; }
    })
    .filter(u => /array|layout|panel|module/i.test(u));
  const seen = new Set();
  const candidates = [...directUrls, ...scannedUrls].filter(u => {
    if (seen.has(u)) return false;
    seen.add(u); return true;
  });

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) continue;
      const ct = resp.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;
      const data = await resp.json();
      if (data?.arrays?.length && data.arrays[0]?.modules?.length) {
        const out = JSON.stringify(data.arrays, null, 2);
        const totalModules = data.arrays.reduce((n, a) => n + (a.modules?.length || 0), 0);
        showSuccess(out, url, data.arrays.length, totalModules);
        return;
      }
    } catch (_) { /* not JSON or wrong shape */ }
  }

  showError(
    `Tried <code>system_id ${systemId}</code> but didn't find a layout JSON.<br><br>` +
    `URLs attempted:<br>` +
    `<ul style="margin:8px 0; padding-left:20px;">` +
    candidates.map(u => `<li><code>${u}</code></li>`).join("") +
    `</ul>` +
    `Enphase may have changed the endpoint pattern. Capture it manually via ` +
    `DevTools → Network — see <a href="https://github.com/awolden/lovelace-enphase-cards/blob/main/docs/getting-layout-json.md" target="_blank" style="color:#ff8a4c;">docs/getting-layout-json.md</a>.`
  );
})();
