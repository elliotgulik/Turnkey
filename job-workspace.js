/* Job records: worker-submitted work hours, TurnKey's own staff calendar
   (actual logged hours — not scheduling/payroll), equipment runtime and
   service-due tracking, and before/after job photos.
   Mount after index.html's own application script (which defines
   window.openDetail, currentBusinessId/currentUserId/sb/records/etc as
   globals) — wraps openDetail to append a card, and adds a small
   floating launcher for the staff calendar / equipment views that aren't
   tied to a single job. No dependency on, or edits to, ServiceM8/quote/
   sales/booking/extension files.

   TK_JOB_WORK.configure({...}) lets tests substitute every external
   dependency (request/business/user/version/records) the same way
   marketing-analytics.js's TK_MARKETING.configure() does — see
   tests/job-workspace-browser.cjs. */
(function (root) {
  'use strict';
  let config = {};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tenant = () => (config.getBusinessId ? config.getBusinessId() : (typeof currentBusinessId !== 'undefined' ? currentBusinessId : null));
  const tenantUser = () => (config.getUserId ? config.getUserId() : (typeof currentUserId !== 'undefined' ? currentUserId : null));
  const tenantVersion = () => (config.getVersion ? config.getVersion() : (typeof businessSessionVersion !== 'undefined' ? businessSessionVersion : 0));
  const notify = (m) => { if (config.notify) return config.notify(m); if (typeof toast === 'function') toast(m); else console.log('[Job records]', m); };
  const staleError = () => Object.assign(Error('Business session changed'), { stale: true });

  /* A scope is captured once, at the moment a user action starts (a click,
     opening a dialog, picking a file) — every async step after that
     (await getSession(), await fetch(), await FileReader, a form submit
     days later) re-checks it before doing anything observable, so a
     business switch or sign-out mid-flight can't write stale data into the
     wrong tenant's view or a different job's card. */
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
    if (!client || !base) throw Error('Connect the TurnKey backend and sign in to use job records.');
    const { data, error } = await client.auth.getSession();
    if (scope && scope.isStale()) throw staleError();
    if (error || !data.session) throw Error('Please sign in again.');
    const res = await fetch(base.replace(/\/$/, '') + '/api/job-work' + path, {
      ...options,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token },
      signal: AbortSignal.timeout(30000)
    });
    if (scope && scope.isStale()) throw staleError();
    const body = await res.json().catch(() => ({}));
    if (scope && scope.isStale()) throw staleError();
    if (res.status === 503) throw Object.assign(Error(body.error || 'Job records are not set up on this server yet.'), { notMigrated: true });
    if (!res.ok) throw Error(body.error || 'Request failed');
    return body;
  }

  const fmtDuration = (minutes) => {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return (h ? h + 'h ' : '') + (m || !h ? m + 'm' : '');
  };
  const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const toIso = (dateStr, timeStr) => new Date(dateStr + 'T' + timeStr + ':00').toISOString();
  // Local calendar date (never toISOString().slice(0,10) — that converts to
  // UTC first, which is off by a day for any timezone ahead of UTC, e.g.
  // NZ, for a good chunk of the day).
  const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Local midnight on the Monday of the week containing `d` — built from
  // the (year,month,date) constructor, which is local-time by definition,
  // so weekStart.toISOString() always serializes the correct UTC instant
  // for "local midnight", regardless of the viewer's offset from UTC.
  function weekStartOf(d) {
    const day = d.getDay();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (day === 0 ? 6 : day - 1));
  }
  async function stableRequestId(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  /* ===================== staff role (cached per tenant+user+session) ===================== */
  let roleCache = null, roleCacheKey = null, staffListCache = null;
  async function myRole(scope) {
    const key = scope.biz + ':' + scope.user + ':' + scope.version;
    if (roleCache && roleCacheKey === key) return roleCache;
    const data = await request('/staff', {}, scope);
    if (scope.isStale()) throw staleError();
    roleCache = data.role; roleCacheKey = key; staffListCache = data.staff;
    return roleCache;
  }
  const isPrivileged = (r) => r === 'owner' || r === 'manager';

  /* ===================== job records card (appended into openDetail) ===================== */

  function findRecord(id) {
    if (config.getRecords) return config.getRecords().find((x) => x.id === id) || null;
    if (typeof records === 'undefined') return null;
    return records.find((x) => x.id === id) || null;
  }

  async function renderJobCard(recordId) {
    const host = document.getElementById('view-detail');
    if (!host) return;
    const scope = makeScope();

    const old = document.getElementById('tkj-card');
    if (old) old.remove();
    const card = document.createElement('div');
    card.id = 'tkj-card';
    card.dataset.recordId = String(recordId);
    card.className = 'panel tkj-panel';
    const anchor = host.querySelector('.detail-grid') || host;
    anchor.appendChild(card);
    // Checked before every DOM write below — not just "does #tkj-card
    // exist", but "is it literally THIS node, for THIS record" — otherwise
    // a quick re-open of a different job (new card, same #id) could have an
    // earlier card's async load land on top of it.
    const isCurrentCard = () => card.isConnected && document.getElementById('tkj-card') === card && card.dataset.recordId === String(recordId);

    const r = findRecord(recordId);
    if (!r) { card.innerHTML = '<h4>Job records</h4><p class="tkj-empty">Opportunity not found.</p>'; return; }
    if (!r.jobId) {
      card.innerHTML = '<h4>Job records</h4><p class="tkj-empty">Save/sync this job to TurnKey\'s database before logging hours or photos against it.</p>';
      return;
    }

    card.innerHTML = `<h4>Job records <span class="eng-badge">Hours &amp; photos</span></h4>
      <div class="tkj-actions">
        <button class="btn primary sm" data-tkj="log-hours">Log hours</button>
        <button class="btn ghost sm" data-tkj="upload" data-kind="before_photo">Add before photo</button>
        <button class="btn ghost sm" data-tkj="upload" data-kind="after_photo">Add after photo</button>
        <button class="btn ghost sm" data-tkj="calendar">Staff calendar</button>
        <button class="btn ghost sm" data-tkj="equipment">Equipment &amp; service</button>
      </div>
      <p class="tkj-message" role="status" aria-live="polite">Loading…</p>
      <div class="tkj-photos"></div>
      <div class="tkj-logs"></div>
      <input type="file" accept="image/jpeg,image/png,image/webp" class="tkj-file-input" hidden>`;

    card.querySelectorAll('[data-tkj]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.tkj;
        if (action === 'log-hours') openLogHoursDialog(r);
        else if (action === 'calendar') openCalendar();
        else if (action === 'equipment') openEquipment();
        else if (action === 'upload') pickAndUploadPhoto(r, btn.dataset.kind, card);
      });
    });

    const message = (text, error) => {
      if (!isCurrentCard()) return;
      const el = card.querySelector('.tkj-message');
      if (el) { el.textContent = text; el.classList.toggle('tkj-error', !!error); }
    };

    try {
      const [logsData, photosData] = await Promise.all([
        request('/logs?' + new URLSearchParams({ jobId: r.jobId }), {}, scope),
        request('/jobs/' + encodeURIComponent(r.jobId) + '/photos', {}, scope)
      ]);
      if (!isCurrentCard() || scope.isStale()) return;
      renderPhotos(card, photosData.photos);
      renderLogs(card, logsData.logs);
      message(logsData.logs.length ? '' : 'No hours logged against this job yet.');
    } catch (e) {
      if (e.stale) return; // business/session changed mid-load — drop silently, no stale message on screen
      message(e.notMigrated ? e.message : 'Could not load job records: ' + e.message, true);
    }
  }

  function renderPhotos(card, photos) {
    const el = card.querySelector('.tkj-photos');
    if (!photos.length) { el.innerHTML = ''; return; }
    const group = (kind, label) => {
      const rows = photos.filter((p) => p.kind === kind);
      if (!rows.length) return '';
      return `<div class="tkj-photo-group"><div class="tkj-photo-label">${label}</div><div class="tkj-thumbs">${rows.map((p) => p.url
        ? `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(label)}" loading="lazy"></a>`
        : `<span class="tkj-thumb-broken" title="Could not load photo">!</span>`).join('')}</div></div>`;
    };
    el.innerHTML = group('before_photo', 'Before') + group('after_photo', 'After');
  }

  function renderLogs(card, logs) {
    const el = card.querySelector('.tkj-logs');
    if (!logs.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="tkj-log-list">' + logs.slice(0, 8).map((l) => `<div class="tkj-log-row">
      <span>${esc(fmtDateTime(l.start_at))} – ${esc(fmtDateTime(l.end_at))}</span>
      <span>${esc(fmtDuration(l.minutes))}</span>
      ${l.notes ? `<span class="tkj-log-notes">${esc(l.notes)}</span>` : ''}
    </div>`).join('') + '</div>';
  }

  function pickAndUploadPhoto(r, kind, card) {
    const scope = makeScope();
    const input = card.querySelector('.tkj-file-input');
    input.value = '';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      // Captured the instant the user actually picked a file — the native
      // file picker is a real-world async gap a tenant switch can happen
      // across, same as the FileReader read itself below.
      if (scope.isStale() || document.getElementById('tkj-card') !== card || !card.isConnected) return;
      if (file.size > 8 * 1024 * 1024) { notify('Photos must be 8MB or smaller'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        if (scope.isStale()) return;
        try {
          await request('/jobs/' + encodeURIComponent(r.jobId) + '/photos', {
            method: 'POST',
            body: JSON.stringify({ kind, dataUrl: reader.result, filename: file.name })
          }, scope);
          if (scope.isStale()) return;
          notify('Photo saved');
          if (document.getElementById('tkj-card') === card) renderJobCard(r.id);
        } catch (e) {
          if (e.stale) return;
          notify(e.message);
        }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  /* ===================== log hours dialog ===================== */

  function overlay(html, scope) {
    const host = document.createElement('div');
    host.className = 'tkj-overlay';
    host.innerHTML = html;
    document.body.appendChild(host);
    let watcher = null;
    const onKey = (e) => { if(e.key==='Escape'){ e.preventDefault(); close(); } };
    const close = () => { clearInterval(watcher); document.removeEventListener('keydown',onKey); host.remove(); };
    document.addEventListener('keydown',onKey);
    if (scope) watcher = setInterval(() => { if (scope.isStale()) close(); }, 250);
    host.addEventListener('click', (e) => { if (e.target === host) close(); });

    const firstFocusable = host.querySelector('button,input,select,textarea');
    if (firstFocusable) firstFocusable.focus();
    return { host, close };
  }

  async function openLogHoursDialog(r) {
    const scope = makeScope();
    let role, staff = [], equipment = [];
    try {
      role = await myRole(scope);
      if (isPrivileged(role)) staff = staffListCache || [];
      equipment = (await request('/equipment', {}, scope)).equipment;
    } catch (e) { if (!e.stale) notify(e.message); return; }
    if (scope.isStale()) return;

    const today = localDateStr(new Date());
    const { host, close } = overlay(`
      <form class="tkj-dialog" data-tkj-form="log-hours" role="dialog" aria-modal="true" aria-labelledby="tkj-log-title">
        <h3 id="tkj-log-title">Log hours — ${esc(r.name || 'Job')}</h3>
        <p class="tkj-dialog-message" role="alert"></p>
        ${staff.length ? `<label>Worker<select name="userId">${staff.map((u) => `<option value="${esc(u.id)}" ${u.id === scope.user ? 'selected' : ''}>${esc(u.email || u.id)}</option>`).join('')}</select></label>` : ''}
        <div class="tkj-row">
          <label>Date<input type="date" name="date" value="${today}" required></label>
          <label>Start<input type="time" name="startTime" required></label>
          <label>End<input type="time" name="endTime" required></label>
        </div>
        <label>Notes<textarea name="notes" maxlength="2000"></textarea></label>
        <fieldset class="tkj-equipment-rows"><legend>Equipment used (optional)</legend></fieldset>
        <button type="button" data-tkj="add-equipment">+ Add equipment used</button>
        <div class="tkj-dialog-actions">
          <button type="button" data-tkj="cancel">Cancel</button>
          <button type="submit" class="btn primary">Save hours</button>
        </div>
      </form>`, scope);

    const addEquipmentRow = () => {
      const fieldset = host.querySelector('.tkj-equipment-rows');
      const row = document.createElement('div');
      row.className = 'tkj-equipment-row';
      row.innerHTML = `<select name="assetId">${equipment.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
        <input type="number" name="hours" min="0" max="24" step="0.1" placeholder="Hours used">
        <input type="text" name="eqNotes" placeholder="Notes" maxlength="500">
        <button type="button" data-tkj="remove-equipment" aria-label="Remove equipment row">×</button>`;
      fieldset.appendChild(row);
      row.querySelector('[data-tkj="remove-equipment"]').addEventListener('click', () => row.remove());
    };
    host.querySelector('[data-tkj="add-equipment"]').addEventListener('click', addEquipmentRow);
    host.querySelector('[data-tkj="cancel"]').addEventListener('click', close);

    host.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (scope.isStale()) { close(); return; }
      const form = e.target;
      const message = (text) => { host.querySelector('.tkj-dialog-message').textContent = text; };
      const startAt = toIso(form.date.value, form.startTime.value);
      const endAt = toIso(form.date.value, form.endTime.value);
      const durationHours = (new Date(endAt) - new Date(startAt)) / 3600000;
      const equipmentEntries = [...host.querySelectorAll('.tkj-equipment-row')].map((row) => ({
        assetId: row.querySelector('[name="assetId"]').value,
        hours: Number(row.querySelector('[name="hours"]').value || 0),
        notes: row.querySelector('[name="eqNotes"]').value || undefined
      })).filter((eq) => eq.hours > 0);
      if (equipmentEntries.some((eq) => eq.hours > durationHours)) { message('Equipment hours cannot exceed the logged work duration'); return; }

      const payload = {
        jobId: r.jobId,
        userId: form.userId ? form.userId.value : scope.user,
        startAt, endAt,
        notes: form.notes.value || undefined,
        equipment: equipmentEntries
      };
      // Deterministic, not random: an identical resubmit (double-click,
      // network retry) reuses the exact same id so the backend's dedupe
      // recognizes it as the same submission; any actual change to the
      // payload naturally produces a different id instead.
      const requestId = await stableRequestId(payload);
      if (scope.isStale()) { close(); return; }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await request('/logs', { method: 'POST', body: JSON.stringify({ ...payload, requestId }) }, scope);
        if (scope.isStale()) { close(); return; }
        notify('Hours logged');
        root.dispatchEvent(new Event('turnkey:equipment-changed'));
        close();
        renderJobCard(r.id);
      } catch (e2) {
        if (e2.stale) { close(); return; }
        message(e2.message);
        submit.disabled = false;
      }
    });
  }

  /* ===================== employee work-log page ===================== */
  let workPageLoadSeq = 0, workRealtimeChannel = null, workRealtimeKey = '', workRealtimeTimer = null;
  function workDateRange(date) {
    const start = new Date(date + 'T00:00:00');
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  function ensureWorkRealtime(scope) {
    const client = config.supabase || root.TK_SUPABASE_CLIENT;
    if ((config.request && !config.supabase) || !client?.channel) return;
    const key = scope.biz + ':' + scope.user;
    if (workRealtimeKey === key && workRealtimeChannel) return;
    if (workRealtimeChannel) client.removeChannel?.(workRealtimeChannel);
    workRealtimeKey = key;
    workRealtimeChannel = client.channel('tk-work-log-' + key)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_work_logs', filter: 'business_id=eq.' + scope.biz }, () => {
        clearTimeout(workRealtimeTimer);
        workRealtimeTimer = setTimeout(() => { if (!scope.isStale() && document.getElementById('view-worklog')?.classList.contains('active')) renderWorkLogPage(); }, 300);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'equipment_usage', filter: 'business_id=eq.' + scope.biz }, () => {
        clearTimeout(workRealtimeTimer);
        workRealtimeTimer = setTimeout(() => { if (!scope.isStale() && document.getElementById('view-worklog')?.classList.contains('active')) renderWorkLogPage(); }, 300);
      })
      .subscribe();
  }
  function openWorkLogPage() { renderWorkLogPage(); }
  async function renderWorkLogPage() {
    const page = document.getElementById('view-worklog');
    if (!page) return;
    const scope = makeScope(), seq = ++workPageLoadSeq;
    const selectedDate = page.querySelector('[name="workDate"]')?.value || localDateStr(new Date());
    ensureWorkRealtime(scope);
    page.innerHTML = `<div class="tkj-work-page">
      <header class="tkj-work-heading"><div><span>TEAM</span><h1>Staff work log</h1><p>Log one shift against its job. Paid hours stay on the timesheet; travel is excluded from equipment runtime.</p></div><button type="button" class="btn ghost" data-work="refresh">Refresh</button></header>
      <div class="tkj-work-stats" aria-live="polite"><div><span>Shift hours</span><strong data-work-stat="shift">…</strong></div><div><span>Travel</span><strong data-work-stat="travel">…</strong></div><div><span>On-site time</span><strong data-work-stat="onsite">…</strong></div></div>
      <div class="tkj-work-columns"><section class="tkj-work-card"><h2>Submit today’s hours</h2><p class="tkj-sub">Choose the job, enter the full shift and today’s travel. TurnKey calculates equipment runtime automatically.</p>
        <form data-work="form"><label>Work date<input type="date" name="workDate" value="${esc(selectedDate)}" required></label>
          <label>Job<select name="jobId" required><option value="">Loading assigned jobs…</option></select></label>
          <div class="tkj-row"><label>Shift starts<input type="time" name="startTime" value="08:00" required></label><label>Shift ends<input type="time" name="endTime" value="16:00" required></label></div>
          <label>Travel today (minutes)<input type="number" name="travelMinutes" min="0" max="1440" step="5" value="0" required></label>
          <div class="tkj-work-runtime"><span>Equipment runtime for this shift</span><strong data-work="runtime">8.0 hours</strong><small>Calculated as shift length minus travel time. All equipment selected below gets this runtime.</small></div>
          <fieldset class="tkj-work-assets"><legend>Equipment used this shift</legend><div data-work="assets">Loading equipment…</div></fieldset>
          <label>Notes<textarea name="notes" maxlength="1600" placeholder="Work completed, issues or handover"></textarea></label>
          <p class="tkj-dialog-message" data-work="message" role="status" aria-live="polite"></p>
          <button type="submit" class="btn primary" data-work="submit">Save shift &amp; timesheet</button>
        </form></section>
        <section class="tkj-work-card"><h2>Equipment service status</h2><p class="tkj-sub">Runtime updates as work hours are submitted. Service due is shown clearly.</p><div data-work="equipment-summary">Loading…</div></section></div>
      <section class="tkj-work-card tkj-work-timesheet"><div class="tkj-work-section-head"><div><h2>Timesheet for <span data-work="date-label">${esc(selectedDate)}</span></h2><p class="tkj-sub">Employee work entries appear here as soon as they’re saved.</p></div><button type="button" class="btn ghost sm" data-work="calendar">Open staff calendar</button></div><div data-work="entries">Loading timesheet…</div></section>
    </div>`;

    const form = page.querySelector('[data-work="form"]');
    const runtimeEl = page.querySelector('[data-work="runtime"]');
    const calcRuntime = () => {
      const start = form.startTime.value, end = form.endTime.value;
      let minutes = start && end ? (Number(end.slice(0,2)) * 60 + Number(end.slice(3,5))) - (Number(start.slice(0,2)) * 60 + Number(start.slice(3,5))) : 0;
      if (minutes <= 0) minutes += 1440;
      const travel = Math.max(0, Number(form.travelMinutes.value || 0));
      const usable = Math.max(0, minutes - travel);
      runtimeEl.textContent = (usable / 60).toFixed(1) + ' hours';
      form.travelMinutes.max = String(minutes);
      return { minutes, travel, usable };
    };
    form.addEventListener('input', calcRuntime);
    form.workDate.addEventListener('change', () => renderWorkLogPage());
    page.querySelector('[data-work="refresh"]').onclick = () => renderWorkLogPage();
    page.querySelector('[data-work="calendar"]').onclick = () => root.TK_JOB_WORK.openCalendar();

    const setMessage = (text, isError = false) => {
      const target = page.querySelector('[data-work="message"]');
      if (target) { target.textContent = text; target.classList.toggle('tkj-error', isError); }
    };
    try {
      const range = workDateRange(selectedDate);
      const [jobsData, equipmentData, logsData] = await Promise.all([
        request('/jobs?date=' + encodeURIComponent(selectedDate), {}, scope),
        request('/equipment', {}, scope),
        request('/logs?' + new URLSearchParams(range), {}, scope),
      ]);
      if (scope.isStale() || seq !== workPageLoadSeq || !page.isConnected) return;
      const jobs = jobsData.jobs || [], equipment = equipmentData.equipment || [], logs = logsData.logs || [], usage = logsData.usage || [];
      form.jobId.innerHTML = '<option value="">Select a job</option>' + jobs.map(job => `<option value="${esc(job.id)}">${esc(job.name)}${job.address ? ' · ' + esc(job.address) : ''}${job.services?.length ? ' · ' + esc(job.services.join(', ')) : ''}</option>`).join('');
      page.querySelector('[data-work="assets"]').innerHTML = equipment.length ? equipment.map(asset => `<label class="tkj-work-asset"><input type="checkbox" name="assetId" value="${esc(asset.id)}"><span><b>${esc(asset.name)}</b><small>${asset.due ? 'Service due' : Number(asset.remainingHours).toFixed(1) + 'h until service'}</small></span></label>`).join('') : '<p>No equipment set up yet.</p>';
      page.querySelector('[data-work="equipment-summary"]').innerHTML = equipment.length ? `<div class="tkj-work-eq-list">${equipment.map(asset => `<div><span>${esc(asset.name)}</span><b class="${asset.due ? 'due' : ''}">${asset.due ? 'Service due' : Number(asset.remainingHours).toFixed(1) + 'h remaining'}</b></div>`).join('')}</div>` : '<p>Add equipment in Settings to start service-hour tracking.</p>';
      const grossMinutes = logs.reduce((sum, log) => sum + Number(log.minutes || 0), 0);
      const travelMinutes = logs.reduce((sum, log) => sum + Number((/\[Travel: (\d+) min\]/.exec(log.notes || '') || [])[1] || 0), 0);
      const onSiteMinutes = Math.max(0, grossMinutes - travelMinutes);
      page.querySelector('[data-work-stat="shift"]').textContent = fmtDuration(grossMinutes);
      page.querySelector('[data-work-stat="travel"]').textContent = fmtDuration(travelMinutes);
      page.querySelector('[data-work-stat="onsite"]').textContent = fmtDuration(onSiteMinutes);
      page.querySelector('[data-work="date-label"]').textContent = new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' });
      const jobById = new Map(jobs.map(job => [job.id, job]));
      page.querySelector('[data-work="entries"]').innerHTML = logs.length ? `<div class="tkj-work-entry-list">${logs.map(log => {
        const travel = Number((/\[Travel: (\d+) min\]/.exec(log.notes || '') || [])[1] || 0);
        const job = jobById.get(log.job_id);
        const equipmentHours = usage.filter(row => row.log_id === log.id).reduce((sum, row) => sum + Number(row.hours || 0), 0);
        return `<article><div><strong>${esc(job?.name || 'Job')}</strong><small>${esc(fmtDateTime(log.start_at))} – ${esc(new Date(log.end_at).toLocaleTimeString('en-NZ', { hour:'numeric', minute:'2-digit' }))}${log.notes ? ' · ' + esc(log.notes.replace(/\[Travel: \d+ min\](\s*·\s*)?/, '').trim()) : ''}</small></div><div class="tkj-work-entry-metrics"><b>${esc(fmtDuration(log.minutes))}</b><small>${travel ? fmtDuration(travel) + ' travel · ' : ''}${fmtDuration(Math.max(0, log.minutes - travel))} on site${equipmentHours ? ' · ' + equipmentHours.toFixed(1) + 'h equipment' : ''}</small></div></article>`;
      }).join('')}</div>` : '<div class="tkj-empty-state"><strong>No hours submitted for this day</strong><span>Save a shift above to start this timesheet.</span></div>';
      if (!jobs.length) setMessage('No jobs assigned in this date window. Ask a manager to assign you a job in the calendar.', true);
      calcRuntime();

      form.onsubmit = async event => {
        event.preventDefault();
        if (scope.isStale()) return;
        const calculated = calcRuntime();
        const startAt = toIso(form.workDate.value, form.startTime.value), endAt = toIso(form.workDate.value, form.endTime.value);
        if (+new Date(endAt) <= +new Date(startAt)) { setMessage('End time must be later than start time.', true); return; }
        if (calculated.travel > calculated.minutes) { setMessage('Travel cannot exceed the length of this shift.', true); return; }
        if (!form.jobId.value) { setMessage('Choose a job before saving your timesheet entry.', true); return; }
        const payload = { jobId: form.jobId.value, startAt, endAt, travelMinutes: calculated.travel, equipmentHoursAuto: true,
          equipment: [...form.querySelectorAll('[name="assetId"]:checked')].map(input => ({ assetId: input.value })), notes: form.notes.value.trim() || undefined };
        const requestId = await stableRequestId(payload);
        if (scope.isStale()) return;
        const submit = form.querySelector('[data-work="submit"]'); submit.disabled = true; setMessage('Saving shift…');
        try {
          await request('/logs', { method: 'POST', body: JSON.stringify({ ...payload, requestId }) }, scope);
          if (scope.isStale()) return;
          notify('Shift saved to the timesheet; equipment runtime updated.');
          root.dispatchEvent(new Event('turnkey:equipment-changed'));
          renderWorkLogPage();
        } catch (error) { if (!error.stale) setMessage(error.message, true); if (submit.isConnected) submit.disabled = false; }
      };
    } catch (error) {
      if (!error.stale && seq === workPageLoadSeq) setMessage('Could not load work log: ' + error.message, true);
    }
  }

  /* ===================== staff calendar (actual logged hours) ===================== */

  async function openCalendar() {
    const scope = makeScope();
    let role, staff = [];
    try { role = await myRole(scope); staff = staffListCache || []; } catch (e) { if (!e.stale) notify(e.message); return; }
    if (scope.isStale()) return;
    let weekStart = weekStartOf(new Date());
    let selectedUserId = isPrivileged(role) ? '' : scope.user;
    let loadSeq = 0;

    const { host, close } = overlay(`
      <section class="tkj-panel-modal" role="dialog" aria-modal="true" aria-labelledby="tkj-cal-title">
        <header><div><span>JOB RECORDS</span><h2 id="tkj-cal-title">Staff calendar — actual logged hours</h2><p class="tkj-sub">This shows hours workers have logged, not a schedule or payroll total.</p></div><button data-tkj="close" aria-label="Close staff calendar">Close</button></header>
        <div class="tkj-filters">
          <button type="button" data-tkj="prev-week" aria-label="Previous week">←</button>
          <span class="tkj-week-label"></span>
          <button type="button" data-tkj="next-week" aria-label="Next week">→</button>
          ${isPrivileged(role) ? `<select data-tkj="staff-filter"><option value="">All staff</option>${staff.map((u) => `<option value="${esc(u.id)}">${esc(u.email || u.id)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="tkj-calendar-actions"><button type="button" class="btn primary" data-tkj="open-booking">Open team booking calendar</button><button type="button" class="btn ghost" data-tkj="block-staff">Block leave / unavailable time</button></div>
        <div class="tkj-calendar-summary" aria-live="polite"></div>
        <p class="tkj-message" role="status" aria-live="polite">Loading…</p>
        <div class="tkj-week-grid"></div>
      </section>`, scope);

    host.querySelector('[data-tkj="close"]').addEventListener('click', close);
    host.querySelector('[data-tkj="prev-week"]').addEventListener('click', () => { weekStart = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 7); load(); });
    host.querySelector('[data-tkj="next-week"]').addEventListener('click', () => { weekStart = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7); load(); });
    host.querySelector('[data-tkj="open-booking"]').addEventListener('click', () => {
      close();
      if (root.TK_JOB_CALENDAR) root.TK_JOB_CALENDAR.open(); else notify('Calendar is not available yet.');
    });
    host.querySelector('[data-tkj="block-staff"]').addEventListener('click', () => {
      const staffId = filterEl?.value || (isPrivileged(role) ? '' : scope.user);
      close();
      if (root.TK_JOB_CALENDAR) root.TK_JOB_CALENDAR.blockTime({ dateISO: localDateStr(new Date()), staffId, reason: 'Staff unavailable' });
      else notify('Calendar is not available yet.');
    });
    const filterEl = host.querySelector('[data-tkj="staff-filter"]');
    if (filterEl) filterEl.addEventListener('change', () => { selectedUserId = filterEl.value; load(); });

    async function load() {
      const seq = ++loadSeq;
      const days = [...Array(7)].map((_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i));
      const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
      const label = host.querySelector('.tkj-week-label');
      label.textContent = localDateStr(days[0]) + ' – ' + localDateStr(days[6]);
      const message = (text, error) => { const el = host.querySelector('.tkj-message'); el.textContent = text; el.classList.toggle('tkj-error', !!error); };
      message('Loading…');
      try {
        const params = { from: weekStart.toISOString(), to: weekEnd.toISOString() };
        if (selectedUserId) params.userId = selectedUserId;
        const data = await request('/logs?' + new URLSearchParams(params), {}, scope);
        // A slower earlier request (e.g. the previous week, still in
        // flight) landing after a newer one would silently show the wrong
        // week — discard anything that isn't the most recent load() call.
        if (scope.isStale() || seq !== loadSeq) return;
        renderWeek(host, days, data.logs, staff);
        message(data.logs.length ? '' : 'No logged hours in this week.');
      } catch (e) {
        if (e.stale || seq !== loadSeq) return;
        message(e.notMigrated ? e.message : 'Could not load the calendar: ' + e.message, true);
      }
    }
    load();
  }

  function renderWeek(host, days, logs, staff) {
    const byUser = new Map();
    for (const l of logs) {
      if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
      byUser.get(l.user_id).push(l);
    }
    const dayStrs = days.map(localDateStr);
    const nameFor = (uid) => (staff.find((u) => u.id === uid) || {}).email || uid;
    const grid = host.querySelector('.tkj-week-grid');
    const total = logs.reduce((sum, l) => sum + Number(l.minutes || 0), 0);
    const summary = host.querySelector('.tkj-calendar-summary');
    if (summary) summary.innerHTML = `<span><b>${new Set(logs.map((l) => l.user_id)).size}</b> team members</span><span><b>${fmtDuration(total)}</b> recorded</span><span><b>${logs.length}</b> work entries</span>`;
    if (!byUser.size) { grid.innerHTML = '<div class="tkj-empty-state"><strong>No hours logged this week</strong><span>Plan a crew booking or record a shift from the calendar.</span></div>'; return; }
    grid.innerHTML = [...byUser.entries()].map(([uid, entries]) => {
      const perDay = dayStrs.map((ds) => entries.filter((l) => localDateStr(new Date(l.start_at)) === ds));
      const totalMinutes = entries.reduce((s, l) => s + l.minutes, 0);
      return `<div class="tkj-week-row">
        <div class="tkj-week-worker">${esc(nameFor(uid))}<small>${esc(fmtDuration(totalMinutes))} total</small></div>
        <div class="tkj-week-days">${perDay.map((dayLogs, i) => `<div class="tkj-week-day"><div class="tkj-week-day-label">${esc(days[i].toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric' }))}</div>${dayLogs.map((l) => `<div class="tkj-week-entry" title="${esc(l.notes || '')}">${esc(fmtDuration(l.minutes))}</div>`).join('') || '<div class="tkj-week-empty">—</div>'}</div>`).join('')}</div>
      </div>`;
    }).join('');
  }

  /* ===================== equipment & service ===================== */

  async function openEquipment() {
    const scope = makeScope();
    let role;
    try { role = await myRole(scope); } catch (e) { if (!e.stale) notify(e.message); return; }
    if (scope.isStale()) return;
    const { host, close } = overlay(`
      <section class="tkj-panel-modal" role="dialog" aria-modal="true" aria-labelledby="tkj-eq-title">
        <header><div><span>FLEET &amp; MAINTENANCE</span><h2 id="tkj-eq-title">Equipment &amp; service</h2><p class="tkj-sub">Runtime is calculated from submitted work logs. Book maintenance on the TurnKey calendar when service is due.</p></div><button data-tkj="close" aria-label="Close equipment">Close</button></header>
        <div class="tkj-calendar-actions"><button type="button" class="btn ghost" data-tkj="open-calendar">Open service calendar</button></div>
        <p class="tkj-message" role="status" aria-live="polite">Loading…</p>
        <div class="tkj-equipment-list"></div>
        ${isPrivileged(role) ? `<details><summary>Add equipment</summary>
          <form class="tkj-dialog" data-tkj-form="add-asset">
            <label>Name<input type="text" name="name" maxlength="200" required></label>
            <label>Service interval (hours)<input type="number" name="serviceIntervalHours" min="0.01" step="0.1" required></label>
            <label>Baseline hours already on this asset (cannot be changed later)<input type="number" name="baselineHours" min="0" step="0.1" value="0"></label>
            <p class="tkj-dialog-message" role="alert"></p>
            <button type="submit" class="btn primary">Add equipment</button>
          </form></details>` : ''}
      </section>`, scope);
    host.querySelector('[data-tkj="close"]').addEventListener('click', close);
    host.querySelector('[data-tkj="open-calendar"]').addEventListener('click', () => { close(); root.TK_JOB_CALENDAR?.open(); });
    let loadSeq = 0;

    async function load() {
      const seq = ++loadSeq;
      const message = (text, error) => { const el = host.querySelector('.tkj-message'); el.textContent = text; el.classList.toggle('tkj-error', !!error); };
      message('Loading…');
      try {
        const data = await request('/equipment', {}, scope);
        if (scope.isStale() || seq !== loadSeq) return;
        renderEquipmentList(host, data.equipment, role);
        message(data.equipment.length ? '' : 'No equipment configured yet.');
      } catch (e) {
        if (e.stale || seq !== loadSeq) return;
        message(e.notMigrated ? e.message : 'Could not load equipment: ' + e.message, true);
      }
    }

    const addForm = host.querySelector('[data-tkj-form="add-asset"]');
    if (addForm) addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (scope.isStale()) { close(); return; }
      const message = (text) => { addForm.querySelector('.tkj-dialog-message').textContent = text; };
      try {
        await request('/equipment', {
          method: 'POST',
          body: JSON.stringify({
            name: addForm.name.value,
            serviceIntervalHours: Number(addForm.serviceIntervalHours.value),
            baselineHours: Number(addForm.baselineHours.value || 0)
          })
        }, scope);
        if (scope.isStale()) { close(); return; }
        addForm.reset();
        notify('Equipment added');
        root.dispatchEvent(new Event('turnkey:equipment-changed'));
        load();
      } catch (e2) { if (!e2.stale) message(e2.message); }
    });

    host.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-tkj="mark-serviced"]');
      const schedule = e.target.closest('[data-tkj="schedule-service"]');
      if (schedule) {
        const asset = JSON.parse(schedule.dataset.asset || '{}');
        close();
        root.TK_JOB_CALENDAR?.scheduleEvent({ title: 'Equipment service · ' + asset.name,
          notes: `Scheduled maintenance for ${asset.name}. Runtime ${Number(asset.runtimeHours || 0).toFixed(1)}h; ${asset.due ? 'service is due' : Number(asset.remainingHours || 0).toFixed(1) + 'h remaining before service is due'}.` });
        return;
      }
      if (!btn) return;
      if (scope.isStale()) { close(); return; }
      if (!confirm('Mark "' + btn.dataset.name + '" as serviced now?')) return;
      try {
        await request('/equipment/' + encodeURIComponent(btn.dataset.id) + '/service', { method: 'POST', body: JSON.stringify({}) }, scope);
        if (scope.isStale()) { close(); return; }
        notify('Marked serviced');
        root.dispatchEvent(new Event('turnkey:equipment-changed'));
        load();
      } catch (e3) { if (!e3.stale) notify(e3.message); }
    });

    load();
  }

  function renderEquipmentList(host, equipment, role) {
    const el = host.querySelector('.tkj-equipment-list');
    el.innerHTML = equipment.map((a) => `<article class="tkj-asset ${a.due ? 'tkj-asset-due' : ''}">
      <div class="tkj-asset-head">
        <div><strong>${esc(a.name)}</strong><small>${a.due ? 'Needs attention now' : a.hasServiceHistory ? 'Service tracking active' : 'Service history not recorded yet'}</small></div>
        ${a.due ? '<span class="tkj-due-badge">Service due</span>' : `<span class="tkj-service-ok">${Number(a.remainingHours).toFixed(1)}h to service</span>`}
      </div>
      <div class="tkj-asset-stats">
        <span><b>${Number(a.runtimeHours).toFixed(1)}h</b><small>Total runtime</small></span>
        <span><b>${Number(a.sinceServiceHours).toFixed(1)}h</b><small>Since service${a.hasServiceHistory ? '' : ' · history unknown'}</small></span>
        <span><b>${Number(a.service_interval_hours).toFixed(1)}h</b><small>Service interval</small></span>
      </div>
      <div class="tkj-progress"><span style="width:${Math.max(0, Math.min(100, (a.sinceServiceHours / a.service_interval_hours) * 100))}%"></span></div>
      <div class="tkj-asset-actions">${isPrivileged(role) ? `<button type="button" class="btn primary sm" data-tkj="schedule-service" data-asset="${esc(JSON.stringify({ name: a.name, runtimeHours: a.runtimeHours, remainingHours: a.remainingHours, due: a.due }))}">Schedule service</button><button type="button" class="btn ghost sm" data-tkj="mark-serviced" data-id="${esc(a.id)}" data-name="${esc(a.name)}">Record completed service</button>` : ''}</div>
      ${a.recentServiceEvents.length ? `<details><summary>Service history (${a.recentServiceEvents.length})</summary><ul class="tkj-service-history">${a.recentServiceEvents.map((ev) => `<li>${esc(fmtDateTime(ev.serviced_at))} — meter ${Number(ev.meter_hours).toFixed(1)}h${ev.notes ? ': ' + esc(ev.notes) : ''}</li>`).join('')}</ul></details>` : '<p class="tkj-sub">No service recorded yet. Confirm the service meter baseline when creating the asset.</p>'}
    </article>`).join('') || '';
  }

  /* ===================== mount ===================== */

  function wrapOpenDetail() {
    if (typeof root.openDetail !== 'function' || root.openDetail.__tkJobWork) return false;
    const original = root.openDetail;
    const wrapped = function (recordId) {
      original(recordId);
      renderJobCard(recordId);
    };
    wrapped.__tkJobWork = true;
    root.openDetail = wrapped;
    return true;
  }

  let launcherVisibilityTimer = null;
  function mountLauncher() {
    if (document.getElementById('tkj-launcher')) return;
    const bar = document.createElement('div');
    bar.id = 'tkj-launcher';
    bar.className = 'tkj-launcher';
    bar.innerHTML = `<button data-tkj="calendar" title="Staff calendar — actual logged hours">Staff calendar</button>
      <button data-tkj="equipment" title="Equipment runtime and service status">Equipment &amp; service</button>`;
    bar.querySelector('[data-tkj="calendar"]').addEventListener('click', openCalendar);
    bar.querySelector('[data-tkj="equipment"]').addEventListener('click', openEquipment);
    document.body.appendChild(bar);
    let alertKey=null;
    const updateVisibility = () => {
      const scope=makeScope();
      bar.style.display=scope.biz&&scope.user?'':'none';
      const key=scope.biz+':'+scope.user+':'+scope.version;
      if(key===alertKey)return;
      alertKey=key;
      const button=bar.querySelector('[data-tkj="equipment"]');
      button.textContent='Equipment & service';
      if(!scope.biz||!scope.user)return;
      request('/equipment',{},scope).then(data=>{
        if(scope.isStale())return;
        const due=data.equipment.filter(a=>a.due).length;
        button.textContent='Equipment & service'+(due?' · '+due+' due':'');
        button.style.color=due?'#b91c1c':'';
      }).catch(()=>{});
    };
    root.addEventListener('turnkey:equipment-changed',()=>{alertKey=null;updateVisibility();});
    updateVisibility();
    clearInterval(launcherVisibilityTimer);
    launcherVisibilityTimer = setInterval(updateVisibility, 1000);
  }

  function init() {
    if (!wrapOpenDetail()) { setTimeout(init, 200); return; }
    mountLauncher();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

    root.TK_JOB_WORK = {
    configure(options) { config = { ...options }; roleCache = null; roleCacheKey = null; staffListCache = null; },
    openWorkLogPage,
    openCalendar,
    openEquipment,
    renderJobCard
  };
})(window);
