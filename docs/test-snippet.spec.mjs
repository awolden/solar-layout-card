// Playwright test for docs/devtools-snippet.js (one-shot version).
// Spins up a fake "Enlighten" page that has already loaded a layout JSON
// resource. The snippet, when pasted, should scan loaded resources via
// the Performance API, refetch the layout endpoint, and copy the `arrays`
// value to the clipboard.
//
// Run with:
//   npx playwright install chromium
//   npx playwright test docs/test-snippet.spec.mjs

import { test, expect, chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNIPPET = readFileSync(resolve(__dirname, "devtools-snippet.js"), "utf8");

const FAKE_LAYOUT = {
  system_id: 9999,
  arrays: [
    {
      label: "TEST_ARRAY",
      x: 100, y: 100, azimuth: 180,
      modules: [
        { rotation: 0, x: 0, y: 0,   inverter: { serial_num: "555000111222" } },
        { rotation: 0, x: 100, y: 0, inverter: { serial_num: "555000111223" } },
      ],
    },
  ],
};

let server, baseUrl;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/blank") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body></body></html>");
    } else if (req.url === "/array") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!doctype html>
        <html><head><title>Fake Enlighten</title></head>
        <body><h1>Loading…</h1>
        <script>
          // Page pre-loads the layout endpoint, exactly like Enlighten does.
          fetch("/api/array_layout").then(r => r.json());
          // And some unrelated noise (a non-matching JSON endpoint)
          fetch("/api/user_prefs").then(r => r.json()).catch(() => {});
        </script>
        </body></html>
      `);
    } else if (req.url === "/api/array_layout") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FAKE_LAYOUT));
    } else if (req.url === "/api/user_prefs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ theme: "dark", language: "en" }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => server.close());

test("snippet finds layout JSON in already-loaded resources", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", msg => logs.push(msg.text()));

  await page.goto(`${baseUrl}/array`);
  // Wait for the page's pre-loaded fetches to settle
  await page.waitForLoadState("networkidle");

  // Now run the snippet — it should find the loaded layout endpoint
  await page.evaluate(SNIPPET);
  await page.waitForTimeout(200);

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clipboard);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBe(1);
  expect(parsed[0].label).toBe("TEST_ARRAY");
  expect(parsed[0].modules.length).toBe(2);
  expect(parsed[0].modules[0].inverter.serial_num).toBe("555000111222");
  expect(logs.some(l => l.includes("Captured solar layout JSON"))).toBe(true);
  expect(logs.some(l => l.includes("/api/array_layout"))).toBe(true);

  await browser.close();
});

test("snippet warns when no layout JSON is on the page", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const warnings = [];
  page.on("console", msg => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });

  // Plain blank page — no resources for the snippet to find
  await page.goto(`${baseUrl}/blank`);
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  await page.evaluate(SNIPPET);
  await page.waitForTimeout(200);

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("untouched");
  expect(warnings.some(w => w.includes("No layout JSON found"))).toBe(true);

  await browser.close();
});
