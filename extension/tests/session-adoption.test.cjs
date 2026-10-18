const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const project = 'rcighpmdrutnghsqhzlr';
const config = {
  supabaseUrl: `https://${project}.supabase.co`,
  supabaseAnonKey: 'public-anon-key'
};
const response = (body, ok = true, status = 200) => ({
  ok, status,
  text: async () => JSON.stringify(body),
  json: async () => body
});

test('adopting a CRM session validates its token and derives user id from Supabase', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: 'verified-user', email: 'owner@example.com' });
    if (String(url).includes('/rest/v1/users?')) return response([{ business_id: 'biz-verified', role: 'owner', name: 'Owner' }]);
    throw new Error('Unexpected request: ' + url);
  };
  const { TurnKeyClient } = await import(path.join(__dirname, '..', 'api', 'turnkey-api.js') + '?adopt=1');
  const client = new TurnKeyClient(config, null);
  const session = await client.adoptSession({
    access_token: 'valid-access', refresh_token: 'valid-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'forged-user' }
  });
  assert.equal(session.userId, 'verified-user');
  assert.equal((await client.getRequiredProfile()).business_id, 'biz-verified');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer valid-access');
  assert.match(calls[1].url, /id=eq\.verified-user/);
});

test('adopting a missing, invalid, or expired-unrefreshable CRM session is rejected', async () => {
  const { TurnKeyClient } = await import(path.join(__dirname, '..', 'api', 'turnkey-api.js') + '?adopt=2');
  const client = new TurnKeyClient(config, null);
  await assert.rejects(() => client.adoptSession(null), /No active TurnKey sign-in/);

  global.fetch = async () => response({ message: 'invalid token' }, false, 401);
  await assert.rejects(() => client.adoptSession({ access_token: 'bad', refresh_token: 'ref' }), /could not be verified/);
});

test('an expired CRM access token is refreshed before the connection is saved', async () => {
  let authCalls = 0;
  global.fetch = async (url) => {
    url = String(url);
    if (url.endsWith('/auth/v1/user')) {
      authCalls++;
      return authCalls === 1 ? response({ message: 'expired' }, false, 401) : response({ id: 'refreshed-user' });
    }
    if (url.includes('grant_type=refresh_token')) return response({
      access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600, user: { id: 'refreshed-user' }
    });
    throw new Error('Unexpected request: ' + url);
  };
  const { TurnKeyClient } = await import(path.join(__dirname, '..', 'api', 'turnkey-api.js') + '?adopt=refresh');
  const client = new TurnKeyClient(config, null);
  const session = await client.adoptSession({ access_token: 'expired-access', refresh_token: 'good-refresh', expires_at: 1 });
  assert.equal(session.accessToken, 'fresh-access');
  assert.equal(session.refreshToken, 'fresh-refresh');
  assert.equal(session.userId, 'refreshed-user');
  assert.equal(authCalls, 2);
});

