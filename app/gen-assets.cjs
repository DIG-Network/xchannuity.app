// Generate favicon PNGs + apple-touch-icon + og.png from the brand mark, using
// the (already-installed) Playwright chromium. Run: node gen-assets.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "public");

const HEX = `
  <rect width="32" height="32" rx="7" fill="#0b0c0e"/>
  <path d="M16 4 26 9.5v13L16 28 6 22.5v-13z" fill="none" stroke="#cbd2de" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M11 20c2.5-9 7.5-9 10 0" fill="none" stroke="#9aa2b1" stroke-width="1.8" stroke-linecap="round"/>`;

function iconHtml(px) {
  return `<!doctype html><html><body style="margin:0">
    <svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32">${HEX}</svg>
  </body></html>`;
}

const OG_HTML = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  *{margin:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:
    radial-gradient(120% 80% at 50% -20%, rgba(203,210,222,0.06), transparent 55%),
    linear-gradient(180deg,#0d0e11,#0b0c0e 45%);
    font-family:'Geist',system-ui,sans-serif;color:#e9ebf0;
    padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between}
  .top{display:flex;align-items:center;gap:16px}
  .top svg{width:44px;height:44px}
  .brand{font-size:24px;font-weight:600;letter-spacing:-0.01em}
  .eyebrow{font-size:18px;letter-spacing:0.22em;text-transform:uppercase;color:#686d77;font-weight:500}
  h1{font-size:84px;font-weight:600;line-height:1.02;letter-spacing:-0.02em}
  h1 span{color:#9a9faa}
  .rule{height:1px;background:#21232a;margin:36px 0 24px}
  .figure{font-family:'Geist Mono',monospace;font-size:30px;color:#cbd2de}
  .foot{display:flex;justify-content:space-between;align-items:flex-end}
  .muted{color:#9a9faa;font-size:20px}
</style></head><body>
  <div class="top">
    <svg viewBox="0 0 32 32">${HEX}</svg>
    <div class="brand">XCH&nbsp;Annuity</div>
  </div>
  <div>
    <div class="eyebrow">Streamed · Transferable · Tradable</div>
    <h1 style="margin-top:22px">Annuities that vest<br><span>by the second.</span></h1>
    <div class="rule"></div>
    <div class="foot">
      <div class="muted">On-chain streamed-CAT annuities on Chia</div>
      <div class="figure">1,284.07</div>
    </div>
  </div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  const sizes = { 16: "favicon-16.png", 32: "favicon-32.png", 48: "favicon-48.png", 180: "apple-touch-icon.png", 192: "favicon-192.png", 512: "favicon-512.png" };
  for (const [px, name] of Object.entries(sizes)) {
    await page.setViewportSize({ width: +px, height: +px });
    await page.setContent(iconHtml(+px), { waitUntil: "load" });
    await page.screenshot({ path: path.join(OUT, name), omitBackground: false, clip: { x: 0, y: 0, width: +px, height: +px } });
    console.log("wrote", name);
  }

  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(OG_HTML, { waitUntil: "networkidle" });
  await page.waitForTimeout(800); // let webfont settle
  await page.screenshot({ path: path.join(OUT, "og.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log("wrote og.png");

  await browser.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
