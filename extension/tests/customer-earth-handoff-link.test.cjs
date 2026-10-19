// Tests the Google Earth customer-handoff IIFE appended to the repo root's
// extension-quote-link.js (separate from, and running alongside, its
// existing job-import IIFE — see quote-link.test.cjs for that one). Runs
// the real file in a fresh vm context with a minimal fake DOM, since this
// script is a plain classic script with no module system of its own (same
// approach quote-link.test.cjs already uses).
//
// This IIFE is THE quoting entry point for an existing customer's "Build
// quote" / customer-profile Quote click — it never calls the old
// openQuoteModal() builder once it decides to act. Every test here asserts
// that directly: `opened` (the openQuoteModal(id) call tracker) must stay
// empty across every scenario where the handoff modal takes over, even
// when the extension is missing, errors, or times out.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

// ---- Minimal fake DOM, just enough for the imperative (no innerHTML)
// modal construction in extension-quote-link.js. ---------------------------
function makeFakeElement(tag) {
  return {
    tagName: tag,
    id: undefined,
    className: '',
    textContent: '',
    children: [],
    parentNode: null,
    _attrs: {},
    _listeners: {},
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; },
    addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn); },
    get firstChild() { return this.children[0] || null; }
  };
}
function findById(el, id) {
  if (!el) return null;
  if (el.id === id) return el;
  for (const c of el.children) { const f = findById(c, id); if (f) return f; }
  return null;
}
function findByAttr(el, name) {
  if (el.getAttribute && el.getAttribute(name) !== null) return el;
  for (const c of (el.children || [])) { const f = findByAttr(c, name); if (f) return f; }
  return null;
}
function allText(el) {
  let s = el.textContent || '';
  (el.children || []).forEach((c) => { s += ' ' + allText(c); });
  return s;
}
function makeFakeDocument() {
  const head = makeFakeElement('head');
  const body = makeFakeElement('body');
  const listeners = {};
  return {
    head, body,
    createElement: (tag) => makeFakeElement(tag),
    getElementById: (id) => findById(head, id) || findById(body, id),
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    _listeners: listeners
  };
}

function makeElement({ onclick = '', text = '', cpQa = false, action = null, recordId = null, id = null } = {}) {
  const el = {
    id,
    _onclick: onclick,
    _text: text,
    classList: { contains: (c) => (cpQa ? c === 'cp-qa' : false) },
    getAttribute: (name) => (name === 'onclick' ? el._onclick : name === 'data-sale-action' ? action : name === 'data-id' ? recordId : null),
    get textContent() { return el._text; },
    closest: (sel) => ((el._onclick || ['quote','quote-select'].includes(action) || id === 'quote-builder-open') ? el : null)
  };
  return el;
}

