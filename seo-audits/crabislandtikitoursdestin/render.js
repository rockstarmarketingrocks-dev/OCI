// Usage: node render.js src/01-home.html pdf/01-home-changelog.pdf
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [src, out] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(src));
  await page.pdf({ path: out, format: 'Letter', printBackground: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888">Crab Island Tiki Tours SEO changelog, page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    margin: { top: '0.6in', bottom: '0.7in', left: '0.6in', right: '0.6in' } });
  await browser.close();
})();
