/* Focused sales UX check. The fixture server mounts the scoped stylesheet so
 * the parent can integrate index.html separately. No live services are used. */
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
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(file);
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[ext] || 'application/octet-stream');
      res.end(name === 'index.html' ? data.toString().replace('</head>', '<link rel="stylesheet" href="sales-experience.css"></head>') : data);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'turnkey-sales-ux-'));
  try {
    const cached = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(chromium.executablePath()) ? {} : { executablePath: cached }) });
    const errors = [];
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 980 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        // Keep this focused on sales-platform rather than the later Nova Leads replacement.
        if (url.startsWith(base) && new URL(url).pathname === '/nova-lead-manager.js')
          return route.fulfill({ contentType: 'text/javascript', body: '' });
        if (url.startsWith(base)) return new URL(url).pathname === '/config.js' ? route.fulfill({ contentType: 'text/javascript', body: 'window.TURNKEY_CONFIG={};' }) : route.continue();
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
      });
      await page.goto(base);
      await page.waitForFunction(() => window.TK_SALES_PLATFORM && window.TK_EARTH_QUOTES);
      await page.evaluate(() => {
        const now = Date.now();
        records = [
          {id:1,name:'Aroha Thompson',stage:'new',source:'Wix',email:'aroha@example.test',phone:'+6421555011',opportunityValue:850,nextFollowUpAt:new Date(now-86400000).toISOString()},
          {id:2,name:'Harbour Property Group',stage:'qualified',source:'Referral',email:'harbour@example.test',opportunityValue:2400},
          {id:3,name:'Moana Williams',stage:'followup',source:'Meta',email:'moana@example.test',total:1250,nextFollowUpAt:new Date(now-3600000).toISOString()},
          {id:4,name:'Confirmed sale',stage:'won',total:1600,nextFollowUpAt:new Date(now-86400000).toISOString()},
          {id:5,name:'Scheduled work',stage:'scheduled',total:2200},
          {id:6,name:'Lost enquiry',stage:'cancelled',lostAt:now,lostReason:'Timing'},
          {id:7,name:'Cancelled job',stage:'cancelled',cancelReason:'Weather',nextFollowUpAt:new Date(now-86400000).toISOString()},
          {id:8,name:'Missing contact',stage:'new',source:'Manual'},
          {id:9,name:'Phone enquiry',stage:'new',phone:'+6421555022'},
          {id:10,name:'ServiceM8 completed',stage:'completed',source:'ServiceM8',total:300},
          {id:11,name:'ServiceM8 paid',stage:'paid',source:'ServiceM8',total:400}
        ].map(r => newRecord({address:'18 Kowhai Road, Auckland',createdAt:now-172800000,customerId:'customer-'+r.id,jobId:'job-'+r.id,...r}));
        currentBusinessId = 'sales-ux-test'; currentUserId = 'sales-ux-owner'; businessStateReady = true;
        records.forEach(r => recordBusinesses.set(r, currentBusinessId));
        showApp(); render(); switchView('leads');
        window.__salesInitialStages = records.map(r => r.stage);
        window.__earthOpened = [];
        window.addEventListener('message', e => {
          if (e.source === window && e.data?.source === 'turnkey-crm-page' && e.data.type === 'TK_LAUNCH') {
            window.__earthOpened.push(e.data.recordId);
            window.postMessage({source:'turnkey-customer-launch',type:'TK_LAUNCH_ACK',nonce:e.data.nonce}, location.origin);
          }
        });
        window.postMessage({source:'turnkey-customer-launch',type:'TK_READY'}, location.origin);
      });
      const leads = page.locator('#view-leads');
      const card = id => leads.locator(`[data-record="${id}"]`);
      assert.match(await leads.locator('.sale-results').innerText(), /Showing 5 of 11 opportunities/);
      assert.equal(await leads.locator('[data-record][role="button"]').count(), 0, 'Cards must not contain interactive children inside a button role');
      assert.match(await card(1).locator('.sale-state').innerText(), /New lead/);
      assert.match(await card(2).locator('.sale-state').innerText(), /Contacted/);
      assert.match(await card(3).locator('.sale-next').innerText(), /Follow up/);
      assert.match(await card(8).locator('.sale-next').innerText(), /Add contact details/);
      assert.equal(await card(9).locator('.sale-next').getAttribute('href'), 'tel:+6421555022');
      assert.equal(await card(2).locator('.sale-next svg').count(), 1, 'Earth icon remains on quote action');

      // Native customer-name buttons support both keyboard activation keys.
      for (const key of ['Enter', 'Space']) {
        await card(1).locator('.sale-record-open').focus();
        await page.keyboard.press(key);
        await page.locator('#view-detail.active').waitFor();
        await page.evaluate(() => switchView('leads'));
      }
      // Stage labels, plain controls and shared custom-select roles stay in Leads.
      await card(1).locator('.sale-card-stage label > span:not(.ux-select)').click();
      assert.equal(await leads.evaluate(el => el.classList.contains('active')), true);
      await card(1).evaluate(el => {
        const host = document.createElement('div');
        host.id = 'sales-child-controls';
        host.innerHTML = '<button type="button">Child button</button><label>Child label<input aria-label="Child input"></label><textarea aria-label="Child notes"></textarea><a href="#">Child link</a><div role="combobox" tabindex="0"><span>Shared select control</span></div><div role="option"><span>Shared option</span></div>';
        el.append(host);
      });
      for (const selector of ['button', 'label', 'input', 'textarea', 'a', '[role="combobox"] span', '[role="option"] span']) {
        await page.locator('#sales-child-controls').locator(selector).click();
        assert.equal(await leads.evaluate(el => el.classList.contains('active')), true, selector + ' must not open detail');
      }
      await page.locator('#sales-child-controls').evaluate(el => el.remove());
      await card(2).locator('[data-sale-action="quote"]').click();
      await page.waitForFunction(() => window.__earthOpened.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__earthOpened), [2]);
      assert.equal(await page.locator('#quote-overlay').evaluate(el => el.classList.contains('open')), false);
      await page.evaluate(() => document.getElementById('toast').classList.remove('show'));

      await leads.locator('[data-sale-filter="stage"]').selectOption('won');
      assert.deepEqual(await leads.locator('[data-record]').evaluateAll(els => els.map(el => Number(el.dataset.record))), [4, 5]);
      assert.match(await leads.innerText(), /Scheduled/);
      await leads.locator('[data-sale-action="leads-scope"][data-id="completed"]').click();
      assert.deepEqual(await leads.locator('[data-record]').evaluateAll(els => els.map(el => Number(el.dataset.record))), [10,11]);
      assert.equal(await leads.locator('[data-sale-filter="stage"]').inputValue(), 'completed');
      assert.match(await leads.locator('.sale-results').innerText(), /Completed/);
      for (const layout of ['table', 'cards']) {
        await leads.locator(`[data-sale-action="leads-layout"][data-id="${layout}"]`).click();
        assert.equal(await leads.locator('[data-sale-state="completed"]').count(), 2);
        assert.equal(await leads.locator('[data-sale-state="won"]').count(), 0);
      }
      await leads.locator('[data-sale-filter="stage"]').selectOption('completed');
      assert.equal(await leads.locator('[data-record]').count(), 2);
      await leads.locator('[data-sale-action="leads-scope"][data-id="won"]').click();
      assert.deepEqual(await leads.locator('[data-record]').evaluateAll(els => els.map(el => Number(el.dataset.record))), [4,5]);
      await leads.locator('[data-sale-filter="stage"]').selectOption('lost');
      assert.equal(await leads.locator('[data-record]').count(), 2);
      await leads.locator('[data-sale-action="leads-reset"]').click();
      await leads.locator('#sale-search').fill('no matches');
      assert.match(await leads.locator('.sale-results').innerText(), /Showing 0 of 11/);
      await leads.locator('.sale-no-results [data-sale-action="leads-reset"]').click();
      assert.equal(await leads.locator('#sale-search').inputValue(), '');
      await leads.locator('#sale-leads-due').check();
      assert.equal(await leads.locator('[data-record]').count(), 2, 'Terminal records never count as overdue');
      await leads.locator('[data-sale-action="leads-reset"]').click();
      await leads.locator('[data-sale-action="leads-layout"][data-id="table"]').click();
      assert.equal(await leads.locator('tbody tr[data-record]').count(), 5);
      assert.equal(await leads.locator('table caption').innerText(), 'Sales opportunities and next actions');
      if (width < 760) {
        const row = leads.locator('tbody tr').first();
        assert.ok(await row.locator('td').first().evaluate(el => el.getBoundingClientRect().width > el.parentElement.getBoundingClientRect().width * .8), 'Mobile customer information uses the full row width');
      }
      await page.screenshot({path:path.join(screenshots,`leads-table-${width}.png`),fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Table must not overflow the document');
      await leads.locator('[data-sale-action="leads-layout"][data-id="cards"]').click();
      await page.screenshot({path:path.join(screenshots,`leads-cards-${width}.png`),fullPage:true});

      // Enter the actual shared customer modal, with focus on its editable name.
      await card(1).locator('[data-sale-action="customer-edit"]').click();
      await page.locator('#customer-overlay.open #cp-name').waitFor();
      assert.equal(await page.locator('#cp-name').inputValue(), 'Aroha Thompson');
      assert.equal(await page.locator('#cp-name').evaluate(el => el === document.activeElement), true);
      await page.evaluate(() => closeCustomerProfile());
      await card(1).locator('[data-sale-action="history"]').click();
      await page.locator('#view-detail.active #sale-history').waitFor();
      assert.equal(await page.locator('#sale-history h3').evaluate(el => el === document.activeElement), true);
      await page.locator('#view-detail [data-sale-action="sales-plan"]').click();
      assert.equal(await page.locator('#sale-followup').evaluate(el => el === document.activeElement), true);
      await page.locator('#view-detail [data-sale-action="customer-edit"]').click();
      await page.locator('#customer-overlay.open #cp-name').waitFor();
      await page.evaluate(() => closeCustomerProfile());
      await page.locator('#sale-notes').fill('Unsaved sales plan');
      await page.evaluate(() => {
        records[0].name = 'Aroha Updated';
        records[0].email = 'updated@example.test';
        render(); // The original shared customer-save workflow calls render().
      });
      assert.equal(await page.locator('#view-detail .sale-head h2').innerText(), 'Aroha Updated');
      assert.match(await page.locator('#sale-customer').innerText(), /updated@example.test/);
      assert.equal(await page.locator('#sale-notes').inputValue(), 'Unsaved sales plan', 'Customer refresh preserves unsaved sales notes');
      await page.evaluate(() => window.scrollTo(0,0));
      await page.screenshot({path:path.join(screenshots,`detail-${width}.png`),fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Detail must not overflow the document');

      await page.evaluate(() => switchView('pipeline'));
      const pipeline = page.locator('#view-pipeline');
      assert.deepEqual(await pipeline.locator('[data-drop-stage]').evaluateAll(els => els.map(el => el.dataset.dropStage)), ['new','contacted','quoted','won','lost']);
      assert.equal(await pipeline.locator('[data-record]').count(), 11);
      await pipeline.locator('[data-sale-action="pipeline-scope"][data-id="won"]').click();
      assert.equal(await pipeline.locator('[data-record]').count(), 2);
      await pipeline.locator('[data-sale-stage="5"]').selectOption('contacted');
      assert.equal(await page.evaluate(() => records.find(r => r.id === 5).stage), 'scheduled', 'Won operations keep their saved stage');
      assert.equal(await pipeline.locator('[data-sale-stage="5"]').inputValue(), 'won', 'Rejected moves reset the stage menu');
      await pipeline.locator('#pipeline-due').check();
      assert.equal(await pipeline.locator('[data-record]').count(), 0);
      await pipeline.locator('.sale-no-results [data-sale-action="pipeline-reset"]').click();
      assert.equal(await pipeline.locator('[data-record]').count(), 11);
      await pipeline.locator('#pipeline-search').fill('Moana');
      assert.match(await pipeline.locator('.sale-results').innerText(), /Showing 1 of 11/);
      await pipeline.locator('[data-sale-action="pipeline-reset"]').click();
      await pipeline.locator('[data-sale-stage="1"]').selectOption('won');
      assert.equal(await page.evaluate(() => records.find(r => r.id === 1).stage), 'new', 'Unquoted leads cannot bypass acceptance safeguards');
      await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
      await page.screenshot({path:path.join(screenshots,`pipeline-${width}.png`),fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Pipeline scroll stays inside its board');
      assert.deepEqual(await page.evaluate(() => records.map(r => r.stage)), await page.evaluate(() => window.__salesInitialStages), 'Rendering, filtering and actions must preserve stored legacy stages');
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log('Sales UX browser check passed at 1440px and 390px. Screenshots: ' + screenshots);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
