// Content bridge, injected (via chrome.scripting.executeScript, see
// background/service-worker.js) into the TurnKey-hosted measurement
// workspace tab (measure.html) once it finishes loading. Written as a
// plain classic script (no import/export keywords) rather than an ES
// module for two reasons: (1) chrome.scripting.executeScript's `files`
// option runs programmatically-injected scripts as classic scripts, and
// (2) the same file can then be `require()`d directly from a Node test
// without a transpile step — see extension/tests/measure-bridge.test.cjs.
// `geometry.js` (the authoritative measurement math — see its own header,
// owned by a different workstream) is loaded with a real dynamic
// `import()`, which both browsers and Node support from classic/CJS code.
(function (global) {
  'use strict';

  const BRIDGE_SOURCE = 'turnkey-measure-bridge';
  const PAGE_SOURCE = 'turnkey-measure-workspace';
  const MAX_PAYLOAD_BYTES = 200_000; // generous for a few hundred lat/lng points; rejects anything pathological
  const MAX_POINTS = 2000;

  /**
   * Validates a raw `message` event from the page before trusting any of
   * its contents. Returns the parsed finish-request object, or null if the
   * event should be ignored outright (not a message this bridge cares
   * about — NOT the same as "invalid", which is reported back to the page).
   */
  function readFinishEvent(event, { expectedWindow, expectedOrigin } = {}) {
    if (expectedWindow && event.source !== expectedWindow) return null;
    if (expectedOrigin && event.origin !== expectedOrigin) return null;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return null;
    if (msg.source !== PAGE_SOURCE || msg.type !== 'TURNKEY_MEASURE_FINISH') return null;
    return msg;
  }

  const VALID_KINDS = new Set(['area', 'line', 'perimeter']);
  const VALID_MODES = new Set(['ground', 'surface']);

  function validatePayloadShape(msg) {
    if (typeof msg.requestId !== 'string' || !msg.requestId) return 'Missing requestId.';
    if (!VALID_KINDS.has(msg.kind)) return 'Invalid measurement kind.';
    if (typeof msg.category !== 'string' || !msg.category) return 'Missing category.';
    if (!Array.isArray(msg.points)) return 'Missing points.';
    if (msg.points.length < (msg.kind === 'line' ? 2 : 3)) return 'Not enough points.';
    if (msg.points.length > MAX_POINTS) return 'Too many points.';
    for (const p of msg.points) {
      if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return 'Malformed point.';
      if (p.altitude != null && typeof p.altitude !== 'number') return 'Malformed point altitude.';
    }
    try {
      if (JSON.stringify(msg).length > MAX_PAYLOAD_BYTES) return 'Measurement payload too large.';
    } catch {
      return 'Measurement payload could not be serialized.';
    }
    return null;
  }

  /**
   * The workspace page (measure.js) sends its OWN explicit, operator-chosen
   * `mode` — this never infers 'surface' from whether points happen to
   * carry an altitude. A missing/unrecognized mode defaults to 'ground'
   * (the always-safe choice) rather than guessing; geometry.js's own
   * validatePoints() is what actually enforces "every vertex needs a real
   * altitude" if 'surface' was explicitly requested.
   */
  function resolveMode(requestedMode) {
    return VALID_MODES.has(requestedMode) ? requestedMode : 'ground';
  }

  /** requestId -> true once handled, so a duplicate Finish click (double postMessage, or a reloaded page replaying state) can't send the same measurement twice. */
  function createDedupeTracker() {
    const seen = new Set();
    return {
      release(requestId) { seen.delete(requestId); },
      shouldProcess(requestId) {
        if (seen.has(requestId)) return false;
        seen.add(requestId);
        return true;
      }
    };
  }

  async function computeResult(geometryModule, msg) {
    const kind = msg.kind;
    const mode = resolveMode(msg.mode);
    geometryModule.validatePoints(msg.points, { kind, mode });
    return geometryModule.measureGeometry(msg.points, { kind, mode });
  }

  const internals = { readFinishEvent, validatePayloadShape, resolveMode, createDedupeTracker, computeResult };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = internals;
  }

  // ── Real bootstrap — only runs inside an actual extension content-script
  // context (guarded so `require()`-ing this file for unit tests, or
  // loading it in a plain browser tab outside the extension, never
  // attaches live listeners). ─────────────────────────────────────────────
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && typeof window !== 'undefined') {
    // A new document needs a new bridge after refresh; repeated injection
    // into the same document must not install a second Finish listener.
    if (window.__turnkeyMeasureBridgeInstalled) return;
    window.__turnkeyMeasureBridgeInstalled = true;
    const dedupe = createDedupeTracker();

    function postToPage(requestId, type, extra) {
      window.postMessage(Object.assign({ source: BRIDGE_SOURCE, requestId, type }, extra), window.location.origin);
    }

    window.addEventListener('message', async (event) => {
      const msg = readFinishEvent(event, { expectedWindow: window, expectedOrigin: window.location.origin });
      if (!msg) return;

      const validationError = validatePayloadShape(msg);
      if (validationError) {
        postToPage(msg.requestId, 'TURNKEY_MEASURE_ERROR', { message: validationError });
        return;
      }
      if (!dedupe.shouldProcess(msg.requestId)) {
        postToPage(msg.requestId, 'TURNKEY_MEASURE_ERROR', { message: 'This measurement was already sent.' });
        return;
      }

      let geometryModule;
      try {
        geometryModule = await import(chrome.runtime.getURL('geometry.js'));
      } catch (err) {
        dedupe.release(msg.requestId);
        postToPage(msg.requestId, 'TURNKEY_MEASURE_ERROR', {
          message: 'The TurnKey measurement engine is not available in this extension build yet — try again after updating the extension.'
        });
        console.error('[TurnKey] geometry.js failed to load', err);
        return;
      }

      let result;
      try {
        result = await computeResult(geometryModule, msg);
      } catch (err) {
        dedupe.release(msg.requestId);
        postToPage(msg.requestId, 'TURNKEY_MEASURE_ERROR', { message: err.message || 'That trace could not be measured — check for crossed or duplicate points.' });
        return;
      }

      chrome.runtime.sendMessage({ type: 'TK_MEASURE_RESULT', requestId: msg.requestId, result, category: msg.category, kind: msg.kind }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          dedupe.release(msg.requestId);
          postToPage(msg.requestId, 'TURNKEY_MEASURE_ERROR', { message: (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not reach the extension.' });
          return;
        }
        postToPage(msg.requestId, 'TURNKEY_MEASURE_ACK', {});
      });
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
