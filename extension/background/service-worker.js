// Background service worker. Three jobs, all requiring the background
// context specifically (none of this can run in the Earth content script):
//
// 1. chrome.tabs.captureVisibleTab for the "Screenshot" toolbar button —
//    content scripts cannot call chrome.tabs.* at all.
// 2. Opening the TurnKey-hosted measurement workspace (measure.html) in its
//    own tab, injecting the content bridge into it once it loads, and
//    routing the finished measurement back to the right Google Earth tab.
// 3. A narrow, allowlisted TurnKey API proxy (TK_API messages) so the Earth
//    content script never has to `fetch()` Supabase directly from inside
//    earth.google.com's page context.
//
// MV3 service workers are suspended after ~30s of inactivity and can be
// killed/restarted between any two messages — an in-memory Map alone would
// silently lose every pending measurement request on a real, long (several
// minutes) property trace. The pending-request registry is therefore
// backed by chrome.storage.session (cleared when the browser session ends,
// but NOT on worker suspension/restart, unlike chrome.storage.local which
// would needlessly survive a full browser restart for what's meant to be a
// short-lived handshake) — see loadPending()/savePending() below.
import { fetchSiteConfig, TurnKeyClient } from '../api/turnkey-api.js';
import { Storage } from '../api/storage.js';
import { dataUrlToBlob } from '../content/panel/screenshot.js';
import { registerCustomerHandoff } from './customer-handoff.js';

// Customer → Google Earth handoff (TK_CUSTOMER_LAUNCH / TK_GET_CUSTOMER_CONTEXT) — see customer-handoff.js.
registerCustomerHandoff();

// ── 1. Screenshot ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CAPTURE_SCREENSHOT') {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      else sendResponse({ ok: true, dataUrl });
    });
    return true;
  }
  return false;
});

// ── 2. Measurement workspace bridge ─────────────────────────────────────
const EARTH_ORIGIN = 'https://earth.google.com';
const REQUEST_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — generous for a slow multi-angle 3D trace, still bounded
const PENDING_KEY = 'tk_pending_measure_requests';

// Origins the bridge script (extension/content/bridge/measure-bridge.js)
// can actually be injected AND import geometry.js into — must exactly
// match manifest.json's static web_accessible_resources matches for
// geometry.js, since that list can't be extended at runtime the way
// host_permissions can. Keep these two lists in sync by hand; there's no
// single source of truth that can generate manifest.json's JSON and this
// JS array both without a build step.
const BRIDGE_ALLOWED_ORIGINS = new Set([
  'https://turnkeycrm.net',
  'http://localhost',
  'http://localhost:5173',
  'http://localhost:8888',
  'http://127.0.0.1',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8888'
]);

/** requestId -> {earthTabId, workspaceTabId, category, kind, createdAt, completed, bridged} */
export const pendingRequests = new Map();
let loaded = false;
let loadingPromise = null;

async function loadPending() {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        const data = await chrome.storage.session.get(PENDING_KEY);
        const stored = data[PENDING_KEY] || {};
        for (const [id, req] of Object.entries(stored)) pendingRequests.set(id, req);
      } catch {
        // chrome.storage.session unavailable (older Chrome) — pending
        // requests just won't survive a worker restart; still correct
        // within a single worker lifetime.
      }
      loaded = true;
    })();
  }
  await loadingPromise;
}

async function savePending() {
  try {
    await chrome.storage.session.set({ [PENDING_KEY]: Object.fromEntries(pendingRequests) });
  } catch {
    // best-effort — see loadPending()'s catch
  }
}

async function sweepExpired(now = Date.now()) {
  await loadPending();
  let changed = false;
  for (const [id, req] of pendingRequests) {
    if (now - req.createdAt > REQUEST_TTL_MS) {
      pendingRequests.delete(id);
      changed = true;
    }
  }
  if (changed) await savePending();
}

