// Tests the measurement-request bridging logic in
// extension/background/service-worker.js: wrong-tab/spoofed-origin
// rejection, expiry, and duplicate-Finish concurrency handling. Runs under
// plain Node with a minimal chrome mock installed before the module is
// imported (service workers register their onMessage/tabs listeners at
// module-load time).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * `listeners` and `storageData` are returned separately so a test can
 * simulate a service-worker restart: call `resetListeners()` (a fresh
 * worker's module-load registers its OWN listeners) while leaving
 * `storageData` — standing in for chrome.storage.session, which genuinely
 * does survive a worker restart within the same browser session — intact.
 */
function installChromeMock() {
  const listeners = { onMessage: [], onUpdated: [], onRemoved: [], onChanged: [] };
  const storageData = {};
  const createdTabs = [];
  global.chrome = {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      lastError: undefined
    },
    tabs: {
      create: async (opts) => {
        const tab = { id: createdTabs.length + 1, ...opts };
        createdTabs.push(tab);
        return tab;
      },
      sendMessage: async () => ({ok:true}),
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) }
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        get: async (key) => ({ [key]: storageData[key] }),
        set: async (obj) => Object.assign(storageData, obj),
        remove: async () => {}
      },
      session: {
        get: async (key) => ({ [key]: storageData['session:' + key] }),
        set: async (obj) => { for (const k of Object.keys(obj)) storageData['session:' + k] = obj[k]; }
      },
      onChanged: { addListener: (fn) => listeners.onChanged.push(fn) }
    },
    windows: { WINDOW_ID_CURRENT: -2 }
  };
  storageData.tk_config = { siteUrl: 'https://turnkeycrm.net' };
  return {
    listeners,
    createdTabs,
    resetListeners: () => { listeners.onMessage = []; listeners.onUpdated = []; listeners.onRemoved = []; },
    setSiteUrl: (url) => { storageData.tk_config = { siteUrl: url }; }
  };
}

/**
 * Simulates Chrome calling every registered onMessage listener for a
 * message, honoring whichever one actually calls sendResponse — including
 * asynchronously, exactly like a real listener that returns `true` and
 * resolves later (e.g. after an `await` inside it). Only resolves with
 * `undefined` up front if no listener claimed it would respond async.
 */
function dispatch(listeners, msg, sender) {
  return new Promise((resolve) => {
    let settled = false;
    let anyAsync = false;
    const sendResponse = (res) => { if (!settled) { settled = true; resolve(res); } };
    for (const fn of listeners.onMessage) {
      const keepsAlive = fn(msg, sender, sendResponse);
      if (settled) return;
      if (keepsAlive) anyAsync = true;
    }
    if (!settled && !anyAsync) resolve(undefined);
  });
}

const { pathToFileURL } = require('node:url');
let loadCounter = 0;
async function loadBackground() {
  // Cache-busted per call (unique query string) — each test installs its
  // own chrome mock and needs the module's top-level listener
  // registration to run against THAT mock, not whatever mock was global
  // when a previous test first imported it.
  const url = pathToFileURL(path.join(__dirname, '..', 'background', 'service-worker.js')).href + '?t=' + (++loadCounter);
  return import(url);
}

