// Paste this into the DevTools console while signed into enlighten.enphaseenergy.com.
// Then navigate to your system's Array view (or refresh it).
// When the layout JSON loads, this snippet copies it to your clipboard,
// formatted and ready to paste into solar-layout-card's `arrays:` config.
//
// Repo: https://github.com/awolden/lovelace-enphase-cards

(() => {
  const orig = window.fetch;
  let captured = false;
  window.fetch = async function (...args) {
    const resp = await orig.apply(this, args);
    if (captured) return resp;
    try {
      const data = await resp.clone().json();
      if (data && Array.isArray(data.arrays) && data.arrays.length &&
          data.arrays[0].modules && Array.isArray(data.arrays[0].modules)) {
        captured = true;
        const out = JSON.stringify(data.arrays, null, 2);
        await navigator.clipboard.writeText(out);
        console.log(
          "%c✅ Captured solar layout JSON",
          "color:#43a047;font-weight:700;font-size:14px"
        );
        console.log(
          `Copied ${data.arrays.length} array(s), ` +
          `${data.arrays.reduce((n, a) => n + (a.modules?.length || 0), 0)} module(s) to clipboard.`
        );
        console.log("Paste it into your card config under `arrays:`.");
        console.log("Restoring window.fetch — feel free to refresh.");
        window.fetch = orig;
      }
    } catch (_) { /* not JSON, not our payload */ }
    return resp;
  };
  console.log(
    "%c👀 Watching for layout JSON…",
    "color:#1e88e5;font-weight:600;font-size:13px"
  );
  console.log(
    "Now navigate to your system's Array view (or refresh the page). " +
    "Once detected, the JSON will be copied to your clipboard."
  );
})();
