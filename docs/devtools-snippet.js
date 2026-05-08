// Paste this into the DevTools console while on your system's Array view at
// enlighten.enphaseenergy.com (the page that shows your panels in their
// physical positions). The snippet looks at the resources the page has already
// loaded, finds the one whose JSON looks like a solar array layout, refetches
// it using your existing session, and copies the `arrays` value to clipboard,
// formatted and ready to paste into solar-layout-card's `arrays:` config.
//
// One-shot: no need to refresh, no event listeners, no waiting.
//
// Repo: https://github.com/awolden/lovelace-enphase-cards

(async () => {
  console.log("%c👀 Scanning page for solar layout JSON…",
    "color:#1e88e5;font-weight:600;font-size:13px");

  // Find every same-origin URL the page has loaded so far. Prefer URLs that
  // look like they're about arrays / panels / layouts.
  const candidates = performance.getEntriesByType("resource")
    .map(r => r.name)
    .filter(url => {
      try { return new URL(url).origin === location.origin; } catch { return false; }
    })
    .sort((a, b) => {
      const score = u => /array|layout|panel|module/i.test(u) ? -1 : 0;
      return score(a) - score(b);
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
        await navigator.clipboard.writeText(out);
        const totalModules = data.arrays.reduce((n, a) => n + (a.modules?.length || 0), 0);
        console.log(
          "%c✅ Captured solar layout JSON",
          "color:#43a047;font-weight:700;font-size:14px"
        );
        console.log(`Source: ${url}`);
        console.log(`${data.arrays.length} array(s) · ${totalModules} module(s) · copied to clipboard.`);
        console.log("Paste it under `arrays:` in your solar-layout-card config.");
        console.log(data);
        return;
      }
    } catch (_) { /* not JSON or wrong shape */ }
  }

  console.warn(
    "%c❌ No layout JSON found in loaded resources.",
    "color:#e53935;font-weight:700;font-size:13px"
  );
  console.log(
    "Make sure you are on your system's Array view (URL containing `/web/<id>/array`). " +
    "If you are, the page may not have loaded the layout XHR yet — refresh and re-run."
  );
})();
