/* Independent Jobs / Invoices UI. Load after the CRM scripts; no automatic hooks.
 * Parent: TK_OPERATIONS.install({host: element, subscribe: refresh => unsubscribe});
 * Or mount separate instances with TK_OPERATIONS.create(options).install(host).
 * Call refresh() after CRM renders/data loads, reset() BEFORE auth/tenant changes,
 * and destroy() on unmount. A session watchdog also clears stale views/actions.
 * getContext returns {businessId, userId, version, role, ready}; ready must
 * remain false during tenant loads. subscribe(refresh) returns an unsubscribe.
 * getStaff/getInvoiceTerms and paymentBalance/invoiceDisplayStatus/money may
 * be supplied. actions overrides existing function names; null disables one.
 * closeFlows can replace native cleanup for a different host. Native send,
 * payment, PDF and checklist flows remain owned by the CRM and its safeguards.
 * Optional getters below replace globals (including lexical CRM globals) in tests.
 * getRecords MUST return the current business's hydrated CRM records; recordBusiness
 * defaults to the CRM's recordBusinesses WeakMap, rejecting unowned records.
 * No network, alternate persistence, ServiceM8 dependency, or optimistic writes.
 */
(function (root) {
  'use strict';
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {won:'Won',scheduled:'Scheduled',travelling:'Travelling',on_site:'On site',in_progress:'In progress',paused:'Paused',completed:'Completed',cancelled:'Cancelled',paid:'Paid',draft:'Draft',sent:'Sent',partial:'Partially paid',overdue:'Overdue'};
  function create(options = {}) {
    const get = (key, fallback) => options[key] ? options[key]() : fallback();
    const context = () => get('getContext', () => ({
      businessId: typeof currentBusinessId === 'undefined' ? null : currentBusinessId,
      userId: typeof currentUserId === 'undefined' ? null : currentUserId,
      version: typeof businessSessionVersion === 'undefined' ? 0 : businessSessionVersion,
      role: typeof currentUserRole === 'undefined' ? null : currentUserRole,
      ready: typeof businessStateReady !== 'undefined' && businessStateReady
    }));
    const keyOf = c => JSON.stringify([c.businessId,c.userId,c.version,c.role,c.ready]);
    const manager = c => ['owner','manager'].includes(c.role);
    const assigned = (r,c) => r.assignedStaffId === c.userId || (Array.isArray(r.assignedStaffIds) && r.assignedStaffIds.includes(c.userId));
    const source = () => get('getRecords', () => typeof records === 'undefined' ? [] : records);
    const staffList = () => get('getStaff', () => typeof staff === 'undefined' ? [] : staff);
    const action = name => Object.prototype.hasOwnProperty.call(options.actions || {}, name) ? options.actions[name] : name === 'calendar' && root.TK_JOB_CALENDAR?.open ? () => root.TK_JOB_CALENDAR.open() : root[name];
    const balance = r => (options.paymentBalance || root.paymentBalance)?.(r);
    const invoiceStatus = r => (options.invoiceDisplayStatus || root.invoiceDisplayStatus)?.(r);
    const currency = v => (options.money || root.money || (n => new Intl.NumberFormat('en-NZ',{style:'currency',currency:'NZD'}).format(n)))(v);
    const owned = (r,c) => (options.recordBusiness ? options.recordBusiness(r) : typeof recordBusinesses !== 'undefined' ? recordBusinesses.get(r) : r.businessId || r.business_id) === c.businessId;
    const job = r => ['won','scheduled','completed','paid'].includes(r.stage) || (r.stage === 'cancelled' && !r.lostAt && !!(r.wonAt || r.approvedAt));
    const status = r => ['completed','paid','cancelled'].includes(r.stage) ? r.stage : r.jobStatus || r.stage;
    let host, stamp, timer, unsubscribe, lastData, busy = false, epoch = 0, message = '', launched = false;
    let view = 'jobs', search = '', filter = 'all', layout = 'table', customer = '';
    const visible = c => {
      const seen = new Set();
      if (!c.ready || !c.businessId || !c.userId) return [];
      return source().filter(r => {
        if (!owned(r,c) || r.id == null) return false;
        if (!manager(c) && !(c.role === 'technician' && assigned(r,c))) return false;
        const id = r.jobId || r.id;
        if (seen.has(id)) return false;
        seen.add(id); return true;
      });
    };
    const crew = r => {
      const ids = [...new Set([...(r.assignedStaffIds || []),r.assignedStaffId].filter(Boolean))];
      const names = ids.map(id => { const s = staffList().find(s => s.id === id); return s ? s.name || s.email || 'Unnamed staff' : 'Assigned staff'; });
      return [r.calendarTeamLabel, names.join(', ') || r.tech].filter(Boolean).join(' · ') || 'Unassigned';
    };
    const schedule = r => {
      if (r.calendarStartAt) { const d = new Date(r.calendarStartAt); if (!Number.isNaN(d.valueOf())) return d.toLocaleString('en-NZ',{dateStyle:'medium',timeStyle:'short'}); }
      const date = r.scheduledDateISO || r.scheduledDate;
      const mins = r.scheduledStartMin;
      return date ? date + (Number.isFinite(mins) ? ' ' + String(Math.floor(mins / 60)).padStart(2,'0') + ':' + String(mins % 60).padStart(2,'0') : '') : 'Unscheduled';
    };
    function allowed(name,r,c) {
      if (typeof action(name) !== 'function') return false;
      if (name === 'openNewJobModal' || name === 'createJob' || name === 'calendar') return manager(c);
      if (name === 'openDetail') return true;
      if (['previewInvoice','openPaymentModal'].includes(name)) return manager(c) && !!r.invoiceId && (name !== 'openPaymentModal' || (Number.isFinite(balance(r)) && balance(r) > 0 && invoiceStatus(r) !== 'paid'));
      if (name === 'openSchedule') return manager(c) && ['won','scheduled'].includes(r.stage) && !['in_progress','paused'].includes(r.jobStatus);
      if (!(manager(c) || (c.role === 'technician' && assigned(r,c)))) return false;
      if (name === 'startJob') return r.stage === 'scheduled' && !r.startedAt && !['in_progress','paused','completed'].includes(r.jobStatus);
      if (name === 'pauseJob') return r.stage === 'scheduled' && r.jobStatus === 'in_progress';
      if (name === 'resumeJob') return r.stage === 'scheduled' && r.jobStatus === 'paused';
      if (name === 'completeJob') return r.stage === 'scheduled' && r.jobStatus === 'in_progress';
      return false;
    }
    const button = (name,label,r,c) => allowed(name,r,c) ? `<button type="button" data-action="${name}" data-record="${escape(r.id)}" ${busy?'disabled':''}>${label}</button>` : '';
    function actions(r,c) {
      return button('openDetail','Open record',r,c) + (view === 'invoices' ? button('previewInvoice','Preview / send',r,c) + button('openPaymentModal','Record payment',r,c) : button('openSchedule','Schedule / crew',r,c) + button('startJob','Start',r,c) + button('pauseJob','Pause',r,c) + button('resumeJob','Resume',r,c) + button('completeJob','Complete',r,c));
    }
    function closeFlows() {
      if (!launched) return;
      launched = false;
      if (options.closeFlows) { options.closeFlows(); return; }
      // Clear native modal payloads as well as hiding them: a stale confirmation
      // must not resolve a reused local record id in the next business.
      for (const id of ['lead-overlay','schedule-overlay','pause-overlay','payment-overlay','doc-preview-overlay','send-doc-overlay','signature-overlay','cancel-job-overlay','job-note-overlay']) {
        const el = root.document.getElementById(id); if (el) { el.classList.remove('open'); el.querySelectorAll('input,textarea').forEach(input => { input.value = ''; }); }
      }
      if (typeof leadModalSchedulingMode !== 'undefined') leadModalSchedulingMode = false;
      if (typeof pendingPhotoTarget !== 'undefined') pendingPhotoTarget = null;
      if (typeof pendingSignatureJobId !== 'undefined') pendingSignatureJobId = null;
      if (typeof pendingNoteJobId !== 'undefined') pendingNoteJobId = null;
      if (typeof pendingCancelId !== 'undefined') pendingCancelId = null;
      if (typeof sigDrawing !== 'undefined') sigDrawing = false;
      const pad = root.document.getElementById('signature-pad');
      if (pad) pad.width = pad.width;
      if (typeof pendingPauseId !== 'undefined') pendingPauseId = null;
      if (typeof pendingPaymentJobId !== 'undefined') pendingPaymentJobId = null;
      if (typeof pendingNewJobCustomerId !== 'undefined') pendingNewJobCustomerId = null;
      if (typeof scheduleId !== 'undefined') scheduleId = null;
      if (typeof scheduleChoice !== 'undefined') scheduleChoice = null;
      if (typeof docPreview !== 'undefined') docPreview = {mode:'quote',recordId:null};
      if (typeof sendDocCtx !== 'undefined') sendDocCtx = {mode:'quote',recordId:null};
      for (const id of ['doc-preview-body','doc-preview-foot','sched-body','pay-summary','pay-history']) root.document.getElementById(id)?.replaceChildren();
      const detail = root.document.getElementById('view-detail');
      if (detail) { detail.replaceChildren(); detail.classList.remove('active'); }
    }
    function reset() {
      ++epoch; closeFlows(); busy = false; search = ''; filter = 'all'; customer = ''; message = ''; view = 'jobs'; layout = 'table';
      stamp = keyOf(context()); if (host) host.replaceChildren();
    }
    function refresh() {
      if (!host) return;
      const c = context();
      if (stamp !== keyOf(c)) reset();
      if (!c.ready || !c.businessId || !c.userId) { host.innerHTML = '<p class="tko-empty">Sign in and load your business to view operations.</p>'; return; }
      const scope = visible(c);
      const invoiceView = view === 'invoices';
      const rows = scope.filter(r => invoiceView ? manager(c) && !!r.invoiceId : job(r)).filter((r,i,all) => !invoiceView || all.findIndex(x => x.invoiceId === r.invoiceId) === i);
      const needle = search.toLocaleLowerCase().trim();
      const shown = rows.filter(r => {
        const s = invoiceView ? invoiceStatus(r) : status(r);
        const matches = filter === 'all' || (invoiceView && filter === 'unpaid' ? s !== 'paid' && Number.isFinite(balance(r)) && balance(r) > 0 : filter === 'unscheduled' ? !r.scheduledDateISO && !r.scheduledDate && !r.calendarStartAt : s === filter);
        return matches && (!needle || [r.name,r.email,r.phone,r.address,r.suburb,r.jobId,r.invoiceId,crew(r)].join(' ').toLocaleLowerCase().includes(needle));
      });
      const filters = invoiceView ? ['all','draft','sent','unpaid','partial','overdue','paid'] : ['all','unscheduled','won','scheduled','travelling','on_site','in_progress','paused','completed','paid','cancelled'];
      const customers = [...new Map(scope.filter(r => r.customerId).map(r => [r.customerId,r])).values()];
      const currentFocus = host.contains(root.document.activeElement) ? root.document.activeElement.dataset.control : null;
      const caret = currentFocus === 'search' ? root.document.activeElement.selectionStart : null;
      const cells = r => {
        const s = invoiceView ? invoiceStatus(r) : status(r);
        const b = invoiceView ? balance(r) : null;
        return `<td data-label="Customer"><strong>${escape(r.name || 'Unnamed customer')}</strong><small>${escape([r.address,r.suburb].filter(Boolean).join(', '))}</small>${invoiceView?`<small>Invoice ${escape(r.invoiceId)}</small>${r.payments?.length?`<details><summary>Payment history</summary>${r.payments.map(p=>`<p>${escape(p.date || 'No date')} · ${Number.isFinite(Number(p.amount))?escape(currency(Number(p.amount))):'Amount unavailable'} · ${escape(p.method || 'No method')}${p.notes?' · '+escape(p.notes):''}</p>`).join('')}</details>`:''}`:''}</td><td data-label="${invoiceView?'Due':'Schedule'}">${escape(invoiceView ? r.dueDate || 'No due date' : schedule(r))}</td><td data-label="${invoiceView?'Payment':'Crew'}">${escape(invoiceView ? r.paymentMethod || 'No method recorded' : crew(r))}</td><td data-label="Status"><span class="tko-status">${escape(labels[s] || s || 'Unknown')}</span></td><td data-label="Value">${Number.isFinite(r.total)?escape(currency(r.total)):'Unavailable'}${invoiceView?`<small>Balance: ${Number.isFinite(b)?escape(currency(b)):'Unavailable'}</small>`:''}</td><td data-label="Actions"><div class="tko-actions">${actions(r,c)}</div></td>`;
      };
      host.classList.add('tko-workspace');
      host.innerHTML = `<nav class="tko-nav" aria-label="Operations"><button type="button" data-view="jobs" aria-current="${view==='jobs'?'page':'false'}">Jobs</button>${manager(c)?`<button type="button" data-view="invoices" aria-current="${invoiceView?'page':'false'}">Invoices</button>`:''}</nav><section aria-label="${invoiceView?'Invoices':'Jobs'}"><header><div><h2>${invoiceView?'Invoices':'Jobs'}</h2><p>${invoiceView?'Existing invoices and payment balances.':'Won jobs, scheduling and work in progress.'}</p></div>${!invoiceView && manager(c) && typeof action('calendar') === 'function'?'<button type="button" data-action="calendar">Open calendar</button>':''}</header>
      ${!invoiceView && manager(c) && typeof action('createJob') === 'function'?'<div class="tko-new"><button type="button" data-action="createJob">＋ New job</button><p>Search for an existing customer or add their details in the job form.</p></div>':!invoiceView && manager(c) && typeof action('openNewJobModal') === 'function'?`<div class="tko-new"><label>Existing customer<select data-control="customer"><option value="">Choose customer</option>${customers.map(r=>`<option value="${escape(r.customerId)}" ${customer===r.customerId?'selected':''}>${escape(r.name || r.email || 'Unnamed customer')}</option>`).join('')}</select></label><button type="button" data-action="openNewJobModal" ${!customer||busy?'disabled':''}>New job</button></div>`:''}
      <div class="tko-tools"><label>Search<input type="search" data-control="search" value="${escape(search)}" placeholder="Customer, address, crew or reference"></label><label>Status<select data-control="filter">${filters.map(f=>`<option value="${f}" ${filter===f?'selected':''}>${escape(labels[f] || (f==='all'?'All':f==='unpaid'?'Unpaid':'Unscheduled'))}</option>`).join('')}</select></label>${!invoiceView?`<label>View<select data-control="layout"><option value="table" ${layout==='table'?'selected':''}>Table</option><option value="board" ${layout==='board'?'selected':''}>Board</option></select></label>`:''}</div><p role="status">${escape(message || `${shown.length} ${invoiceView?(shown.length===1?'invoice':'invoices'):(shown.length===1?'job':'jobs')}`)}</p>
      ${shown.length ? !invoiceView && layout === 'board' ? `<div class="tko-board">${[...new Set(shown.map(status))].map(s=>`<section class="tko-column" aria-label="${escape(labels[s]||s)}"><h3>${escape(labels[s]||s)}</h3>${shown.filter(r=>status(r)===s).map(r=>`<article data-row="${escape(r.id)}"><h4>${escape(r.name)}</h4><p>${escape(r.address || r.suburb || '')}</p><p>${escape(schedule(r))}</p><p>${escape(crew(r))}</p><p>${Number.isFinite(r.total)?escape(currency(r.total)):'Unavailable'}</p><div class="tko-actions">${actions(r,c)}</div></article>`).join('')}</section>`).join('')}</div>` : `<table><caption class="tko-sr">${invoiceView?'Invoices':'Jobs'}</caption><thead><tr>${['Customer',invoiceView?'Due':'Schedule',invoiceView?'Payment':'Crew','Status','Value','Actions'].map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${shown.map(r=>`<tr data-row="${escape(r.id)}">${cells(r)}</tr>`).join('')}</tbody></table>` : '<p class="tko-empty">No matching records.</p>'}
      ${invoiceView?`<details><summary>Payment terms</summary><p class="tko-terms">${escape(get('getInvoiceTerms',()=>typeof docTemplate!=='undefined'?docTemplate.invoiceTerms:'') || 'No payment terms configured. Configure them in Settings Templates.')}</p><p>Open the invoice preview for the existing PDF and email flow. Record payment opens the payment ledger and history.</p></details>`:''}</section>`;
      if (currentFocus) { const el = host.querySelector(`[data-control="${currentFocus}"]`); if (el) { el.focus(); if (caret !== null) el.setSelectionRange(caret,caret); } }
    }
    async function click(event) {
      const el = event.target.closest('button'); if (!el || !host.contains(el)) return;
      const c = context();
      if (stamp !== keyOf(c)) { refresh(); return; }
      if (!c.ready || !c.businessId || !c.userId) return;
      if (el.dataset.view) { view = el.dataset.view === 'invoices' && manager(c) ? 'invoices' : 'jobs'; filter = 'all'; search = ''; message = ''; refresh(); return; }
      if (busy || el.disabled) return;
      const name = el.dataset.action;
      const r = visible(c).find(r => String(r.id) === el.dataset.record);
      if (name === 'openNewJobModal') { if (!visible(c).some(r => r.customerId === customer) || !allowed(name,null,c)) return; }
      else if (name === 'createJob') { if (!allowed(name,null,c)) return; }
      else if (name !== 'calendar' && (!r || !(view === 'invoices' ? r.invoiceId && manager(c) : job(r)) || !allowed(name,r,c))) return;
      else if (name === 'calendar' && !allowed(name,null,c)) return;
      busy = true; launched = true; message = ''; const token = epoch; refresh();
      try {
        await action(name)(name === 'openNewJobModal' ? customer : r?.id);
      } catch (error) { if (token === epoch && stamp === keyOf(context())) message = error.message || 'Could not open this action.'; }
      finally { if (token === epoch) { busy = false; refresh(); } }
    }
    function change(event) {
      if (stamp !== keyOf(context())) { refresh(); return; }
      const control = event.target.dataset.control;
      if (control === 'search') search = event.target.value;
      if (control === 'filter') filter = event.target.value;
      if (control === 'layout') layout = event.target.value;
      if (control === 'customer') customer = event.target.value;
      refresh();
    }
    function install(target = options.host) {
      destroy(); host = typeof target === 'string' ? root.document.querySelector(target) : target;
      if (!host) throw Error('Provide an operations workspace host element.');
      host.addEventListener('click',click); host.addEventListener('input',change); host.addEventListener('change',change);
      stamp = keyOf(context());
      if (options.subscribe) unsubscribe = options.subscribe(refresh);
      root.addEventListener('turnkey:business-ready',refresh);
      timer = root.setInterval(() => {
        const next = JSON.stringify([context(),source(),staffList(),get('getInvoiceTerms',()=>typeof docTemplate!=='undefined'?docTemplate.invoiceTerms:'')]);
        if (next !== lastData) { lastData = next; refresh(); }
      }, options.watchInterval || 500);
      lastData = JSON.stringify([context(),source(),staffList(),get('getInvoiceTerms',()=>typeof docTemplate!=='undefined'?docTemplate.invoiceTerms:'')]);
      refresh(); return api;
    }
    function destroy() {
      if (timer) root.clearInterval(timer); timer = null;
      if (typeof unsubscribe === 'function') unsubscribe(); unsubscribe = null;
      root.removeEventListener('turnkey:business-ready',refresh);
      if (host) { reset(); host.removeEventListener('click',click); host.removeEventListener('input',change); host.removeEventListener('change',change); host.classList.remove('tko-workspace'); host = null; }
    }
    const api = {install,refresh,render:refresh,reset,destroy,open(section) { if (stamp !== keyOf(context())) reset(); view = section === 'invoices' && manager(context()) ? 'invoices' : 'jobs'; filter = 'all'; search = ''; refresh(); }};
    return api;
  }
  let instance;
  root.TK_OPERATIONS = {
    create,
    install(options = {}) {
      instance?.destroy();
      const actions = {...options.actions};
      if (!Object.prototype.hasOwnProperty.call(actions,'calendar') && root.TK_JOB_CALENDAR?.open) actions.calendar = () => root.TK_JOB_CALENDAR.open();
      instance = create({...options,actions}); return instance.install();
    },
    refresh() { instance?.refresh(); }, render() { instance?.refresh(); },
    open(section) { instance?.open(section); }, reset() { instance?.reset(); }, destroy() { instance?.destroy(); instance = null; }
  };
})(window);