function setup({ records, currentBusinessId = 'biz1', businessStateReady = true } = {}) {
  const messages = [];
  const opened = []; // openQuoteModal(id) calls — must stay empty whenever the modal takes over
  const synced = []; // syncRecordToSupabase(r) calls
  const timers = [];
  let nextTimerId = 1;

  const recordBusinesses = new WeakMap();
  (records || []).forEach((r) => { if(r.customerId && !Object.hasOwn(r,'jobId'))r.jobId='job-'+r.id; recordBusinesses.set(r, currentBusinessId); });

  const fakeWindow = {
    location: { href: 'https://turnkeycrm.net/index.html', origin: 'https://turnkeycrm.net' },
    crypto: { randomUUID: () => 'nonce-' + Math.random().toString(36).slice(2) },
    addEventListener: (name, fn) => { if (name === 'message') (fakeWindow._msgListeners = fakeWindow._msgListeners || []).push(fn); },
    postMessage: (msg) => messages.push(msg)
  };

  const fakeDocument = makeFakeDocument();

  const ctx = {
    URL,
    location: fakeWindow.location,
    window: fakeWindow,
    document: fakeDocument,
    setTimeout: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    records: records || [],
    recordBusinesses,
    currentBusinessId,
    businessSessionVersion: 1,
    businessStateReady,
    openDetail: () => {},
    openQuoteModal: (id) => opened.push(id),
    syncRecordToSupabase: async (r) => { synced.push(r); },
    toast: (m) => messages.push({ toast: m })
  };
  vm.runInNewContext(fs.readFileSync('extension-quote-link.js', 'utf8'), ctx);

  function click(el) {
    const event = {
      target: el,
      preventDefault: () => { event._prevented = true; },
      stopPropagation: () => {},
      stopImmediatePropagation: () => {}
    };
    (fakeDocument._listeners.click || []).forEach((fn) => fn(event));
    return event;
  }
  function extensionReady() {
    (fakeWindow._msgListeners || []).forEach((fn) => fn({ source: fakeWindow, origin: 'https://turnkeycrm.net', data: { source: 'turnkey-customer-launch', type: 'TK_READY', version: '0.2.2' } }));
  }
  function extensionAck(nonce) {
    (fakeWindow._msgListeners || []).forEach((fn) => fn({ source: fakeWindow, origin: 'https://turnkeycrm.net', data: { source: 'turnkey-customer-launch', type: 'TK_LAUNCH_ACK', nonce } }));
  }
  function extensionError(nonce, error) {
    (fakeWindow._msgListeners || []).forEach((fn) => fn({ source: fakeWindow, origin: 'https://turnkeycrm.net', data: { source: 'turnkey-customer-launch', type: 'TK_LAUNCH_ERROR', nonce, error } }));
  }
  function lastLaunch() {
    return messages.slice().reverse().find((m) => m && m.type === 'TK_LAUNCH');
  }
  function flush() { return new Promise((resolve) => setImmediate(resolve)); }
  function lastModal() {
    const n = fakeDocument.body.children.length;
    return n ? fakeDocument.body.children[n - 1] : null;
  }

  return { ctx, click, extensionReady, extensionAck, extensionError, messages, opened, synced, timers, lastLaunch, flush, lastModal, fakeDocument };
}

test('a "Build quote" click is intercepted even when the extension is not ready yet — shows the manual Earth modal, never the old builder', () => {
  const r = { id: 1, name: 'Jane', customerId: 'cust1', address: '1 Test St', suburb: 'Ponsonby' };
  const s = setup({ records: [r] });
  const el = makeElement({ onclick: 'openQuoteModal(1)', text: 'Build quote' });
  const event = s.click(el);
  assert.equal(event._prevented, true, 'must intercept, not leave the native builder onclick to run');
  assert.equal(s.opened.length, 0, 'the old builder must never be opened');
  const modal = s.lastModal();
  assert.ok(modal, 'a handoff modal must be shown');
  const text = allText(modal);
  assert.match(text, /Address: 1 Test St, Ponsonby/);
  assert.ok(findByAttr(modal, 'data-eh-earth-link'), 'a manual Open Google Earth link must be present');
  assert.ok(findByAttr(modal, 'data-eh-install'), 'install/update instructions must be shown while the extension is not ready');
  assert.match(text, /turnkey-earth-extension-0\.2\.6\.zip/);
});

test('the manual Earth link encodes the exact customer address and points at earth.google.com', () => {
  const r = { id: 1, name: 'Jane', customerId: 'cust1', address: '1 Test St', suburb: 'Ponsonby' };
  const s = setup({ records: [r] });
  const el = makeElement({ onclick: 'openQuoteModal(1)', text: 'Build quote' });
  s.click(el);
  const link = findByAttr(s.lastModal(), 'data-eh-earth-link');
  assert.equal(link.getAttribute('href'), 'https://earth.google.com/web/search/' + encodeURIComponent('1 Test St, Ponsonby'));
});

