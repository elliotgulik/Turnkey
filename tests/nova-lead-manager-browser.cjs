/* Production index with Nova loaded: status scopes on desktop and mobile. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.setHeader('Content-Type', { '.js':'text/javascript', '.css':'text/css', '.html':'text/html' }[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    });
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const cached = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    browser = await chromium.launch({ headless:true, ...(fs.existsSync(chromium.executablePath()) ? {} : { executablePath:cached }) });
    for (const width of [1440,390]) {
      const context = await browser.newContext({ viewport:{width,height:980}, serviceWorkers:'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [], loaded = new Set();
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.ok() && r.url().startsWith(base)) loaded.add(new URL(r.url()).pathname); });
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(base) && new URL(url).pathname !== '/config.js') return route.continue();
        return route.fulfill({ contentType:'text/javascript', body:url.startsWith(base) ? 'window.TURNKEY_CONFIG={};' : '' });
      });
      await page.goto(base);
      await page.waitForFunction(() => window.TK_NOVA_LEAD_MANAGER && window.TK_SALES_PLATFORM);
      await page.evaluate(() => {
        const now = Date.now();
        records = ['new','scheduled','won','completed','paid','cancelled','lost'].map((stage,i) => newRecord({
          id:i+1, stage, name:`Customer ${i+1}`, source:'ServiceM8', total:100,
          createdAt:now, address:'18 Kowhai Road, Auckland', wonAt:now,
          nextFollowUpAt:new Date(now-86400000).toISOString(),
        }));
        showApp(); render(); switchView('leads');
      });
      assert(loaded.has('/nova-lead-manager.js'));
      assert(loaded.has('/nova-lead-manager.css'));
      const leads = page.locator('#view-leads');
      const ids = () => leads.locator('[data-nlm-record]').evaluateAll(els => els.map(el => Number(el.dataset.nlmRecord)));
      const scope = key => leads.locator(`[data-nlm-scope="${key}"]`);
      assert.equal(await leads.locator('h2').innerText(), 'Lead Manager');
      assert.deepEqual(await ids(), [1]);
      for (const [key,count] of [['open',1],['all',7],['won',2],['completed',2],['lost',2]])
        assert.equal(await scope(key).locator('span').innerText(), String(count));
      await scope('won').click();
      assert.deepEqual(await ids(), [2,3]);
      assert.deepEqual(await leads.locator('.nlm-tag.stage').allTextContents(), ['Confirmed','Confirmed']);
      await scope('completed').focus(); await page.keyboard.press('Enter');
      assert.deepEqual(await ids(), [4,5]);
      assert.equal(await scope('completed').getAttribute('aria-pressed'), 'true');
      assert.equal(await scope('completed').evaluate(el => el === document.activeElement), true);
      assert.deepEqual(await leads.locator('.nlm-tag.stage').allTextContents(), ['Completed','Completed']);
      assert.equal(await leads.locator('[data-nlm-filter="stage"]').inputValue(), 'completed');
      assert.equal(await leads.locator('[data-nlm-stage]:disabled').count(), 2);
      assert.equal(await leads.locator('.nlm-follow.overdue').count(), 0);
      await leads.locator('[data-nlm-filter="query"]').fill('Customer 5');
      assert.deepEqual(await ids(), [5]);
      await leads.locator('.nlm-name').click();
      assert.match(await leads.locator('.nlm-fields').innerText(), /Stage\s+Completed/);
      await leads.locator('.nlm-close').click();
      await leads.locator('[data-nlm="clear"]').first().click();
      assert.deepEqual(await ids(), [1]);
      await leads.locator('[data-nlm-filter="stage"]').selectOption('completed');
      assert.deepEqual(await ids(), [4,5]);
      await leads.locator('[data-nlm-filter="overdue"]').check();
      assert.deepEqual(await ids(), []);
      await leads.locator('[data-nlm-filter="overdue"]').uncheck();
      await scope('lost').click();
      assert.deepEqual(await ids(), [6,7]);
      await scope('all').click();
      assert.deepEqual(await ids(), [1,2,3,4,5,6,7]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(await page.evaluate(() => records.map(r => r.stage)), ['new','scheduled','won','completed','paid','cancelled','lost']);
      assert.deepEqual(await page.evaluate(() => records.slice(3,5).map(r => TK_METRICS.won(r))), [true,true]);
      await page.evaluate(() => switchView('pipeline'));
      assert.equal(await page.locator('#view-pipeline h2').innerText(), 'Sales pipeline');
      await page.evaluate(() => switchView('sales'));
      assert.equal(await page.locator('#view-sales h2').innerText(), 'Analytics');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS production Nova Leads Manager at ${width}px`);
    }
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
