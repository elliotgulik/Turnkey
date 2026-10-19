// Content script injected into the TurnKey CRM itself (manifest.json's
// content_scripts entry for the same origins as the rest of this
// extension's host_permissions). Bridges extension-quote-link.js's
// customer-handoff IIFE (which can only talk to this origin's window via
// postMessage — it has no chrome.* APIs of its own) to the background
// worker's TK_CUSTOMER_LAUNCH handler (customer-handoff.js), which is the
// only context allowed to open tabs or read the signed-in TurnKey session.
//
// Written as a plain classic script (no import/export) for the same reason
// as content/bridge/measure-bridge.js: chrome.scripting/content_scripts run
// injected files as classic scripts, and this exact file is `require()`d
// directly from extension/tests/customer-launch.test.cjs without a
// transpile step.
(function (global) {
  'use strict';

  const PAGE_SOURCE = 'turnkey-crm-page';
  const EXT_SOURCE = 'turnkey-customer-launch';
  const CRM_ORIGINS = new Set([
    'https://turnkeycrm.net',
    'http://localhost',
    'http://localhost:5173',
    'http://localhost:8888',
    'http://127.0.0.1',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8888'
  ]);

  function postToPage(type, extra) {
    global.postMessage(Object.assign({ source: EXT_SOURCE, type }, extra), global.location.origin);
  }

  function readPageMessage(event) {
    if (event.source !== global || event.origin !== global.location.origin) return null;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.source !== PAGE_SOURCE) return null;
    return msg;
  }

  const internals = { postToPage, readPageMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = internals;

  // ── Real bootstrap — only inside an actual extension content-script
  // context; see measure-bridge.js's own equivalent guard for why. ───────
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && typeof global.addEventListener === 'function') {
    if (global.__turnkeyCustomerLaunchInstalled) return;
    global.__turnkeyCustomerLaunchInstalled = true;

    // The popup asks the background worker for this through Chrome's
    // extension messaging channel. Never forward the CRM token through
    // window.postMessage, which is observable by page scripts.
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'TK_READ_CRM_AUTH_SESSION' || sender.id !== chrome.runtime.id) return false;
      if (!CRM_ORIGINS.has(global.location.origin) || typeof msg.storageKey !== 'string' ||
          !/^sb-[a-z0-9-]+-auth-token$/.test(msg.storageKey)) {
        sendResponse({ ok: false, error: 'This TurnKey tab cannot be used to connect.' });
        return false;
      }
      try {
        const raw = global.localStorage.getItem(msg.storageKey);
        const session = raw ? JSON.parse(raw) : null;
        if (!session || typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') {
          sendResponse({ ok: false, error: 'No active TurnKey sign-in was found in this tab. Sign in and try again.' });
          return false;
        }
        sendResponse({ ok: true, session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at
        } });
      } catch {
        sendResponse({ ok: false, error: 'Could not read the TurnKey sign-in from this tab.' });
      }
      return false;
    });

    global.addEventListener('message', (event) => {
      const msg = readPageMessage(event);
      if (!msg) return;

      if (msg.type === 'TK_HELLO') {
        postToPage('TK_READY', { nonce: msg.nonce || null, version: chrome.runtime.getManifest().version });
        return;
      }

      if (msg.type === 'TK_LAUNCH') {
        const nonce = msg.nonce;
        if (typeof nonce !== 'string' || !nonce) return;
        chrome.runtime.sendMessage(
          { type: 'TK_CUSTOMER_LAUNCH', recordId: msg.recordId, jobId: msg.jobId, customerId: msg.customerId, businessId: msg.businessId },
          (res) => {
            if (chrome.runtime.lastError) {
              postToPage('TK_LAUNCH_ERROR', { nonce, error: chrome.runtime.lastError.message });
              return;
            }
            if (!res || !res.ok) {
              postToPage('TK_LAUNCH_ERROR', { nonce, error: (res && res.error) || 'Could not open Google Earth.' });
              return;
            }
            postToPage('TK_LAUNCH_ACK', { nonce });
          }
        );
      }
    });

    // Broadcast presence/version immediately on load too (nonce:null) — the
    // CRM page's readiness check doesn't have to send TK_HELLO and wait for
    // a page that's already here; it just needs to have seen one TK_READY
    // at all before it tries a TK_LAUNCH.
    postToPage('TK_READY', { nonce: null, version: chrome.runtime.getManifest().version });
  }
})(typeof window !== 'undefined' ? window : globalThis);