test('"Edit quote" is never intercepted, even when the extension is ready', () => {
  const r = { id: 2, name: 'Bob', customerId: 'cust2', address: '2 Test St' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(2)', text: 'Edit quote' });
  const event = s.click(el);
  assert.equal(event._prevented, undefined);
  assert.equal(s.lastLaunch(), undefined, 'must never dispatch a LAUNCH for Edit quote');
  assert.equal(s.lastModal(), null, 'must never show the handoff modal for Edit quote');
});

test('"Review & send quote" is never intercepted', () => {
  const r = { id: 3, name: 'Amy', customerId: 'cust3', address: '3 Test St' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(3)', text: 'Review & send quote' });
  s.click(el);
  assert.equal(s.lastLaunch(), undefined);
  assert.equal(s.lastModal(), null);
});

test('the .cp-qa customer-profile "Quote" button is intercepted and auto-launches once the extension is ready', () => {
  const r = { id: 4, name: 'Sam', customerId: 'cust4', address: '4 Test St' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'closeCustomerProfile();openQuoteModal(4)', text: 'Quote', cpQa: true });
  const event = s.click(el);
  assert.equal(event._prevented, true);
  const launch = s.lastLaunch();
  assert.ok(launch);
  assert.equal(launch.customerId, 'cust4');
  assert.equal(launch.businessId, 'biz1');
  assert.ok(launch.nonce);
  assert.match(allText(s.lastModal()), /Opening Google Earth automatically/);
});

test('a record with no customerId yet shows a clear "save this lead as a customer" validation message — never the old builder', async () => {
  const r = { id: 5, name: 'No Customer Yet', customerId: null, address: '5 Test St' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(5)', text: 'Build quote' });
  s.click(el);
  await s.flush();
  assert.equal(s.synced.length, 1);
  assert.equal(s.synced[0], r);
  assert.equal(s.opened.length, 0, 'the old builder must never be opened');
  const modal = s.lastModal();
  assert.ok(findByAttr(modal, 'data-eh-validation-error'));
  assert.match(allText(modal), /Save this lead as a customer/);
});

test('a record missing an address shows a clear missing-address validation message, with no Earth link to click', () => {
  const r = { id: 11, name: 'No Address', customerId: 'cust11', address: '' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(11)', text: 'Build quote' });
  s.click(el);
  const modal = s.lastModal();
  assert.match(allText(modal), /Add an address for this customer/);
  assert.equal(findByAttr(modal, 'data-eh-earth-link'), null, 'no Earth link without a real address');
});

test('a LAUNCH error (background rejection) keeps the modal open with the error and install instructions — never the old builder', async () => {
  const r = { id: 6, name: 'Error Case', customerId: 'cust6', address: '6 Test St' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(6)', text: 'Build quote' });
  s.click(el);
  const launch = s.lastLaunch();
  assert.ok(launch);
  s.extensionError(launch.nonce, 'This customer has no saved address yet.');
  await s.flush();
  assert.equal(s.opened.length, 0, 'the old builder must never be opened');
  const modal = s.lastModal();
  assert.ok(modal, 'the modal must still be open, not replaced by the old builder');
  const errEl = findByAttr(modal, 'data-eh-launch-error');
  assert.ok(errEl);
  assert.match(errEl.textContent, /no saved address/i);
  assert.ok(findByAttr(modal, 'data-eh-install'), 'install instructions must show once a launch has failed');
});

test('a LAUNCH timeout keeps the modal open with a clear error instead of hanging or falling back to the old builder', async () => {
  const r = { id: 7, name: 'Timeout Case', customerId: 'cust7', address: '7 Test St' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(7)', text: 'Build quote' });
  s.click(el);
  assert.ok(s.lastLaunch());
  assert.equal(s.timers.length, 1);
  s.timers[0].fn(); // fire the launch timeout directly
  await s.flush();
  assert.equal(s.opened.length, 0, 'the old builder must never be opened');
  const errEl = findByAttr(s.lastModal(), 'data-eh-launch-error');
  assert.ok(errEl);
  assert.match(errEl.textContent, /did not respond/i);
});

test('a business session that is not ready blocks the old builder without handing off customer data', () => {
  const r = { id: 8, name: 'Not Ready', customerId: 'cust8', address: '8 Test St' };
  const s = setup({ records: [r], businessStateReady: false });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(8)', text: 'Build quote' });
  const event = s.click(el);
  assert.equal(event._prevented, true);
  assert.equal(s.lastLaunch(), undefined);
  assert.equal(s.lastModal(), null);
});

test('a record owned by a different business than the current session is never handed off', () => {
  const r = { id: 9, name: 'Foreign Record', customerId: 'cust9', address: '9 Test St' };
  const s = setup({ records: [r], currentBusinessId: 'biz1' });
  s.ctx.recordBusinesses.set(r, 'biz-other');
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(9)', text: 'Build quote' });
  const event = s.click(el);
  assert.equal(event._prevented, true);
  assert.equal(s.lastLaunch(), undefined);
  assert.equal(s.lastModal(), null);
});

test('a successful LAUNCH ack closes the modal and never opens the old builder', async () => {
  const r = { id: 10, name: 'Happy Path', customerId: 'cust10', address: '10 Test St' };
  const s = setup({ records: [r] });
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(10)', text: 'Build quote' });
  s.click(el);
  const launch = s.lastLaunch();
  s.extensionAck(launch.nonce);
  await s.flush();
  assert.equal(s.opened.length, 0);
  assert.equal(s.fakeDocument.body.children.length, 0, 'the modal must be closed on a successful launch');
  assert.ok(s.messages.some((m) => m.toast && /Opening Google Earth/i.test(m.toast)));
});

test('a business switch while awaiting syncRecordToSupabase() aborts the handoff entirely — no modal, no launch, no old builder', async () => {
  const r = { id: 12, name: 'Switches Mid-Sync', customerId: null, address: '12 Test St' };
  const s = setup({ records: [r], currentBusinessId: 'biz1' });
  s.ctx.syncRecordToSupabase = async (rec) => {
    // Simulate reconnecting to a different business while this await is in flight.
    s.ctx.currentBusinessId = 'biz2';
  };
  s.extensionReady();
  const el = makeElement({ onclick: 'openQuoteModal(12)', text: 'Build quote' });
  s.click(el);
  await s.flush();
  assert.equal(s.opened.length, 0, 'the old builder must never be opened');
  assert.equal(s.lastLaunch(), undefined, 'no LAUNCH must be dispatched for a session that changed mid-flight');
  assert.equal(s.lastModal(), null, 'no modal must be shown for a stale/aborted session');
  assert.ok(s.messages.some((m) => m.toast && /session changed/i.test(m.toast)));
});


test('Sales pipeline quote action uses the Earth launcher instead of the old builder', async () => {
 const r={id:42,name:'Customer',customerId:'cust42',address:'42 Test Street'};
 const s=setup({records:[r]});
 const event=s.click(makeElement({action:'quote',recordId:'42',text:'Build quote'}));
 assert.equal(event._prevented,true);
 assert.equal(s.opened.length,0);
 assert.ok(findByAttr(s.ctx.document.body,'data-eh-earth-link'));
});

test('customer picker selection uses Earth and never opens the in-site builder', () => {
 const r={id:43,name:'Picker Customer',customerId:'cust43',address:'43 Test Street'};
 const s=setup({records:[r]});
 const event=s.click(makeElement({action:'quote-select',recordId:'43',text:'Picker Customer'}));
 assert.equal(event._prevented,true);
 assert.equal(s.opened.length,0);
 assert.ok(findByAttr(s.ctx.document.body,'data-eh-earth-link'));
});

test('programmatic new-customer creation has a public Earth entry point and probes for an already-loaded extension', async () => {
 const r={id:44,name:'New Customer',customerId:'cust44',address:'44 Test Street'};
 const s=setup({records:[r]});
 assert.ok(s.messages.some(m=>m.type==='TK_HELLO'));
 await s.ctx.window.TK_EARTH_QUOTES.open(44);
 assert.equal(s.opened.length,0);
 assert.ok(findByAttr(s.lastModal(),'data-eh-earth-link'));
});

test('a customer-only local record is persisted before its exact job is handed to Earth',async()=>{
  const r={id:19,name:'Jane',customerId:'cust19',jobId:null,address:'19 Test St'};
  const s=setup({records:[r]});s.extensionReady();
  s.ctx.syncRecordToSupabase=async row=>{row.jobId='saved-job-19'};
  s.click(makeElement({onclick:'openQuoteModal(19)',text:'Build quote'}));
  await s.flush();
  assert.equal(s.lastLaunch().jobId,'saved-job-19');
  assert.equal(s.lastLaunch().customerId,'cust19');
});
