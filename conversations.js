/* Plain-script Conversations UI. Backend request/auth and the active scope are
 * injected by the host; no global Supabase client or Gmail window is created. */
(function (global) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = m => m.account_id + ':' + (m.thread_id || m.id);
  function groupMessages(messages, stars = []) {
    const groups = new Map(), starred = new Set(stars);
    for (const m of messages) {
      const key = keyOf(m);
      if (!groups.has(key)) groups.set(key, { key, messages: [], starred: starred.has(m.thread_id || m.id) });
      groups.get(key).messages.push(m);
    }
    return [...groups.values()].map(g => {
      g.messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
      g.last = g.messages[g.messages.length - 1];
      g.inbox = g.messages.some(m => m.direction === 'received');
      g.sent = g.messages.some(m => m.direction === 'sent');
      return g;
    }).sort((a, b) => new Date(b.last.sent_at) - new Date(a.last.sent_at));
  }
  function category(groups, folder) {
    return groups.filter(g => folder === 'all' || (folder === 'starred' ? g.starred : !!g[folder]));
  }
  function messageText(message) {
    if (message.body_text) return message.body_text;
    if (!message.body_html) return message.snippet || 'This message has no plain-text preview.';
    // A template stays inert: remote images, scripts and tracking pixels never
    // become live DOM. Render only its escaped text, including HTML-only mail.
    const template = global.document.createElement('template');
    template.innerHTML = message.body_html;
    template.content.querySelectorAll('script,style,iframe,object,noscript').forEach(n => n.remove());
    template.content.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    template.content.querySelectorAll('p,div,tr,li,h1,h2,h3').forEach(n => n.append('\n'));
    return template.content.textContent.trim() || message.snippet || '';
  }
  const emailFonts = { arial: 'Arial, Helvetica, sans-serif', georgia: 'Georgia, serif', system: '-apple-system, Segoe UI, sans-serif' };
  const normalizeEmailFont = font => Object.hasOwn(emailFonts, font) ? font : 'arial';
  function renderEmailHtml(bodyText, font = 'arial') {
    return `<div style="font-family:${emailFonts[normalizeEmailFont(font)]};line-height:1.6;white-space:pre-wrap">${esc(bodyText)}</div>`;
  }
  function pdfBlob(attachment) {
    if (attachment?.mimeType !== 'application/pdf' || !attachment.contentBase64) throw Error('PDF bytes are unavailable.');
    const decoded = global.atob(attachment.contentBase64);
    if (!decoded.startsWith('%PDF-')) throw Error('Invalid PDF attachment.');
    return new Blob([Uint8Array.from(decoded, c => c.charCodeAt(0))], { type: 'application/pdf' });
  }
  function mount({ root, request, onConnect = () => {}, onCount = () => {}, listQuotes = () => [], buildQuoteAttachment, buildDocumentAttachment, beforeSend = () => {}, onDocument = () => {}, onSent = () => {}, initialSnapshot = null, onSnapshot = () => {} }) {
    if (!root || typeof request !== 'function') throw Error('Conversations requires a root and authenticated request function');
    // Bound auth, response-body and injected requests too, not just fetch.
    const transport = request;
    request = async (path, options = {}) => {
      const controller = new AbortController();
      let timeout;
      try {
        return await Promise.race([
          transport(path, { ...options, signal: controller.signal }),
          new Promise((_, reject) => { timeout = setTimeout(() => {
            const error = Error('Email request timed out. Changes may be unsaved; check Sent before retrying a send.');
            controller.abort(error); reject(error);
          }, 30000); })
        ]);
      } finally { clearTimeout(timeout); }
    };
    let messages = [], stars = [], drafts = [], account = null, folder = 'inbox', selected = null;
    let quoteFiles = null, quoteChoices = [], query = '', loaded = false;
    const folders = [['inbox', 'Inbox', 'Customer emails and replies, together in one place.'], ['sent', 'Sent', 'Conversations containing emails you have sent.'], ['starred', 'Starred', 'Keep important conversations close at hand.'], ['drafts', 'Drafts', 'Continue a saved email when you are ready.'], ['all', 'All mail', 'Every conversation synced to TurnKey.']];
    const searchText = new WeakMap();
    const searchable = m => {
      if (!searchText.has(m)) searchText.set(m, [m.from_address, m.to_addresses, m.subject, m.snippet, messageText(m)].join(' ').toLowerCase());
      return searchText.get(m);
    };
    const dateLabel = value => Number.isNaN(new Date(value).getTime()) ? 'Date unavailable' : new Date(value).toLocaleString();
    let lastDocument = null, preview = null;
    function clearPreview() { if (preview) global.URL.revokeObjectURL(preview.url); preview = null; }
    function previewHtml() {
      const file = composer?.payload.attachments.find(f => f.mimeType === 'application/pdf' && f.contentBase64);
      if (!file) { clearPreview(); return ''; }
      if (preview?.contentBase64 !== file.contentBase64) {
        clearPreview();
        try { preview = { contentBase64: file.contentBase64, url: global.URL.createObjectURL(pdfBlob(file)) }; }
        catch { return '<p>PDF preview unavailable: this attachment does not contain a valid PDF.</p>'; }
      }
      return `<section class="cv-pdf-preview" aria-label="Exact PDF attachment preview"><h4>PDF attachment preview</h4><p>This is the PDF attached to this email.</p><object data="${esc(preview.url)}" type="application/pdf" aria-label="PDF attachment"><p>Use Download PDF to review this attachment in your PDF viewer.</p></object><a href="${esc(preview.url)}" download="${esc(file.filename)}">Download PDF</a></section>`;
    }
    let composer = null, notice = '', pending = false, sending = false, destroyed = false, timer, hasMore = false, loading = false;
    let saveQueue = Promise.resolve(), refreshPending=null,refreshDirty=false,lastLoadedAt=0,draftsLoaded=false;
    const saved=initialSnapshot?.data;if(saved&&Array.isArray(saved.messages)&&Array.isArray(saved.stars)){messages=saved.messages;stars=saved.stars;account=saved.account||null;hasMore=!!saved.hasMore;loaded=true;lastLoadedAt=initialSnapshot.savedAt||0;}
    const api = (path, method = 'GET', body) => request('/api/conversations' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const button = (label, action, extra = '') => `<button type="button" data-cv-action="${action}" ${extra}>${label}</button>`;
    const activeDrafts = () => drafts.filter(d => d.status !== 'sent');
    function focusSnapshot() {
      const active = global.document.activeElement;
      if (!root.contains(active)) return null;
      return { name: active.name, action: active.dataset.cvAction, key: active.dataset.key, id: active.dataset.id, folder: active.dataset.folder, index: active.dataset.index,
        start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop };
    }
    function restoreFocus(focus) {
      if (!focus) return;
      const next = [...root.querySelectorAll('input,textarea,select,[data-cv-action]')].find(el => focus.name ? el.name === focus.name : focus.action && el.dataset.cvAction === focus.action && el.dataset.key === focus.key && el.dataset.id === focus.id && el.dataset.folder === focus.folder && el.dataset.index === focus.index);
      if (!next || next.disabled) return;
      next.focus({ preventScroll: true });
      if (typeof focus.start === 'number' && ['text', 'search', 'textarea'].includes(next.type)) next.setSelectionRange(focus.start, focus.end);
      next.scrollTop = focus.scroll;
    }
    function emptyHtml() {
      if (loading) return '<div class="cv-empty"><h4>Loading your conversations…</h4><p>Your synced messages and saved drafts will appear here.</p></div>';
      if (query.trim()) return `<div class="cv-empty"><h4>No matching ${folder === 'drafts' ? 'drafts' : 'conversations'}</h4><p>Try another name, email address or word from the message. Search covers this folder’s synced mail.</p>${button('Clear search', 'clear-search')}</div>`;
      if (loaded && !account) return `<div class="cv-empty"><h4>Bring your customer emails into TurnKey</h4><p>Connect Gmail in Connections, then sync your mailbox. You can prepare and save a draft now.</p>${button('Connect Gmail', 'connect')}${button('Compose', 'compose')}</div>`;
      const copy = {
        inbox: ['Your inbox is clear', 'Sync to check for customer emails. Conversations with received mail appear here.', 'Sync mailbox', 'sync'],
        sent: ['No sent conversations yet', 'Emails appear here after Gmail confirms they were sent.', 'Compose', 'compose'],
        starred: ['Keep important emails handy', 'Use the star beside a conversation to find it here later.', 'Browse inbox', 'inbox'],
        drafts: ['No drafts to finish', 'Start an email and your changes will be saved automatically as a draft.', 'Compose', 'compose'],
        all: ['No synced conversations yet', 'Sync your connected mailbox to bring in customer emails.', 'Sync mailbox', 'sync'],
      }[folder];
      return `<div class="cv-empty"><h4>${copy[0]}</h4><p>${copy[1]}</p>${button(copy[2], copy[3], pending ? 'disabled' : '')}</div>`;
    }
    function mailboxHtml(groups) {
      const q = query.trim().toLowerCase(), filtered = category(groups, folder).filter(g => !q || g.messages.some(m => searchable(m).includes(q)));
      const saved = activeDrafts().filter(d => !q || [d.payload.to, d.payload.subject, d.payload.bodyText, ...(d.payload.attachments || []).map(f => f.filename)].join(' ').toLowerCase().includes(q));
      const thread = filtered.find(g => g.key === selected), count = folder === 'drafts' ? saved.length : filtered.length;
      const info = folders.find(([id]) => id === folder);
      root.dataset.cvReading = thread ? 'true' : 'false';
      const heading = `<header class="cv-folder-heading"><div><h3>${info[1]} <span>${count}</span></h3><p>${q ? 'Matching ' + (folder === 'drafts' ? 'drafts' : 'synced conversations') + ' in this folder' : info[2]}</p></div></header>`;
      if(folder==='drafts'&&!draftsLoaded)return heading+'<p class="cv-sync-hint">Loading saved drafts…</p>';
      if (folder === 'drafts') return heading + `<div class="cv-drafts">${saved.map(d => button(`<div><b>${esc(d.payload.subject || '(no subject)')}</b><span>${esc(d.payload.to || 'Add a recipient')} · ${esc(d.payload.bodyText?.slice(0, 120) || 'Continue writing your email')}</span></div><small>${esc(d.status === 'draft' ? 'Draft' : 'Delivery ' + d.status + ' — check Sent')}</small>`, 'draft', `data-id="${esc(d.id)}"`)).join('') || emptyHtml()}</div>`;
      return heading + `<div class="cv-layout"><aside class="cv-list" aria-label="Conversations">${filtered.map(g => `<div class="cv-row ${g.key === selected ? 'selected' : ''}">${button(g.starred ? '★' : '☆', 'star', `data-id="${esc(g.last.id)}" aria-label="${g.starred ? 'Unstar' : 'Star'} conversation" aria-pressed="${g.starred}"`)}${button(`<b>${esc(g.last.direction === 'sent' ? g.last.to_addresses : g.last.from_address)}</b><strong>${esc(g.last.subject || '(no subject)')}</strong><span>${esc(g.last.snippet || messageText(g.last).slice(0, 140))}</span><small>${esc(dateLabel(g.last.sent_at))}${g.messages.length > 1 ? ' · ' + g.messages.length + ' messages' : ''}</small>`, 'thread', `data-key="${esc(g.key)}" aria-current="${g.key === selected ? 'true' : 'false'}"`)}</div>`).join('') || emptyHtml()}${hasMore ? button(loading ? 'Loading older messages…' : 'Load older messages', 'more', loading || pending ? 'disabled' : '') : ''}<p class="cv-sync-hint">Search and folders cover synced messages.${hasMore ? ' Load older messages to search further back.' : ''}</p></aside><section class="cv-thread" aria-label="Selected conversation">${thread ? `${button('Back to ' + info[1].toLowerCase(), 'back', 'class="cv-back"')}<header class="cv-thread-heading"><h3 tabindex="-1">${esc(thread.last.subject || '(no subject)')}</h3><p>${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'} in this conversation</p></header>${thread.messages.map(m => `<article class="cv-message ${m.direction === 'sent' ? 'sent' : 'received'}"><header><b>${esc(m.from_address)}</b><time>${esc(dateLabel(m.sent_at))}</time></header><p>To: ${esc(m.to_addresses)} <span class="cv-direction">${m.direction === 'sent' ? 'Sent' : 'Received'}</span></p><div class="cv-body">${esc(messageText(m))}</div></article>`).join('')}${button('Reply', 'reply', pending ? 'disabled' : 'class="cv-primary"')}` : '<div class="cv-empty cv-reading-empty"><h4>Your customer conversations</h4><p>Select an email to read the full conversation and reply. Start a new email with Compose.</p></div>'}</section></div>`;
    }
    function draw() {
      if (destroyed) return;
      const focus = focusSnapshot(), groups = groupMessages(messages, stars);
      root.classList.add('tk-conversations');
      if (!composer) clearPreview();
      root.innerHTML = `<header class="cv-head"><div><h2>Conversations</h2><p>${account ? '<span class="cv-connected">Gmail connected</span> ' + esc(account.email_address) : 'Customer emails, replies and saved drafts.'}</p></div><div>${button('Connections', 'connect')}${button(pending ? 'Working…' : 'Sync', 'sync', pending || !account ? 'disabled' : '')}${button('Compose', 'compose', pending ? 'disabled class="cv-primary"' : 'class="cv-primary"')}</div></header>
        <p class="cv-notice" role="status" aria-live="polite">${esc(notice)}</p>
        ${lastDocument && !composer ? `<div class="cv-document-context"><span>${lastDocument.mode === 'quote' ? 'Next: track acceptance on the opportunity.' : 'Next: track payment on the opportunity.'}</span>${button('Open opportunity', 'document')}</div>` : ''}
        <nav class="cv-folders" aria-label="Mail folders">${folders.map(([id, label]) => button(`${label} <span>${id === 'drafts' ? activeDrafts().length : category(groups, id).length}</span>`, 'folder', `data-folder="${id}" aria-current="${folder === id ? 'page' : 'false'}"`)).join('')}</nav>
        <div class="cv-search-bar"><label>Search messages<input type="search" name="cvQuery" placeholder="Search names, subjects or message text…" value="${esc(query)}" autocomplete="off"></label>${button('Clear search', 'clear-search', query ? '' : 'hidden')}</div>
        <div class="cv-results">${mailboxHtml(groups)}</div>${composer ? composeHtml() : ''}`;
      restoreFocus(focus);
      onCount(category(groups, 'inbox').length);
    }
    function composeHtml() {
      const locked = sending || composer.status !== 'draft';
      const preparing = !!composer.documentPending;
      const emailFont = normalizeEmailFont(composer.payload.emailFont);
      const documentMessage = preparing ? 'Preparing and saving the PDF… Edit the recipient or message while it finishes.' : composer.documentError ? `PDF preparation failed: ${esc(composer.documentError)}` : 'PDF attached · Review the exact document below before sending.';
      const fileNames = (preparing ? [] : composer.payload.attachments).map((f, i) => `<li><span><b>${esc(f.filename)}</b><small>${f.savedAttachmentId ? 'Saved quote PDF' : f.mimeType === 'application/pdf' ? 'PDF document' : 'File attachment'}</small></span>${button('Remove', 'remove-file', `data-index="${i}" aria-label="Remove ${esc(f.filename)}" ${locked || (composer.payload.document && i === 0) ? 'disabled' : ''}`)}</li>`).join('');
      return `<section class="cv-composer" aria-label="Email composer"><header><div><h3>${composer.payload.document ? (composer.payload.document.mode === 'quote' ? 'Quote email' : 'Invoice email') : composer.payload.replyToId ? 'Reply' : 'New email'}</h3><p>Your draft saves as you type. Send when you are ready.</p></div>${button(composer.status === 'draft' ? 'Save & close' : 'Close', 'close', pending || preparing ? 'disabled' : '')}</header>${composer.payload.document ? `<div class="cv-document-context"><span>${documentMessage}</span>${composer.documentError ? button('Retry PDF', 'retry-document', pending ? 'disabled' : '') : ''}${button('Open opportunity', 'document', pending ? 'disabled' : '')}</div>` : ''}<form data-cv-form>
        <label>To<input name="to" type="email" autocomplete="email" placeholder="customer@example.com" required maxlength="2000" value="${esc(composer.payload.to)}" ${locked ? 'disabled' : ''}></label>
        <label>Subject<input name="subject" placeholder="What is this email about?" required maxlength="998" value="${esc(composer.payload.subject)}" ${locked ? 'disabled' : ''}></label>
        <label>Email font<select name="emailFont" ${locked ? 'disabled' : ''}>${Object.keys(emailFonts).map(font => `<option value="${font}" ${emailFont === font ? 'selected' : ''}>${font === 'arial' ? 'Arial' : font === 'georgia' ? 'Georgia' : 'System'}</option>`).join('')}</select></label><p class="cv-font-help">Applies to your email message. Some email apps may use their own font.</p>
        <label>Message<textarea style="font-family:${emailFonts[emailFont]}" name="bodyText" rows="9" placeholder="Write your message…" required maxlength="100000" ${locked ? 'disabled' : ''}>${esc(composer.payload.bodyText)}</textarea></label>
        ${preparing ? '' : previewHtml()}<div class="cv-attachments"><h4>Attachments <span>${composer.payload.attachments.length}/10</span></h4><p>Up to 10 files, 12 MB total. Review attached files before sending.</p><ul class="cv-files">${fileNames}</ul><label class="cv-file-input">Attach images or files<input type="file" name="files" multiple ${locked ? 'disabled' : ''}></label>${button('Saved quote PDF', 'quotes', `aria-expanded="${!!quoteFiles}" ${locked ? 'disabled' : ''}`)}</div>
        <div class="cv-quote-picker" ${quoteFiles ? '' : 'hidden'}>${quoteFiles ? '<header><h4>Choose a quote to attach</h4>' + button('Close quote picker', 'quotes') + '</header><h4>Opportunity quotes</h4>' + (quoteChoices.map(q => button(esc(q.label), 'opportunity-quote', `data-id="${esc(q.id)}" ${locked ? 'disabled' : ''}`)).join('') || '<p>No opportunity quotes available.</p>') + '<h4>Uploaded quote PDFs</h4>' + (quoteFiles.map(f => button(esc(f.filename), 'quote', `data-id="${esc(f.id)}" data-filename="${esc(f.filename)}" ${locked ? 'disabled' : ''}`)).join('') || '<p>No uploaded quote PDFs. You can attach a file above.</p>') : ''}</div>
        <footer class="cv-compose-footer"><p class="cv-save-state" role="status" aria-live="polite">${esc(composer.status !== 'draft' ? 'Delivery is ' + composer.status + '. Check Sent or sync before creating another email.' : composer.dirty ? 'Unsaved changes' : 'Draft saved')}</p>${!account ? '<p>Connect Gmail in Connections to send this draft.</p>' : ''}<div class="cv-compose-actions">${button('Save draft', 'save', locked ? 'disabled' : '')}${button('Discard', 'discard', pending || composer.status === 'sending' ? 'disabled' : '')}<button type="submit" class="cv-primary" ${locked || pending || preparing || !!composer.documentError || !account ? 'disabled' : ''}>${sending ? 'Sending…' : preparing ? 'Preparing PDF…' : 'Send email'}</button></div></footer></form></section>`;
    }
    function refresh({force=true}={}) {
      if(refreshPending){if(force)refreshDirty=true;return refreshPending;}
      if(!force&&loaded&&Date.now()-lastLoadedAt<30000&&draftsLoaded)return Promise.resolve();
      loading=!loaded;if(loading)draw();
      refreshPending=(async()=>{try{do{refreshDirty=false;
        const results = await Promise.allSettled([
          api('/messages').then(mail => {
            if (destroyed) return;
            loaded=true;account=mail.account;messages=mail.messages;stars=mail.stars;hasMore=mail.hasMore;lastLoadedAt=Date.now();
            onSnapshot({account:account?{id:account.id,email_address:account.email_address,provider:account.provider}:null,messages:messages.slice(0,100),stars,hasMore:!!hasMore||messages.length>100});
            loading=false;draw();
          }),
          api('/drafts').then(saved => {
            if (destroyed) return;
            // Draft contents/attachments always come from the server.
            draftsLoaded=true;drafts=saved.drafts;draw();
          })
        ]);
        const failures=results.filter(result=>result.status==='rejected');
        if(failures.length){
          notice=failures.map(result=>result.reason.message||'Could not refresh conversations.').join(' ');
          throw failures[0].reason;
        }
        }while(refreshDirty&&!destroyed);
      }finally{loading=false;refreshPending=null;draw();}})();return refreshPending;
    }
    const pendingSaves = new WeakMap();
    function persist() {
      if (!composer || composer.status !== 'draft' || !composer.dirty) return saveQueue;
      const target = composer, serialized = JSON.stringify(target.payload), payload = JSON.parse(serialized);
      const existing = pendingSaves.get(target);
      if (existing?.serialized === serialized) return existing.promise;
      const operation = saveQueue.catch(() => {}).then(async () => {
        const result = await api('/drafts/' + target.id, 'PUT', payload);
        if (destroyed) return;
        drafts = [result.draft, ...drafts.filter(d => d.id !== target.id)];
        if (composer === target && JSON.stringify(target.payload) === JSON.stringify(payload)) {
          target.dirty = false;
          const el = root.querySelector('.cv-save-state'); if (el) el.textContent = 'Draft saved';
        }
      });
      pendingSaves.set(target, { serialized, promise: operation });
      void operation.finally(() => {
        if (pendingSaves.get(target)?.promise === operation) pendingSaves.delete(target);
      }).catch(() => {});
      saveQueue = operation;
      return operation;
    }
    async function startCompose(payload) {
      payload ||= {};
      clearTimeout(timer);
      // Keep the composer responsive: saving a previous draft must not block a
      // new one from opening, and the new draft can be persisted after render.
      void persist().catch(error => { notice = error.message || 'A previous draft could not be saved.'; draw(); });
      quoteFiles = null; quoteChoices = [];
      const { documentPending = false, ...draftPayload } = payload;
      composer = { id: global.crypto.randomUUID(), status: 'draft', dirty: true, documentPending, documentError: '', documentAttachment: null, payload: { to: '', subject: '', bodyText: '', replyToId: '', attachments: [], ...draftPayload, emailFont: normalizeEmailFont(draftPayload.emailFont) } };
      const target = composer;
      draw(); root.querySelector('[name="to"]')?.focus();
      void persist().catch(error => {
        if (composer !== target) return;
        notice = error.message || 'Draft save failed. It will retry when you send.';
        draw();
      });
    }
    async function send() {
      if (pending || !account || !composer || composer.status !== 'draft' || composer.documentPending || composer.documentError) return;
      clearTimeout(timer); pending = true; sending = true; notice = 'Checking the saved quote…'; draw();
      let confirmed = false;
      try {
        await beforeSend(composer.payload);
        notice = 'Saving your email…'; draw();
        await persist();
        notice = 'Sending with Gmail…'; draw();
        const result = await api('/send', 'POST', { draftId: composer.id });
        if (!result.ok || !result.id) throw Error('Gmail did not confirm this send. Your draft is preserved; check Sent before trying again.');
        const sentPayload = composer.payload;
        lastDocument = sentPayload.document || null;
        composer = null;
        // Gmail has confirmed delivery. Unlock the interface immediately;
        // CRM syncing and mailbox refresh must never leave the send button
        // spinning after the customer already received the email.
        confirmed = true; pending = false; sending = false;
        notice = result.warning || 'Email sent.'; draw();
        void (async () => {
          let followUp = '';
          try { await onSent(sentPayload, result); }
          catch { followUp = 'Email was sent, but the opportunity could not be updated. Do not resend.'; }
          try { await refresh(); }
          catch { followUp += (followUp ? ' ' : '') + 'Conversation history could not refresh; use Sync to update it.'; }
          if (!destroyed && followUp) { notice = followUp; draw(); }
        })();
      } catch (e) {
        notice = e.message;
        // A slow recovery lookup is not part of sending. Unlock the page now,
        // but keep an uncertain draft locked against duplicate delivery until
        // the server reports whether Gmail accepted it.
        const draftId = composer?.id;
        if (composer) composer.status = 'unknown';
        pending = false; sending = false; draw();
        void api('/drafts').then(saved => {
          drafts = saved.drafts;
          const row = drafts.find(d => d.id === draftId);
          if (row && composer?.id === draftId) composer.status = row.status;
          if (!destroyed) draw();
        }).catch(() => {
          if (draftId && composer?.id === draftId) notice += ' Could not verify draft status. Refresh before trying again.';
          if (!destroyed) draw();
        });
      } finally { if (!confirmed) { pending = false; sending = false; draw(); } }
    }
    async function action(e) {
      const b = e.target.closest('[data-cv-action]'); if (!b || !root.contains(b) || b.disabled) return;
      const name = b.dataset.cvAction;
      if (pending && name !== 'connect') { notice = 'Please wait for the current action to finish.'; draw(); return; }
      try {
        if (name === 'connect') return onConnect();
        if (name === 'compose') return await startCompose();
        if (name === 'document') { const doc = composer?.payload.document || lastDocument; await persist(); if(doc)await onDocument(doc); return; }
        if (name === 'retry-document') {
          if (!composer?.payload.document || !buildDocumentAttachment) throw Error('Quote PDF preparation is unavailable.');
          pending = true; composer.documentPending = true; composer.documentError = ''; draw();
          const target = composer;
          try { await completeDocumentPreparation(target.payload.document.recordId, await buildDocumentAttachment(target.payload.document.mode, target.payload.document.recordId), null, target.payload.document); }
          catch (err) { await completeDocumentPreparation(target.payload.document.recordId, null, err, target.payload.document); }
          return;
        }
        if (name === 'clear-search') { query = ''; const search = root.querySelector('[name=cvQuery]'); search.value = ''; search.focus(); }
        if (name === 'back') selected = null;
        if (name === 'inbox' || name === 'folder') { folder = name === 'inbox' ? 'inbox' : b.dataset.folder; selected = null; await persist(); draw(); }
        if (name === 'thread') { selected = b.dataset.key; await persist(); draw(); }
        if (name === 'reply') {
          const group = groupMessages(messages, stars).find(g => g.key === selected); if (!group) return;
          const m = group.last, raw = m.direction === 'sent' ? m.to_addresses : m.from_address;
          await startCompose({ to: (raw?.match(/<([^>]+)>/)?.[1] || raw || '').trim(), subject: /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || ''), replyToId: m.id });
        }
        if (name === 'star') {
          const m = messages.find(m => m.id === b.dataset.id), key = m.thread_id || m.id, value = !stars.includes(key);
          b.disabled = true; await api('/stars/' + m.id, 'PUT', { starred: value });
          stars = value ? [...stars, key] : stars.filter(k => k !== key); draw();
        }
        if (name === 'save' || name === 'close') { clearTimeout(timer); await persist(); notice = composer.status === 'draft' ? 'Draft saved.' : 'Draft kept. Check Sent or sync to verify delivery.'; if (name === 'close') composer = null; draw(); }
        if (name === 'discard') { clearTimeout(timer); await saveQueue.catch(() => {}); await api('/drafts/' + composer.id, 'DELETE'); drafts = drafts.filter(d => d.id !== composer.id); composer = null; draw(); }
        if (name === 'draft') { await persist(); const d = drafts.find(d => d.id === b.dataset.id); quoteFiles = null; quoteChoices = []; composer = { ...d, payload: { ...JSON.parse(JSON.stringify(d.payload)), emailFont: normalizeEmailFont(d.payload.emailFont) }, dirty: false }; draw(); root.querySelector('[name=to]')?.focus(); }
        if (name === 'remove-file') { if(composer.payload.document && Number(b.dataset.index) === 0) return; composer.payload.attachments.splice(Number(b.dataset.index), 1); composer.dirty = true; await persist(); draw(); }
        if (name === 'quotes') {
          if (quoteFiles) { quoteFiles = null; return; }
          pending = true; draw();
          quoteChoices = await listQuotes();
          try { quoteFiles = (await api('/quote-attachments')).attachments; }
          catch { quoteFiles = []; notice = 'Uploaded PDFs could not load. You can still choose an opportunity quote.'; }
        }
        if (name === 'opportunity-quote') {
          if (!buildQuoteAttachment) throw Error('Quote generation is unavailable.');
          if (composer.payload.attachments.length >= 10) throw Error('Use at most 10 attachments');
          pending = true; draw();
          const target = composer, file = await buildQuoteAttachment(b.dataset.id);
          if (destroyed || composer !== target) return;
          const bytes = target.payload.attachments.reduce((n, f) => n + (f.contentBase64?.length || 0) * .75, 0) + (file.contentBase64?.length || 0) * .75;
          if (bytes > 12 * 1024 * 1024) throw Error('Attachments must total at most 12 MB');
          target.payload.attachments.push(file); target.dirty = true; quoteFiles = null; await persist();
        }
        if (name === 'quote') {
          if (composer.payload.attachments.length >= 10) throw Error('Use at most 10 attachments');
          composer.payload.attachments.push({ savedAttachmentId: b.dataset.id, filename: b.dataset.filename }); composer.dirty = true; quoteFiles = null; await persist(); draw();
        }
        if (name === 'sync') { pending = true; draw(); await request('/api/email/sync', { method: 'POST', body: '{}' }); notice = 'Mailbox synced.'; await refresh(); }
        if (name === 'more') {
          pending = true; loading = true; draw();
          await persist(); const data = await api('/messages?offset=' + messages.length);
          const ids = new Set(messages.map(m => m.id)); messages.push(...data.messages.filter(m => !ids.has(m.id))); stars = data.stars; hasMore = data.hasMore; draw();
        }
      } catch (err) { notice = err.message; } finally {
        pending = false; loading = false; draw();
        if (name === 'thread') root.querySelector('.cv-thread-heading h3')?.focus({ preventScroll: true });
        if (name === 'back') root.querySelector('[data-cv-action=thread]')?.focus({ preventScroll: true });
        if (name === 'close' || name === 'discard') root.querySelector('[data-cv-action=compose]')?.focus({ preventScroll: true });
        if (name === 'quote' || name === 'opportunity-quote' || name === 'quotes') root.querySelector('.cv-attachments [data-cv-action=quotes]')?.focus({ preventScroll: true });
      }
    }
    async function reply(bodyText = '') {
      const group = groupMessages(messages, stars).find(g => g.key === selected);
      if (!group) throw Error('Select a conversation before replying.');
      const m = group.last, raw = m.direction === 'sent' ? m.to_addresses : m.from_address;
      await startCompose({ to: (raw?.match(/<([^>]+)>/)?.[1] || raw || '').trim(), subject: /^re:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || ''), replyToId: m.id, bodyText });
    }
    function input(e) {
      if (e.target.name === 'cvQuery') {
        query = e.target.value;
        // Replace only results: search and composer inputs keep focus, caret and DOM.
        root.querySelector('.cv-results').innerHTML = mailboxHtml(groupMessages(messages, stars));
        root.querySelector('[data-cv-action=clear-search]').hidden = !query;
        return;
      }
      if (!composer || !['to', 'subject', 'bodyText', 'emailFont'].includes(e.target.name)) return;
      composer.payload[e.target.name] = e.target.name === 'emailFont' ? normalizeEmailFont(e.target.value) : e.target.value;
      if (e.target.name === 'emailFont') root.querySelector('[name=bodyText]').style.fontFamily = emailFonts[composer.payload.emailFont];
      composer.dirty = true; clearTimeout(timer);
      const el = root.querySelector('.cv-save-state'); if (el) el.textContent = 'Saving…';
      timer = setTimeout(() => persist().catch(e => { notice = e.message; const el = root.querySelector('.cv-notice'); if (el) { el.textContent = notice; el.hidden = false; } }), 700);
    }
    async function files(e) {
      if (e.target.name !== 'files' || !composer || pending || composer.status !== 'draft') return;
      const chosen = [...e.target.files], target = composer;
      if (!chosen.length) return;
      pending = true; notice = ''; draw();
      try {
        if (chosen.length + composer.payload.attachments.length > 10) throw Error('Use at most 10 attachments');
        let bytes = composer.payload.attachments.reduce((n, f) => n + (f.contentBase64?.length || 0) * .75, 0);
        const added = [];
        for (const f of chosen) {
          bytes += f.size; if (!f.size || bytes > 12 * 1024 * 1024) throw Error('Attachments must total at most 12 MB');
          const base64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.onerror = () => reject(Error('Could not read ' + f.name)); r.readAsDataURL(f); });
          added.push({ filename: f.name, mimeType: f.type || 'application/octet-stream', contentBase64: base64 });
        }
        if (destroyed || composer !== target) return;
        target.payload.attachments.push(...added); target.dirty = true; await persist();
      } catch (err) { notice = err.message; } finally { pending = false; draw(); }
    }
    function submit(e) { if (e.target.matches('[data-cv-form]')) { e.preventDefault(); void send(); } }
    async function completeDocumentPreparation(recordId, attachment, error, expectedDocument) {
      if (!composer || String(composer.payload.document?.recordId) !== String(recordId)) return;
      if (expectedDocument && composer.payload.document !== expectedDocument) return;
      const target = composer;
      composer.documentError = error ? (error.message || String(error)) : '';
      if (attachment) {
        if (composer.documentAttachment) {
          const i = composer.payload.attachments.indexOf(composer.documentAttachment);
          if (i >= 0) composer.payload.attachments.splice(i, 1);
        }
        composer.documentAttachment = attachment;
        composer.payload.attachments.unshift(attachment); composer.dirty = true;
      }
      if (error) notice = composer.documentError;
      // Do not advertise an attached, ready PDF before the saved draft contains it.
      if (attachment) {
        try { await persist(); }
        catch (err) { notice = err.message || 'PDF is ready, but the draft could not be saved yet.'; }
      }
      if (composer !== target || destroyed) return;
      target.documentPending = false;
      draw();
    }
    function unload(e) { if (composer?.dirty || pending) { e.preventDefault(); e.returnValue = ''; } }
    root.addEventListener('click', action); root.addEventListener('input', input); root.addEventListener('change', files); root.addEventListener('submit', submit); global.addEventListener('beforeunload', unload);
    draw();
    return {
      refresh, compose: startCompose, reply, completeDocumentPreparation,
      destroy() { clearPreview(); destroyed = true; clearTimeout(timer); root.removeEventListener('click', action); root.removeEventListener('input', input); root.removeEventListener('change', files); root.removeEventListener('submit', submit); global.removeEventListener('beforeunload', unload); root.innerHTML = ''; },
    };
  }
  // Host adapter: capture the business/user at mount time and reject late
  // requests after a login or business switch. Call render.reset() from the
  // host's existing business/auth cleanup before replacing session state.
  function createRenderer({ root, getContext, onConnect, onCount, listQuotes, buildQuoteAttachment, buildDocumentAttachment, beforeSend, onDocument, onSent, fetchImpl = global.fetch.bind(global) }) {
    let view = null, activeKey = '', epoch = 0;
    function reset() { epoch++; view?.destroy(); view = null; activeKey = ''; }
    async function ensureView() {
      const context = getContext();
      if (!context.client || !context.businessId || !context.userId) {
        reset(); root.textContent = 'Sign in to view your conversations.'; return false;
      }
      const key = context.businessId + ':' + context.userId;
      if (activeKey !== key) {
        reset(); activeKey = key; const generation = epoch;
        const sameContext = () => {
          const now = getContext();
          return now.client === context.client && now.businessId === context.businessId && now.userId === context.userId && activeKey === key && epoch === generation;
        };
        view = mount({ root, onConnect, onCount, listQuotes, buildQuoteAttachment, buildDocumentAttachment, beforeSend, onDocument, onSent, initialSnapshot:global.TK_WORKSPACE_CACHE?.read(context,'inbox'),onSnapshot:data=>{if(sameContext())global.TK_WORKSPACE_CACHE?.write(context,'inbox',data);},request: async (path, options = {}) => {
          if (!sameContext()) throw Error('Your session changed. Reopen Conversations.');
          if (!context.backendUrl) throw Error('Connect your TurnKey backend first.');
          const cached=global.TK_CURRENT_SESSION;
          const validCached=cached?.user?.id===context.userId&&typeof cached.access_token==='string'&&cached.access_token&&Number.isFinite(cached.expires_at)&&cached.expires_at*1000>Date.now()+30000;
          const {data,error}=validCached?{data:{session:cached},error:null}:await context.client.auth.getSession();
          if(error||!data?.session||data.session.user.id!==context.userId||!sameContext())throw Error('Please sign in again.');
          const response = await fetchImpl(context.backendUrl.replace(/\/$/, '') + path, {
            ...options, credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token }
          });
          const result = await response.json();
          if (!sameContext()) throw Error('Your session changed. Reopen Conversations.');
          if (!response.ok) throw Error(result.error || 'Conversations request failed.');
          return result;
        } });
        return true;
      }
      return false;
    }
    async function render({force=false}={}) {
      await ensureView();
      if (!view) return;
      try { await view.refresh({force}); } catch (e) {
        const notice = root.querySelector('.cv-notice'); if (notice && view) { notice.textContent = e.message; notice.hidden = false; }
      }
    }
    const poll=()=>{if(view&&root.classList.contains('active')&&!global.document?.hidden)void render().catch(()=>{});};
    global.addEventListener?.('focus',poll);
    global.setInterval?.(poll,30000);
    render.reset = reset;
    render.completeDocumentPreparation = (...args) => view?.completeDocumentPreparation(...args);
    render.compose = async payload => {
      // Opening a quote composer should not wait for a mailbox/drafts refresh.
      // If Conversations has not been mounted yet, create it; load messages in
      // the background while the composer appears immediately.
      const created = await ensureView();
      if (!view) throw Error('Sign in to compose an email.');
      const activeView = view;
      const result = activeView.compose(payload);
      if (created) void activeView.refresh({force:false}).catch(error => {
        if (view !== activeView) return;
        const notice = root.querySelector('.cv-notice');
        if (notice) { notice.textContent = error.message; notice.hidden = false; }
      });
      await result;
    };
    render.reply = async bodyText => { await render(); if (!view) throw Error('Sign in to reply.'); await view.reply(bodyText); };
    return render;
  }
  global.TK_CONVERSATIONS = { mount, createRenderer, groupMessages, category, pdfBlob, renderEmailHtml, messageText, normalizeEmailFont };
})(typeof window !== 'undefined' ? window : globalThis);
