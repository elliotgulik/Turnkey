const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const now = 1800000000000;
const session = (overrides = {}) => ({ user: { id: 'owner' }, access_token: 'test-token', expires_at: now / 1000 + 3600, ...overrides });
const source = fs.readFileSync(require.resolve('../sales-platform.js'), 'utf8');
const apiSource = source.slice(source.indexOf('  async function api('), source.indexOf('  async function syncServiceM8Dispatch('));
const never = () => new Promise(() => {});
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture({ cached = session(), getSession = async () => ({ data: { session: session() } }), fetch: request } = {}) {
  let authCalls = 0, timerId = 0;
  const requests = [], timers = new Map();
  const context = {
    window: { TK_CURRENT_SESSION: cached }, currentUserId: 'owner',
    backendUrl: () => 'https://backend.example.test',
    sb: { auth: { getSession() { authCalls++; return getSession(); } } },
    fetch: async (url, opts) => { requests.push({ url, opts }); return request ? request(url, opts) : { ok: true, json: async () => ({ ok: true }) }; },
    AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  Object.defineProperty(context, 'localStorage', { get() { throw Error('Raw token storage must not be read'); } });
  vm.runInNewContext(apiSource, context);
  return { context, requests, timers, authCalls: () => authCalls,
    expire(ms) { const entry = [...timers.values()].find(t => t.ms === ms); assert(entry, `Expected ${ms}ms timeout`); entry.fn(); },
  };
}

test('valid same-user snapshot bypasses a locked auth client and preserves request options', async () => {
  const f = fixture({ getSession: never });
  assert.equal((await f.context.api('/api/sales/servicem8/handoff', { method:'POST', body:'{}' })).ok, true);
  assert.equal(f.authCalls(), 0);
  const { url, opts } = f.requests[0];
  assert.equal(url, 'https://backend.example.test/api/sales/servicem8/handoff');
  assert.equal(opts.credentials, 'include');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.body, '{}');
  assert.equal(opts.headers.Authorization, 'Bearer test-token');
  assert.equal(f.timers.size, 0);
});

test('missing, wrong-user, expired, near-expiry and malformed snapshots use bounded SDK fallback', async () => {
  for (const cached of [null, session({user:{id:'other'}}), session({expires_at:now/1000-1}),
    session({expires_at:now/1000+60}), session({expires_at:now/1000+59}), session({expires_at:undefined}),
    session({expires_at:Infinity}), session({access_token:''}), session({access_token:'   '})]) {
    const f = fixture({ cached });
    await f.context.api('/api/sales/settings');
    assert.equal(f.authCalls(), 1);
    assert.equal(f.requests[0].opts.credentials, 'omit');
    assert.equal(f.timers.size, 0);
  }
  const f = fixture({ cached:session({expires_at:now/1000+61}), getSession:never });
  await f.context.api('/api/sales/settings');
  assert.equal(f.authCalls(), 0);
});

test('stuck fallback times out and late auth resolution cannot send a request', async () => {
  let resolve;
  const f = fixture({ cached:null, getSession:() => new Promise(r => { resolve=r; }) });
  const rejected = assert.rejects(f.context.api('/api/sales/settings'), /Session check timed out/);
  await flush(); f.expire(8000); await rejected;
  resolve({data:{session:session()}}); await flush();
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

test('fallback rejects auth errors, absent sessions, wrong users and sign-out during lookup', async () => {
  for (const result of [{error:Error('Auth unavailable')}, {data:{session:null}}, {data:{session:session({user:{id:'other'}})}}, {data:{session:session({expires_at:now/1000+60})}}]) {
    const f = fixture({cached:null, getSession:async () => result});
    await assert.rejects(f.context.api('/api/sales/settings'), /Auth unavailable|Please sign in again/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
  }
  const f = fixture({cached:null, getSession:async () => { f.context.currentUserId='other'; return {data:{session:session()}}; }});
  await assert.rejects(f.context.api('/api/sales/settings'), /Please sign in again/);
  assert.equal(f.requests.length, 0);
});

test('fetch and body reads share a bounded deadline and abort the request', async () => {
  for (const request of [never, async () => ({ok:true,json:never})]) {
    const f = fixture({fetch:request});
    const rejected = assert.rejects(f.context.api('/api/sales/servicem8/jobs'), /Request timed out/);
    await flush(); f.expire(30000); await rejected;
    assert.equal(f.requests[0].opts.signal.aborted, true);
    assert.equal(f.timers.size, 0);
  }
});

test('HTTP error metadata is preserved and request timers are cleaned up', async () => {
  const f = fixture({ fetch:async () => ({ok:false,status:409,json:async () => ({error:'Needs details',code:'MISSING_FIELDS',missingFields:['email']})}) });
  await assert.rejects(f.context.api('/api/sales/servicem8/handoff'), error => {
    assert.equal(error.message, 'Needs details');
    assert.equal(error.status, 409);
    assert.equal(error.code, 'MISSING_FIELDS');
    assert.equal(error.missingFields[0], 'email');
    return true;
  });
  assert.equal(f.timers.size, 0);
});

test('caller cancellation is forwarded and no-user snapshots cannot authenticate', async () => {
  const f = fixture();
  const caller = new AbortController();
  caller.abort(Error('Cancelled'));
  await f.context.api('/api/sales/settings', {signal:caller.signal});
  assert.equal(f.requests[0].opts.signal.aborted, true);
  const signedOut = fixture();
  signedOut.context.currentUserId = null;
  await assert.rejects(signedOut.context.api('/api/sales/settings'), /Please sign in again/);
  assert.equal(signedOut.requests.length, 0);
  assert.equal(signedOut.authCalls(), 0);
});
