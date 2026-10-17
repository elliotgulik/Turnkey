// Tests TurnKeyClient's _createStable() (extension/api/turnkey-api.js) —
// the "a lost HTTP response must not turn Retry into a second database
// row" recovery path createCustomer/createQuote/createJob all share.
// Uses a fake fetch/auth session; no real network or database.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

async function loadModule() {
  return import(path.join(__dirname, '..', 'api', 'turnkey-api.js'));
}

function freshSession() {
  return { accessToken: 'tok', refreshToken: 'rtok', userId: 'user1', expiresAt: Date.now() + 3600_000 };
}

function makeClient(TurnKeyClient, fetchImpl) {
  global.fetch = fetchImpl;
  return new TurnKeyClient({ supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon' }, freshSession(), () => {});
}

test('createQuote retried after a lost response adopts the row the first write actually created, without writing a second one', async () => {
  const { TurnKeyClient } = await loadModule();
  const stableId = 'quote-stable-1';
  let postCount = 0;
  const client = makeClient(TurnKeyClient, async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (method === 'POST') {
      postCount++;
      // The write actually succeeds server-side, but the response never
      // reaches the client (dropped connection, service worker killed,
      // etc.) — simulated here as a fetch() rejection.
      throw new Error('network interrupted');
    }
    // The recovery GET: real data, as if the POST above HAD landed.
    return {
      ok: true,
      status: 200,
      json: async () => ([{ id: stableId, business_id: 'biz1', lead_id: 'cust1', amount: 450, status: 'draft' }])
    };
  });

  const quote = await client.createQuote('biz1', { id: stableId, customerId: 'cust1', amount: 450 });
  assert.equal(quote.id, stableId);
  assert.equal(postCount, 1, 'only one write attempt should ever be made per call');
});

test('createQuote does NOT adopt a different row that happens to exist at the same id/business (content mismatch)', async () => {
  const { TurnKeyClient } = await loadModule();
  const stableId = 'quote-stable-2';
  const client = makeClient(TurnKeyClient, async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (method === 'POST') throw new Error('network interrupted');
    // A row exists at this id, but with a DIFFERENT amount — e.g. a stale
    // retry racing a legitimate edit, or truly a different record. Must
    // not be silently adopted as "the" result of this call.
    return {
      ok: true,
      status: 200,
      json: async () => ([{ id: stableId, business_id: 'biz1', lead_id: 'cust1', amount: 999, status: 'draft' }])
    };
  });

  await assert.rejects(() => client.createQuote('biz1', { id: stableId, customerId: 'cust1', amount: 450 }), /network interrupted/);
});

test('createQuote without a stable id re-throws on a lost response rather than guessing which row is "the" one', async () => {
  const { TurnKeyClient } = await loadModule();
  const client = makeClient(TurnKeyClient, async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST') throw new Error('network interrupted');
    throw new Error('should not attempt a recovery GET with no id to scope it');
  });
  await assert.rejects(() => client.createQuote('biz1', { customerId: 'cust1', amount: 450 }), /network interrupted/);
});

test('createCustomer recovery is scoped to the correct business — never adopts another business\'s row', async () => {
  const { TurnKeyClient } = await loadModule();
  const stableId = 'cust-stable-1';
  const requestedUrls = [];
  const client = makeClient(TurnKeyClient, async (url, opts = {}) => {
    requestedUrls.push(url);
    if ((opts.method || 'GET') === 'POST') throw new Error('network interrupted');
    return { ok: true, status: 200, json: async () => ([]) }; // no row found scoped to the right business
  });
  await assert.rejects(() => client.createCustomer('biz1', { id: stableId, name: 'Jane' }), /network interrupted/);
  const recoveryGet = requestedUrls.find((u) => u.includes('customers?'));
  assert.ok(recoveryGet.includes('business_id=eq.biz1'), 'recovery lookup must be scoped to the business that attempted the write');
});