test('automatic account connection only stores state after active-tab origin, session, and tenant are validated', async () => {
  const listeners = [];
  const saved = {};
  const configText = `window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || { backendUrl: 'https://turnkeynova.onrender.com', supabaseUrl: 'https://${project}.supabase.co', supabaseAnonKey: 'public-anon-key' };`;
  const authSession = { access_token: 'access', refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  let activeTab = { id: 12, url: 'https://turnkeycrm.net/index.html' };
  let profileRows = [{ business_id: 'biz-real', role: 'owner', name: 'Owner', email: 'owner@example.com' }];
  let businessRows = [{ id: 'biz-real', name: 'Real Business' }];
  let authOk = true;
  let messageRequest = null;
  global.chrome = {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: (fn) => listeners.push(fn) },
      lastError: undefined
    },
    tabs: {
      query: async () => [activeTab],
      sendMessage: async (_tabId, msg) => { messageRequest = msg; return { ok: true, session: authSession }; },
      create: async () => ({ id: 99 }),
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} }
    },
    scripting: { executeScript: async () => {} },
    permissions: { contains: async ({ origins }) => origins.includes(`https://${project}.supabase.co/*`) },
    storage: {
      local: {
        get: async (key) => ({ [key]: saved[key] }),
        set: async (obj) => Object.assign(saved, obj),
        remove: async (keys) => keys.forEach((key) => delete saved[key])
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} }
    },
    windows: { WINDOW_ID_CURRENT: -2 }
  };
  global.fetch = async (url) => {
    url = String(url);
    if (url === 'https://turnkeycrm.net/config.js') return { ok: true, status: 200, text: async () => configText };
    if (url.endsWith('/auth/v1/user')) return response(authOk ? { id: 'verified-user' } : { message: 'bad token' }, authOk, authOk ? 200 : 401);
    if (url.includes('/rest/v1/users?')) return response(profileRows);
    if (url.includes('/rest/v1/businesses?')) return response(businessRows);
    throw new Error('Unexpected request: ' + url);
  };
  const { pathToFileURL } = require('node:url');
  const workerUrl = pathToFileURL(path.join(__dirname, '..', 'background', 'service-worker.js')).href + '?connection=1';
  await import(workerUrl);
  const dispatch = (msg, sender = { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup/popup.html' }) => new Promise((resolve) => {
    let async = false;
    for (const listener of listeners) {
      const keepAlive = listener(msg, sender, resolve);
      if (keepAlive) async = true;
    }
    if (!async) resolve(undefined);
  });

  const result = await dispatch({ type: 'TK_CONNECT_FROM_ACTIVE_CRM' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(messageRequest, { type: 'TK_READ_CRM_AUTH_SESSION', storageKey: `sb-${project}-auth-token` });
  assert.equal(saved.tk_profile.business_id, 'biz-real');
  assert.equal(saved.tk_business.id, 'biz-real');
  assert.equal(saved.tk_session.userId, 'verified-user');
  assert.equal(saved.tk_config.siteUrl, 'https://turnkeycrm.net');
  assert.equal(saved.tk_session.accessToken, 'access');

  const savedBeforeFailure = { ...saved };
  authOk = false;
  const invalid = await dispatch({ type: 'TK_CONNECT_FROM_ACTIVE_CRM' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /could not be verified/);
  assert.deepEqual(saved, savedBeforeFailure, 'invalid credentials must not replace an established connection');

  authOk = true;
  profileRows = [{ business_id: 'biz-real', role: 'owner' }];
  businessRows = [{ id: 'different-business', name: 'Wrong Business' }];
  const wrongBusiness = await dispatch({ type: 'TK_CONNECT_FROM_ACTIVE_CRM' });
  assert.equal(wrongBusiness.ok, false);
  assert.match(wrongBusiness.error, /business profile could not be loaded/);
  assert.deepEqual(saved, savedBeforeFailure, 'a mismatched business record cannot replace the verified connection');

  const spoofed = await dispatch({ type: 'TK_CONNECT_FROM_ACTIVE_CRM' }, { id: 'other-extension', url: 'chrome-extension://other/popup/popup.html' });
  assert.equal(spoofed.ok, false);
  assert.match(spoofed.error, /Open the TurnKey extension popup/);

  activeTab = { id: 13, url: 'https://turnkeycrm.net.evil.example/' };
  const wrongOrigin = await dispatch({ type: 'TK_CONNECT_FROM_ACTIVE_CRM' });
  assert.equal(wrongOrigin.ok, false);
  assert.match(wrongOrigin.error, /Open a TurnKey tab/);
});

test('a valid CRM login without a real business mapping is not connected as a fake personal tenant', async () => {
  const { TurnKeyClient } = await import(path.join(__dirname, '..', 'api', 'turnkey-api.js') + '?adopt=3');
  global.fetch = async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: 'verified-user' });
    if (String(url).includes('/rest/v1/users?')) return response([]);
    throw new Error('Unexpected request: ' + url);
  };
  const client = new TurnKeyClient(config, null);
  await client.adoptSession({ access_token: 'valid', refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  await assert.rejects(() => client.getRequiredProfile(), /no business profile/);
});

test('popup no longer asks the user to paste a site URL or re-enter a TurnKey password', () => {
  const fs = require('node:fs');
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
  assert.match(popup, /Connect to signed-in TurnKey/);
  assert.doesNotMatch(popup, /type="password"|TurnKey site URL|Enter the web address/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, [
    `https://${project}.supabase.co/*`,
    'https://turnkeynova.onrender.com/*'
  ]);
});
