/* One focused UI check. Uses the real assembled app for settings and local
 * mail doubles for conversations; all remote traffic is intercepted. No sends
 * reach a backend. Run: node tests/settings-conversations-ux-browser.cjs */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [], remote = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
        from() {
          const q = { select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
            async single() { return { data: null, error: null }; }, async maybeSingle() { return { data: null, error: null }; },
            then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } };
          return q;
        },
      }) };
    });
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.origin === 'https://ux.test') {
        const name = u.pathname === '/' ? 'index.html' : u.pathname.slice(1), file = path.resolve(base, name);
        if (name === 'config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.TURNKEY_CONFIG={supabaseUrl:"https://fixture.invalid",supabaseAnonKey:"fixture-key",backendUrl:"https://backend.test"};' });
        if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ path: file, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
      }
      remote.push(u.href);
      return route.fulfill({ contentType: 'text/javascript', body: '' });
    });
    await page.goto('https://ux.test/');
    await page.waitForFunction(() => window.TK_SALES_PLATFORM && window.TK_CONVERSATIONS_BRIDGE);
    await page.addStyleTag({ path: path.join(base, 'settings-experience.css') });
    await page.evaluate(() => {
      currentBusinessId = 'fixture-business'; currentUserRole = 'owner';
      currentBusinessProfile = { name: 'Fixture Pressure Wash', email: 'owner@example.com' };
      const previous = window.openSettings;
      window.openSettings = function (...args) {
        window.hostInvocation = { sameThis: this === window, args };
        previous.apply(this, args);
        document.getElementById('settings-body').insertAdjacentHTML('beforeend', settingsGroup('Partner connection', '<form id="fixture-form"><label>Partner token<input id="fixture-credential" type="password" value="fixture-secret"></label><label>Region<select id="fixture-select"><option>North</option><option>South</option></select></label><button type="submit">Save partner</button></form>'));
        window.hostGroups = [...document.querySelectorAll('#settings-body .settings-group')];
        window.originalName = document.getElementById('biz-name-input');
        window.originalCredential = document.getElementById('fixture-credential');
        window.originalSelect = document.getElementById('fixture-select');
        window.originalCredential.addEventListener('input', () => { window.credentialEvents = (window.credentialEvents || 0) + 1; });
        document.getElementById('fixture-form').addEventListener('submit', event => { event.preventDefault(); window.partnerSaved = true; });
        return 'host-result';
      };
      window.beforeInstall = window.openSettings;
    });
    await page.addScriptTag({ path: path.join(base, 'settings-experience.js') });
    assert.equal(await page.evaluate(() => openSettings === beforeInstall), true, 'Loading settings module must be inert');
    assert.deepEqual(await page.evaluate(() => {
      const first = TK_SETTINGS_EXPERIENCE.install(), installed = openSettings;
      const second = TK_SETTINGS_EXPERIENCE.install();
      return { first, second, same: installed === openSettings, result: openSettings.call(window, 'fixture'), invocation: hostInvocation };
    }), { first: true, second: true, same: true, result: 'host-result', invocation: { sameThis: true, args: ['fixture'] } });
    assert.equal(await page.locator('.sx-layout').count(), 1);
    assert.equal(await page.locator('#settings-body .settings-group').count(), 17);
    assert.equal(await page.evaluate(() => hostGroups.every(el => document.getElementById('settings-body').contains(el))), true);
    assert.equal(await page.locator('#settings-body .settings-group:not([hidden])').count(),17,'All sections appear on the initial settings screen');
    await page.locator('.sx-quick [data-sx-group="Quote embeds"]').click();
    assert.equal(await page.locator('#conn-embed-code').isVisible(),true,'Website HTML embed remains directly accessible');
    assert.match(await page.locator('#conn-embed-code').inputValue(), /iframe/);
    await page.locator('.sx-nav [data-sx-category=overview]').click();
    await page.locator('.sx-quick [data-sx-group=Integrations]').click();
    for(const name of ['Wix Forms','Meta — Facebook','ServiceM8','Gmail','Google Calendar'])assert.ok((await page.locator('.sx-sections').innerText()).includes(name),name);
    await page.locator('.sx-nav [data-sx-category=overview]').click();
    await page.locator('.sx-quick [data-sx-group=Business]').click();
    await page.locator('#biz-name-input').fill('Unsaved business name');
    await page.locator('.sx-nav [data-sx-category=operations]').click();
    await page.locator('.sx-nav [data-sx-category=business]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#biz-name-input').inputValue(), 'Unsaved business name');
    assert.equal(await page.evaluate(() => originalName === document.getElementById('biz-name-input')), true);
    assert.equal(await page.locator('.sx-nav [data-sx-category=business]').getAttribute('aria-current'), 'page');
    assert.notEqual(await page.locator('.sx-nav [data-sx-category=business]').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.locator('.sx-nav [data-sx-category=data]').click();
    await page.locator('#settings-search-input').pressSequentially('Gmail');
    assert.equal(await page.locator('#settings-search-input').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('.settings-group:not([hidden])>summary').first().textContent(), 'Email');
    await page.locator('#settings-search-input').fill('no-setting-matches-this');
    assert.equal(await page.locator('.sx-empty').isVisible(), true);
    await page.locator('.sx-empty button').click();
    assert.equal(await page.locator('.sx-overview').isVisible(), true);
    assert.equal(await page.evaluate(() => TK_SETTINGS_EXPERIENCE.showGroup('Workflows')), true);
    await page.locator('.settings-group>summary').filter({ hasText: /^Workflows$/ }).click();
    await page.locator('#settings-search-input').fill('checklist');
    assert.equal(await page.locator('.settings-group').filter({ has: page.locator('summary', { hasText: /^Workflows$/ }) }).getAttribute('open'), '');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.settings-group').filter({ has: page.locator('summary', { hasText: /^Workflows$/ }) }).getAttribute('open'), null);
    assert.equal(await page.evaluate(() => TK_SETTINGS_EXPERIENCE.showGroup('Integrations')), true);
    assert.equal(await page.getByRole('button', { name: /^Card payments \(Stripe\)/ }).isVisible(), true);
    assert.equal(await page.evaluate(() => TK_SETTINGS_EXPERIENCE.showGroup('Partner connection')), true);
    await page.locator('#fixture-credential').fill('unsaved-fixture-secret');
    await page.locator('#fixture-select').selectOption('South');
    await page.locator('.sx-nav [data-sx-category=connections]').click();
    await page.locator('.sx-nav [data-sx-category=other]').click();
    assert.deepEqual(await page.evaluate(() => ({
      credentialSame: originalCredential === document.getElementById('fixture-credential'),
      selectSame: originalSelect === document.getElementById('fixture-select'),
      credential: originalCredential.value, region: originalSelect.value, events: credentialEvents,
    })), { credentialSame: true, selectSame: true, credential: 'unsaved-fixture-secret', region: 'South', events: 1 });
    await page.getByRole('button', { name: 'Save partner', exact: true }).click();
    assert.equal(await page.evaluate(() => partnerSaved), true);
    await page.evaluate(() => TK_SETTINGS_EXPERIENCE.showGroup('Pipeline'));
    assert.equal(await page.getByRole('button', { name: 'Manage pipeline stages', exact: true }).isVisible(), true);
    await page.screenshot({ path: '/private/tmp/turnkey-settings-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.sx-nav [data-sx-category=connections]').click();
    assert.equal(await page.locator('.sx-nav [data-sx-category=connections]').isVisible(), true);
    assert.equal(await page.locator('#settings-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Settings must fit mobile width');
    assert.equal(await page.locator('.sx-nav').evaluate(el => el.scrollWidth > el.clientWidth), true, 'Mobile categories scroll horizontally');
    await page.screenshot({ path: '/private/tmp/turnkey-settings-mobile.png' });
    // Reopening invokes the host again; enhancement and listeners stay singular.
    await page.evaluate(() => openSettings());
    assert.equal(await page.locator('.sx-layout').count(), 1);
    await page.locator('#settings-search-input').fill('pipeline');
    assert.equal(await page.locator('.settings-group:not([hidden])').count(), 1);
    assert.deepEqual(errors, []);
    assert.equal(remote.some(url => /\/api\/(conversations\/send|email\/send)/.test(url)), false);

    const mail = await context.newPage(), mailErrors = [];
    mail.on('pageerror', e => mailErrors.push(e.message));
    await mail.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main id="view-inbox" style="max-width:1100px;margin:24px auto;padding:16px"></main>' }));
    await mail.goto('https://mail-ux.test/');
    const baseCss = fs.readFileSync(path.join(base, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
    await mail.addStyleTag({ content: baseCss });
    await mail.addStyleTag({ path: path.join(base, 'conversations.css') });
    await mail.addScriptTag({ path: path.join(base, 'conversations.js') });
    await mail.evaluate(async () => {
      const drafts = new Map();
      const messages = [
        { id: 'received-1', account_id: 'acct', thread_id: 'thread-1', direction: 'received', from_address: 'Aroha <aroha@example.com>', to_addresses: 'owner@example.com', subject: 'Driveway clean', snippet: 'Can you visit next week?', body_html: '<p>Algae near the gate.</p><img src="https://tracking.invalid/pixel" onerror="window.unsafeMail=true"><script>window.unsafeMail=true</script>', sent_at: '2026-10-17T01:00:00Z' },
        { id: 'sent-1', account_id: 'acct', thread_id: 'thread-2', direction: 'sent', from_address: 'owner@example.com', to_addresses: 'sam@example.com', subject: 'Your quote', body_text: 'Here is the house wash quote.', sent_at: '2026-10-16T01:00:00Z' },
      ];
      let stars = [];
      window.calls = []; window.sendMode = 'reject'; window.confirmed = 0; window.connected = true;
      window.ui = TK_CONVERSATIONS.mount({ root: document.getElementById('view-inbox'),
        onSent: () => { window.confirmed++; }, onConnect: () => { window.connectionOpened = true; },
        listQuotes: () => [{ id: 'quote-1', label: 'Aroha · Quote 101' }],
        buildQuoteAttachment: async () => ({ filename: 'Quote-101.pdf', mimeType: 'application/pdf', contentBase64: btoa('%PDF-1.7 fixture') }),
        request: async (url, opts = {}) => {
          calls.push({ url, method: opts.method || 'GET' });
          const payload = opts.body ? JSON.parse(opts.body) : {};
          if (url.includes('/messages?')) return { messages: [{ id: 'older-1', account_id: 'acct', direction: 'received', from_address: 'fence@example.com', subject: 'Fence wash', body_text: 'Older enquiry', sent_at: '2026-10-01' }], stars, hasMore: false };
          if (url.endsWith('/messages')) return { account: connected ? { email_address: 'owner@example.com' } : null, messages: connected ? messages : [], stars, hasMore: true };
          if (url.endsWith('/drafts')) return { drafts: structuredClone([...drafts.values()]) };
          if (url.includes('/drafts/')) {
            const id = url.split('/').pop();
            if (opts.method === 'DELETE') { drafts.delete(id); return { ok: true }; }
            const draft = { id, status: 'draft', payload }; drafts.set(id, draft); return { draft: structuredClone(draft) };
          }
          if (url.includes('/stars/')) { stars = payload.starred ? ['thread-1'] : []; return { ok: true }; }
          if (url.endsWith('/quote-attachments')) return { attachments: [{ id: 'uploaded-1', filename: 'Uploaded-quote.pdf' }] };
          if (url.endsWith('/send')) {
            if (sendMode === 'reject') throw Error('Gmail rejected the message (403)');
            if (sendMode === 'unknown') { drafts.get(payload.draftId).status = 'unknown'; throw Error('Gmail did not confirm delivery. Check Sent.'); }
            drafts.get(payload.draftId).status = 'sent'; return { ok: true, id: 'confirmed-send' };
          }
          return { ok: true };
        },
      });
      await ui.refresh();
      window.originalSearch = document.querySelector('[name=cvQuery]');
    });
    assert.equal(await mail.locator('.cv-folders [aria-current=page]').getAttribute('data-folder'), 'inbox');
    await mail.locator('[data-folder=starred]').click();
    assert.equal(await mail.getByText('Keep important emails handy', { exact: true }).isVisible(), true);
    await mail.getByRole('button', { name: 'Browse inbox', exact: true }).click();
    await mail.locator('[name=cvQuery]').pressSequentially('algae');
    assert.equal(await mail.locator('.cv-row').count(), 1);
    assert.equal(await mail.evaluate(() => document.activeElement === document.querySelector('[name=cvQuery]')), true);
    await mail.locator('[name=cvQuery]').fill('does-not-match');
    assert.equal(await mail.getByText('No matching conversations', { exact: true }).isVisible(), true);
    await mail.locator('.cv-search-bar [data-cv-action=clear-search]').click();
    await mail.locator('[data-cv-action=thread]').click();
    assert.equal(await mail.locator('.cv-thread img,.cv-thread script').count(), 0);
    assert.equal(await mail.evaluate(() => window.unsafeMail), undefined);
    await mail.locator('[name=cvQuery]').fill('fence');
    assert.equal(await mail.locator('.cv-thread .cv-message').count(), 0, 'Hidden search result must not leave a stale open thread');
    await mail.getByRole('button', { name: 'Load older messages', exact: true }).click();
    assert.equal(await mail.locator('.cv-row').count(), 1);
    await mail.locator('.cv-search-bar [data-cv-action=clear-search]').click();
    await mail.locator('[data-cv-action=star]').first().click();
    await mail.locator('[data-folder=sent]').click();
    assert.equal(await mail.locator('.cv-row').count(), 1);
    await mail.locator('[data-folder=inbox]').click();
    await mail.locator('[data-cv-action=thread]').first().click();
    await mail.getByRole('button', { name: 'Reply', exact: true }).click();
    assert.equal(await mail.locator('[name=to]').inputValue(), 'aroha@example.com');
    await mail.locator('[name=bodyText]').pressSequentially('Thanks, I can visit on Tuesday.');
    await mail.waitForFunction(() => document.querySelector('.cv-save-state').textContent === 'Draft saved');
    await mail.evaluate(() => { window.searchBeforeTyping = document.querySelector('[name=cvQuery]'); window.bodyBeforeSearch = document.querySelector('[name=bodyText]'); });
    await mail.locator('[name=cvQuery]').pressSequentially('aroha');
    assert.deepEqual(await mail.evaluate(() => ({ search: searchBeforeTyping === document.querySelector('[name=cvQuery]'), body: bodyBeforeSearch === document.querySelector('[name=bodyText]'), focus: document.activeElement === searchBeforeTyping })), { search: true, body: true, focus: true });
    await mail.locator('[name=files]').setInputFiles({ name: 'site-photo.png', mimeType: 'image/png', buffer: Buffer.from('fixture-photo') });
    await mail.getByRole('button', { name: 'Saved quote PDF', exact: true }).click();
    await mail.getByRole('button', { name: 'Aroha · Quote 101', exact: true }).click();
    await mail.getByRole('button', { name: 'Saved quote PDF', exact: true }).click();
    await mail.getByRole('button', { name: 'Uploaded-quote.pdf', exact: true }).click();
    assert.equal(await mail.locator('.cv-files li').count(), 3);
    await mail.getByRole('button', { name: 'Remove Uploaded-quote.pdf', exact: true }).click();
    assert.equal(await mail.locator('.cv-files li').count(), 2);
    await mail.getByRole('button', { name: 'Save & close', exact: true }).click();
    await mail.locator('[data-folder=drafts]').click();
    await mail.locator('[name=cvQuery]').fill('Tuesday');
    assert.equal(await mail.locator('[data-cv-action=draft]').count(), 1);
    await mail.locator('[data-cv-action=draft]').click();
    assert.equal(await mail.locator('.cv-files li').count(), 2);
    assert.equal(await mail.locator('[name=bodyText]').inputValue(), 'Thanks, I can visit on Tuesday.');
    assert.equal(await mail.evaluate(() => calls.filter(c => c.url.endsWith('/send')).length), 0, 'Browsing, drafting and attachments must never send');
    await mail.getByRole('button', { name: 'Send email', exact: true }).click();
    await mail.getByText('Gmail rejected the message (403)', { exact: true }).waitFor();
    assert.equal(await mail.locator('[name=bodyText]').inputValue(), 'Thanks, I can visit on Tuesday.');
    assert.equal(await mail.evaluate(() => confirmed), 0);
    await mail.evaluate(() => { window.sendMode = 'unknown'; });
    await mail.getByRole('button', { name: 'Send email', exact: true }).click();
    await mail.getByText('Gmail did not confirm delivery. Check Sent.', { exact: true }).waitFor();
    assert.equal(await mail.getByRole('button', { name: 'Send email', exact: true }).isDisabled(), true);
    assert.equal(await mail.evaluate(() => confirmed), 0);
    await mail.getByRole('button', { name: 'Close', exact: true }).click();
    await mail.locator('[data-folder=sent]').click();
    await mail.getByRole('button', { name: 'Compose', exact: true }).click();
    await mail.locator('[name=to]').fill('aroha@example.com');
    await mail.locator('[name=subject]').fill('Confirmed visit');
    await mail.locator('[name=bodyText]').fill('See you on Tuesday.');
    await mail.evaluate(() => { window.sendMode = 'success'; });
    await mail.getByRole('button', { name: 'Send email', exact: true }).click();
    await mail.getByText('Email sent.', { exact: true }).waitFor();
    assert.equal(await mail.locator('.cv-composer').count(), 0);
    assert.equal(await mail.evaluate(() => confirmed), 1);
    assert.equal(await mail.evaluate(() => calls.filter(c => c.url.endsWith('/send')).length), 3);
    await mail.locator('.cv-search-bar [data-cv-action=clear-search]').click();
    await mail.locator('[data-folder=inbox]').click();
    await mail.screenshot({ path: '/private/tmp/turnkey-conversations-desktop.png' });
    await mail.setViewportSize({ width: 390, height: 844 });
    await mail.locator('[data-cv-action=thread]').first().click();
    assert.equal(await mail.locator('.cv-list').isVisible(), false);
    assert.equal(await mail.getByRole('button', { name: 'Back to inbox', exact: true }).isVisible(), true);
    await mail.getByRole('button', { name: 'Back to inbox', exact: true }).click();
    assert.equal(await mail.locator('.cv-list').isVisible(), true);
    assert.equal(await mail.locator('#view-inbox').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Conversations must fit mobile width');
    await mail.screenshot({ path: '/private/tmp/turnkey-conversations-mobile.png' });
    await mail.evaluate(async () => { window.connected = false; await ui.refresh(); });
    assert.equal(await mail.getByRole('button', { name: 'Connect Gmail', exact: true }).isVisible(), true);
    await mail.locator('.cv-head [data-cv-action=compose]').click();
    assert.equal(await mail.getByRole('button', { name: 'Send email', exact: true }).isDisabled(), true);
    await mail.evaluate(async () => {
      ui.destroy();
      const userId = 'fixture-user';
      let calls = 0, current;
      const client = { auth: { getSession: async () => ({ data: { session: { user: { id: userId }, access_token: 'fixture-session' } } }) } };
      current = { client, userId, businessId: 'A', backendUrl: 'https://backend.test' };
      const render = TK_CONVERSATIONS.createRenderer({ root: document.getElementById('view-inbox'), getContext: () => current,
        fetchImpl: async (url, options) => {
          if (options.credentials !== 'omit' || options.headers.Authorization !== 'Bearer fixture-session') throw Error('Authentication request contract changed');
          calls++;
          return { ok: true, json: async () => url.endsWith('/drafts') ? { drafts: [] } : { messages: [], stars: [], account: null, hasMore: false } };
        },
      });
      await render();
      if (calls !== 2) throw Error('Expected mail and draft requests');
      client.auth.getSession = async () => { current = { ...current, businessId: 'B' }; return { data: { session: { user: { id: userId }, access_token: 'fixture-session' } } }; };
      await render();
      if (calls !== 2) throw Error('Stale business reached backend');
      render.reset();
      if (document.getElementById('view-inbox').textContent) throw Error('Reset retained private mail');
    });
    assert.deepEqual(mailErrors, []);
    console.log('Settings + Conversations UI passed: real settings wrappers and all groups, original form/credential identity, unsaved edits, global search, keyboard/mobile navigation; mailbox folders/search, safe HTML, autosave, attachments, draft restore, rejected/unknown/confirmed sends and auth fencing. All traffic mocked.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
