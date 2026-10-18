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
          { type: 'TK_CUSTOMER_LAUNCH', recordId: msg.recordId, customerId: msg.customerId, businessId: msg.businessId },
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