test('TK_OPEN_WORKSPACE is rejected if the sender is not the Google Earth origin', async () => {
  const { listeners } = installChromeMock();
  await loadBackground();
  const res = await dispatch(listeners, { type: 'TK_OPEN_WORKSPACE', payload: { category: 'roof', shape: 'area', lat: -36.8, lng: 174.7 } }, { tab: { id: 1 }, url: 'https://evil.example/' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Google Earth/);
});

test('TK_MEASURE_RESULT from the wrong tab (spoofed sender) is rejected', async () => {
  const { listeners } = installChromeMock();
  const bg = await loadBackground();
  bg.pendingRequests.set('req1', { earthTabId: 10, workspaceTabId: 20, category: 'roof', shape: 'area', createdAt: Date.now(), completed: false });

  const res = await dispatch(listeners, { type: 'TK_MEASURE_RESULT', requestId: 'req1', result: { value: 10 } }, { tab: { id: 999 } });
  assert.equal(res.ok, false);
  assert.match(res.error, /expected TurnKey workspace tab/);
});

test('TK_MEASURE_RESULT for an unknown/expired requestId is rejected', async () => {
  const { listeners } = installChromeMock();
  await loadBackground();
  const res = await dispatch(listeners, { type: 'TK_MEASURE_RESULT', requestId: 'does-not-exist', result: { value: 10 } }, { tab: { id: 20 } });
  assert.equal(res.ok, false);
  assert.match(res.error, /expired|never opened/);
});

test('a second TK_MEASURE_RESULT for the same requestId (duplicate Finish / concurrency) is rejected', async () => {
  const { listeners } = installChromeMock();
  const bg = await loadBackground();
  bg.pendingRequests.set('req2', { earthTabId: 10, workspaceTabId: 20, category: 'roof', shape: 'area', createdAt: Date.now(), completed: false });

  const first = await dispatch(listeners, { type: 'TK_MEASURE_RESULT', requestId: 'req2', result: { value: 10 } }, { tab: { id: 20 } });
  assert.equal(first.ok, true);

  bg.pendingRequests.set('req2', { earthTabId: 10, workspaceTabId: 20, category: 'roof', shape: 'area', createdAt: Date.now(), completed: true });
  const second = await dispatch(listeners, { type: 'TK_MEASURE_RESULT', requestId: 'req2', result: { value: 10 } }, { tab: { id: 20 } });
  assert.equal(second.ok, false);
  assert.match(second.error, /already sent/);
});

test('TK_API rejects an action outside the explicit allowlist', async () => {
  const { listeners } = installChromeMock();
  await loadBackground();
  const res = await dispatch(listeners, { type: 'TK_API', action: 'rawRestQuery', args: ['customers?select=*'] }, { tab: { id: 1 } });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unsupported/);
});

test('a pending request survives a simulated service-worker restart (chrome.storage.session-backed, not just in-memory)', async () => {
  const { listeners, createdTabs, resetListeners } = installChromeMock();
  await loadBackground(); // "worker instance A" — registers its listeners

  const openRes = await dispatch(
    listeners,
    { type: 'TK_OPEN_WORKSPACE', payload: { category: 'roof', categoryLabel: 'Roof', kind: 'area', lat: -36.8, lng: 174.7 } },
    { tab: { id: 10 }, url: 'https://earth.google.com/web/@-36.8,174.7' }
  );
  assert.equal(openRes.ok, true);
  const workspaceTabId = createdTabs[0].id;

  // Simulate the real MV3 lifecycle: worker A is suspended/killed (its
  // listeners are gone — nothing in this test still calls into module A),
  // then a fresh worker B is spun back up for the next message. Only
  // chrome.storage.session (storageData, untouched here) carries the
  // pending request across that gap.
  resetListeners();
  await loadBackground(); // "worker instance B" — fresh module, empty in-memory Map, must rehydrate from storage.session

  const res = await dispatch(
    listeners,
    { type: 'TK_MEASURE_RESULT', requestId: openRes.requestId, result: { value: 42, unit: 'm²', groundArea: 42, method: 'geodesic', points: [] } },
    { tab: { id: workspaceTabId } }
  );
  assert.equal(res.ok, true, res.error);
});

test('opening the workspace on a TurnKey site outside the bridge allowlist fails clearly, with no silent/broken tab opened', async () => {
  const { listeners, createdTabs, setSiteUrl } = installChromeMock();
  setSiteUrl('https://my-self-hosted-crm.example');
  await loadBackground();

  const res = await dispatch(
    listeners,
    { type: 'TK_OPEN_WORKSPACE', payload: { category: 'roof', categoryLabel: 'Roof', kind: 'area', lat: -36.8, lng: 174.7 } },
    { tab: { id: 10 }, url: 'https://earth.google.com/web/@-36.8,174.7' }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /secure bridge isn't enabled/);
  assert.equal(createdTabs.length, 0, 'must not open a workspace tab that can never complete a measurement');
});
