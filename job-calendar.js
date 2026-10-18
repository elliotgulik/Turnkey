/* TurnKey Calendar page: booking/scheduling for jobs, multi-staff team
   assignment, busy/availability blocks, and a read-only overlay of native
   calendar events + connected Google busy times. Owns #view-calendar
   end-to-end once mounted — overrides window.renderCalendar (the old
   FullCalendar wiring in index.html stays in the file, just unused; nothing
   is deleted) and wraps renderAll()/openMoreSheet() so this page refreshes
   and is reachable from the mobile "More" sheet without editing index.html.

   Mount after index.html's own script and after job-workspace.js (order
   doesn't actually matter — every hook below retries until its target
   exists). No dependency on, or edits to, ServiceM8/quote/sales/booking/
   extension files, or job-workspace.js/.css.

   TK_JOB_CALENDAR.configure({...}) lets tests substitute every external
   dependency, same pattern as job-workspace.js's TK_JOB_WORK.configure() —
   see tests/job-calendar-browser.cjs. */
(function (root) {
  'use strict';
  let config = {};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const tenant = () => (config.getBusinessId ? config.getBusinessId() : (typeof currentBusinessId !== 'undefined' ? currentBusinessId : null));
  const tenantUser = () => (config.getUserId ? config.getUserId() : (typeof currentUserId !== 'undefined' ? currentUserId : null));
  const tenantVersion = () => (config.getVersion ? config.getVersion() : (typeof businessSessionVersion !== 'undefined' ? businessSessionVersion : 0));
  const notify = (m) => { if (config.notify) return config.notify(m); if (typeof toast === 'function') toast(m); else console.log('[Calendar]', m); };
  const staleError = () => Object.assign(Error('Business session changed'), { stale: true });

  function makeScope() {
    const biz = tenant(), user = tenantUser(), version = tenantVersion();
    return { biz, user, version, isStale() { return tenant() !== biz || tenantUser() !== user || tenantVersion() !== version; } };
  }

  async function request(path, options = {}, scope) {
    if (scope && scope.isStale()) throw staleError();
    if (config.request) {
      const result = await config.request(path, options);
      if (scope && scope.isStale()) throw staleError();
      return result;
    }
    const client = typeof sb !== 'undefined' ? sb : null;
    const base = (typeof backendUrl === 'function' ? backendUrl() : (root.TURNKEY_CONFIG && root.TURNKEY_CONFIG.backendUrl)) || '';
    if (!client || !base) throw Error('Connect the TurnKey backend and sign in to use the calendar.');
    const { data, error } = await client.auth.getSession();
    if (scope && scope.isStale()) throw staleError();
    if (error || !data.session) throw Error('Please sign in again.');
    const res = await fetch(base.replace(/\/$/, '') + '/api/job-calendar' + path, {
      ...options,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token },
      signal: AbortSignal.timeout(30000)
    });
    if (scope && scope.isStale()) throw staleError();
    const body = await res.json().catch(() => ({}));
    if (scope && scope.isStale()) throw staleError();
    if (res.status === 409) throw Object.assign(Error(body.error || 'That slot changed — refresh and try again.'), { conflict: true });
    if (!res.ok) throw Error(body.error || 'Request failed');
    return body;
  }

  async function syncGoogleNow(scope) {
    if (config.syncGoogleNow) return config.syncGoogleNow();
    const client = typeof sb !== 'undefined' ? sb : null;
    const base = (typeof backendUrl === 'function' ? backendUrl() : (root.TURNKEY_CONFIG && root.TURNKEY_CONFIG.backendUrl)) || '';
    if (!client || !base) throw Error('Connect the TurnKey backend and sign in to use the calendar.');
    const { data, error } = await client.auth.getSession();
    if (scope && scope.isStale()) throw staleError();
    if (error || !data.session) throw Error('Please sign in again.');
    const res = await fetch(base.replace(/\/$/, '') + '/api/calendar/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + data.session.access_token } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(body.error || 'Sync failed');
    return body;
  }

  /* ===================== dates ===================== */
  const pad2 = (n) => String(n).padStart(2, '0');
  const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseLocalDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDaysISO = (iso, n) => { const d = parseLocalDate(iso); d.setDate(d.getDate() + n); return localDateStr(d); };
  function weekStartOf(d) { const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (day === 0 ? 6 : day - 1)); }
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDateLabel = (d) => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
  const fmtTimeOfDate = (d) => d.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
  const timeZoneName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'UTC'; } };

  function rangeForView(view, anchor) {
    if (view === 'day') { const from = localDateStr(anchor); return { fromISO: from, toISO: addDaysISO(from, 1), label: fmtDateLabel(anchor) }; }
    if (view === 'week') {
      const start = weekStartOf(anchor);
      const fromISO = localDateStr(start), toISO = addDaysISO(fromISO, 7);
      return { fromISO, toISO, label: `${fmtDateLabel(start)} – ${fmtDateLabel(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6))}` };
    }
    if (view === 'list') {
      const first=new Date(anchor.getFullYear(),anchor.getMonth(),1),next=new Date(anchor.getFullYear(),anchor.getMonth()+1,1);
      return {fromISO:localDateStr(first),toISO:localDateStr(next),label:MON[anchor.getMonth()]+' '+anchor.getFullYear()+' · Agenda'};
    }
    // month
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const next = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return { fromISO: localDateStr(weekStartOf(first)), toISO: addDaysISO(localDateStr(weekStartOf(first)),42), label: `${MON[anchor.getMonth()]} ${anchor.getFullYear()}` };
  }

  /* ===================== state ===================== */
  const BLOCK_TYPES = [
    ['holiday', 'Holiday'], ['sick', 'Sick'], ['personal', 'Personal'], ['training', 'Training'],
    ['unavailable', 'Unavailable'], ['business_closed', 'Business closed'], ['public_holiday', 'Public holiday'], ['other', 'Other']
  ];
  const STATUS_COLOR = { scheduled: '#2b6cb0', in_progress: '#b7791f', completed: '#2f855a', invoiced: '#6b46c1', paid: '#1a7f5a', cancelled: '#94a3b8' };

  let state = null;
  function freshState() {
    return {
      bizKey: null, loaded: false, loadSeq: 0,
      jobs: [], staff: [], events: [], blocks: [], google: { connected: false }, canManage: false, myRole: null, myUserId: null,
      view: 'month', anchor: new Date(), range: { fromISO: null, toISO: null },
      staffFilter: new Set(), search: ''
    };
  }

  function findJob(id) { return state.jobs.find((j) => String(j.id) === String(id)) || null; }
  function findBlock(id) { return state.blocks.find((b) => String(b.id) === String(id)) || null; }
  function findStaff(id) { return state.staff.find((s) => String(s.id) === String(id)) || null; }

  /* ===================== load ===================== */
  async function load() {
    if (!state) state = freshState();
    const scope = makeScope();
    const bizKey = scope.biz + ':' + scope.user;
    if (state.bizKey !== bizKey) { state = freshState(); state.bizKey = bizKey; destroyFc(); }
    const seq = ++state.loadSeq;
    const { fromISO, toISO } = rangeForView(state.view, state.anchor);
    state.range = { fromISO, toISO };
    try {
      const data = await request(`/range?from=${encodeURIComponent(parseLocalDate(fromISO).toISOString())}&to=${encodeURIComponent(parseLocalDate(toISO).toISOString())}`, {}, scope);
      if (scope.isStale() || seq !== state.loadSeq) return;
      state.jobs = data.jobs || [];
      state.staff = data.staff || [];
      state.events = data.events || [];
      state.blocks = data.blocks || [];
      state.google = data.google || { connected: false };
      state.canManage = !!data.canManage;
      state.myUserId = scope.user;
      state.loaded = true;
    } catch (e) {
      if (e && e.stale) return;
      notify(e.message || 'Could not load the calendar');
    }
    if (scope.isStale() || seq !== state.loadSeq) return;
    renderBody();
  }

  function refreshFromHydratedApp() {
    // Best-effort: re-pulls the main app's own `records` array so other
    // screens see a booking made here immediately. Never blocks or throws —
    // this page's own state (just reloaded above) is the source of truth
    // for what's drawn here either way.
    const scope = makeScope();
    try {
      const fn = config.afterWrite || (typeof loadFromSupabase === 'function' ? loadFromSupabase : null);
      if (fn) Promise.resolve(fn()).catch(() => {});
    } catch (e) { /* ignore */ }
    return scope;
  }

  /* ===================== skeleton ===================== */
  let fcInstance = null;
  function destroyFc() { if (fcInstance) { try { fcInstance.destroy(); } catch (e) {} fcInstance = null; } }

  function ensureSkeleton() {
    const host = document.getElementById('view-calendar');
    if (!host) return null;
    const bizKey = tenant() + ':' + tenantUser();
    if (host.dataset.tkjc === '1' && host.dataset.tkjcBiz === bizKey) return host;
    destroyFc();
    host.dataset.tkjc = '1';
    host.dataset.tkjcBiz = bizKey;
    host.innerHTML = `
      <div class="view-head"><div><h2>Calendar</h2><p>Book jobs, assign crews, and block out unavailable time. Works without Google Calendar — connect one in Connections to also overlay your own busy times.</p></div>
        <div class="tkjc-head-actions">
          <button type="button" class="btn ghost sm" data-tkjc="actual-hours">Actual hours</button>
          <button type="button" class="btn ghost sm" data-tkjc="block">+ Block time</button>
          <button type="button" class="btn accent sm" data-tkjc="book">+ Book job</button>
        </div>
      </div>
      <div class="tkjc-toolbar">
        <div class="tkjc-nav">
          <button type="button" data-tkjc="today">Today</button>
          <button type="button" data-tkjc="prev" aria-label="Previous">←</button>
          <button type="button" data-tkjc="next" aria-label="Next">→</button>
          <span class="tkjc-title" id="tkjc-title"></span>
        </div>
        <div class="tkjc-views" role="group" aria-label="Calendar view">
          <button type="button" data-tkjc-view="month">Month</button>
          <button type="button" data-tkjc-view="week">Week</button>
          <button type="button" data-tkjc-view="day">Day</button>
          <button type="button" data-tkjc-view="list">List</button>
        </div>
      </div>
      <div class="tkjc-legend">
        <span><i style="background:${STATUS_COLOR.scheduled}"></i>Scheduled</span>
        <span><i style="background:${STATUS_COLOR.in_progress}"></i>In progress</span>
        <span><i style="background:${STATUS_COLOR.completed}"></i>Completed</span>
        <span><i style="background:#9a7a32"></i>Blocked</span>
        <span><i style="background:#c7cdd1"></i>Busy (external)</span>
        <span><i style="background:transparent;border:1px dashed #9aa5af"></i>Free (external)</span>
      </div>
      <div class="tkjc-google" id="tkjc-google"></div>
      <div class="tkjc-filters" id="tkjc-staff-filter"></div>
      <div class="tkjc-layout">
        <aside class="tkjc-sidebar">
          <input type="search" id="tkjc-search" placeholder="Search jobs…" aria-label="Search jobs">
          <div class="tkjc-sidebar-list" id="tkjc-sidebar-list"></div>
        </aside>
        <div class="tkjc-main" id="tkjc-main"></div>
      </div>`;
    wireSkeleton(host);
    return host;
  }

  function wireSkeleton(host) {
    host.querySelector('[data-tkjc="book"]').addEventListener('click', () => openBookingModal({}));
    host.querySelector('[data-tkjc="block"]').addEventListener('click', () => openBlockModal({}));
    host.querySelector('[data-tkjc="actual-hours"]').addEventListener('click', () => {
      if (root.TK_JOB_WORK && typeof root.TK_JOB_WORK.openCalendar === 'function') root.TK_JOB_WORK.openCalendar();
      else notify('Staff calendar (actual hours) is not available yet.');
    });
    host.querySelector('[data-tkjc="today"]').addEventListener('click', () => { state.anchor = new Date(); load(); });
    host.querySelector('[data-tkjc="prev"]').addEventListener('click', () => { shiftAnchor(-1); load(); });
    host.querySelector('[data-tkjc="next"]').addEventListener('click', () => { shiftAnchor(1); load(); });
    host.querySelectorAll('[data-tkjc-view]').forEach((btn) => btn.addEventListener('click', () => { state.view = btn.dataset.tkjcView; load(); }));
    const search = host.querySelector('#tkjc-search');
    search.addEventListener('input', () => { state.search = search.value; renderSidebar(); renderMain(); });
  }

  function shiftAnchor(dir) {
    const a = state.anchor;
    if (state.view === 'day') state.anchor = new Date(a.getFullYear(), a.getMonth(), a.getDate() + dir);
    else if (state.view === 'week') state.anchor = new Date(a.getFullYear(), a.getMonth(), a.getDate() + dir * 7);
    else state.anchor = new Date(a.getFullYear(), a.getMonth() + dir, 1);
  }

  /* ===================== render ===================== */
  function renderBody() {
    const host = document.getElementById('view-calendar');
    if (!host || host.dataset.tkjc !== '1') return;
    const { label } = rangeForView(state.view, state.anchor);
    const titleEl = document.getElementById('tkjc-title'); if (titleEl) titleEl.textContent = label;
    document.querySelectorAll('[data-tkjc-view]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tkjcView === state.view));
    renderGooglePanel();
    renderStaffChips();
    renderSidebar();
    renderMain();
  }

  function renderGooglePanel() {
    const zone = document.getElementById('tkjc-google'); if (!zone) return;
    const g = state.google || {};
    zone.innerHTML = `
      <span class="tkjc-google-status ${g.connected ? 'on' : 'off'}">${g.connected ? `Google Calendar connected${g.email ? ' (' + esc(g.email) + ')' : ''}` : 'Google Calendar not connected'}</span>
      <span class="tkjc-google-synced">${g.connected ? (g.lastSyncedAt ? 'Last synced ' + new Date(g.lastSyncedAt).toLocaleString('en-NZ') : 'Never synced — busy times may be stale') : ''}</span>
      ${g.connected ? '<button type="button" class="btn ghost sm" data-tkjc="refresh-google">Refresh Google busy times</button>' : ''}
      <button type="button" class="btn ghost sm" data-tkjc="connections">Connections</button>`;
    const refresh = zone.querySelector('[data-tkjc="refresh-google"]');
    if (refresh) refresh.addEventListener('click', async () => {
      const scope = makeScope();
      try { await syncGoogleNow(scope); if (scope.isStale()) return; notify('Google Calendar synced ✓'); load(); }
      catch (e) { if (!(e && e.stale)) notify(e.message || 'Sync failed'); }
    });
    zone.querySelector('[data-tkjc="connections"]').addEventListener('click', () => {
      if (config.openConnections) config.openConnections();
      else if (typeof openConnections === 'function') openConnections();
    });
  }

  function renderStaffChips() {
    const zone = document.getElementById('tkjc-staff-filter'); if (!zone) return;
    const chip = (id, label) => `<button type="button" class="tkjc-chip${state.staffFilter.has(id) ? ' sel' : ''}" data-tkjc-chip="${esc(id)}">${esc(label)}</button>`;
    zone.innerHTML = `<button type="button" class="tkjc-chip${!state.staffFilter.size ? ' sel' : ''}" data-tkjc-chip="">All staff</button>` +
      state.staff.map((u) => chip(u.id, u.name || u.email || 'Unnamed')).join('') + chip('unassigned', 'Unassigned');
    zone.querySelectorAll('[data-tkjc-chip]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.tkjcChip;
      if (!id) state.staffFilter.clear();
      else if (state.staffFilter.has(id)) state.staffFilter.delete(id);
      else state.staffFilter.add(id);
      renderStaffChips(); renderMain();
    }));
  }

  function jobStaffIds(job) {
    const d = job.details || {};
    if (Array.isArray(d.assignedStaffIds) && d.assignedStaffIds.length) return d.assignedStaffIds;
    return job.assigned_to ? [job.assigned_to] : [];
  }
  function matchesStaffFilter(staffIds) {
    if (!state.staffFilter.size) return true;
    if (!staffIds.length) return state.staffFilter.has('unassigned');
    return staffIds.some((id) => state.staffFilter.has(id));
  }

  // Honest booking window: a real start/end if we have one, otherwise the
  // legacy explicit date + scheduledStartMin/duration, otherwise an all-day
  // "unconfirmed time" block — never a fabricated exact time.
  function jobWindow(job) {
    const d = job.details || {};
    if (d.calendarStartAt) return { start: new Date(d.calendarStartAt), end: d.calendarEndAt ? new Date(d.calendarEndAt) : new Date(new Date(d.calendarStartAt).getTime() + 3600000), allDay: false, confirmed: true };
    const dateISO = job.scheduled_date;
    if (!dateISO) return null;
    if (d.scheduledStartMin != null) {
      const dur = d.scheduledDurationMin || 60;
      const start = new Date(dateISO + 'T00:00:00'); start.setMinutes(start.getMinutes() + d.scheduledStartMin);
      const end = new Date(start.getTime() + dur * 60000);
      return { start, end, allDay: false, confirmed: true };
    }
    return { start: new Date(dateISO + 'T00:00:00'), end: new Date(addDaysISO(dateISO, 1) + 'T00:00:00'), allDay: true, confirmed: false };
  }

  function jobTitle(job) {
    const c = job.customer || {};
    return c.name || 'Job';
  }
  function jobTimeLabel(job) {
    const w = jobWindow(job);
    if (!w) return 'Unscheduled';
    if (!w.confirmed) return 'Unconfirmed time — ' + w.start.toLocaleDateString('en-NZ');
    return fmtTimeOfDate(w.start) + '–' + fmtTimeOfDate(w.end);
  }

  function renderSidebar() {
    const zone = document.getElementById('tkjc-sidebar-list'); if (!zone) return;
    const q = state.search.trim().toLowerCase();
    const matches = (job) => {
      if (!q) return true;
      const c = job.customer || {};
      return [c.name, c.address, c.suburb].filter(Boolean).join(' ').toLowerCase().includes(q);
    };
    const unscheduled = state.jobs.filter((j) => !jobWindow(j) && matches(j));
    const scheduled = state.jobs.filter((j) => jobWindow(j) && matches(j)).sort((a, b) => {
      const wa = jobWindow(a), wb = jobWindow(b);
      return wa.start - wb.start;
    });
    const row = (job) => {
      const c = job.customer || {};
      const addr = [c.address, c.suburb].filter(Boolean).join(', ');
      return `<button type="button" class="tkjc-sidebar-row" data-tkjc-job="${esc(job.id)}">
        <span class="tkjc-sidebar-name">${esc(jobTitle(job))}</span>
        <span class="tkjc-sidebar-sub">${esc(addr || 'No address on file')}</span>
        <span class="tkjc-sidebar-time">${esc(jobTimeLabel(job))}</span>
      </button>`;
    };
    zone.innerHTML = `
      <div class="tkjc-sidebar-group">Unscheduled (${unscheduled.length})</div>
      ${unscheduled.length ? unscheduled.map(row).join('') : '<p class="tkjc-empty">Nothing waiting to be booked.</p>'}
      <div class="tkjc-sidebar-group">In this range (${scheduled.length})</div>
      ${scheduled.length ? scheduled.map(row).join('') : '<p class="tkjc-empty">No booked jobs in this range.</p>'}`;
    zone.querySelectorAll('[data-tkjc-job]').forEach((btn) => btn.addEventListener('click', () => openJobFromId(btn.dataset.tkjcJob)));
  }

  function openJobFromId(jobId) {
    const job = findJob(jobId); if (!job) return;
    openBookingModal({ jobId });
  }

  /* ===================== main calendar area ===================== */
  function renderMain() {
    const zone = document.getElementById('tkjc-main'); if (!zone) return;
    if (typeof FullCalendar !== 'undefined') { renderWithFullCalendar(zone); return; }
    renderFallbackAgenda(zone);
  }

  function buildFcEvents() {
    const out = [];
    state.jobs.forEach((job) => {
      const w = jobWindow(job); if (!w) return;
      const q=state.search.trim().toLowerCase();
      if(q&&![job.customer?.name,job.customer?.address,job.customer?.suburb].filter(Boolean).join(' ').toLowerCase().includes(q))return;
      const staffIds = jobStaffIds(job);
      if (!matchesStaffFilter(staffIds)) return;
      const crewLabel=job.details?.calendarTeamLabel || staffIds.map(id=>{const u=findStaff(id);return u?.name||u?.email?.split('@')[0]||'';}).filter(Boolean).join(' + ');
      out.push({
        id: 'job:' + job.id, title: jobTitle(job) + (crewLabel?' · '+crewLabel:'') + (w.confirmed ? '' : ' (unconfirmed time'),
        start: w.start.toISOString(), end: w.end.toISOString(), allDay: w.allDay,
        backgroundColor: STATUS_COLOR[job.status] || STATUS_COLOR.scheduled, borderColor: STATUS_COLOR[job.status] || STATUS_COLOR.scheduled,
        editable: w.confirmed && state.canManage, extendedProps: { kind: 'job', jobId: job.id }
      });
    });
    state.events.forEach((ev) => {
      if (ev.user_id && !matchesStaffFilter([ev.user_id])) return;
      const free = ev.busy_status === 'free';
      out.push({
        id: 'event:' + ev.id, title: ev.title || (free ? 'Free' : 'Busy'), start: ev.start_time, end: ev.end_time,
        display: 'background', backgroundColor: free ? 'transparent' : '#c7cdd1', editable: false,
        extendedProps: { kind: 'event', free }
      });
    });
    state.blocks.forEach((b) => {
      if (b.user_id && !matchesStaffFilter([b.user_id])) return;
      out.push({
        id: 'block:' + b.id, title: (BLOCK_TYPES.find((t) => t[0] === b.block_type) || [, 'Blocked'])[1] + (b.user_id ? '' : ' (business)'),
        start: b.start_at, end: b.end_at, allDay: !!b.all_day, display: 'auto', backgroundColor: '#f4d9a0', editable: false,
        extendedProps: { kind: 'block', blockId: b.id }
      });
    });
    return out;
  }

  function renderWithFullCalendar(zone) {
    if (!document.getElementById('tkjc-fc')) zone.innerHTML = '<div id="tkjc-fc"></div>';
    const fcViewName = { month: 'dayGridMonth', week: 'timeGridWeek', day: 'timeGridDay', list: 'listMonth' }[state.view] || 'dayGridMonth';
    if (!fcInstance) {
      fcInstance = new FullCalendar.Calendar(document.getElementById('tkjc-fc'), {
        initialView: fcViewName, initialDate: state.anchor, firstDay: 1, fixedWeekCount: true, height: 'auto', editable: true, selectable: true, dayMaxEvents: true,
        headerToolbar: false,
        events: buildFcEvents(),
        eventClick: (info) => onFcEventClick(info),
        dateClick: (info) => onFcDateClick(info),
        eventDrop: (info) => onFcDropResize(info),
        eventResize: (info) => onFcDropResize(info)
      });
      fcInstance.render();
    } else {
      if (fcInstance.view.type !== fcViewName) fcInstance.changeView(fcViewName);
      fcInstance.gotoDate(state.anchor);
      fcInstance.removeAllEventSources();
      fcInstance.addEventSource(buildFcEvents());
    }
  }

  function onFcEventClick(info) {
    const props = info.event.extendedProps;
    if (props.kind === 'job') openBookingModal({ jobId: props.jobId });
    else if (props.kind === 'block') { const b = findBlock(props.blockId); if (b) openBlockDetail(b); }
    // native/google events: read-only, no handler
  }
  function onFcDateClick(info) {
    const dateISO = localDateStr(info.date);
    if (state.canManage) openBookingModal({ dateISO });
    else openBlockModal({ dateISO, staffId: state.myUserId });
  }
  function onFcDropResize(info) {
    const props = info.event.extendedProps;
    if (props.kind !== 'job') { info.revert(); return; }
    const job = findJob(props.jobId); if (!job) { info.revert(); return; }
    const start = info.event.start, end = info.event.end || new Date(start.getTime() + 3600000);
    saveBooking(job.id, buildBookingPayload(job, start, end, jobStaffIds(job), (job.details || {}).calendarTeamLabel, (job.details || {}).calendarNotes, !!(job.details || {}).calendarGoogleSync), () => info.revert());
  }

  /* ===================== fallback agenda (no FullCalendar loaded) ===================== */
  function renderFallbackAgenda(zone) {
    const { fromISO, toISO } = state.range;
    const days = [];
    let cur = fromISO;
    while (cur < toISO) { days.push(cur); cur = addDaysISO(cur, 1); }
    const byDay = {};
    days.forEach((d) => { byDay[d] = []; });
    state.jobs.forEach((job) => {
      const w = jobWindow(job); if (!w) return;
      if (!matchesStaffFilter(jobStaffIds(job))) return;
      const dISO = localDateStr(w.start);
      if (byDay[dISO]) byDay[dISO].push({ kind: 'job', job, w });
    });
    state.blocks.forEach((b) => {
      if (b.user_id && !matchesStaffFilter([b.user_id])) return;
      const bStart = new Date(b.start_at), bEnd = new Date(b.end_at);
      days.forEach((dISO) => {
        const dayStart = parseLocalDate(dISO), dayEnd = new Date(dayStart.getTime() + 86400000);
        if (bStart < dayEnd && bEnd > dayStart) byDay[dISO].push({ kind: 'block', block: b });
      });
    });
    state.events.forEach((ev) => {
      if (ev.user_id && !matchesStaffFilter([ev.user_id])) return;
      const dISO = localDateStr(new Date(ev.start_time));
      if (byDay[dISO]) byDay[dISO].push({ kind: 'event', event: ev });
    });

    zone.innerHTML = `<div class="tkjc-agenda">${days.map((dISO) => {
      const d = parseLocalDate(dISO);
      const items = byDay[dISO] || [];
      return `<div class="tkjc-agenda-day">
        <div class="tkjc-agenda-date"><span>${esc(fmtDateLabel(d))}</span><button type="button" class="tkjc-agenda-add" data-tkjc-add="${esc(dISO)}" aria-label="Add on ${esc(dISO)}">+</button></div>
        <div class="tkjc-agenda-items">
          ${items.length ? items.map((it) => renderAgendaItem(it)).join('') : '<div class="tkjc-agenda-empty">—</div>'}
        </div>
      </div>`;
    }).join('')}</div>`;

    zone.querySelectorAll('[data-tkjc-add]').forEach((btn) => btn.addEventListener('click', () => {
      const dateISO = btn.dataset.tkjcAdd;
      if (state.canManage) openBookingModal({ dateISO }); else openBlockModal({ dateISO, staffId: state.myUserId });
    }));
    zone.querySelectorAll('[data-tkjc-agenda-job]').forEach((btn) => btn.addEventListener('click', () => openJobFromId(btn.dataset.tkjcAgendaJob)));
    zone.querySelectorAll('[data-tkjc-agenda-block]').forEach((btn) => btn.addEventListener('click', () => { const b = findBlock(btn.dataset.tkjcAgendaBlock); if (b) openBlockDetail(b); }));
  }

  function renderAgendaItem(it) {
    if (it.kind === 'job') {
      const job = it.job, w = it.w;
      return `<button type="button" class="tkjc-agenda-chip tkjc-agenda-job" data-tkjc-agenda-job="${esc(job.id)}" style="border-left-color:${STATUS_COLOR[job.status] || STATUS_COLOR.scheduled}">
        <b>${esc(jobTitle(job))}</b><span>${esc(jobTimeLabel(job))}</span>
      </button>`;
    }
    if (it.kind === 'block') {
      const b = it.block;
      const label = (BLOCK_TYPES.find((t) => t[0] === b.block_type) || [, 'Blocked'])[1];
      const who = b.user_id ? esc((findStaff(b.user_id) || {}).name || 'Staff') : 'Whole business';
      return `<button type="button" class="tkjc-agenda-chip tkjc-agenda-block" data-tkjc-agenda-block="${esc(b.id)}">
        <b>${esc(label)}</b><span>${who}</span>
      </button>`;
    }
    const ev = it.event;
    const free = ev.busy_status === 'free';
    return `<div class="tkjc-agenda-chip tkjc-agenda-event ${free ? 'free' : 'busy'}"><b>${esc(ev.title || (free ? 'Free' : 'Busy'))}</b><span>${free ? 'Free' : 'Busy'} — external</span></div>`;
  }

  /* ===================== booking modal ===================== */
  let bookingState = null;
  function buildBookingPayload(job, start, end, staffIds, teamLabel, notes, syncGoogle) {
    return {
      startAt: start.toISOString(), endAt: end.toISOString(),
      dateISO: localDateStr(start), startMin: start.getHours() * 60 + start.getMinutes(),
      timeZone: timeZoneName(), staffIds: staffIds || [], teamLabel: teamLabel || null, notes: notes || null, syncGoogle: !!syncGoogle
    };
  }

  function closeOverlay(id) { const el=document.getElementById(id); if(el){clearInterval(el._scopeTimer);document.removeEventListener('keydown',el._escape);el.remove();} }
  function bindOverlay(overlay){
    overlay._scope=makeScope();
    overlay._escape=e=>{if(e.key==='Escape'){e.preventDefault();closeOverlay(overlay.id);}};
    document.addEventListener('keydown',overlay._escape);
    overlay._scopeTimer=setInterval(()=>{if(overlay._scope.isStale())closeOverlay(overlay.id);},200);
  }

  function openBookingModal({ jobId, dateISO }) {
    const job = jobId ? findJob(jobId) : null;
    const readOnly = !state.canManage || (job && ['completed','paid'].includes(job.status));
    const w = job ? jobWindow(job) : null;
    const presetDate = dateISO || (w ? localDateStr(w.start) : localDateStr(new Date()));
    // normalize to 24h HH:MM for <input type=time>
    const toHHMM = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const startTime = w && w.confirmed ? toHHMM(w.start) : '09:00';
    const durationMin = w && w.confirmed ? Math.round((w.end - w.start) / 60000) : 60;
    const existingStaff = job ? jobStaffIds(job) : [];
    const teamLabel = job ? (job.details || {}).calendarTeamLabel || '' : '';
    const notes = job ? (job.details || {}).calendarNotes || '' : '';
    const alreadyLinked = job ? !!(job.details || {}).calendarGoogleSync : false;
    const unscheduledOptions = !job ? state.jobs.filter((j) => !jobWindow(j)) : [];

    const overlay = document.createElement('div');
    overlay.className = 'tkjc-overlay';
    overlay.id = 'tkjc-booking-overlay';
    overlay.innerHTML = `
      <div class="tkjc-dialog" role="dialog" aria-modal="true" aria-labelledby="tkjc-booking-title">
        <h3 id="tkjc-booking-title">${job ? esc(jobTitle(job)) : 'Book a job'}</h3>
        ${!job ? `<label>Job<select data-tkjc-field="jobId" ${readOnly ? 'disabled' : ''}>
            <option value="">— choose a job —</option>
            ${unscheduledOptions.map((j) => `<option value="${esc(j.id)}">${esc(jobTitle(j))}${(j.customer || {}).address ? ' — ' + esc(j.customer.address) : ''}</option>`).join('')}
          </select></label>` : ''}
        <div class="tkjc-row">
          <label>Date<input type="date" data-tkjc-field="date" value="${esc(presetDate)}" ${readOnly ? 'disabled' : ''}></label>
          <label>Start time<input type="time" data-tkjc-field="startTime" value="${esc(startTime)}" ${readOnly ? 'disabled' : ''}></label>
          <label>Duration (min, max 1440)<input type="number" min="5" max="1440" step="5" data-tkjc-field="duration" value="${esc(String(durationMin))}" ${readOnly ? 'disabled' : ''}></label>
        </div>
        <fieldset class="tkjc-staff-fieldset" ${readOnly ? 'disabled' : ''}>
          <legend>Assign staff (select more than one for a crew)</legend>
          ${state.staff.map((u) => `<label class="tkjc-check"><input type="checkbox" value="${esc(u.id)}" data-tkjc-staff ${existingStaff.includes(u.id) ? 'checked' : ''} ${readOnly ? 'disabled' : ''}> ${esc(u.name || u.email || 'Unnamed')}</label>`).join('') || '<p class="tkjc-empty">No staff on this business yet.</p>'}
        </fieldset>
        <label>Crew name (optional)<input type="text" data-tkjc-field="teamLabel" value="${esc(teamLabel)}" placeholder="e.g. Deck crew" ${readOnly ? 'disabled' : ''}></label>
        <label>Notes<textarea data-tkjc-field="notes" ${readOnly ? 'disabled' : ''}>${esc(notes)}</textarea></label>
        ${state.google.connected ? `<label class="tkjc-check"><input type="checkbox" data-tkjc-field="syncGoogle" ${alreadyLinked ? 'checked' : ''} ${readOnly || alreadyLinked ? 'disabled' : ''}> Sync to my connected Google Calendar${alreadyLinked ? ' (already linked — saving will update it)' : ''}</label>` : ''}
        ${job && state.canManage && (job.details || {}).calendarGoogleSync ? renderGoogleJobStatus(job) : ''}
        <div class="tkjc-dialog-message" id="tkjc-booking-msg"></div>
        <div class="tkjc-dialog-actions">
          <button type="button" data-tkjc="cancel">${readOnly ? 'Close' : 'Cancel'}</button>
          ${!readOnly ? '<button type="button" class="btn accent" data-tkjc="save">Save booking</button>' : ''}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    bindOverlay(overlay);
    bookingState = { jobId: job ? job.id : null };
    overlay.querySelector('[data-tkjc="cancel"]').addEventListener('click', () => closeOverlay('tkjc-booking-overlay'));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay('tkjc-booking-overlay'); });
    const retryBtn = overlay.querySelector('[data-tkjc="retry-google"]');
    if (retryBtn) retryBtn.addEventListener('click', () => retryGoogleForJob(bookingState.jobId, overlay));
    const saveBtn = overlay.querySelector('[data-tkjc="save"]');
    if (saveBtn) saveBtn.addEventListener('click', () => submitBooking(overlay));
    setTimeout(() => { const first = overlay.querySelector('select,input,textarea'); if (first && !first.disabled) first.focus(); }, 50);
  }

  function renderGoogleJobStatus(job) {
    const d = job.details || {};
    const ok = !!d.googleEventId && !d.calendarGoogleSyncError && (!d.calendarGoogleSyncState || d.calendarGoogleSyncState==='synced');
    return `<div class="tkjc-google-job ${ok ? 'ok' : 'pending'}">
      ${ok ? 'Synced to Google ✓' : (d.calendarGoogleSyncError ? 'Google sync failed: ' + esc(d.calendarGoogleSyncError) : 'Google sync pending')}
      ${!ok ? '<button type="button" class="btn ghost sm" data-tkjc="retry-google">Retry</button>' : ''}
    </div>`;
  }

  async function retryGoogleForJob(jobId, overlay) {
    if (!jobId) return;
    const scope = makeScope();
    const msg = overlay.querySelector('#tkjc-booking-msg');
    try {
      const body = await request('/jobs/' + encodeURIComponent(jobId) + '/google', { method: 'POST' }, scope);
      if (scope.isStale()) return;
      applyJobPatch(body.job); if (body.google) state.google = body.google;
      notify('Google sync retried ✓');
      closeOverlay('tkjc-booking-overlay');
      renderBody();
    } catch (e) {
      if (e && e.stale) return;
      if (msg) msg.textContent = e.message || 'Retry failed';
    }
  }

  function submitBooking(overlay) {
    if(overlay._scope?.isStale()){closeOverlay(overlay.id);return;}
    const field = (name) => overlay.querySelector(`[data-tkjc-field="${name}"]`);
    const msg = overlay.querySelector('#tkjc-booking-msg');
    const jobIdField = field('jobId');
    const jobId = bookingState.jobId || (jobIdField ? jobIdField.value : null);
    if (!jobId) { msg.textContent = 'Choose a job'; return; }
    const dateISO = field('date').value;
    const startTime = field('startTime').value;
    const duration = parseInt(field('duration').value, 10) || 60;
    if (!dateISO || !startTime) { msg.textContent = 'Pick a date and start time'; return; }
    if (duration <= 0 || duration > 1440) { msg.textContent = 'Duration must be 1–1440 minutes'; return; }
    const [h, m] = startTime.split(':').map(Number);
    const start = new Date(dateISO + 'T00:00:00'); start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + duration * 60000);
    const staffIds = [...overlay.querySelectorAll('[data-tkjc-staff]:checked')].map((c) => c.value);
    const teamLabel = field('teamLabel') ? field('teamLabel').value.trim() : '';
    const notes = field('notes') ? field('notes').value.trim() : '';
    const syncField = field('syncGoogle');
    const payload = buildBookingPayload(null, start, end, staffIds, teamLabel, notes, syncField ? syncField.checked : false);
    const saveBtn = overlay.querySelector('[data-tkjc="save"]');
    saveBtn.disabled = true; msg.textContent = '';
    saveBooking(jobId, payload, null, overlay).finally(() => { if (saveBtn) saveBtn.disabled = false; });
  }

  async function saveBooking(jobId, payload, onRevert, overlay) {
    const scope = overlay?._scope || makeScope();
    if(scope.isStale()){if(overlay)closeOverlay(overlay.id);return;}
    try {
      const body = await request('/jobs/' + encodeURIComponent(jobId), { method: 'PUT', body: JSON.stringify(payload) }, scope);
      if (scope.isStale()) return;
      applyJobPatch(body.job); if (body.google) state.google = body.google;
      notify(body.googleSync?.status==='error'?'Booking saved — Google sync needs attention. Open the booking to retry.':'Booking saved ✓');
      if (overlay) closeOverlay(overlay.id);
      renderBody();
      refreshFromHydratedApp();
    } catch (e) {
      if (e && e.stale) return;
      if (onRevert) onRevert();
      const msg = overlay && overlay.querySelector('#tkjc-booking-msg');
      if (msg) msg.textContent = e.message || 'Could not save';
      else notify(e.message || 'Could not save — reverted');
    }
  }

  function applyJobPatch(job) {
    if (!job) return;
    const idx = state.jobs.findIndex((j) => String(j.id) === String(job.id));
    if (idx >= 0) state.jobs[idx] = {...state.jobs[idx],...job,customer:job.customer||state.jobs[idx].customer}; else state.jobs.push(job);
  }

  /* ===================== block modal ===================== */
  let blockDialogId = null;
  function openBlockModal({ dateISO, staffId }) {
    blockDialogId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
    const start = dateISO || localDateStr(new Date());
    const canPickStaff = state.canManage;
    const overlay = document.createElement('div');
    overlay.className = 'tkjc-overlay';
    overlay.id = 'tkjc-block-overlay';
    overlay.innerHTML = `
      <div class="tkjc-dialog" role="dialog" aria-modal="true" aria-labelledby="tkjc-block-title">
        <h3 id="tkjc-block-title">Block time</h3>
        <div class="tkjc-row">
          <label>Start date<input type="date" data-tkjc-field="startDate" value="${esc(start)}"></label>
          <label>End date<input type="date" data-tkjc-field="endDate" value="${esc(start)}"></label>
        </div>
        <label class="tkjc-check"><input type="checkbox" data-tkjc-field="allDay" checked> All day</label>
        <div class="tkjc-row" data-tkjc="time-row" style="display:none">
          <label>Start time<input type="time" data-tkjc-field="startTime" value="09:00"></label>
          <label>End time<input type="time" data-tkjc-field="endTime" value="17:00"></label>
        </div>
        <label>Who<select data-tkjc-field="staffId" ${canPickStaff ? '' : 'disabled'}>
          ${canPickStaff ? '<option value="">Whole business</option>' : ''}
          ${state.staff.map((u) => `<option value="${esc(u.id)}" ${((staffId || state.myUserId) === u.id) || !canPickStaff ? 'selected' : ''}>${esc(u.name || u.email || 'Unnamed')}</option>`).join('')}
        </select></label>
        <label>Type<select data-tkjc-field="blockType">${BLOCK_TYPES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
        <label>Reason (optional)<textarea data-tkjc-field="reason"></textarea></label>
        <div class="tkjc-dialog-message" id="tkjc-block-msg"></div>
        <div class="tkjc-dialog-actions">
          <button type="button" data-tkjc="cancel">Cancel</button>
          <button type="button" class="btn accent" data-tkjc="save">Block time</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    bindOverlay(overlay);
    overlay.querySelector('[data-tkjc="cancel"]').addEventListener('click', () => closeOverlay('tkjc-block-overlay'));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay('tkjc-block-overlay'); });
    overlay.querySelector('[data-tkjc-field="allDay"]').addEventListener('change', (e) => { overlay.querySelector('[data-tkjc="time-row"]').style.display = e.target.checked ? 'none' : ''; });
    overlay.querySelector('[data-tkjc="save"]').addEventListener('click', () => submitBlock(overlay));
  }

  function submitBlock(overlay) {
    if(overlay._scope?.isStale()){closeOverlay(overlay.id);return;}
    const field = (name) => overlay.querySelector(`[data-tkjc-field="${name}"]`);
    const msg = overlay.querySelector('#tkjc-block-msg');
    const startDate = field('startDate').value;
    const endDate = field('endDate').value || startDate;
    if (!startDate) { msg.textContent = 'Pick a start date'; return; }
    if (endDate < startDate) { msg.textContent = 'End date is before the start date'; return; }
    const allDay = field('allDay').checked;
    let startAt, endAt;
    if (allDay) {
      startAt = new Date(startDate + 'T00:00:00');
      // inclusive end date -> exclusive next local midnight, via setDate so DST-affected days still land on the right wall-clock midnight.
      const endExclusive = new Date(endDate + 'T00:00:00'); endExclusive.setDate(endExclusive.getDate() + 1);
      endAt = endExclusive;
    } else {
      const st = field('startTime').value || '00:00', et = field('endTime').value || '23:59';
      startAt = new Date(startDate + 'T' + st + ':00');
      endAt = new Date(endDate + 'T' + et + ':00');
    }
    if (endAt <= startAt) { msg.textContent = 'End must be after start'; return; }
    const staffField = field('staffId');
    const payload = {
      id: blockDialogId, startAt: startAt.toISOString(), endAt: endAt.toISOString(), allDay,
      staffId: staffField && !staffField.disabled ? (staffField.value || null) : state.myUserId,
      blockType: field('blockType').value, reason: field('reason').value.trim() || null
    };
    const saveBtn = overlay.querySelector('[data-tkjc="save"]');
    saveBtn.disabled = true; msg.textContent = '';
    saveBlockReq(payload, overlay).finally(() => { if (saveBtn) saveBtn.disabled = false; });
  }

  async function saveBlockReq(payload, overlay) {
    const scope = overlay?._scope || makeScope();
    if(scope.isStale()){if(overlay)closeOverlay(overlay.id);return;}
    try {
      const body = await request('/blocks', { method: 'POST', body: JSON.stringify(payload) }, scope);
      if (scope.isStale()) return;
      const idx = state.blocks.findIndex((b) => String(b.id) === String(payload.id));
      const saved = body.block || payload;
      if (idx >= 0) state.blocks[idx] = saved; else state.blocks.push(saved);
      notify('Time blocked ✓' + (body.warnings && body.warnings.length ? ' — ' + body.warnings.join(' ') : ''));
      if (overlay) closeOverlay(overlay.id);
      renderBody();
    } catch (e) {
      if (e && e.stale) return;
      const msg = overlay && overlay.querySelector('#tkjc-block-msg');
      if (msg) msg.textContent = e.message || 'Could not save';
    }
  }

  function openBlockDetail(block) {
    const who = block.user_id ? esc((findStaff(block.user_id) || {}).name || 'Staff') : 'Whole business';
    const label = (BLOCK_TYPES.find((t) => t[0] === block.block_type) || [, 'Blocked'])[1];
    const canRemove = state.canManage || (block.user_id && block.user_id === state.myUserId);
    const overlay = document.createElement('div');
    overlay.className = 'tkjc-overlay';
    overlay.id = 'tkjc-block-detail-overlay';
    overlay.innerHTML = `
      <div class="tkjc-dialog" role="dialog" aria-modal="true" aria-labelledby="tkjc-block-detail-title">
        <h3 id="tkjc-block-detail-title">${esc(label)}</h3>
        <p>${who} — ${esc(new Date(block.start_at).toLocaleString('en-NZ'))} to ${esc(new Date(block.end_at).toLocaleString('en-NZ'))}</p>
        ${block.reason ? `<p class="tkjc-sub">${esc(block.reason)}</p>` : ''}
        <div class="tkjc-dialog-message" id="tkjc-block-detail-msg"></div>
        <div class="tkjc-dialog-actions">
          <button type="button" data-tkjc="close">Close</button>
          ${canRemove ? '<button type="button" class="btn danger" data-tkjc="remove">Remove</button>' : ''}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    bindOverlay(overlay);
    overlay.querySelector('[data-tkjc="close"]').addEventListener('click', () => closeOverlay('tkjc-block-detail-overlay'));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay('tkjc-block-detail-overlay'); });
    const removeBtn = overlay.querySelector('[data-tkjc="remove"]');
    if (removeBtn) removeBtn.addEventListener('click', () => {
      if (!confirm('Remove this block? This will not cancel any existing bookings.')) return;
      deleteBlockReq(block.id, overlay);
    });
  }

  async function deleteBlockReq(id, overlay) {
    const scope = overlay?._scope || makeScope();
    if(scope.isStale()){if(overlay)closeOverlay(overlay.id);return;}
    try {
      await request('/blocks/' + encodeURIComponent(id), { method: 'DELETE' }, scope);
      if (scope.isStale()) return;
      state.blocks = state.blocks.filter((b) => String(b.id) !== String(id));
      notify('Block removed');
      if (overlay) closeOverlay(overlay.id);
      renderBody();
    } catch (e) {
      if (e && e.stale) return;
      const msg = overlay && overlay.querySelector('#tkjc-block-detail-msg');
      if (msg) msg.textContent = e.message || 'Could not remove block';
    }
  }

  /* ===================== mount / integration hooks ===================== */
  function tkRenderCalendar() {
    const host = ensureSkeleton();
    if (!host) return;
    load();
  }

  function patchDesktopNav() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return false;
    if (nav.querySelector('button[data-view="calendar"]')) return true;
    const btn = document.createElement('button');
    btn.setAttribute('data-view', 'calendar');
    btn.innerHTML = '<span class="nav-ico" data-icon="calendar"></span>Calendar';
    const goals = nav.querySelector('button[data-view="goals"]');
    if (goals) goals.insertAdjacentElement('afterend', btn); else nav.appendChild(btn);
    return true;
  }

  function wrapOpenMoreSheet() {
    if (typeof root.openMoreSheet !== 'function' || root.openMoreSheet.__tkjc) return false;
    const original = root.openMoreSheet;
    const wrapped = function () {
      original.apply(this, arguments);
      const body = document.getElementById('more-body');
      if (!body || body.querySelector('[data-tkjc-more="calendar"]')) return;
      const row = document.createElement('button');
      row.className = 'more-row';
      row.setAttribute('data-tkjc-more', 'calendar');
      row.innerHTML = '<span class="mr-label">Calendar</span><span class="mr-chev">›</span>';
      row.addEventListener('click', () => {
        if (typeof root.closeModal === 'function') root.closeModal('more-overlay');
        if (typeof root.switchView === 'function') root.switchView('calendar');
      });
      const firstGroup = body.querySelector('.more-group-label');
      if (firstGroup) firstGroup.insertAdjacentElement('afterend', row); else body.insertBefore(row, body.firstChild);
    };
    wrapped.__tkjc = true;
    root.openMoreSheet = wrapped;
    return true;
  }

  function wrapRenderAll() {
    if (typeof root.renderAll !== 'function' || root.renderAll.__tkjc) return false;
    const original = root.renderAll;
    let debounce = null;
    const wrapped = function () {
      original.apply(this, arguments);
      const host = document.getElementById('view-calendar');
      if (host && host.classList.contains('active') && host.dataset.tkjc === '1') {
        clearTimeout(debounce);
        debounce = setTimeout(() => load(), 300);
      }
    };
    wrapped.__tkjc = true;
    root.renderAll = wrapped;
    return true;
  }

  function installLauncherCapture() {
    if (root.__tkjcLauncherCapture) return;
    root.__tkjcLauncherCapture = true;
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('#tkj-launcher [data-tkj="calendar"]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof root.switchView === 'function') root.switchView('calendar');
      else tkRenderCalendar();
    }, true);
  }

  function init() {
    root.renderCalendar = tkRenderCalendar;
    installLauncherCapture();
    const ready = wrapRenderAll() && wrapOpenMoreSheet() && patchDesktopNav();
    if (!ready) setTimeout(init, 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  root.TK_JOB_CALENDAR = {
    configure(options) { config = { ...options }; state = null; destroyFc(); },
    open() { if (typeof root.switchView === 'function') root.switchView('calendar'); else tkRenderCalendar(); },
    refresh() { load(); }
  };
})(window);
