import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMetaSystemUserToken } from './metaTokenValidation.js';

const valid = {
  data: {
    app_id: 'app-1',
    type: 'SYSTEM_USER',
    is_valid: true,
    expires_at: 0,
    scopes: ['leads_retrieval', 'pages_manage_metadata', 'ads_read'],
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

test('accepts only valid, never-expiring System User tokens for this app with required scopes', async () => {
  const result = await inspectMetaSystemUserToken({
    token: 'credential-under-test', appId: 'app-1', appSecret: 'app-secret', fetchImpl: fakeFetch(valid),
  });
  assert.equal(result.type, 'SYSTEM_USER');
  assert.equal(result.expiresAt, 0);
});

test('rejects personal, expiring, wrong-app, invalid, and under-scoped tokens safely', async () => {
  const cases = [
    [{ ...valid, data: { ...valid.data, type: 'USER' } }, /Never/],
    [{ ...valid, data: { ...valid.data, expires_at: 1900000000 } }, /Never/],
    [{ ...valid, data: { ...valid.data, app_id: 'other' } }, /different Meta app/],
    [{ data: { ...valid.data, is_valid: false } }, /rejected this token/],
    [{ ...valid, data: { ...valid.data, scopes: ['ads_read'] } }, /leads_retrieval/],
  ];
  for (const [payload, message] of cases) {
    await assert.rejects(() => inspectMetaSystemUserToken({
      token: 'credential-under-test', appId: 'app-1', appSecret: 'app-secret', fetchImpl: fakeFetch(payload),
    }), error => error.status === 400 || error.status === 403 ? message.test(error.publicMessage) : false);
  }
});

test('does not accept a credential when server-side app verification is not configured', async () => {
  await assert.rejects(() => inspectMetaSystemUserToken({ token: 'credential-under-test' }), error => error.status === 503);
});
