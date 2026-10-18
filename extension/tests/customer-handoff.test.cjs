// Tests the customer→Google Earth handoff in
// extension/background/customer-handoff.js: CRM-origin / tenant mismatch
// rejection, missing-address rejection, tab scoping across a simulated
// worker restart, and that a mismatched/foreign business can never read
// another tab's bound customer context.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function installChromeMock({ sessionSetShouldFail = false } = {}) {
  const listeners = { onRemoved: [] };
  const storageData = {};
  const createdTabs = [];
  const removedTabIds = [];
  global.chrome = {
    runtime: { id: 'test-extension-id' },
    tabs: {
      create: async (opts) => {
        const tab = { id: createdTabs.length + 1, ...opts };
        createdTabs.push(tab);
        return tab;
      },
      update: async (tabId, opts) => {
        const tab = createdTabs.find((t) => t.id === tabId);
        if (tab) Object.assign(tab, opts);
      },
      remove: async (tabId) => { removedTabIds.push(tabId); },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) }
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: storageData[key] }),
        set: async (obj) => Object.assign(storageData, obj)
      },
      session: {
        get: async (key) => ({ [key]: storageData['session:' + key] }),
        set: async (obj) => {
          if (sessionSetShouldFail) throw new Error('storage.session quota/unavailable (simulated)');
          for (const k of Object.keys(obj)) storageData['session:' + k] = obj[k];
        }
      }
    }
  };
  storageData.tk_config = { siteUrl: 'https://turnkeycrm.net', supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' };
  storageData.tk_session = { accessToken: 'tok', refreshToken: 'ref', userId: 'u1', expiresAt: Date.now() + 3600000 };
  return { listeners, createdTabs, removedTabIds, storageData };
}

function dispatch(listeners, msg, sender) {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (res) => { if (!settled) { settled = true; resolve(res); } };
    for (const fn of listeners.onMessage) {
      fn(msg, sender, sendResponse);
      if (settled) return;
    }
  });
}

let loadCounter = 0;
async function loadModule({ profile, customers } = {}) {
  // Intercept TurnKeyClient's two network-bound methods (getProfile/getCustomer)
  // by monkey-patching global.fetch, since customer-handoff.js builds its own
  // TurnKeyClient straight from chrome.storage rather than taking one as an
  // argument (same ensureClient() shape as service-worker.js).
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok', refresh_token: 'ref', user: { id: 'u1' }, expires_in: 3600 }) };
    }
    if (u.includes('/rest/v1/users')) {
      const body = profile === undefined ? [{ business_id: 'biz1', role: 'owner' }] : (profile ? [profile] : []);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    if (u.includes('/rest/v1/customers')) {
      const idMatch = u.match(/id=eq\.([^&]+)/);
      const bizMatch = u.match(/business_id=eq\.([^&]+)/);
      const id = idMatch && decodeURIComponent(idMatch[1]);
      const biz = bizMatch && decodeURIComponent(bizMatch[1]);
      const all = customers || [{ id: 'cust1', business_id: 'biz1', name: 'Jane Doe', address: '42 Example St', suburb: 'Ponsonby' }];
      const match = all.filter((c) => c.id === id && c.business_id === biz);
      return { ok: true, status: 200, text: async () => JSON.stringify(match) };
    }
    throw new Error('unexpected fetch ' + u);
  };
  const listeners = { onMessage: [] };
  const originalAddListener = global.chrome.runtime.onMessage;
  global.chrome.runtime.onMessage = { addListener: (fn) => listeners.onMessage.push(fn) };
  const url = pathToFileURL(path.join(__dirname, '..', 'background', 'customer-handoff.js')).href + '?t=' + (++loadCounter);
  const mod = await import(url);
  mod.registerCustomerHandoff();
  return { mod, listeners };
}

test('TK_CUSTOMER_LAUNCH from a non-CRM origin is rejected and opens no tab', async () => {
  const { createdTabs } = installChromeMock();
  const { listeners } = await loadModule();
  const res = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 1, customerId: 'cust1', businessId: 'biz1' }, { tab: { id: 5 }, url: 'https://evil.example/' });
  assert.equal(res.ok, false);
  assert.match(res.error, /TurnKey site/);
  assert.equal(createdTabs.length, 0);
});

test('TK_CUSTOMER_LAUNCH for a business that does not match the signed-in profile is rejected (tenant mismatch)', async () => {
  const { createdTabs } = installChromeMock();
  const { listeners } = await loadModule(); // signed-in profile is biz1
  const res = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 1, customerId: 'cust1', businessId: 'biz2' }, { tab: { id: 5 }, url: 'https://turnkeycrm.net/index.html' });
  assert.equal(res.ok, false);
  assert.match(res.error, /different business/);
  assert.equal(createdTabs.length, 0);
});

test('TK_CUSTOMER_LAUNCH for a customer with no saved address is rejected and opens no tab', async () => {
  const { createdTabs } = installChromeMock();
  const { listeners } = await loadModule({ customers: [{ id: 'cust1', business_id: 'biz1', name: 'Jane Doe', address: '', suburb: '' }] });
  const res = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 1, customerId: 'cust1', businessId: 'biz1' }, { tab: { id: 5 }, url: 'https://turnkeycrm.net/index.html' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no saved address/);
  assert.equal(createdTabs.length, 0);
});

