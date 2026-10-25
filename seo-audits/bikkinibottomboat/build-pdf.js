// Usage: node build-pdf.js src/01-homepage.html  -> writes pdf/01-homepage.pdf
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
(async () => {
  const src = path.resolve(process.argv[2]);
  const out = path.resolve(__dirname, 'pdf', path.basename(src, '.html') + '.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + src, { waitUntil: 'load' });
  await page.pdf({
    path: out, format: 'Letter', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888">bikkinibottomboat.com SEO changelog · page <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  });
  await browser.close();
  console.log(out);
})();
