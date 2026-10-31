import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeMetaUserToken, inspectMetaAccessToken } from './metaTokenValidation.js';

const valid = {
  data: {
    app_id: 'app-1',
    type: 'USER',
    is_valid: true,
    expires_at: 0,
    scopes: ['leads_retrieval', 'pages_manage_metadata'],
  },
};

function fakeFetch(payload) {
  return async (url, options) => {
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.pathname, '/v26.0/debug_token');
    assert.equal(url.searchParams.get('input_token'), 'credential-under-test');
    assert.equal(url.searchParams.get('access_token'), 'app-1|app-secret');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => payload };
  };
}

test('accepts a valid user token for this app with the lead scopes; ads_read is optional', async () => {
  const result = await inspectMetaAccessToken({
    token: 'credential-under-test', appId: 'app-1', appSecret: 'app-secret', fetchImpl: fakeFetch(valid),
  });
  assert.equal(result.type, 'USER');
  assert.equal(result.expiresAt, 0);
});

test('accepts expiring user tokens and still rejects wrong-app, invalid, and under-scoped tokens safely', async () => {
  const cases = [
    [{ ...valid, data: { ...valid.data, type: 'APP' } }, /user access token/],
    [{ ...valid, data: { ...valid.data, app_id: 'other' } }, /different Meta app/],
    [{ data: { ...valid.data, is_valid: false } }, /rejected this token/],
    [{ ...valid, data: { ...valid.data, scopes: ['ads_read'] } }, /leads_retrieval/],
  ];
  for (const [payload, message] of cases) {
    await assert.rejects(() => inspectMetaAccessToken({
      token: 'credential-under-test', appId: 'app-1', appSecret: 'app-secret', fetchImpl: fakeFetch(payload),
    }), error => error.status === 400 || error.status === 403 ? message.test(error.publicMessage) : false);
  }
});

test('accepts a user token that expires but reports the expiry for the UI', async () => {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const payload = { data: { ...valid.data, expires_at: expiry } };
  const result = await inspectMetaAccessToken({ token: 'credential-under-test', appId: 'app-1', appSecret: 'app-secret', fetchImpl: fakeFetch(payload) });
  assert.equal(result.expiresAt, expiry);
});

test('exchanges a short-lived user token server-side without exposing the app secret in errors', async () => {
  const result = await exchangeMetaUserToken({ token: 'credential-under-test', appId: 'app-1', appSecret: 'app-secret', fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/v26.0/oauth/access_token');
    assert.equal(url.search, '');
    assert.equal(options.method, 'POST');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'fb_exchange_token');
    assert.equal(body.get('client_id'), 'app-1');
    assert.equal(body.get('client_secret'), 'app-secret');
    assert.equal(body.get('fb_exchange_token'), 'credential-under-test');
    return { ok: true, json: async () => ({ access_token: 'long-lived-token', expires_in: 5184000 }) };
  }});
  assert.deepEqual(result, { accessToken: 'long-lived-token', expiresIn: 5184000 });
});

test('does not accept a credential when server-side app verification is not configured', async () => {
  await assert.rejects(() => inspectMetaAccessToken({ token: 'credential-under-test' }), error => error.status === 503);
});