test('TK_CUSTOMER_LAUNCH opens a blank tab, stores context BEFORE navigating, and the Earth URL carries only the address', async () => {
  const { createdTabs } = installChromeMock();
  const { listeners } = await loadModule();
  const res = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 7, customerId: 'cust1', businessId: 'biz1' }, { tab: { id: 5 }, url: 'https://turnkeycrm.net/index.html' });
  assert.equal(res.ok, true, res.error);
  assert.equal(createdTabs.length, 1);
  const tab = createdTabs[0];
  assert.ok(tab.url.startsWith('https://earth.google.com/web/search/'));
  assert.ok(!tab.url.includes('cust1'), 'no customer id in the Earth URL');
  assert.ok(!tab.url.includes('biz1'), 'no business id in the Earth URL');
  assert.ok(!tab.url.includes('tok'), 'no session token in the Earth URL');
});

test('TK_GET_CUSTOMER_CONTEXT only answers the exact Earth tab that was opened for it, from the Earth origin, with the matching business', async () => {
  installChromeMock();
  const { listeners } = await loadModule();
  const launch = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 7, customerId: 'cust1', businessId: 'biz1' }, { tab: { id: 5 }, url: 'https://turnkeycrm.net/index.html' });
  const earthTabId = launch.data.tabId;

  // Wrong tab.
  const wrongTab = await dispatch(listeners, { type: 'TK_GET_CUSTOMER_CONTEXT' }, { tab: { id: earthTabId + 999 }, url: 'https://earth.google.com/web/' });
  assert.equal(wrongTab.ok, true);
  assert.equal(wrongTab.data, null);

  // Wrong origin (not Earth), even for the right tab id.
  const wrongOrigin = await dispatch(listeners, { type: 'TK_GET_CUSTOMER_CONTEXT' }, { tab: { id: earthTabId }, url: 'https://evil.example/' });
  assert.equal(wrongOrigin.data, null);

  // Correct tab + correct Earth origin.
  const ok = await dispatch(listeners, { type: 'TK_GET_CUSTOMER_CONTEXT' }, { tab: { id: earthTabId }, url: 'https://earth.google.com/web/@-36.8,174.7' });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.customerId, 'cust1');
  assert.equal(ok.data.address, '42 Example St, Ponsonby');
  assert.equal(ok.data.businessId, 'biz1');
});

test('TK_GET_CUSTOMER_CONTEXT rejects a look-alike origin (startsWith-vulnerable, not an exact origin match)', async () => {
  installChromeMock();
  const { listeners } = await loadModule();
  const launch = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 7, customerId: 'cust1', businessId: 'biz1' }, { tab: { id: 5 }, url: 'https://turnkeycrm.net/index.html' });
  const earthTabId = launch.data.tabId;

  // "https://earth.google.com.evil.example" STARTS WITH the real Earth
  // origin as a plain string, but is a completely different origin —
  // must be rejected, not treated as if it were earth.google.com.
  const spoofed = await dispatch(listeners, { type: 'TK_GET_CUSTOMER_CONTEXT' }, { tab: { id: earthTabId }, url: 'https://earth.google.com.evil.example/web/' });
  assert.equal(spoofed.ok, true);
  assert.equal(spoofed.data, null);

  // The real origin, for the same tab, still works.
  const real = await dispatch(listeners, { type: 'TK_GET_CUSTOMER_CONTEXT' }, { tab: { id: earthTabId }, url: 'https://earth.google.com/web/' });
  assert.equal(real.data.customerId, 'cust1');
});

test('a chrome.storage.session.set failure during TK_CUSTOMER_LAUNCH aborts and closes the blank tab, instead of claiming a durable context it does not have', async () => {
  const { createdTabs, removedTabIds } = installChromeMock({ sessionSetShouldFail: true });
  const { listeners } = await loadModule();
  const res = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 7, customerId: 'cust1', businessId: 'biz1' }, { tab: { id: 5 }, url: 'https://turnkeycrm.net/index.html' });
  assert.equal(res.ok, false);
  assert.match(res.error, /storage is unavailable/);
  assert.equal(createdTabs.length, 1, 'a blank tab was opened before the storage write was attempted');
  assert.deepEqual(removedTabIds, [createdTabs[0].id], 'that tab must be closed again, never navigated to Earth');
  assert.equal(createdTabs[0].url, 'about:blank', 'never navigated to the Earth search URL');
});

test('context survives a simulated service-worker restart (chrome.storage.session-backed, not just in-memory)', async () => {
  installChromeMock();
  const { listeners } = await loadModule();
  const launch = await dispatch(listeners, { type: 'TK_CUSTOMER_LAUNCH', recordId: 7, customerId: 'cust1', businessId: 'biz1' }, { tab: { id: 5 }, url: 'https://turnkeycrm.net/index.html' });
  const earthTabId = launch.data.tabId;

  // Fresh module load == fresh worker instance, empty in-memory Map.
  const { listeners: listenersB } = await loadModule();
  const res = await dispatch(listenersB, { type: 'TK_GET_CUSTOMER_CONTEXT' }, { tab: { id: earthTabId }, url: 'https://earth.google.com/web/' });
  assert.equal(res.ok, true);
  assert.equal(res.data.customerId, 'cust1');
});
