/* All API responses are local test doubles. No Gmail account or live backend. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://conversations.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="view-inbox"></main>' }));
    await page.goto('https://conversations.test/');
    await page.addStyleTag({ path: path.resolve('conversations.css') });
    await page.addScriptTag({ path: path.resolve('conversations.js') });
    await page.evaluate(() => {
      const drafts = new Map();
      window.testCalls = []; window.sendMode = 'reject'; window.testBody = '<img src=x onerror="window.pwned=true">';
      window.TK_TEST = TK_CONVERSATIONS.mount({ root: document.getElementById('view-inbox'), request: async (url, opts = {}) => {
        window.testCalls.push({ url, opts });
        const body = opts.body ? JSON.parse(opts.body) : {};
        if (url.endsWith('/messages')) return { account: { email_address: 'me@example.com' }, stars: [], hasMore: false, messages: [{ id: '11111111-1111-4111-8111-111111111111', account_id: 'acct', thread_id: 'thread', direction: 'received', from_address: 'Client <client@example.com>', to_addresses: 'me@example.com', subject: window.testBody, body_text: '', body_html: '<p>' + window.testBody + '</p><script>window.pwned=true</script>', sent_at: '2026-10-01' }] };
        if (url.endsWith('/drafts')) return { drafts: [...drafts.values()] };
        if (url.includes('/drafts/') && opts.method === 'DELETE') { drafts.delete(url.split('/').pop()); return { ok: true }; }
        if (url.includes('/drafts/')) {
          const draft = { id: url.split('/').pop(), status: 'draft', payload: body }; drafts.set(draft.id, draft); return { draft };
        }
        if (url.endsWith('/quote-attachments')) return { attachments: [{ id: '22222222-2222-4222-8222-222222222222', filename: 'Quote-101.pdf' }] };
        if (url.endsWith('/send')) {
          if (window.sendMode === 'reject') throw Error('Gmail rejected the message (403)');
          if (window.sendMode === 'unknown') { drafts.get(body.draftId).status = 'unknown'; throw Error('Gmail did not confirm delivery. Check Sent.'); }
          drafts.get(body.draftId).status = 'sent'; return { ok: true, id: 'sent-1' };
        }
        return { ok: true };
      } });
      return window.TK_TEST.refresh();
    });
    await page.locator('[data-cv-action=thread]').click();
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('.cv-body img').count(), 0);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    assert.equal(await page.locator('[name=to]').inputValue(), 'client@example.com');
    // Use a clean subject because the received subject deliberately contains markup.
    await page.locator('[name=subject]').fill('Re: Your quote');
    await page.locator('[name=bodyText]').fill('Here is your saved quote.');
    await page.locator('[name=files]').setInputFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('test-image') }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }]);
    await page.getByRole('button', { name: 'Saved quote PDF', exact: true }).click();
    await page.getByRole('button', { name: 'Quote-101.pdf', exact: true }).click();
    assert.equal(await page.locator('.cv-files li').count(), 3);
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await page.getByText('Gmail rejected the message (403)', { exact: true }).waitFor();
    assert.equal(await page.locator('[name=bodyText]').inputValue(), 'Here is your saved quote.');
    assert.equal(await page.locator('.cv-files li').count(), 3);
    await page.getByRole('button', { name: 'Save & close', exact: true }).click();
    await page.getByRole('button', { name: /^Drafts/ }).click();
    await page.locator('[data-cv-action=draft]').click();
    assert.equal(await page.locator('[name=bodyText]').inputValue(), 'Here is your saved quote.');
    await page.evaluate(() => { window.sendMode = 'unknown'; });
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await page.getByText('Gmail did not confirm delivery. Check Sent.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send email', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await page.locator('[name=to]').fill('client@example.com');
    await page.locator('[name=subject]').fill('New email');
    await page.locator('[name=bodyText]').fill('A new message');
    await page.evaluate(() => { window.sendMode = 'success'; });
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await page.getByText('Email sent.', { exact: true }).waitFor();
    assert.equal(await page.locator('[name=bodyText]').count(), 0);
    assert.equal(await page.evaluate(() => window.testCalls.filter(c => c.url.endsWith('/send')).length), 3);
    assert.equal(await page.evaluate(() => window.testCalls.some(c => /gmail\.com|googleapis/.test(c.url))), false);
    await page.evaluate(async () => {
      window.TK_TEST.destroy();
      const userId = '11111111-1111-4111-8111-111111111111';
      let context, calls = 0;
      const client = { auth: { getSession: async () => ({ data: { session: { user: { id: userId }, access_token: 'test-session' } } }) } };
      context = { client, userId, businessId: 'A', backendUrl: 'https://backend.test' };
      const render = TK_CONVERSATIONS.createRenderer({ root: document.getElementById('view-inbox'), getContext: () => context, fetchImpl: async (url, options) => {
        if (options.headers.Authorization !== 'Bearer test-session') throw Error('Missing session header');
        if (options.credentials !== 'omit') throw Error('Unexpected credential mode');
        calls++;
        return { ok: true, json: async () => url.endsWith('/drafts') ? { drafts: [] } : { messages: [], stars: [], account: null, hasMore: false } };
      } });
      await render();
      if (calls !== 2) throw Error('Adapter did not load mail and drafts');
      client.auth.getSession = async () => { context = { ...context, businessId: 'B' }; return { data: { session: { user: { id: userId }, access_token: 'old-token' } } }; };
      await render();
      if (calls !== 2) throw Error('Stale scope reached backend');
      render.reset();
      if (document.getElementById('view-inbox').textContent) throw Error('Reset retained private conversation state');
    });
    console.log('Conversations browser passed: folders, safe rendering, reply, files, saved PDF, draft restore, rejection, unknown delivery, confirmed send.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