function randomRequestId() {
  return (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : 'r' + Date.now() + '_' + Math.random().toString(36).slice(2);
}

function bridgeOriginAllowed(siteUrl) {
  try {
    return BRIDGE_ALLOWED_ORIGINS.has(new URL(siteUrl).origin);
  } catch {
    return false;
  }
}

async function openWorkspace({ category, categoryLabel, kind, lat, lng }, earthTabId) {
  await sweepExpired();
  const config = await Storage.getConfig();
  if (!config || !config.siteUrl) throw new Error('Connect the extension to your TurnKey site first.');
  if (!bridgeOriginAllowed(config.siteUrl)) {
    throw new Error(
      `The measurement workspace's secure bridge isn't enabled for ${new URL(config.siteUrl).origin} yet — it works automatically for https://turnkeycrm.net and local development. Ask whoever manages this TurnKey extension build to add your site's origin, or connect the extension to turnkeycrm.net instead.`
    );
  }
  const requestId = randomRequestId();
  const url = new URL(config.siteUrl.replace(/\/+$/, '') + '/measure.html');
  url.searchParams.set('requestId', requestId);
  url.searchParams.set('category', category);
  url.searchParams.set('label', categoryLabel || category);
  url.searchParams.set('kind', kind);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lng', String(lng));
  const tab = await chrome.tabs.create({ url: url.toString(), active: true });
  pendingRequests.set(requestId, {
    earthTabId,
    workspaceTabId: tab.id,
    category,
    kind,
    createdAt: Date.now(),
    completed: false,
    bridged: false
  });
  await savePending();
  return requestId;
}

// Injects the bridge into the workspace tab once it's actually loaded.
// `chrome.scripting.executeScript` requires host permission for that tab's
// origin, already satisfied here because openWorkspace() only ever
// navigates to an origin in BRIDGE_ALLOWED_ORIGINS, which is a subset of
// manifest.json's static host_permissions.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  await loadPending();
  for (const [id, req] of pendingRequests) {
    if (req.workspaceTabId === tabId && !req.completed) {
      req.bridged = true;
      await savePending();
      chrome.scripting.executeScript({ target: { tabId }, files: ['content/bridge/measure-bridge.js'] }).catch((err) => {
        console.warn('[TurnKey] could not inject measurement bridge into workspace tab', err && err.message);
      });
      break;
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadPending();
  let changed = false;
  for (const [id, req] of pendingRequests) {
    if (req.earthTabId === tabId || req.workspaceTabId === tabId) {
      pendingRequests.delete(id);
      changed = true;
    }
  }
  if (changed) await savePending();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'TK_OPEN_WORKSPACE') {
    if (!sender.tab || !sender.url || !sender.url.startsWith(EARTH_ORIGIN)) {
      sendResponse({ ok: false, error: 'Measurement workspace can only be opened from Google Earth.' });
      return false;
    }
    openWorkspace(msg.payload, sender.tab.id)
      .then((requestId) => sendResponse({ ok: true, requestId }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg && msg.type === 'TK_MEASURE_RESULT') {
    (async () => {
      await sweepExpired();
      const req = pendingRequests.get(msg.requestId);
      if (!req) {
        sendResponse({ ok: false, error: 'This measurement request has expired or was never opened by this extension.' });
        return;
      }
      // Anti-spoof: the result must come from the exact workspace tab this
      // extension itself opened for this requestId — a random page
      // guessing/replaying a requestId, or a different tab entirely, is
      // rejected. This check (and the `completed` dedupe below) is backed
      // by storage.session, so it still holds even if the worker was
      // killed and restarted since the request was opened.
      if (!sender.tab || sender.tab.id !== req.workspaceTabId) {
        sendResponse({ ok: false, error: 'This measurement did not come from the expected TurnKey workspace tab.' });
        return;
      }
      if (req.completed) {
        sendResponse({ ok: false, error: 'This measurement was already sent.' });
        return;
      }
      req.completed = true;
      await savePending();
      try {
        const ack = await chrome.tabs.sendMessage(req.earthTabId, {
          type: 'TK_MEASURE_COMPLETE',
          requestId: msg.requestId,
          category: req.category,
          kind: req.kind,
          result: msg.result
        });
        if (!ack?.ok) throw new Error('The Earth toolbar could not accept this measurement.');
        sendResponse({ ok: true });
        pendingRequests.delete(msg.requestId);
      } catch {
        req.completed = false;
        sendResponse({ ok: false, error: 'The Google Earth toolbar could not accept this measurement. Keep the original Earth tab open and retry.' });
      }
      await savePending();
    })();
    return true;
  }

  return false;
});

// ── 3. Scoped TurnKey API proxy ─────────────────────────────────────────
// Only these named operations are reachable from content scripts/popup —
// deliberately not a generic "fetch this URL"/"run this REST path" proxy.
const API_ACTIONS = new Set([
  'fetchSiteConfig', 'signIn', 'refresh', 'getProfile', 'getBusiness',
  'listCustomers', 'getCustomer', 'createCustomer', 'createQuote', 'createJob',
  'logActivity', 'uploadScreenshotDataUrl'
]);

let client = null;
async function ensureClient() {
  if (client) return client;
  const { config, session } = await Storage.loadAll();
  if (!config) return null;
  client = new TurnKeyClient(config, session, (s) => Storage.setSession(s));
  return client;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.tk_config || changes.tk_session)) client = null;
});

async function handleApiAction(action, args) {
  if (action === 'fetchSiteConfig') return fetchSiteConfig(args[0]);
  const c = await ensureClient();
  if (!c) throw new Error('Not connected to a TurnKey site yet.');
  if (action === 'signIn') {
    const session = await c.signIn(args[0], args[1]);
    await Storage.setSession(session);
    return session;
  }
  if (action === 'uploadScreenshotDataUrl') {
    const [businessId, customerId, jobId, dataUrl] = args;
    return c.uploadScreenshot(businessId, customerId, jobId, dataUrlToBlob(dataUrl));
  }
  return c[action](...args);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'TK_API') return false;
  if (!API_ACTIONS.has(msg.action)) {
    sendResponse({ ok: false, error: 'Unsupported API action.' });
    return false;
  }
  handleApiAction(msg.action, msg.args || [])
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
