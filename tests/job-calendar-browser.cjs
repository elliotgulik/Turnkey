/* Offline UI checks for job-calendar.js: only fixture responses via
   TK_JOB_CALENDAR.configure(), all real network requests blocked. No
   FullCalendar CDN available here (network blocked), so this exercises the
   built-in fallback agenda renderer end-to-end — same data flow and
   payload-building code the FullCalendar drag/resize handlers call into.
   Covers: nav patch (desktop + mobile More sheet), the floating launcher's
   "Staff calendar" button being redirected here instead of opening the old
   actual-hours modal, role gating (owner/manager vs technician), all-day
   block date-exclusivity, multi-staff serialization, a failed reschedule
   reverting instead of optimistically persisting, a stale tenant-switch
   mid-request being dropped silently, and a failed Google sync staying
   visible with a working retry. */
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
    await page.goto(base + '/tests/fixtures/job-calendar.html');
    await page.addStyleTag({ path: path.resolve('job-calendar.css') });
    if(process.env.TURNKEY_CALENDAR_SDK)await page.addScriptTag({path:process.env.TURNKEY_CALENDAR_SDK});

    await page.evaluate(() => {
      // Stand in for index.html's own globals/functions that job-calendar.js wraps or reads.
      window.renderAllCalls = 0;
      window.renderAll = function () { window.renderAllCalls++; };
      window.toast = function (m) { window.lastToast = m; };
      window.closeModal = function (id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); };
      window.switchView = function (v) {
        document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
        const el = document.getElementById('view-' + v); if (el) el.classList.add('active');
        document.querySelectorAll('nav.tabs button[data-view], .bottom-nav button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
        if (v === 'calendar' && typeof window.renderCalendar === 'function') window.renderCalendar();
      };
      window.openMoreSheet = function () {
        document.getElementById('more-body').innerHTML = '<div class="more-group-label">Overview</div><button class="more-row">Dashboard</button>';
      };
      // Mirrors index.html's own delegated nav-click wiring (#tabs/#bottom-nav -> switchView(dataset.view)).
      document.getElementById('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) window.switchView(b.dataset.view); });
      document.getElementById('bottom-nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) window.switchView(b.dataset.view); });
    });
    await page.addScriptTag({ path: path.resolve('job-calendar.js') });

    await page.evaluate(() => {
      window.fixture = {
        business: 'biz-a', userId: 'owner-1', version: 0, canManage: true,
        staff: [
          { id: 'owner-1', name: 'Owner One', email: 'owner@test.example', role: 'owner' },
          { id: 'tech-1', name: 'Tech One', email: 'tech@test.example', role: 'technician' }
        ],
        jobs: [
          { id: 'job-1', status: 'scheduled', assigned_to: null, scheduled_date: '2026-07-10', updated_at: '2026-07-01T00:00:00.000Z',
            customer: { name: 'Alice', address: '1 Test St', suburb: 'Testville' },
            details: { calendarStartAt: '2026-07-10T09:00:00.000Z', calendarEndAt: '2026-07-10T11:00:00.000Z', scheduledStartMin: null, scheduledDurationMin: null, assignedStaffIds: ['owner-1'], calendarTeamLabel: null, calendarNotes: '', calendarGoogleSync: false, googleEventId: null } },
          { id: 'job-2', status: 'scheduled', assigned_to: null, scheduled_date: null, updated_at: '2026-07-01T00:00:00.000Z',
            customer: { name: 'Bob', address: '2 Test Rd', suburb: 'Suburbia' },
            details: { calendarStartAt: null, calendarEndAt: null, scheduledStartMin: null, scheduledDurationMin: null, assignedStaffIds: [], calendarTeamLabel: null, calendarNotes: '', calendarGoogleSync: false, googleEventId: null } },
          { id: 'job-3', status: 'scheduled', assigned_to: null, scheduled_date: '2026-07-12', updated_at: '2026-07-01T00:00:00.000Z',
            customer: { name: 'Carol', address: '3 Test Rd', suburb: 'Town' },
            details: { calendarStartAt: '2026-07-12T01:00:00.000Z', calendarEndAt: '2026-07-12T03:00:00.000Z', scheduledStartMin: null, scheduledDurationMin: null, assignedStaffIds: ['owner-1'], calendarTeamLabel: null, calendarNotes: '', calendarGoogleSync: true, googleEventId: null, calendarGoogleSyncError: 'Rate limited' } }
        ],
        events: [], blocks: [], google: { connected: false },
        calls: [], putError: null, delayPut: false, putResolver: null
      };
      window.TK_JOB_CALENDAR.configure({
        getBusinessId: () => fixture.business,
        getUserId: () => fixture.userId,
        getVersion: () => fixture.version,
        notify: (m) => { window.lastNotify = m; },
        request: async (p, options) => {
          fixture.calls.push({ path: p, options });
          if (p.startsWith('/range')) return structuredClone({ jobs: fixture.jobs, staff: fixture.staff, events: fixture.events, blocks: fixture.blocks, google: fixture.google, canManage: fixture.canManage });
          if (options && options.method === 'PUT' && p.startsWith('/jobs/')) {
            const jobId = p.split('/jobs/')[1];
            const run = () => {
              if (fixture.putError) throw new Error(fixture.putError);
              const body = JSON.parse(options.body);
              const idx = fixture.jobs.findIndex((j) => j.id === jobId);
              const updated = { ...fixture.jobs[idx], details: { ...fixture.jobs[idx].details, calendarStartAt: body.startAt, calendarEndAt: body.endAt, assignedStaffIds: body.staffIds, calendarTeamLabel: body.teamLabel, calendarNotes: body.notes, calendarGoogleSync: body.syncGoogle } };
              fixture.jobs[idx] = updated;
              return { job: updated };
            };
            if (fixture.delayPut) return new Promise((resolve, reject) => { fixture.putResolver = () => { try { resolve(run()); } catch (e) { reject(e); } }; });
            return run();
          }
          if (options && options.method === 'POST' && p.endsWith('/google')) {
            const jobId = p.split('/jobs/')[1].split('/google')[0];
            const idx = fixture.jobs.findIndex((j) => j.id === jobId);
            const updated = { ...fixture.jobs[idx], details: { ...fixture.jobs[idx].details, googleEventId: 'evt-123', calendarGoogleSyncError: null } };
            fixture.jobs[idx] = updated;
            return { job: updated };
          }
          if (options && options.method === 'POST' && p === '/blocks') {
            const body = JSON.parse(options.body);
            fixture.blocks.push(body);
            return { block: body };
          }
          if (options && options.method === 'DELETE' && p.startsWith('/blocks/')) {
            const id = p.split('/blocks/')[1];
            fixture.blocks = fixture.blocks.filter((b) => b.id !== id);
            return { ok: true };
          }
          return {};
        }
      });
    });

    /* ===== 1. nav patch (desktop) + page renders via switchView ===== */
    await page.locator('.sidebar-nav button[data-view="calendar"]').waitFor();
    await page.locator('.sidebar-nav button[data-view="calendar"]').click();
    assert.equal(await page.evaluate(() => document.getElementById('view-calendar').classList.contains('active')), true);
    await page.locator('.tkjc-sidebar-row').first().waitFor();
    const sidebarText = await page.locator('#tkjc-sidebar-list').innerText();
    assert.match(sidebarText, /Bob/); // unscheduled
    assert.match(sidebarText, /Alice/); // scheduled, in range

    /* ===== 2. mobile More sheet gets a Calendar row ===== */
    await page.evaluate(() => { document.getElementById('view-dashboard').classList.add('active'); document.getElementById('view-calendar').classList.remove('active'); window.openMoreSheet(); });
    await page.locator('[data-tkjc-more="calendar"]').waitFor();
    await page.locator('[data-tkjc-more="calendar"]').click();
    assert.equal(await page.evaluate(() => document.getElementById('view-calendar').classList.contains('active')), true);

    /* ===== 3. floating launcher's Calendar button is redirected here ===== */
    await page.evaluate(() => {
      document.getElementById('view-dashboard').classList.add('active'); document.getElementById('view-calendar').classList.remove('active');
      const bar = document.createElement('div'); bar.id = 'tkj-launcher';
      bar.innerHTML = '<button data-tkj="calendar">Staff calendar</button>';
      bar.querySelector('button').addEventListener('click', () => { window.oldCalendarOpened = true; });
      document.body.appendChild(bar);
      window.oldCalendarOpened = false;
    });
    await page.locator('#tkj-launcher [data-tkj="calendar"]').click();
    assert.equal(await page.evaluate(() => window.oldCalendarOpened), false); // old handler never ran
    assert.equal(await page.evaluate(() => document.getElementById('view-calendar').classList.contains('active')), true);

    /* ===== 4. multi-staff serialization (crew booking) ===== */
    await page.click('[data-tkjc="book"]');
    await page.locator('#tkjc-booking-overlay').waitFor();
    await page.selectOption('#tkjc-booking-overlay [data-tkjc-field="jobId"]', 'job-2');
    await page.fill('#tkjc-booking-overlay [data-tkjc-field="date"]', '2026-07-15');
    await page.fill('#tkjc-booking-overlay [data-tkjc-field="startTime"]', '08:30');
    await page.fill('#tkjc-booking-overlay [data-tkjc-field="duration"]', '90');
    await page.check('#tkjc-booking-overlay input[data-tkjc-staff][value="owner-1"]');
    await page.check('#tkjc-booking-overlay input[data-tkjc-staff][value="tech-1"]');
    await page.fill('#tkjc-booking-overlay [data-tkjc-field="teamLabel"]', 'Deck crew');
    await page.click('#tkjc-booking-overlay [data-tkjc="save"]');
    await page.locator('#tkjc-booking-overlay').waitFor({ state: 'detached' });
    const putCall = await page.evaluate(() => fixture.calls.filter((c) => c.options && c.options.method === 'PUT').pop());
    const putBody = JSON.parse(putCall.options.body);
    assert.deepEqual(putBody.staffIds.sort(), ['owner-1', 'tech-1']);
    assert.equal(putBody.teamLabel, 'Deck crew');
    assert.equal(putBody.dateISO, '2026-07-15');
    assert.equal(putBody.startMin, 8 * 60 + 30);
    assert.match(putBody.startAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    /* ===== 5. reschedule failure reverts — error shown, job unchanged ===== */
    await page.evaluate(() => { fixture.putError = 'Could not reach backend'; });
    await page.locator('[data-tkjc-job="job-1"]').click();
    await page.locator('#tkjc-booking-overlay').waitFor();
    await page.fill('#tkjc-booking-overlay [data-tkjc-field="startTime"]', '14:00');
    await page.click('#tkjc-booking-overlay [data-tkjc="save"]');
    await page.locator('#tkjc-booking-overlay #tkjc-booking-msg', { hasText: 'Could not reach backend' }).waitFor();
    assert.equal(await page.locator('#tkjc-booking-overlay').count(), 1); // still open, not closed as if it succeeded
    const job1Unchanged = await page.evaluate(() => fixture.jobs.find((j) => j.id === 'job-1').details.calendarStartAt);
    assert.equal(job1Unchanged, '2026-07-10T09:00:00.000Z'); // untouched
    await page.evaluate(() => { fixture.putError = null; });
    await page.click('#tkjc-booking-overlay [data-tkjc="cancel"]');

    /* ===== 6. stale tenant-switch mid-request is dropped silently ===== */
    await page.evaluate(() => { fixture.delayPut = true; });
    await page.locator('[data-tkjc-job="job-1"]').click();
    await page.locator('#tkjc-booking-overlay').waitFor();
    await page.fill('#tkjc-booking-overlay [data-tkjc-field="startTime"]', '16:00');
    await page.click('#tkjc-booking-overlay [data-tkjc="save"]');
    await page.evaluate(() => { fixture.business = 'biz-b'; }); // tenant switches while PUT is in flight
    await page.evaluate(() => { fixture.putResolver && fixture.putResolver(); });
    await page.waitForTimeout(150);
    await page.locator('#tkjc-booking-overlay').waitFor({state:'detached'});
    await page.evaluate(() => { fixture.business = 'biz-a'; fixture.delayPut = false; });
    // Reopen job-1 from this module's own (still business-a-scoped) in-memory state — never reloaded in between — to prove the stale write's response never got applied to it, even though the fake backend itself did persist it server-side.
    await page.locator('[data-tkjc-job="job-1"]').click();
    await page.locator('#tkjc-booking-overlay').waitFor();
    assert.equal(await page.locator('#tkjc-booking-overlay [data-tkjc-field="startTime"]').inputValue(), '21:00');
    await page.click('#tkjc-booking-overlay [data-tkjc="cancel"]');

    /* ===== 7. Google sync failure stays visible with a working retry ===== */
    await page.evaluate(() => { document.getElementById('view-dashboard').classList.add('active'); document.getElementById('view-calendar').classList.remove('active'); window.switchView('calendar'); });
    await page.locator('.tkjc-sidebar-row').first().waitFor();
    await page.locator('[data-tkjc-job="job-3"]').click();
    await page.locator('#tkjc-booking-overlay').waitFor();
    assert.match(await page.locator('.tkjc-google-job').innerText(), /Google sync failed: Rate limited/);
    await page.click('#tkjc-booking-overlay [data-tkjc="retry-google"]');
    await page.locator('#tkjc-booking-overlay').waitFor({ state: 'detached' });
    const job3AfterRetry = await page.evaluate(() => fixture.jobs.find((j) => j.id === 'job-3').details.googleEventId);
    assert.equal(job3AfterRetry, 'evt-123');

    /* ===== 8. role gating — technician can't book others or pick a crew ===== */
    await page.evaluate(() => { fixture.canManage = false; fixture.userId = 'tech-1'; });
    await page.evaluate(() => window.switchView('calendar'));
    await page.locator('.tkjc-sidebar-row').first().waitFor();
    await page.locator('[data-tkjc-job="job-1"]').click();
    await page.locator('#tkjc-booking-overlay').waitFor();
    assert.equal(await page.locator('#tkjc-booking-overlay [data-tkjc="save"]').count(), 0); // read-only, no save
    assert.equal(await page.locator('#tkjc-booking-overlay [data-tkjc-field="date"]').isDisabled(), true);
    await page.click('#tkjc-booking-overlay [data-tkjc="cancel"]');

    await page.click('[data-tkjc="block"]');
    await page.locator('#tkjc-block-overlay').waitFor();
    const staffSelect = page.locator('#tkjc-block-overlay [data-tkjc-field="staffId"]');
    assert.equal(await staffSelect.isDisabled(), true);
    assert.equal(await staffSelect.inputValue(), 'tech-1'); // forced to self, can't block someone else's time

    /* ===== 9. native block all-day is exclusive on the end date (DST-safe setDate, not +86400000) ===== */
    await page.fill('#tkjc-block-overlay [data-tkjc-field="startDate"]', '2026-07-20');
    await page.fill('#tkjc-block-overlay [data-tkjc-field="endDate"]', '2026-07-20');
    await page.selectOption('#tkjc-block-overlay [data-tkjc-field="blockType"]', 'sick');
    await page.click('#tkjc-block-overlay [data-tkjc="save"]');
    await page.locator('#tkjc-block-overlay').waitFor({ state: 'detached' });
    const blockCall = await page.evaluate(() => fixture.calls.filter((c) => c.options && c.options.method === 'POST' && c.path === '/blocks').pop());
    const blockBody = JSON.parse(blockCall.options.body);
    assert.equal(blockBody.allDay, true);
    assert.equal(blockBody.staffId, 'tech-1');
    const startLocal = await page.evaluate((iso) => new Date(iso).toLocaleDateString('en-NZ'), blockBody.startAt);
    const endLocal = await page.evaluate((iso) => new Date(iso).toLocaleDateString('en-NZ'), blockBody.endAt);
    assert.equal(startLocal, '20/07/2026');
    assert.equal(endLocal, '21/07/2026'); // inclusive UI end date -> exclusive next local midnight

    assert.deepEqual(errors, []);
    await page.close();
    console.log('Job calendar UI passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
