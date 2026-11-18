const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.join(__dirname, '../api/turnkey-api.js')).href;
const cfg = { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' };
const session = (expiresAt = 1) => ({ accessToken: 'old', refreshToken: 'old-refresh', userId: 'user', expiresAt });
const response = (data, status = 200) => ({ status, ok: status < 300, json: async () => data, text: async () => JSON.stringify(data) });
const fresh = { access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600, user: { id: 'user' } };

test('parallel reads rotate once and wait for durable token persistence', async () => {
  const { TurnKeyClient } = await import(moduleUrl);
  let rotations = 0, reads = 0, persisted = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  global.fetch = async (url, options) => {
    if (url.includes('grant_type=')) { rotations++; await gate; return response(fresh); }
    reads++;
    assert.equal(persisted, true);
    assert.equal(options.headers.Authorization, 'Bearer new');
    return response([]);
  };
  const client = new TurnKeyClient(cfg, session(), async next => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(next.refreshToken, 'new-refresh'); persisted = true;
  });
  const pending = [client._rest('jobs'), client._rest('customers'), client.refresh()];
  assert.equal(reads, 0); release();
  await Promise.all(pending);
  assert.equal(rotations, 1); assert.equal(reads, 2);
});

test('server-rejected access token refreshes once and retries the authenticated request', async () => {
  const { TurnKeyClient } = await import(moduleUrl);
  let rotations = 0, reads = 0;
  global.fetch = async (url, options) => {
    if (url.includes('grant_type=')) { rotations++; return response(fresh); }
    reads++;
    return options.headers.Authorization === 'Bearer old' ? response({ message: 'expired' }, 401) : response([{ id: 'job' }]);
  };
  const client = new TurnKeyClient(cfg, session(Date.now() + 3600000));
  assert.deepEqual(await client._rest('jobs'), [{ id: 'job' }]);
  assert.equal(rotations, 1); assert.equal(reads, 2);
});

test('temporary refresh failure retains credentials and allows a subsequent retry', async () => {
  const { TurnKeyClient } = await import(moduleUrl);
  const original = session(); let tries = 0, saves = 0;
  global.fetch = async () => ++tries === 1 ? response({}, 503) : response(fresh);
  const client = new TurnKeyClient(cfg, original, async () => { saves++; });
  await assert.rejects(client.refresh(), /temporarily unavailable/);
  assert.equal(client.session, original); assert.equal(saves, 0);
  await client.refresh(); assert.equal(saves, 1);
});

test('revoked session does not loop or erase the connection', async () => {
  const { TurnKeyClient } = await import(moduleUrl);
  const original = session(); let calls = 0;
  global.fetch = async () => { calls++; return response({ error: 'invalid_grant' }, 400); };
  const client = new TurnKeyClient(cfg, original);
  await assert.rejects(client.refresh(), /revoked or expired/);
  assert.equal(client.session, original); assert.equal(calls, 1);
});

test('stale shared refresh token recovers from the same verified CRM account only', async () => {
  const { TurnKeyClient } = await import(moduleUrl);
  global.fetch = async () => response({}, 400);
  let saves = 0;
  const recovered = { ...session(Date.now() + 3600000), accessToken: 'crm-current', refreshToken: 'crm-refresh' };
  const client = new TurnKeyClient(cfg, session(), async () => { saves++; }, async () => recovered);
  assert.equal((await client.refresh()).accessToken, 'crm-current');
  assert.equal(saves, 1);
  const foreign = new TurnKeyClient(cfg, session(), async () => { throw Error('must not save'); }, async () => ({ ...recovered, userId: 'other' }));
  await assert.rejects(foreign.refresh(), /revoked or expired/);
});

test('open-tab recovery ignores foreign users and validates the matching user with Supabase', async () => {
  const { recoverFromCRM } = await import(pathToFileURL(path.join(__dirname, '../background/session-recovery.js')).href);
  const seen = [];
  const browser = { tabs: {
    query: async () => [{ id: 1, url: 'https://turnkeycrm.net/' }, { id: 2, url: 'https://turnkeycrm.net/' }],
    sendMessage: async id => ({ ok: true, session: { access_token: 'tab-' + id, refresh_token: 'ref-' + id, expires_at: Math.floor(Date.now() / 1000) + 3600 } })
  }};
  global.fetch = async (url, options) => {
    seen.push(options.headers.Authorization);
    assert.ok(url.endsWith('/auth/v1/user'));
    return response({ id: options.headers.Authorization === 'Bearer tab-1' ? 'other' : 'user' });
  };
  const result = await recoverFromCRM(browser, { ...cfg, siteUrl: 'https://turnkeycrm.net/' }, session());
  assert.equal(result.accessToken, 'tab-2'); assert.equal(result.userId, 'user');
  assert.deepEqual(seen, ['Bearer tab-1', 'Bearer tab-2', 'Bearer tab-2']);
});
