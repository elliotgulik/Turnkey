/* Load after the app's inline script, conversations.js, sales-platform.js and
 * quote-workspace.js. Installs existing entry points; never opens Gmail and
 * never sends an email until the operator submits the Conversations composer. */
(function (global) {
  'use strict';
  if (global.TK_CONVERSATIONS_BRIDGE) return;
  if (!global.TK_CONVERSATIONS) throw Error('Load conversations.js before conversations-bridge.js');
  const root = document.getElementById('view-inbox');
  if (!root) throw Error('Conversations requires #view-inbox');
  let generation = 0;
  const context = () => ({
    client: typeof sb !== 'undefined' ? sb : null,
    businessId: typeof currentBusinessId !== 'undefined' ? currentBusinessId : null,
    userId: typeof currentUserId !== 'undefined' ? currentUserId : null,
    backendUrl: typeof backendUrl === 'function' ? backendUrl() : '',
  });
  const currentRecords = () => typeof records !== 'undefined' && Array.isArray(records) ? records : [];
  function scope() {
    const c = context();
    if (!c.client || !c.businessId || !c.userId || (typeof businessStateReady !== 'undefined' && !businessStateReady)) throw Error('Sign in and wait for your business to finish loading.');
    return { ...c, generation };
  }
  function assertScope(start) {
    const now = scope();
    if (now.businessId !== start.businessId || now.userId !== start.userId || now.client !== start.client || now.generation !== start.generation) throw Error('Your business or session changed. Reopen Conversations.');
  }
  function recordFor(value) {
    const key = value && typeof value === 'object' ? value.id : value;
    const r = currentRecords().find(r => String(r.id) === String(key));
    const c = scope();
    if (!r || (typeof recordBusinesses !== 'undefined' && recordBusinesses.get(r) !== c.businessId) || (r.business_id && r.business_id !== c.businessId) || (r.businessId && r.businessId !== c.businessId)) throw Error('This opportunity is not available in your current business.');
    return r;
  }
  function listQuotes() {
    scope();
    return currentRecords().filter(r => {
      try { return recordFor(r) === r && Array.isArray(r.services) && r.services.length && Number.isFinite(Number(r.total)) && Number(r.total) > 0; } catch { return false; }
    }).map(r => ({ id: String(r.id), label: (r.name || 'Customer') + ' · ' + docNumber('quote', r) + (r.address ? ' · ' + r.address : '') }));
  }
  function publicRecord(r) {
    // buildDocPDF is the existing customer-facing renderer. Give it only its
    // public inputs, never internal costs, margins, notes or attachments.
    const out = {};
    for (const k of ['id', 'name', 'email', 'phone', 'address', 'suburb', 'total', 'quotePublicToken', '_mapSnapshotDataUrl', '_mapSnapshotWidth', '_mapSnapshotHeight', 'areaPolys']) {
      if (r[k] !== undefined) out[k] = structuredClone(r[k]);
    }
    out.services = (r.services || []).map(line => {
      const safe = {};
      for (const k of ['svc', 'qty', 'customRate', 'fixedPrice', 'roofType', 'storeys', 'sides']) if (line[k] !== undefined) safe[k] = structuredClone(line[k]);
      return safe;
    });
    return out;
  }
  async function prepareDocument(mode, value) {
    if (!['quote', 'invoice'].includes(mode)) throw Error('Choose a quote or invoice.');
    const start = scope(), r = recordFor(value);
    if (!Array.isArray(r.services) || !r.services.length || !Number.isFinite(Number(r.total)) || Number(r.total) <= 0) throw Error('Build and save the quote lines before attaching a PDF.');
    if (typeof buildDocPDF !== 'function') throw Error('The PDF renderer is unavailable. Please reload TurnKey.');
    if (mode === 'quote') await syncRecordToSupabase(r);
    else await ensureRecordSynced(r);
    assertScope(start);
    if (recordFor(r.id) !== r) throw Error('The opportunity changed. Select it again.');
    // Preload the owned record, not a detached copy, so preview/send share
    // in-flight work and the loader can enforce the business/session guard.
    if (typeof preloadMapSnapshot === 'function') {
      await preloadMapSnapshot(r); assertScope(start);
    }
    if (recordFor(r.id) !== r) throw Error('The opportunity changed. Select it again.');
    if (global.TK_MAP_SNAPSHOT?.getAreas(r.areaPolys).length && !r._mapSnapshotDataUrl) throw Error('The property outline could not be prepared. Please retry. Nothing was sent.');
    const safe = publicRecord(r);
    // Actual helper contract: buildDocPDF(mode, record, 'base64') returns raw
    // base64; its default returns a Blob and is intentionally not used here.
    const contentBase64 = buildDocPDF(mode, safe, 'base64');
    if (typeof contentBase64 !== 'string' || !contentBase64 || contentBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) throw Error('The PDF could not be generated. Nothing was sent.');
    if (contentBase64.length > 16 * 1024 * 1024) throw Error('The PDF exceeds the 12 MB attachment limit.');
    let decoded;
    try { decoded = atob(contentBase64); } catch { throw Error('The PDF could not be generated. Nothing was sent.'); }
    if (!decoded.startsWith('%PDF-')) throw Error('The PDF renderer did not return a valid PDF. Nothing was sent.');
    assertScope(start);
    return { record: r, start, attachment: { filename: (mode === 'quote' ? 'Quote-' : 'Invoice-') + docNumber(mode, r) + '.pdf', mimeType: 'application/pdf', contentBase64 } };
  }
  function bodyFor(mode, r) {
    const first = (r.name || '').split(' ')[0] || 'there', number = docNumber(mode, r);
    let body = typeof buildEmailPlainBody === 'function' ? buildEmailPlainBody(mode, r) : `Hi ${first},\n\nPlease find your ${mode} ${number} attached.\n\nAny questions, just reply to this email.\n\nCheers,\n${docBizName()}`;
    if (mode === 'quote' && r.quotePublicToken && !body.includes(r.quotePublicToken)) {
      body += '\n\nView and approve online:\n' + new URL('quote.html', location.href).href + '?t=' + encodeURIComponent(r.quotePublicToken);
    }
    return body;
  }
  async function onSent(payload) {
    if (!payload.document) return;
    const start = scope(), r = recordFor(payload.document.recordId), mode = payload.document.mode;
    // Only this confirmed-success callback marks a document as sent. Opening
    // a preview, saving a draft or a rejected/unknown send never does so.
    if (mode === 'quote') {
      if (r.stage === 'new') r.stage = 'quoted';
      if ((!r.follows || !r.follows.length) && typeof defaultFollows === 'function') r.follows = defaultFollows();
      (r.follows || []).forEach(f => { if (f.dayOffset === 0) f.state = 'sent'; });
      r.quoteSentAt = Date.now(); r.clientResponded = false; r.selfPriced = false;
    } else {
      r.invoiceSent = true; r.paymentStatus = 'sent';
      if (!r.dueDate && typeof addDaysISO === 'function') r.dueDate = addDaysISO(todayISO(), 7);
    }
    await syncRecordToSupabase(r); assertScope(start);
    if (typeof render === 'function') render();
    if (typeof renderAll === 'function') renderAll();
    if (typeof logActivity === 'function') logActivity(r.customerId, r.jobId, mode + '_sent', (mode === 'quote' ? 'Quote' : 'Invoice') + ' sent to ' + payload.to);
  }
  const renderer = global.TK_CONVERSATIONS.createRenderer({
    root, getContext: context,
    onConnect: () => { if (typeof openConnections === 'function') openConnections(); },
    onCount: count => { const el = document.getElementById('cnt-inbox'); if (el) el.textContent = count; },
    listQuotes,
    buildQuoteAttachment: async id => (await prepareDocument('quote', id)).attachment,
    onSent,
  });
  const resetRenderer = renderer.reset;
  function reset() { generation++; resetRenderer(); const el = document.getElementById('cnt-inbox'); if (el) el.textContent = '0'; }
  // Existing auth paths already call these hooks on sign-out and business
  // changes. Wrap them here, without editing any host or ServiceM8 file.
  for (const name of ['showAuth', 'handleAuthedSession']) {
    const original = global[name];
    if (typeof original === 'function') global[name] = function (...args) { reset(); return original.apply(this, args); };
  }
  if (global.TK_SALES_PLATFORM && typeof global.TK_SALES_PLATFORM.reset === 'function') {
    const original = global.TK_SALES_PLATFORM.reset;
    global.TK_SALES_PLATFORM.reset = function (...args) { reset(); return original.apply(this, args); };
  }
  function reportError(e) {
    const message = e?.message || 'The email draft could not be prepared. Nothing was sent.';
    if (typeof toast === 'function') toast(message);
    else { const el = root.querySelector('.cv-notice'); if (el) el.textContent = message; }
    return false;
  }
  const guarded = fn => async (...args) => { try { return await fn(...args); } catch (e) { return reportError(e); } };
  function showInbox() { if (typeof switchView === 'function') switchView('inbox'); }
  async function compose(payload = {}) {
    const start = scope(); showInbox(); assertScope(start);
    await renderer.compose(payload); assertScope(start); return true;
  }
  async function composeDocument(mode, value, overrides = {}) {
    const { record: r, start, attachment } = await prepareDocument(mode, value);
    const number = docNumber(mode, r), business = docBizName();
    const payload = {
      to: r.email || '', subject: mode === 'quote' ? 'Your quote from ' + business + ' — ' + number : 'Invoice ' + number + ' from ' + business,
      bodyText: bodyFor(mode, r), ...overrides,
      attachments: [attachment], document: { mode, recordId: String(r.id) },
    };
    assertScope(start);
    const opened = await compose(payload);
    if (typeof closeModal === 'function') { closeModal('send-doc-overlay'); closeModal('compose-overlay'); }
    return opened;
  }
  renderer.reset = reset;
  // Existing contact/detail templates still emit mailto links. Normalize
  // their destinations as well as capturing clicks, so middle-click and
  // context-menu navigation cannot launch an external mail application.
  const emailLinks = new WeakMap();
  function emailIntent(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      if (url.protocol === 'mailto:') return { to: decodeURIComponent(url.pathname), subject: url.searchParams.get('subject') || '', body: url.searchParams.get('body') || '' };
      if (url.protocol === 'https:' && url.hostname === 'mail.google.com') return { to: url.searchParams.get('to') || '', subject: url.searchParams.get('su') || url.searchParams.get('subject') || '', body: url.searchParams.get('body') || '' };
    } catch { /* malformed link: leave ordinary navigation unchanged */ }
    return null;
  }
  function normalizeEmailLink(anchor) {
    const intent = emailIntent(anchor.getAttribute('href'));
    if (intent) { emailLinks.set(anchor, intent); anchor.setAttribute('href', '#'); anchor.removeAttribute('target'); }
    return intent || emailLinks.get(anchor);
  }
  function scanEmailLinks(node) {
    if (node.nodeType !== 1) return;
    if (node.matches('a[href]')) normalizeEmailLink(node);
    node.querySelectorAll('a[href]').forEach(normalizeEmailLink);
  }
  function emailClick(event) {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    const intent = normalizeEmailLink(anchor);
    if (!intent) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void global.openGmailCompose(intent);
  }
  document.addEventListener('click', emailClick, true);
  document.addEventListener('auxclick', emailClick, true);
  scanEmailLinks(document.body);
  new MutationObserver(changes => {
    for (const change of changes) {
      if (change.type === 'attributes') normalizeEmailLink(change.target);
      else change.addedNodes.forEach(scanEmailLinks);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  global.renderInbox = renderer;
  global.openGmailCompose = guarded(ctx => compose({ to: ctx?.to || '', subject: ctx?.subject || '', bodyText: ctx?.bodyText ?? ctx?.body ?? '', attachments: ctx?.attachments || (ctx?.attachment ? [ctx.attachment] : []) }));
  global.openComposeModal = guarded(ctx => {
    ctx ||= {};
    const last = ctx.thread?.[ctx.thread.length - 1];
    return compose({ to: ctx.to || '', subject: ctx.forward && last ? 'Fwd: ' + (last.subject || '') : ctx.subject || '', bodyText: ctx.bodyText ?? ctx.body ?? (ctx.forward && ctx.thread ? '\n\n---------- Forwarded message ----------\n' + ctx.thread.map(m => m.body_text || m.snippet || '').join('\n\n') : ''), attachments: ctx.attachments || (ctx.attachment ? [ctx.attachment] : []), ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {}) });
  });
  global.sendReply = guarded(async () => {
    const bodyText = document.getElementById('ib-reply-text')?.value || '';
    const thread = typeof inboxThreads !== 'undefined' && typeof inboxOpenThread !== 'undefined' ? inboxThreads[inboxOpenThread] : null;
    if (thread?.length && document.getElementById('ib-reply-text')) {
      const m = thread[thread.length - 1], raw = m.direction === 'sent' ? m.to_addresses : m.from_address;
      return compose({ to: (raw?.match(/<([^>]+)>/)?.[1] || raw || '').trim(), subject: /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || ''), bodyText, replyToId: m.id, attachments: [] });
    }
    scope(); showInbox(); await renderer.reply(bodyText); return true;
  });
  global.generateAndSendDoc = guarded(composeDocument);
  global.openSendDocModal = guarded(composeDocument);
  for (const [name, mode] of [['sendQuoteDoc', 'quote'], ['sendInvoiceDoc', 'invoice']]) {
    global[name] = guarded(async () => {
      const r = recordFor(typeof docPreview !== 'undefined' ? docPreview.recordId : null);
      const result = await composeDocument(mode, r);
      if (typeof closeDocPreview === 'function') closeDocPreview();
      return result;
    });
  }
  // A stale legacy modal must never bypass the common composer or fall back
  // to sending without the generated attachment when PDF generation fails.
  global.confirmSendDocEmail = global.saveSendDocDraft = guarded(() => {
    if (typeof sendDocCtx === 'undefined') throw Error('Choose a quote or invoice first.');
    const overrides = {};
    for (const [name, id] of [['to', 'sd-to'], ['subject', 'sd-subject'], ['bodyText', 'sd-body']]) { const el = document.getElementById(id); if (el) overrides[name] = el.value; }
    return composeDocument(sendDocCtx.mode, sendDocCtx.recordId, overrides);
  });
  global.sendComposeModal = guarded(() => compose({ to: document.getElementById('cmp-to')?.value || '', subject: document.getElementById('cmp-subject')?.value || '', bodyText: document.getElementById('cmp-body')?.value || '', attachments: [] }));
  global.TK_CONVERSATIONS_BRIDGE = { render: renderer, reset, compose: guarded(compose), composeDocument: guarded(composeDocument), listQuotes };
  if (root.classList.contains('active')) void renderer();
})(window);
