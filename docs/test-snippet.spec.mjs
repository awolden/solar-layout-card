// Playwright test for docs/devtools-snippet.js.
// Spins up a local server that serves a fake "Enlighten" page; the page makes
// a fetch() call that returns layout-shaped JSON; the snippet runs in the
// browser context and is expected to capture the response and copy it to the
// clipboard. Asserts on the clipboard content.
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
          // Simulate the Enlighten page making an XHR for layout JSON
          window.addEventListener("DOMContentLoaded", () => {
            setTimeout(() => fetch("/api/array_layout"), 100);
          });
        </script>
        </body></html>
      `);
    } else if (req.url === "/api/array_layout") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FAKE_LAYOUT));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => server.close());

test("snippet captures layout JSON to clipboard", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  // Capture console for asserting the success log
  const logs = [];
  page.on("console", msg => logs.push(msg.text()));

  await page.goto(`${baseUrl}/array`);
  // Inject the snippet BEFORE the auto-fetch fires.
  await page.evaluate(SNIPPET);
  // Trigger the fetch (it would have fired on DOMContentLoaded but we may have
  // raced; nudge it).
  await page.evaluate(() => fetch("/api/array_layout"));
  // Give the snippet a tick to process the response.
  await page.waitForTimeout(200);

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clipboard);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBe(1);
  expect(parsed[0].label).toBe("TEST_ARRAY");
  expect(parsed[0].modules.length).toBe(2);
  expect(parsed[0].modules[0].inverter.serial_num).toBe("555000111222");
  expect(logs.some(l => l.includes("Captured solar layout JSON"))).toBe(true);

  await browser.close();
});

test("snippet ignores non-layout JSON responses", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  // Use a blank page so nothing auto-fires the layout fetch
  await page.goto(`${baseUrl}/blank`);
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  await page.evaluate(SNIPPET);
  await page.evaluate(async () => {
    await fetch("data:application/json,{\"foo\":\"bar\"}");
  });
  await page.waitForTimeout(150);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("untouched");
  await browser.close();
});
