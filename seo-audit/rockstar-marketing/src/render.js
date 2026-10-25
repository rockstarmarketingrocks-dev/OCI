// usage: node render.js in.html out.pdf
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [inp, out] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + path.resolve(inp));
  await p.pdf({ path: out, format: 'Letter', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888">Rockstar Marketing SEO Audit · Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
  await b.close();
})();
