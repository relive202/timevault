// Opens tests.html in a headless browser, runs the 53 safety tests and fails unless all pass.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8099, async () => {
  const browser = await chromium.launch(); const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto('http://127.0.0.1:8099/tests.html');
  await page.click('#run');
  await page.waitForFunction(() => / of \d+ tests passed|Setup failed/.test(document.getElementById('sum').textContent), null, { timeout: 15 * 60 * 1000 });
  const sum = await page.textContent('#sum');
  const failed = await page.$$eval('#log li.fail', (ls) => ls.map((l) => l.textContent));
  console.log(sum); failed.forEach((f) => console.log('FAILED: ' + f));
  await browser.close(); server.close();
  const m = sum.match(/(\d+) of (\d+)/);
  process.exit(m && m[1] === m[2] && Number(m[2]) >= 53 ? 0 : 1);
});
