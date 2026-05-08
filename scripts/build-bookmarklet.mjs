import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { minify } from "terser";

const src = readFileSync("docs/devtools-snippet.js", "utf8");
const min = await minify(src, {
  compress: { passes: 2 },
  mangle: true,
  format: { ascii_only: true, comments: false, quote_style: 1 },
});
if (min.error) { console.error(min.error); process.exit(1); }
const bookmarklet = "javascript:" + encodeURIComponent(min.code);
mkdirSync("docs", { recursive: true });
writeFileSync("docs/bookmarklet.txt", bookmarklet + "\n");
console.log(`Minified: ${min.code.length} chars`);
console.log(`Bookmarklet (URL-encoded): ${bookmarklet.length} chars`);
console.log(`Saved to docs/bookmarklet.txt`);
