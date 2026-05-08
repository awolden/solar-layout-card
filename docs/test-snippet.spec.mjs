// Playwright test for docs/devtools-snippet.js (overlay version).
// Spins up a fake "Enlighten" page at /web/<id>/array. Snippet should
// extract system_id from the URL, fetch /pv/systems/<id>/array_layout_x.json,
// then render an overlay with the JSON in a textarea + Copy / Download
// buttons. Tests verify the overlay renders correctly and the Copy button
// puts the right data on the clipboard.
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

const SYSTEM_ID = "6277207";
const FAKE_LAYOUT = {
  system_id: Number(SYSTEM_ID),
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
    if (req.url === `/web/${SYSTEM_ID}/array`) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><head><title>Fake Enlighten Array</title></head>
        <body><h1>Solar Array</h1></body></html>`);
    } else if (req.url === `/pv/systems/${SYSTEM_ID}/array_layout_x.json`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FAKE_LAYOUT));
    } else if (req.url === "/web/no-system-id-here") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body></body></html>");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => server.close());

test("snippet renders success overlay with layout JSON", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();

  await page.goto(`${baseUrl}/web/${SYSTEM_ID}/array`);
  await page.evaluate(SNIPPET);
  // Overlay should appear
  await page.waitForSelector("#solar-layout-export-overlay", { timeout: 2000 });

  // Reach into shadow DOM to verify content
  const overlayInfo = await page.evaluate(() => {
    const root = document.getElementById("solar-layout-export-overlay").shadowRoot;
    return {
      header: root.querySelector("h3")?.textContent,
      meta: root.querySelector(".meta")?.textContent,
      taValue: root.querySelector("textarea")?.value,
      hasCopy: !!root.querySelector(".copy"),
      hasDl: !!root.querySelector(".dl"),
      hasClose: !!root.querySelector(".close"),
    };
  });
  expect(overlayInfo.header).toContain("Solar Layout JSON");
  expect(overlayInfo.meta).toContain("1 array(s)");
  expect(overlayInfo.meta).toContain("2 module(s)");
  expect(overlayInfo.hasCopy).toBe(true);
  expect(overlayInfo.hasDl).toBe(true);
  expect(overlayInfo.hasClose).toBe(true);
  const parsed = JSON.parse(overlayInfo.taValue);
  expect(parsed[0].label).toBe("TEST_ARRAY");
  expect(parsed[0].modules[0].inverter.serial_num).toBe("555000111222");

  // Click Copy → clipboard gets the JSON
  await page.evaluate(() => {
    document.getElementById("solar-layout-export-overlay").shadowRoot
      .querySelector(".copy").click();
  });
  await page.waitForTimeout(100);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(clipboard)[0].label).toBe("TEST_ARRAY");

  // Click Close → overlay removed
  await page.evaluate(() => {
    document.getElementById("solar-layout-export-overlay").shadowRoot
      .querySelector(".close").click();
  });
  expect(await page.locator("#solar-layout-export-overlay").count()).toBe(0);

  await browser.close();
});

test("snippet renders error overlay when system_id missing from URL", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${baseUrl}/web/no-system-id-here`);
  await page.evaluate(SNIPPET);
  await page.waitForSelector("#solar-layout-export-overlay", { timeout: 2000 });

  const errText = await page.evaluate(() =>
    document.getElementById("solar-layout-export-overlay").shadowRoot
      .querySelector(".err")?.textContent
  );
  expect(errText).toContain("system_id");
  expect(errText).toContain("Array view");

  await browser.close();
});

test("snippet renders error overlay when layout endpoint not found", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Use a system_id the fake server doesn't know
  await page.goto(`${baseUrl}/web/0000000/array`);
  await page.evaluate(SNIPPET);
  await page.waitForSelector("#solar-layout-export-overlay", { timeout: 2000 });

  const errText = await page.evaluate(() =>
    document.getElementById("solar-layout-export-overlay").shadowRoot
      .querySelector(".err")?.textContent
  );
  expect(errText).toContain("0000000");
  expect(errText).toContain("array_layout");

  await browser.close();
});
