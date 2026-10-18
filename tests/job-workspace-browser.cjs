/* Offline UI checks for job-workspace.js: only fixture responses via
   TK_JOB_WORK.configure(), all real network requests blocked. Covers the
   four areas flagged in review: new screens actually render, form/photo
   payloads are serialized safely (no injection), local-timezone grouping
   in the staff calendar is correct, and a mid-flight tenant change doesn't
   write stale data anywhere. No new dependencies — Playwright is already
   installed at the repo root (see tests/marketing-browser.cjs). */
const { chromium } = require('playwright'),
  fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path'),
  assert = require('node:assert/strict');

(async () => {
  const cached = path.join(
    require('node:os').homedir(),
    'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  );
  const browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(chromium.executablePath()) ? {} : { executablePath: cached })
  });
  // crypto.subtle (used for the stable, content-derived requestId) is only
  // available in a secure context — about:blank's opaque "null" origin
  // doesn't qualify, but http://localhost does (Chromium treats localhost
  // as secure even without TLS), matching how this actually runs in
  // production (always served over https). A tiny static server avoids
  // needing a new dependency just for this.
  const server = http.createServer((req, res) => {
    const file = path.resolve('.' + decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Auckland' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
    await page.goto(base + '/tests/fixtures/job-workspace.html');
    await page.addStyleTag({ path: path.resolve('job-workspace.css') });

    await page.evaluate(() => {
      // Stub the thing job-workspace.js wraps, same shape as index.html's
      // real openDetail(id): re-renders #view-detail from scratch.
      window.openDetail = function (id) {
        document.getElementById('view-detail').innerHTML = '<div class="detail-grid"></div>';
      };
      window.records = [{ id: 1, jobId: 'job-1', name: 'Test job', customerId: 'cust-1' }];
    });
    await page.addScriptTag({ path: path.resolve('job-workspace.js') });

    await page.evaluate(() => {
      window.fixture = {
        business: 'biz-a', userId: 'owner-1', version: 0, role: 'owner',
        staff: [{ id: 'owner-1', email: 'owner@test.example', role: 'owner' }],
        calls: [], logsResult: [], delayEquipment: false, equipmentResolver: null
      };
      window.TK_JOB_WORK.configure({
        getBusinessId: () => fixture.business,
        getUserId: () => fixture.userId,
        getVersion: () => fixture.version,
        getRecords: () => window.records,
        notify: (m) => { window.lastNotify = m; },
        request: async (p, options) => {
          fixture.calls.push({ path: p, options });
          if (p.startsWith('/staff')) return { role: fixture.role, staff: fixture.staff };
          if (p.startsWith('/equipment') && (!options || !options.method)) {
            if (fixture.delayEquipment) return new Promise((resolve) => { fixture.equipmentResolver = () => resolve({ equipment: [] }); });
            return { equipment: [] };
          }
          if (p.startsWith('/equipment') && options && options.method === 'POST') return { ok: true, asset: { id: 'asset-1', name: 'Washer' } };
          if (p.startsWith('/logs') && p.includes('jobId')) return { logs: [], usage: [] };
          if (p.startsWith('/logs') && p.includes('from=')) return { logs: fixture.logsResult };
          if (p.startsWith('/logs') && options && options.method === 'POST') return { ok: true, logId: 'log-1', deduped: false };
          if (p.includes('/photos') && (!options || !options.method)) return { photos: [] };
          return { ok: true };
        }
      });
    });

    /* ===== 1. new screens actually render ===== */
    await page.evaluate(() => window.openDetail(1));
    await page.locator('#tkj-card').waitFor();
    assert.match(await page.locator('#tkj-card').innerText(), /No hours logged against this job yet/);

    await page.locator('[data-tkj="calendar"]').first().click();
    await page.locator('.tkj-panel-modal h2').waitFor();
    assert.match(await page.locator('.tkj-panel-modal h2').innerText(), /Staff calendar/);
    await page.keyboard.press('Escape');
    await page.locator('.tkj-overlay').waitFor({ state: 'detached' });

    await page.locator('[data-tkj="equipment"]').first().click();
    await page.locator('.tkj-panel-modal h2').waitFor();
    assert.match(await page.locator('.tkj-panel-modal h2').innerText(), /Equipment/);
    await page.locator('.tkj-overlay [data-tkj="close"]').click();
    await page.locator('.tkj-overlay').waitFor({ state: 'detached' });

    /* ===== 2. safe form serialization — no injection via notes ===== */
    const injected = '<img src=x onerror="window.injected=true">';
    await page.locator('[data-tkj="log-hours"]').click();
    await page.locator('[data-tkj-form="log-hours"]').waitFor();
    await page.fill('[name="date"]', '2026-01-10');
    await page.fill('[name="startTime"]', '08:00');
    await page.fill('[name="endTime"]', '10:00');
    await page.fill('[name="notes"]', injected);
    await page.click('button[type="submit"]');
    await page.locator('.tkj-overlay').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.injected), undefined);
    const postCall = await page.evaluate(() => fixture.calls.find((c) => c.path === '/logs' && c.options && c.options.method === 'POST'));
    const sentBody = JSON.parse(postCall.options.body);
    assert.equal(sentBody.notes, injected); // sent as plain data, never interpreted as markup
    assert.equal(sentBody.jobId, 'job-1');
    assert.match(sentBody.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.match(sentBody.startAt, /^2026-01-/); // a real ISO instant, not a bare date

    // Resubmitting the exact same form content must produce the SAME
    // requestId (stable-by-content, not random each time).
    await page.locator('[data-tkj="log-hours"]').click();
    await page.locator('[data-tkj-form="log-hours"]').waitFor();
    await page.fill('[name="date"]', '2026-01-10');
    await page.fill('[name="startTime"]', '08:00');
    await page.fill('[name="endTime"]', '10:00');
    await page.fill('[name="notes"]', injected);
    await page.click('button[type="submit"]');
    await page.locator('.tkj-overlay').waitFor({ state: 'detached' });
    const secondPostCall = (await page.evaluate(() => fixture.calls.filter((c) => c.path === '/logs' && c.options && c.options.method === 'POST')))[1];
    assert.equal(JSON.parse(secondPostCall.options.body).requestId, sentBody.requestId);

    /* ===== 3. local-timezone correctness in the staff calendar ===== */
    // One log entry "right now" (from the page's own clock, under the
    // emulated Pacific/Auckland timezone) must land in the day column for
    // "today" — a UTC-based grouping bug would shift it to the wrong day
    // for roughly half of every 24h cycle.
    await page.evaluate(() => {
      fixture.logsResult = [{ id: 'log-x', user_id: 'owner-1', start_at: new Date().toISOString(), end_at: new Date(Date.now() + 3600000).toISOString(), minutes: 60, notes: '' }];
    });
    await page.locator('[data-tkj="calendar"]').first().click();
    await page.locator('.tkj-week-entry').waitFor();
    const expectedLabel = await page.evaluate(() => new Date().toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric' }));
    const dayWithEntry = await page.locator('.tkj-week-day', { has: page.locator('.tkj-week-entry') }).first();
    assert.equal((await dayWithEntry.locator('.tkj-week-day-label').innerText()).trim(), expectedLabel);
    await page.locator('.tkj-overlay [data-tkj="close"]').click();
    await page.locator('.tkj-overlay').waitFor({ state: 'detached' });

    /* ===== 4. stale-async guard: business changes mid-request ===== */
    await page.evaluate(() => { fixture.delayEquipment = true; });
    await page.locator('[data-tkj="equipment"]').first().click();
    await page.locator('.tkj-panel-modal h2').waitFor();
    // Simulate a tenant switch while the /equipment fetch is still pending.
    await page.evaluate(() => { fixture.business = 'biz-b'; });
    // The overlay's own staleness watcher polls every 250ms and must close it.
    await page.locator('.tkj-overlay').waitFor({ state: 'detached', timeout: 2000 });
    await page.evaluate(() => { fixture.equipmentResolver && fixture.equipmentResolver(); });
    await page.waitForTimeout(100); // let the now-stale response finish resolving, harmlessly
    assert.equal(await page.locator('.tkj-overlay').count(), 0); // nothing re-opened or re-rendered from the stale response
    await page.evaluate(() => { fixture.business = 'biz-a'; fixture.delayEquipment = false; });

    /* ===== launcher hides when signed out ===== */
    assert.notEqual(await page.locator('#tkj-launcher').evaluate((el) => el.style.display), 'none');
    await page.evaluate(() => { fixture.business = null; });
    await page.waitForFunction(() => document.getElementById('tkj-launcher').style.display === 'none');
    await page.evaluate(() => { fixture.business = 'biz-a'; });
    await page.waitForFunction(() => document.getElementById('tkj-launcher').style.display !== 'none');

    assert.deepEqual(errors, []);
    await page.close();
    console.log('Job records UI passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
