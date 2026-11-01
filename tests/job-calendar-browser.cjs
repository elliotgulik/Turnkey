/* Offline UI checks for job-calendar.js: only fixture responses via
   TK_JOB_CALENDAR.configure(), all real network requests blocked. No
   FullCalendar CDN requests are made: this exercises the built-in fallback
   agenda plus a strict lifecycle double (set TURNKEY_CALENDAR_SDK to a local
   FullCalendar script to also exercise the real renderer end-to-end) — same data flow and
   payload-building code the FullCalendar drag/resize handlers call into.
   Covers: nav patch (desktop + mobile More sheet), the floating launcher's
   "Staff calendar" button being redirected here instead of opening the old
   actual-hours modal, role gating (owner/manager vs technician), all-day
   block date-exclusivity, multi-staff serialization, a failed reschedule
   reverting instead of optimistically persisting, a stale tenant-switch
   mid-request being dropped silently, and a failed Google sync staying
   visible with a working retry. Also covers coalesced range loads, saved
   data during errors and navigation, stale reads after writes/session changes,
   completed deduplication, remote staff filters, bounded auth/body reads,
   cached session validation and DB-only disconnect/focus polling. */
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
    await page.clock.setFixedTime(new Date('2026-07-15T00:00:00Z'));
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
    await page.goto(base + '/tests/fixtures/job-calendar.html');
    await page.addStyleTag({ path: path.resolve('job-calendar.css') });
    await page.addStyleTag({ path: path.resolve('mobile-experience.css') });
    await page.addScriptTag({ path: path.resolve('servicem8-pricing-view.js') });
    if(process.env.TURNKEY_CALENDAR_SDK)await page.addScriptTag({path:process.env.TURNKEY_CALENDAR_SDK});

    await page.evaluate(() => {
      // Stand in for index.html's own globals/functions that job-calendar.js wraps or reads.
      window.renderAllCalls = 0;
      window.renderAll = function () { window.renderAllCalls++; };
      window.toast = function (m) { window.lastToast = m; };
      window.weatherForDate = (iso) => iso === '2026-07-20' ? { type:'forecast', cond:'Mostly fine', tempHi:18, rainPct:10, windKmh:12, label:'Good working conditions' } : { type:'unavailable' };
      window.calendarDayWeatherBadge = () => ({ label:'Excellent', cls:'good', forecast:true });
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
    if (process.env.TURNKEY_CALENDAR_SDK) await page.evaluate(() => {
      const Calendar = FullCalendar.Calendar;
      FullCalendar.Calendar = class extends Calendar { constructor(...args) { super(...args); window.testFc = this; } };
    });
    await page.addScriptTag({ path: path.resolve('job-calendar.js') });

    await page.evaluate(() => {
      window.fixture = {
        business: 'biz-a', userId: 'owner-1', version: 0, canManage: true,
        staff: [
          { id: 'owner-1', name: 'Owner One', email: 'owner@test.example', role: 'owner' },
          { id: 'tech-1', name: 'Tech One', email: 'tech@test.example', role: 'technician' },
          { id:'servicem8:remote-1',name:'Jordan Lee',email:'remote@example.test',role:'servicem8',source:'servicem8',readOnly:true }
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
          ,{ id: 'job-4', status: 'completed', assigned_to: null, scheduled_date: '2026-07-02', updated_at: '2026-07-02T00:00:00.000Z',
            customer: { name: 'Done Customer', address: '4 Test Rd', suburb: 'Town' }, details: {} }
        ],
        events: [], blocks: [], google: { connected: false },
        calls: [], realtimeHandlers: [], putError: null, delayPut: false, putResolver: null
      };
      const supabase = { channel() { const channel = { on(_event, _filter, handler) { fixture.realtimeHandlers.push(handler); return channel; }, subscribe() { return channel; } }; return channel; }, removeChannel() {} };
      window.TK_JOB_CALENDAR.configure({
        supabase,
        getBusinessId: () => fixture.business,
        getUserId: () => fixture.userId,
        getVersion: () => fixture.version,
        notify: (m) => { window.lastNotify = m; },
        request: async (p, options) => {
          fixture.calls.push({ path: p, options });
          if (p === '/events' && options?.method === 'POST') {
            if (fixture.eventError) throw Error(fixture.eventError);
            const b = JSON.parse(options.body);
            const event = { id: b.id, user_id: b.staffId, title: b.title, start_time: b.startAt, end_time: b.endAt, busy_status: b.busyStatus, notes: b.notes, source: 'turnkey', connection_id: null, external_id: null };
            fixture.events = fixture.events.filter(e => e.id !== b.id).concat(event); return { event };
          }
          if (p.startsWith('/events/') && options?.method === 'DELETE') {
            fixture.events = fixture.events.filter(e => e.id !== p.split('/')[2]); return { ok: true };
          }
          if (p.endsWith('/unschedule') && options?.method === 'POST') {
            const j = fixture.jobs.find(j => j.id === p.split('/')[2]);
            j.scheduled_date = null; delete j.details.calendarStartAt; delete j.details.calendarEndAt;
            delete j.details.scheduledStartMin; delete j.details.scheduledDurationMin; j.details.calendarGoogleSync = false;
            return { job: structuredClone(j), googleWarning: 'Google copy remains unchanged.' };
          }
          if (p.startsWith('/range')) return structuredClone({ jobs: fixture.jobs, staff: fixture.staff, events: fixture.events, blocks: fixture.blocks, google: fixture.google, canManage: fixture.canManage });
          if (p === '/servicem8/sync' && options?.method === 'POST') {
            fixture.calls.push({ dispatchSync: JSON.parse(options.body) });
            fixture.events = fixture.events.filter(e => e.source !== 'servicem8').concat({ id: 'sm8-booking', user_id: null,
              title: 'Nova Exterior · House wash', source: 'servicem8', connection_id: null, external_id: 'activity-1', busy_status: 'busy',
              start_time: '2026-07-20T01:00:00.000Z', end_time: '2026-07-20T02:00:00.000Z', notes: 'ServiceM8 job',
              details: { personName:'Alex Smith', companyName:'Nova Exterior', email:'alex@example.test', phone:'021 555 0100', address:'29 Selwyn Cres', services:['House wash'], lineItems:[{name:'House wash',quantity:'1'}], assignedStaff:['Jordan Lee'], assignedStaffIds:['servicem8:remote-1'], status:'Work Order' } });
            return { synced: 1, reconciledCompleted: 1 };
          }
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
            if (fixture.blockError) throw Error(fixture.blockError);
            const block = { id: body.id, user_id: body.staffId, block_type: body.blockType, start_at: body.startAt, end_at: body.endAt, all_day: body.allDay, reason: body.reason };
            fixture.blocks = fixture.blocks.filter(b => b.id !== body.id).concat(block);
            return { block, conflictingJobs: 1 };
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
    const rangeCount = await page.evaluate(() => fixture.calls.filter(c => c.path?.startsWith('/range')).length);
    await page.waitForFunction(() => fixture.calls.some(c => c.dispatchSync));
    assert.equal(await page.locator('[data-tkjc="sync-servicem8"]').count(), 0);
    assert.equal(await page.locator('#tkjc-load-status').isHidden(), true);
    await page.waitForFunction(before => fixture.calls.filter(c => c.path?.startsWith('/range')).length > before, rangeCount);
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    const seededRangeCount = await page.evaluate(() => fixture.calls.filter(c => c.path?.startsWith('/range')).length);
    await page.evaluate(() => { window.renderAll(); for (let i = 0; i < 10; i++) window.renderCalendar(); });
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.path?.startsWith('/range')).length), seededRangeCount, 'app renders do not restart calendar fetches');
    await page.evaluate(() => fixture.realtimeHandlers[0]?.());
    await page.waitForFunction((before) => fixture.calls.filter(c => c.path?.startsWith('/range')).length > before, seededRangeCount);
    assert.equal(await page.evaluate(() => fixture.calls.some(c => c.dispatchSync && !('from' in c.dispatchSync))), true);
    assert.match(await page.locator('#tkjc-main').innerText(), /Nova Exterior · House wash/);
    await page.click('[data-tkjc-section="completed"]');
    assert.match(await page.locator('#tkjc-main').innerText(), /Done Customer/);
    await page.click('[data-tkjc-section="schedule"]');
    if (process.env.TURNKEY_CALENDAR_SDK) await page.locator('.fc-event-title').filter({hasText:'Nova Exterior'}).first().click();
    else await page.locator('[data-tkjc-agenda-event="sm8-booking"]').click();
    const dispatchDetail = await page.locator('#tkjc-event-overlay').innerText();
    assert.match(dispatchDetail, /Alex Smith/);
    assert.match(dispatchDetail, /29 Selwyn Cres/);
    assert.match(dispatchDetail, /Jordan Lee/);
    assert.match(dispatchDetail, /Forecast/);
    await page.locator('#tkjc-event-overlay [data-tkjc="close"]').click();

    await page.click('[data-tkjc-chip="servicem8:remote-1"]');
    assert.match(await page.locator('#tkjc-main').innerText(), /Nova Exterior/);
    assert.doesNotMatch(await page.locator('#tkjc-sidebar-list').innerText(), /Alice/);
    await page.click('[data-tkjc="clear-filters"]');

    // Imported WorkOrders also exist as real jobs. Keep every persisted
    // dispatch activity, hiding only the matching local job's calendar card.
    await page.evaluate(async () => {
      const dispatch = fixture.events.find(e => e.id === 'sm8-booking');
      dispatch.details.jobUuid = 'sm8-local-match';
      dispatch.details.pricing = {items:[
        {name:'House wash <actual>',quantity:3,unitPrice:50,lineTotal:131.75},
        {name:'Free inspection',quantity:1,unitPrice:0,lineTotal:0},
        {name:'Roof price unknown',quantity:2,unitPrice:25,lineTotal:null}
      ],total:777.23,currency:'NZD',taxLabel:'GST inclusive',lineTaxLabel:'Lines exclude GST',updatedAt:'2026-07-14T00:00:00Z'};
      fixture.events.push({...structuredClone(dispatch),id:'sm8-second-day',external_id:'activity-2',
        start_time:'2026-07-21T01:00:00.000Z',end_time:'2026-07-21T02:00:00.000Z'});
      fixture.events.push({...structuredClone(dispatch),id:'sm8-second-staff',external_id:'activity-3',
        details:{...structuredClone(dispatch.details),assignedStaff:['Jordan Lee','Second crew member'],assignedStaffIds:['servicem8:remote-1','servicem8:remote-2']}});
      fixture.staff.push({id:'servicem8:remote-2',name:'Second crew member',source:'servicem8',role:'servicem8',readOnly:true});
      const local = {id:'local-import',status:'scheduled',scheduled_date:'2026-07-20',customer:{name:'Imported local job'},
        details:{serviceM8JobUuid:'sm8-local-match',serviceM8Booking:{startAt:dispatch.start_time,endAt:dispatch.end_time},
          pricing:{...structuredClone(dispatch.details.pricing),total:222.22}}};
      fixture.jobs.push(local,{...structuredClone(local),id:'unmatched-import',customer:{name:'Unmatched imported job'},
        details:{...structuredClone(local.details),serviceM8JobUuid:'sm8-no-dispatch'}});
      window.records = [{id:'record-ui-id',jobId:'local-import',customerId:'customer-id'}];
      window.openDetail = id => {window.openedRecord = id;};
      window.openCustomerProfile = id => {window.openedCustomer = id;};
      await TK_JOB_CALENDAR.refresh();
    });
    if (process.env.TURNKEY_CALENDAR_SDK) {
      assert.deepEqual(await page.evaluate(() => ({
        local:!!testFc.getEventById('job:local-import'),unmatched:!!testFc.getEventById('job:unmatched-import'),
        dispatch:testFc.getEvents().filter(e => ['event:sm8-booking','event:sm8-second-day','event:sm8-second-staff'].includes(e.id)).length,
        readOnly:testFc.getEvents().filter(e => ['event:sm8-booking','event:sm8-second-day','event:sm8-second-staff'].includes(e.id)).every(e => e.startEditable === false)
      })), {local:false,unmatched:true,dispatch:3,readOnly:true});
    } else {
      assert.equal(await page.locator('[data-tkjc-agenda-job="local-import"]').count(), 0);
      assert.equal(await page.locator('[data-tkjc-agenda-job="unmatched-import"]').count(), 1);
      assert.equal(await page.locator('[data-tkjc-agenda-event="sm8-booking"], [data-tkjc-agenda-event="sm8-second-day"], [data-tkjc-agenda-event="sm8-second-staff"]').count(), 3);
    }
    assert.equal(await page.locator('[data-tkjc-chip="servicem8:remote-2"]').count(), 1, 'all remote staff remain available');
    const openDispatch = async () => {
      if (process.env.TURNKEY_CALENDAR_SDK) await page.locator('.fc-event-title').filter({hasText:'Nova Exterior'}).first().click();
      else await page.locator('[data-tkjc-agenda-event="sm8-booking"]').click();
    };
    await openDispatch();
    assert.equal(await page.locator('#tkjc-event-overlay input, #tkjc-event-overlay select').count(), 0, 'remote booking dates stay read-only');
    assert.match(await page.locator('#tkjc-event-overlay').innerText(), /Jordan Lee/);
    const upstreamPanel = page.locator('#tkjc-event-overlay .tk-sm8-pricing');
    assert.equal(await upstreamPanel.count(), 1, 'pricing panel replaces the old service-name list');
    await upstreamPanel.locator('summary').click();
    const pricingText = await upstreamPanel.innerText();
    assert.match(pricingText, /House wash <actual>/);
    assert.match(pricingText, /Qty 3.*50\.0 each/);
    assert.match(pricingText, /131\.8/);
    assert.match(pricingText, /777\.2/);
    assert.match(pricingText, /GST inclusive/);
    assert.match(pricingText, /Lines exclude GST/);
    assert.match(pricingText, /Updated/);
    assert.match(await upstreamPanel.locator('li').nth(1).innerText(), /0\.0/);
    assert.match(await upstreamPanel.locator('li').nth(2).innerText(), /Price unavailable/);
    assert.equal(await upstreamPanel.locator('actual').count(), 0, 'service names are escaped by the shared helper');
    await page.click('[data-tkjc="open-record"]');
    assert.equal(await page.evaluate(() => openedRecord), 'record-ui-id', 'openDetail receives the app record id, not job id');
    await openDispatch();
    await page.click('[data-tkjc="open-customer"]');
    assert.equal(await page.evaluate(() => openedCustomer), 'record-ui-id', 'customer profile expects the app record id');
    // Linked local booking uses its own supplied snapshot, including a
    // top-level record snapshot. Unknown totals are never reconstructed.
    await page.locator('[data-tkjc-job="local-import"]').click();
    assert.match(await page.locator('#tkjc-booking-overlay .tk-sm8-pricing').innerText(), /222\.2/);
    assert.equal(await page.locator('#tkjc-booking-overlay [data-tkjc-field="date"]').isDisabled(), true);
    assert.equal(await page.locator('#tkjc-booking-overlay [data-tkjc="save"]').count(), 0);
    await page.click('#tkjc-booking-overlay [data-tkjc="cancel"]');
    await page.evaluate(async () => {
      fixture.jobs.find(j => j.id === 'local-import').serviceM8Pricing = {items:[{name:'Unknown-priced work',quantity:2,unitPrice:25,lineTotal:null}],total:null,currency:'NZD'};
      fixture.events.filter(e => e.source === 'servicem8').forEach(e => {e.details.pricing = {items:[],total:null,currency:'NZD'};});
      await TK_JOB_CALENDAR.refresh();
    });
    await page.locator('[data-tkjc-job="local-import"]').click();
    await page.locator('#tkjc-booking-overlay .tk-sm8-pricing summary').click();
    assert.match(await page.locator('#tkjc-booking-overlay .tk-sm8-pricing').innerText(), /Price unavailable/);
    assert.equal(await page.locator('#tkjc-booking-overlay .tk-sm8-pricing-total strong').innerText(), 'Unavailable');
    await page.click('#tkjc-booking-overlay [data-tkjc="cancel"]');
    await openDispatch();
    await page.locator('#tkjc-event-overlay .tk-sm8-pricing summary').click();
    assert.match(await page.locator('#tkjc-event-overlay .tk-sm8-pricing').innerText(), /has not supplied itemised prices/);
    assert.equal(await page.locator('#tkjc-event-overlay .tk-sm8-pricing-total strong').innerText(), 'Unavailable');
    await page.click('#tkjc-event-overlay [data-tkjc="close"]');
    // A snapshot absent from an event may still be available on its linked job.
    await page.evaluate(async () => {
      fixture.events.filter(e => e.source === 'servicem8').forEach(e => {delete e.details.pricing;});
      await TK_JOB_CALENDAR.refresh();
    });
    await openDispatch();
    await page.locator('#tkjc-event-overlay .tk-sm8-pricing summary').click();
    assert.match(await page.locator('#tkjc-event-overlay .tk-sm8-pricing').innerText(), /Unknown-priced work/);
    await page.click('#tkjc-event-overlay [data-tkjc="close"]');
    await page.evaluate(() => {window.records = [];window.openedRecord = null;});
    await openDispatch();
    await page.click('[data-tkjc="open-record"]');
    assert.equal(await page.evaluate(() => openedRecord), null);
    assert.match(await page.evaluate(() => lastNotify), /Refresh the app/);
    await page.click('#tkjc-event-overlay [data-tkjc="close"]');
    await page.evaluate(async () => {
      fixture.jobs = fixture.jobs.filter(j => !['local-import','unmatched-import'].includes(j.id));
      fixture.events = fixture.events.filter(e => !['sm8-second-day','sm8-second-staff'].includes(e.id));
      fixture.staff = fixture.staff.filter(u => u.id !== 'servicem8:remote-2');
      await TK_JOB_CALENDAR.refresh();
    });
    await openDispatch();
    assert.equal(await page.locator('[data-tkjc="open-record"], [data-tkjc="open-customer"]').count(), 0, 'unmatched dispatch has no local record actions');
    assert.match(await page.locator('#tkjc-event-overlay').innerText(), /ServiceM8 prices unavailable/);
    await page.click('#tkjc-event-overlay [data-tkjc="close"]');

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
    assert.equal(await page.locator('#tkjc-booking-overlay input[value^="servicem8:"]').count(), 0);
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
    assert.equal(await staffSelect.locator('option[value^="servicem8:"]').count(), 0);
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


    // Native appointment create/edit/delete through visible UI, including retry.
    await page.click('[data-tkjc="event"]');
    assert.equal(await page.locator('[data-event="staff"]').isDisabled(), true);
    assert.equal(await page.locator('[data-event="staff"] option[value^="servicem8:"]').count(), 0);
    await page.fill('[data-event="title"]', 'Site visit <safe>');
    await page.fill('[data-event="start"]', '2026-07-20T10:00');
    await page.fill('[data-event="end"]', '2026-07-20T11:00');
    await page.fill('[data-event="notes"]', 'Access gate');
    await page.screenshot({path:process.env.TURNKEY_CALENDAR_SDK ? '/tmp/calendar-appointment-fullcalendar.png' : '/tmp/calendar-appointment-agenda.png'});
    await page.evaluate(() => { fixture.eventError = 'Scheduling conflict'; });
    await page.click('[data-event="save"]');
    await page.waitForFunction(() => document.querySelector('[data-event="message"]').textContent.includes('conflict'));
    const firstId = await page.evaluate(() => JSON.parse(fixture.calls.filter(c => c.path === '/events').at(-1).options.body).id);
    await page.evaluate(() => { fixture.eventError = null; });
    await page.click('[data-event="save"]');
    await page.locator('#tkjc-event-overlay').waitFor({state:'detached'});
    const created = await page.evaluate((id) => fixture.events.find(event => event.id === id), firstId);
    assert.equal(created.id, firstId); assert.equal(created.user_id, 'tech-1');
    assert.equal(created.title, 'Site visit <safe>');
    if (!process.env.TURNKEY_CALENDAR_SDK) {
      await page.locator('[data-tkjc-agenda-event="' + created.id + '"]').click();
    } else {
      await page.locator('.fc-event-title').filter({hasText:'Site visit <safe>'}).first().click();
    }
    await page.fill('[data-event="title"]', 'Edited visit');
    await page.selectOption('[data-event="busy"]', 'free');
    await page.click('[data-event="save"]');
    await page.locator('#tkjc-event-overlay').waitFor({state:'detached'});
    assert.equal(await page.evaluate(id => fixture.events.find(event => event.id === id).busy_status, created.id), 'free');

    // Imported rows never expose a writable form, even to an owner.
    await page.evaluate(() => {
      fixture.canManage = true; fixture.userId = 'owner-1';
      fixture.events.push({id:'google-readonly',user_id:'owner-1',title:'Google meeting',source:'external',connection_id:'connection',external_id:'remote',start_time:'2026-07-20T01:00Z',end_time:'2026-07-20T02:00Z',busy_status:'busy'});
      window.TK_JOB_CALENDAR.refresh();
    });
    await page.waitForTimeout(150);
    if (!process.env.TURNKEY_CALENDAR_SDK) {
      await page.locator('[data-tkjc-agenda-event="google-readonly"]').click();
      assert.equal(await page.locator('[data-event="save"]').count(),0);
      assert.equal(await page.locator('[data-event="delete"]').count(),0);
      await page.click('[data-event="close"]');
    }

    // Exercise a real pointer drag in the rendered FullCalendar month grid.
    if (process.env.TURNKEY_CALENDAR_SDK) {
      const source = page.locator('.fc-daygrid-event').filter({hasText:'Edited visit'}).first();
      const box = await source.boundingBox();
      const cell = await page.locator('.fc-daygrid-day[data-date="2026-07-20"]').boundingBox();
      const before = await page.evaluate(() => fixture.calls.filter(c => c.path === '/events').length);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.move(box.x + box.width / 2 + cell.width, box.y + box.height / 2, {steps:12});
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForFunction(n => fixture.calls.filter(c => c.path === '/events').length > n, before);
    }

    // FullCalendar callbacks receive actual EventApi objects, persist events/
    // blocks, and invoke revert on failure. Also verify per-event editability.
    if (process.env.TURNKEY_CALENDAR_SDK) {
      await page.evaluate(() => {
        const events = window.testFc.getEvents();
        const native = events.find(e => e.id.startsWith('event:') && e.title === 'Edited visit');
        const imported = events.find(e => e.id === 'event:google-readonly');
        const block = events.find(e => e.id.startsWith('block:'));
        if (!native.startEditable || imported.startEditable || !block.startEditable) throw Error('Incorrect edit permissions');
        window.reverts = 0;
        window.testNativeId = native.id;
        native.setDates(new Date('2026-07-21T01:00Z'),new Date('2026-07-21T03:00Z'));
        window.testFc.getOption('eventDrop')({event:native,revert(){window.reverts++;}});
      });
      await page.waitForFunction(() => fixture.events.find(e => e.title === 'Edited visit').start_time === '2026-07-21T01:00:00.000Z');
      await page.evaluate(() => {
        fixture.eventError = 'conflict';
        const event = testFc.getEventById(testNativeId);
        testFc.getOption('eventResize')({event,revert(){window.reverts++;}});
      });
      await page.waitForFunction(() => window.reverts === 1);
      await page.evaluate(() => {
        fixture.eventError = null;
        const block = testFc.getEvents().find(e => e.id.startsWith('block:'));
        block.setDates(new Date('2026-07-22T00:00Z'),new Date('2026-07-23T00:00Z'),{allDay:true});
        window.expectedBlockStart = block.start.toISOString();
        testFc.getOption('eventDrop')({event:block,revert(){window.reverts++;}});
      });
      await page.waitForFunction(() => fixture.calls.some(c => c.path === '/blocks' && JSON.parse(c.options.body).startAt === window.expectedBlockStart));
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        fixture.blockError = 'block failure';
        const block = testFc.getEvents().find(e => e.id.startsWith('block:'));
        testFc.getOption('eventResize')({event:block,revert(){window.reverts++;}});
      });
      await page.waitForFunction(() => window.reverts === 2);
      await page.evaluate(() => { fixture.blockError = null; });
    }
    // Delete a native event in either renderer.
    if (!process.env.TURNKEY_CALENDAR_SDK) await page.locator('[data-tkjc-agenda-event="' + created.id + '"]').click();
    else await page.locator('.fc-event-title').filter({hasText:'Edited visit'}).first().click();
    page.once('dialog', d => d.accept());
    await page.click('[data-event="delete"]');
    await page.locator('#tkjc-event-overlay').waitFor({state:'detached'});
    assert.equal(await page.evaluate(() => fixture.events.some(e => e.title === 'Edited visit')),false);

    // Explicit unschedule preserves stage/customer and exposes Google warning.
    await page.locator('[data-tkjc-job="job-1"]').click();
    page.once('dialog', d => { assert.match(d.message(),/Google/); d.accept(); });
    await page.click('[data-tkjc="unschedule"]');
    await page.locator('#tkjc-booking-overlay').waitFor({state:'detached'});
    assert.match(await page.evaluate(() => window.lastNotify), /Google copy remains/);
    const unscheduled = await page.evaluate(() => fixture.jobs.find(j => j.id === 'job-1'));
    assert.equal(unscheduled.status,'scheduled'); assert.equal(unscheduled.customer.name,'Alice');
    assert.equal(unscheduled.scheduled_date,null);

    // Controlled reads exercise races without backend timing or a CDN dependency.
    await page.evaluate(() => {
      window.reads = [];
      window.rangeData = (name = 'Saved booking') => ({
        canManage: true, staff: [{id:'owner-1',name:'Owner'}, {id:'tech-1',name:'Tech'}],
        jobs: [{id:'saved',status:'scheduled',scheduled_date:'2026-07-15',customer:{name},details:{assignedStaffIds:['owner-1']}}],
        events: [], blocks: []
      });
      TK_JOB_CALENDAR.configure({
        getBusinessId: () => fixture.business, getUserId: () => fixture.userId, getVersion: () => fixture.version,
        request: (path, options) => {
          if (path.startsWith('/range')) return new Promise((resolve, reject) => reads.push({path,resolve,reject}));
          if (path.startsWith('/jobs/') && options.method === 'PUT') {
            const b = JSON.parse(options.body);
            return Promise.resolve({job:{...rangeData().jobs[0], details:{calendarStartAt:b.startAt,calendarEndAt:b.endAt,assignedStaffIds:b.staffIds}}});
          }
          return Promise.resolve({});
        }
      });
      window.renderCalendar();
      for (let i = 0; i < 15; i++) window.renderCalendar();
    });
    assert.equal(await page.evaluate(() => reads.length), 1, 'render storms share one read');
    await page.evaluate(() => reads[0].resolve(rangeData()));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    await page.evaluate(() => {
      TK_JOB_CALENDAR.refresh();
      for (let i = 0; i < 15; i++) TK_JOB_CALENDAR.refresh();
    });
    assert.equal(await page.evaluate(() => reads.length), 2, 'refresh storm shares an in-flight read');
    assert.match(await page.locator('#tkjc-sidebar-list').innerText(), /Saved booking/);
    assert.equal(await page.locator('[data-tkjc="book"]').isDisabled(), false);
    await page.evaluate(() => reads[1].resolve(rangeData()));
    await page.waitForFunction(() => reads.length === 3);
    await page.evaluate(() => reads[2].reject(Error('Temporary outage')));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').textContent.includes('Temporary outage'));
    assert.match(await page.locator('#tkjc-sidebar-list').innerText(), /Saved booking/);
    await page.getByRole('button', {name:'Retry loading calendar'}).click();
    await page.evaluate(() => reads[3].resolve(rangeData()));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);

    // A save while an older read is pending survives both that response and
    // a failed follow-up refresh.
    await page.evaluate(() => { TK_JOB_CALENDAR.refresh(); });
    await page.locator('[data-tkjc-job="saved"]').click();
    await page.fill('#tkjc-booking-overlay [data-tkjc-field="startTime"]', '10:30');
    await page.click('#tkjc-booking-overlay [data-tkjc="save"]');
    await page.locator('#tkjc-booking-overlay').waitFor({state:'detached'});
    await page.evaluate(() => reads[4].resolve(rangeData('Stale response')));
    await page.waitForFunction(() => reads.length === 6);
    await page.evaluate(() => reads[5].reject(Error('Refresh after save failed')));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').textContent.includes('Refresh after save failed'));
    assert.match(await page.locator('#tkjc-sidebar-list').innerText(), /Saved booking/);
    assert.doesNotMatch(await page.locator('#tkjc-sidebar-list').innerText(), /Stale response/);
    await page.locator('[data-tkjc-job="saved"]').click();
    assert.equal(await page.locator('#tkjc-booking-overlay [data-tkjc-field="startTime"]').inputValue(), '10:30');
    await page.click('#tkjc-booking-overlay [data-tkjc="cancel"]');

    // Navigation paints immediately; an older range cannot overwrite it.
    await page.click('[data-tkjc="next"]');
    assert.match(await page.locator('#tkjc-title').innerText(), /Aug 2026/);
    await page.click('[data-tkjc="next"]');
    assert.match(await page.locator('#tkjc-title').innerText(), /Sep 2026/);
    await page.evaluate(() => reads[7].resolve({...rangeData('September booking'),jobs:[{...rangeData('September booking').jobs[0],scheduled_date:'2026-09-15'}]}));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    await page.evaluate(() => reads[6].resolve(rangeData('Old August response')));
    assert.match(await page.locator('#tkjc-sidebar-list').innerText(), /September booking/);
    await page.click('[data-tkjc="today"]');
    await page.evaluate(() => reads[8].reject(Error('July temporarily unavailable')));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').textContent.includes('July temporarily unavailable'));
    assert.match(await page.locator('#tkjc-sidebar-list').innerText(), /Saved booking/);
    assert.doesNotMatch(await page.locator('#tkjc-sidebar-list').innerText(), /September booking/);

    // Always run a strict FullCalendar lifecycle double, even offline. The
    // optional SDK run above additionally checks real layout and pointer drags.
    await page.click('[data-tkjc-section="completed"]');
    await page.evaluate(() => {
      window.fcCreated = 0; window.fcDestroyed = 0;
      window.FullCalendar = { Calendar: class {
        constructor(el, options) { this.el = el; this.view = {type:options.initialView}; this.options = options; this.events = options.events; window.latestFc = this; fcCreated++; }
        check() { if (this.dead || !this.el.isConnected) throw Error('Detached FullCalendar used'); }
        render() { this.check(); this.el.textContent = 'Calendar mounted'; }
        destroy() { this.check(); this.dead = true; this.el.textContent = ''; fcDestroyed++; }
        updateSize() { this.check(); }
        changeView(type) { this.check(); this.view.type = type; }
        gotoDate(date) { this.check(); this.date = date; }
        removeAllEventSources() { this.check(); this.events = []; }
        addEventSource(events) { this.check(); this.events = events; }
      }};
      window.renderCalendar();
    });
    await page.click('[data-tkjc-section="schedule"]');
    for (let i = 0; i < 3; i++) {
      await page.click('[data-tkjc-section="completed"]');
      await page.click('[data-tkjc-section="schedule"]');
      assert.equal(await page.locator('#tkjc-fc').innerText(), 'Calendar mounted');
    }
    assert.deepEqual(await page.evaluate(() => [fcCreated,fcDestroyed]), [4,3]);
    await page.evaluate(() => {
      TK_JOB_CALENDAR.refresh();
      const completed = {id:'done',status:'paid',scheduled_date:'2026-07-18',customer:{name:'Done <safe>',address:'A street'},details:{serviceM8JobUuid:'remote-job',assignedStaffIds:['owner-1']}};
      const ev = {source:'servicem8',user_id:'owner-1',start_time:'2026-07-18T01:00Z',end_time:'2026-07-18T02:00Z',details:{jobUuid:'remote-job',status:'Completed',personName:'Duplicate'}};
      reads[9].resolve({...rangeData(),jobs:[completed,completed],events:[{...ev,id:'crew-1'},{...ev,id:'crew-2'},
        {...ev,id:'only-1',details:{...ev.details,jobUuid:'event-only',personName:'Event only'}},
        {...ev,id:'only-2',user_id:'tech-1',details:{...ev.details,jobUuid:'event-only',personName:'Event only'}},
        {...ev,id:'old',end_time:'2025-01-01T02:00Z',details:{...ev.details,jobUuid:'old',personName:'Outside range'}}]});
    });
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    await page.click('[data-tkjc-section="completed"]');
    assert.equal(await page.locator('.tkjc-completed-row').count(), 3, 'deduplicate CRM and imported crew activities by job identity');
    assert.match(await page.locator('#tkjc-sidebar-list').innerText(), /Completed jobs \(3\)/i);
    assert.doesNotMatch(await page.locator('#tkjc-main').innerText(), /Duplicate/);
    await page.fill('#tkjc-search', 'Done <safe>');
    assert.equal(await page.locator('.tkjc-completed-row').count(), 1);
    assert.equal(await page.locator('#tkjc-main strong').innerText(), 'Done <safe>');
    await page.click('[data-tkjc-chip="tech-1"]');
    assert.equal(await page.locator('.tkjc-completed-row').count(), 0);
    assert.match(await page.locator('#tkjc-main').innerText(), /Clear the filters/);
    await page.click('[data-tkjc="clear-filters"]');
    assert.equal(await page.locator('.tkjc-completed-row').count(), 3);
    assert.equal(await page.locator('#tkjc-search').inputValue(), '');
    assert.equal(await page.locator('[data-tkjc="clear-filters"]').isHidden(), true);
    await page.click('[data-tkjc-chip="tech-1"]');
    assert.equal(await page.locator('.tkjc-completed-row').count(), 1, 'deduplicated rows retain every crew member');
    await page.click('[data-tkjc="clear-filters"]');
    await page.click('[data-tkjc-section="schedule"]');
    await page.click('[data-tkjc-view="week"]');
    await page.evaluate(() => reads[10].resolve(rangeData()));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    assert.equal(await page.evaluate(() => latestFc.view.type), 'timeGridWeek');

    // A session version change invalidates both cached permissions and reads.
    await page.evaluate(() => { TK_JOB_CALENDAR.refresh(); fixture.version++; window.renderCalendar(); });
    await page.evaluate(() => reads[12].resolve({...rangeData('New session'),canManage:false}));
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    await page.evaluate(() => reads[11].resolve(rangeData('Old session')));
    assert.match(await page.locator('#tkjc-sidebar-list').innerText(), /New session/);
    assert.doesNotMatch(await page.locator('#tkjc-sidebar-list').innerText(), /Old session/);

    // Production regression: getSession can stall before fetch even starts.
    // Use only lexical sb here, with no TK_SUPABASE_CLIENT alias.
    await page.clock.install({time:new Date('2026-07-15T00:00:00Z')});
    await page.evaluate(() => {
      window.sessionReads = 0; window.channelSubscriptions = 0;
      window.TURNKEY_CONFIG = {backendUrl:location.origin};
      window.testSupabase = {
        auth:{getSession(){ sessionReads++; return new Promise(resolve => { window.releaseSession = resolve; }); }},
        channel(){ const channel = {on(){return channel;},subscribe(){channelSubscriptions++;return channel;}}; return channel; },
        removeChannel(){}
      };
      delete window.TK_SUPABASE_CLIENT;
    });
    await page.addScriptTag({content:'const sb = window.testSupabase;'});
    await page.evaluate(() => {
      TK_JOB_CALENDAR.configure({getBusinessId:()=>fixture.business,getUserId:()=>fixture.userId,getVersion:()=>fixture.version});
      window.renderCalendar();
    });
    assert.equal(await page.evaluate(() => channelSubscriptions), 1, 'Realtime uses lexical sb fallback');
    assert.equal(await page.evaluate(() => sessionReads), 1);
    await page.clock.fastForward(30001);
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').textContent.includes('timed out'));
    assert.equal(await page.getByRole('button',{name:'Retry loading calendar'}).isVisible(), true);
    assert.doesNotMatch(await page.locator('#tkjc-load-status').innerText(), /Loading calendar/);
    await page.click('[data-tkjc="next"]');
    assert.match(await page.locator('#tkjc-title').innerText(), /Aug 2026/);
    await page.clock.fastForward(30001);
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').textContent.includes('timed out'));

    // Body decoding is also within the same deadline, and successful retry
    // clears the loading/error message.
    await page.evaluate(() => {
      testSupabase.auth.getSession = async () => ({data:{session:{access_token:'fixture-token'}}});
      window.nativeFetch = window.fetch;
      window.fetch = async () => ({ok:true,status:200,json:()=>new Promise(()=>{})});
    });
    await page.getByRole('button',{name:'Retry loading calendar'}).click();
    await page.clock.fastForward(30001);
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').textContent.includes('timed out'));
    await page.evaluate(() => { window.fetch = async () => ({ok:true,status:200,json:async()=>({...rangeData(),canManage:false})}); });
    await page.getByRole('button',{name:'Retry loading calendar'}).click();
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    await page.evaluate(() => { window.fetch = window.nativeFetch; });

    // A valid same-user memory session bypasses the stalled Supabase auth
    // lock. Wrong-user and expired tokens must use the bounded fallback.
    await page.evaluate(() => {
      window.beforeSessionReads = sessionReads;
      testSupabase.auth.getSession = () => { sessionReads++; return new Promise(()=>{}); };
      window.TK_CURRENT_SESSION = {user:{id:fixture.userId},expires_at:Math.floor(Date.now()/1000)+3600,access_token:'cached-fixture'};
      window.fetch = async (_url, options) => { window.lastAuthorization = options.headers.Authorization; return {ok:true,status:200,json:async()=>({...rangeData(),canManage:false})}; };
      TK_JOB_CALENDAR.refresh();
    });
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden);
    assert.equal(await page.evaluate(() => sessionReads), await page.evaluate(() => beforeSessionReads));
    assert.equal(await page.evaluate(() => lastAuthorization), 'Bearer cached-fixture');
    for (const invalid of ['wrong-user','expired']) {
      await page.evaluate(invalid => {
        TK_CURRENT_SESSION = {user:{id:invalid === 'wrong-user' ? 'another-user' : fixture.userId},expires_at:Math.floor(Date.now()/1000)+(invalid === 'expired' ? -1 : 3600),access_token:'must-not-use'};
        TK_JOB_CALENDAR.refresh();
      }, invalid);
      await page.clock.fastForward(30001);
      await page.waitForFunction(() => document.getElementById('tkjc-load-status').textContent.includes('timed out'));
    }
    assert.equal(await page.evaluate(() => sessionReads), await page.evaluate(() => beforeSessionReads + 2));

    // Queued ServiceM8 imports complete through saved DB reads only. Polling
    // is quiet with Realtime connected and resumes on disconnect/focus.
    await page.evaluate(() => {
      window.pollReads = 0; window.importCalls = 0;
      const remoteStaff = {id:'servicem8:poll-staff',name:'Remote Person',source:'servicem8',role:'servicem8',readOnly:true};
      TK_JOB_CALENDAR.configure({
        getBusinessId:()=> 'poll-biz',getUserId:()=>fixture.userId,
        supabase:{channel(){const c={on(){return c;},subscribe(fn){window.pollStatus=fn;return c;}};return c;},removeChannel(){}},
        request:async path => {
          if (path === '/servicem8/sync') { importCalls++; return {queued:true}; }
          if (path.startsWith('/range')) {
            pollReads++;
            return {...rangeData(),staff:[...rangeData().staff,remoteStaff],
              completedEvents:[{id:'archived',source:'servicem8',end_time:'2025-01-01T02:00Z',details:{jobUuid:'archive-job',status:'Completed',personName:'Archived remote job',assignedStaffIds:[remoteStaff.id]}}],
              servicem8:{state:'queued',seededAt:'2026-07-13T00:00Z',webhookSubscribed:false,lastSyncedAt:'2026-07-14T00:00Z',lastError:'sensitive internal error <script>'}};
          }
          throw Error('Unexpected polling write ' + path);
        }
      });
      window.renderCalendar();
    });
    await page.waitForFunction(() => document.getElementById('tkjc-load-status').hidden && importCalls === 1);
    assert.match(await page.locator('#tkjc-servicem8').innerText(), /queued.*Last synced.*Sync delayed/);
    assert.doesNotMatch(await page.locator('#tkjc-servicem8').innerText(), /sensitive|script/);
    await page.click('[data-tkjc-section="completed"]');
    await page.click('[data-tkjc-chip="servicem8:poll-staff"]');
    assert.equal(await page.locator('.tkjc-completed-row').count(), 1);
    assert.match(await page.locator('#tkjc-main').innerText(), /Archived remote job/);
    await page.fill('#tkjc-search', 'Remote Person');
    assert.equal(await page.locator('.tkjc-completed-row').count(), 1, 'completed search includes assigned remote staff');
    await page.click('[data-tkjc="clear-filters"]');
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => pollReads === 2);
    assert.equal(await page.evaluate(() => importCalls), 1, 'polling never repeats queued import');
    await page.evaluate(() => pollStatus('SUBSCRIBED'));
    await page.clock.fastForward(120001);
    assert.equal(await page.evaluate(() => pollReads), 2, 'Realtime-connected calendar does not poll');
    await page.evaluate(() => {pollStatus('CHANNEL_ERROR');window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(() => pollReads === 3);
    await page.evaluate(() => window.switchView('dashboard'));
    await page.clock.fastForward(120001);
    assert.equal(await page.evaluate(() => pollReads), 3, 'hidden calendar does not poll');
    await page.evaluate(() => {window.switchView('calendar');window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(() => pollReads === 4);
    assert.equal(await page.evaluate(() => importCalls), 1);

    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-tkjc-section="schedule"]').click();
    assert.equal(await page.locator('[data-tkjc="next"]').evaluate(el=>el.getBoundingClientRect().height>=44),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    const mobileTitle=await page.locator('.tkjc-title').innerText();
    await page.locator('[data-tkjc="next"]').click();
    await page.waitForFunction(previous=>document.querySelector('.tkjc-title').textContent!==previous,mobileTitle);
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
