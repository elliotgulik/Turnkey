// Customer → Google Earth handoff. Lets the CRM (extension-quote-link.js,
// via the content script extension/content/bridge/customer-launch.js) open
// Google Earth at an EXISTING customer's saved address, with the quote
// panel there pre-bound to that same customer — no re-picking who the
// quote is for, and no customer id/business id/token ever riding along in
// the Earth tab's URL.
//
// Two one-way trips:
//   1. TK_CUSTOMER_LAUNCH (sender = the CRM content script): looks up the
//      authoritative customer record for the SIGNED-IN business, opens a
//      blank tab, stores the verified {businessId, customerId, address} in
//      chrome.storage.session keyed by that tab's id, THEN navigates the
//      tab to the Earth search URL — in that order, so a fast Earth page
//      load can never race ahead of the context it needs (see
//      handleLaunch() below).
//   2. TK_GET_CUSTOMER_CONTEXT (sender = the Earth content panel,
//      content/panel/app.js): returns that context back to the tab that
//      asked for it, and ONLY that tab — never a different tab, never a
//      different business than the one currently signed in.
//
// Same chrome.storage.session-backed-Map pattern as the measurement bridge
// in service-worker.js (MV3 can suspend/restart this worker between any two
// messages); see that file's own comment for why storage.session specifically.
import { TurnKeyClient } from '../api/turnkey-api.js';
import { Storage } from '../api/storage.js';

const EARTH_ORIGIN = 'https://earth.google.com';
const CONTEXT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CONTEXT_KEY = 'tk_pending_customer_context';

// Same allowlist as service-worker.js's BRIDGE_ALLOWED_ORIGINS — the CRM
// origins this extension is actually built to talk to. Kept as its own
// copy (not imported) since the two files guard two different message
// flows and have no other shared dependency; duplicating one short list is
// simpler than introducing a shared-constants module for it.
const CRM_ALLOWED_ORIGINS = new Set([
  'https://turnkeycrm.net',
  'http://localhost',
  'http://localhost:5173',
  'http://localhost:8888',
  'http://127.0.0.1',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8888'
]);

/** earthTabId -> {businessId, customerId, customerName, address, recordId, createdAt} */
export const contexts = new Map();
let loaded = false;
let loadingPromise = null;

async function loadContexts() {
  if (loaded) return;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        const data = await chrome.storage.session.get(CONTEXT_KEY);
        const stored = data[CONTEXT_KEY] || {};
        for (const [id, ctx] of Object.entries(stored)) contexts.set(Number(id), ctx);
      } catch {
        // chrome.storage.session unavailable — context just won't survive a worker restart.
      }
      loaded = true;
    })();
  }
  await loadingPromise;
}

async function saveContexts() {
  try {
    await saveContextsStrict();
  } catch {
    // best-effort for non-critical callers (sweepExpired/onRemoved cleanup)
    // — see loadContexts()'s own catch for why a missing storage.session
    // only costs restart-durability, not correctness, for THOSE callers.
    // handleLaunch() below does NOT use this — it must know if the save
    // failed, since a context that silently never got saved cannot be
    // trusted to still be there once the tab finishes navigating.
  }
}

async function saveContextsStrict() {
  await chrome.storage.session.set({ [CONTEXT_KEY]: Object.fromEntries(contexts) });
}

function originExact(url, expectedOrigin) {
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

async function sweepExpired(now = Date.now()) {
  await loadContexts();
  let changed = false;
  for (const [tabId, ctx] of contexts) {
    if (now - ctx.createdAt > CONTEXT_TTL_MS) {
      contexts.delete(tabId);
      changed = true;
    }
  }
  if (changed) await saveContexts();
}

function crmOriginAllowed(url) {
  try {
    return CRM_ALLOWED_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

async function buildClient() {
  const { config, session } = await Storage.loadAll();
  if (!config) return null;
  return new TurnKeyClient(config, session, (s) => Storage.setSession(s));
}

/**
 * Verifies the signed-in business/customer before anything is opened, so a
 * compromised or stale CRM tab can never trick this worker into handing a
 * foreign business's customer data to a new Earth tab. Only the ADDRESS
 * (never the customer id, business id, or any token) ends up in that tab's
 * URL — see the search URL built below.
 */
async function handleLaunch(msg, sender) {
  if (!sender.tab || !sender.url || !crmOriginAllowed(sender.url)) {
    throw new Error('The Google Earth handoff can only be started from your TurnKey site.');
  }
  const { recordId, customerId, businessId } = msg;
  if (!customerId) throw new Error('This opportunity has no saved customer yet.');
  if (!businessId) throw new Error('Could not determine your signed-in business.');

  const client = await buildClient();
  if (!client) throw new Error('Connect the extension to your TurnKey site first.');
  const profile = await client.getProfile();
  if (!profile || profile.business_id !== businessId) {
    throw new Error('The extension is signed in to a different business than this TurnKey tab — reconnect it and try again.');
  }

  const customer = await client.getCustomer(businessId, customerId);
  if (!customer) throw new Error('This customer could not be found in your TurnKey account.');
  const address = [customer.address, customer.suburb].filter(Boolean).join(', ');
  if (!address) throw new Error('This customer has no saved address yet — add one before using the Google Earth handoff.');

  await sweepExpired();
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  // Store the verified context BEFORE navigating the tab — app.js's own
  // request for this context can land the instant the Earth page starts
  // loading, well before this function returns.
  contexts.set(tab.id, {
    businessId,
    customerId: customer.id,
    customerName: customer.name || '',
    address,
    recordId: recordId != null ? recordId : null,
    createdAt: Date.now()
  });
  try {
    await saveContextsStrict();
  } catch (err) {
    // The context this tab needs to bind to its customer could NOT be
    // durably stored — navigating it to Earth anyway would open a tab that
    // silently falls back to an unbound/generic quote (or, worse, picks up
    // a DIFFERENT tab's leftover context after a worker restart). Closing
    // it and failing loudly is safer than a tab that quietly claims a
    // context it doesn't actually have.
    contexts.delete(tab.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error('Could not prepare the Google Earth handoff (extension storage is unavailable) — please try again.');
  }
  const earthUrl = 'https://earth.google.com/web/search/' + encodeURIComponent(address);
  await chrome.tabs.update(tab.id, { url: earthUrl });
  return { tabId: tab.id };
}

async function handleGetContext(sender) {
  // Exact origin match, not startsWith — `https://earth.google.com.evil.example`
  // starts with EARTH_ORIGIN as a STRING but is a completely different
  // origin, and startsWith would let it through.
  if (!sender.tab || !sender.url || !originExact(sender.url, EARTH_ORIGIN)) return null;
  await sweepExpired();
  const ctx = contexts.get(sender.tab.id);
  if (!ctx) return null;
  const client = await buildClient();
  const profile = client ? await client.getProfile().catch(() => null) : null;
  if (!profile || profile.business_id !== ctx.businessId) return null;
  return {
    businessId: ctx.businessId,
    customerId: ctx.customerId,
    customerName: ctx.customerName,
    address: ctx.address,
    recordId: ctx.recordId
  };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadContexts();
  if (contexts.delete(tabId)) await saveContexts();
});

export function registerCustomerHandoff() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'TK_CUSTOMER_LAUNCH') {
      handleLaunch(msg, sender)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg && msg.type === 'TK_GET_CUSTOMER_CONTEXT') {
      handleGetContext(sender)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  });
}
