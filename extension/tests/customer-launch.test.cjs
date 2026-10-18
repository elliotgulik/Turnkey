// Tests the content script extension/content/bridge/customer-launch.js in
// isolation: it only acts on same-window/same-origin messages from the CRM
// page, answers TK_HELLO with TK_READY (echoing the nonce), and forwards
// TK_LAUNCH to the background worker via chrome.runtime.sendMessage,
// relaying the ack/error straight back to the page with the SAME nonce.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadBridge({ onSendMessage } = {}) {
  const posted = [];
  const listeners = [];
  const fakeWindow = {
    location: { origin: 'https://turnkeycrm.net' },
    postMessage: (msg, origin) => posted.push({ msg, origin }),
    addEventListener: (name, fn) => { if (name === 'message') listeners.push(fn); }
  };
  global.chrome = {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '0.2.2' }),
      sendMessage: (msg, cb) => (onSendMessage || (() => cb({ ok: true })))(msg, cb)
    }
  };
  delete require.cache[path.join(__dirname, '..', 'content', 'bridge', 'customer-launch.js')];
  const origWindow = global.window;
  global.window = fakeWindow;
  require('../content/bridge/customer-launch.js');
  global.window = origWindow;
  return { posted, emit: (data, overrides = {}) => listeners.forEach((fn) => fn(Object.assign({ source: fakeWindow, origin: 'https://turnkeycrm.net', data }, overrides))) };
}

test('broadcasts TK_READY on load, with the extension version and no nonce', () => {
  const { posted } = loadBridge();
  const ready = posted.find((p) => p.msg.type === 'TK_READY');
  assert.ok(ready);
  assert.equal(ready.msg.version, '0.2.2');
  assert.equal(ready.msg.nonce, null);
});

test('ignores a message from a different window (not the page itself)', () => {
  const { posted, emit } = loadBridge();
  posted.length = 0;
  emit({ source: 'turnkey-crm-page', type: 'TK_HELLO', nonce: 'n1' }, { source: {} });
  assert.equal(posted.length, 0);
});

test('ignores a message not sourced from the CRM page', () => {
  const { posted, emit } = loadBridge();
  posted.length = 0;
  emit({ source: 'someone-else', type: 'TK_HELLO', nonce: 'n1' });
  assert.equal(posted.length, 0);
});

test('TK_HELLO gets a TK_READY echoing the same nonce', () => {
  const { posted, emit } = loadBridge();
  posted.length = 0;
  emit({ source: 'turnkey-crm-page', type: 'TK_HELLO', nonce: 'abc' });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.type, 'TK_READY');
  assert.equal(posted[0].msg.nonce, 'abc');
});

test('TK_LAUNCH forwards to the background worker and relays TK_LAUNCH_ACK with the same nonce', () => {
  const { posted, emit } = loadBridge({ onSendMessage: (msg, cb) => cb({ ok: true }) });
  posted.length = 0;
  emit({ source: 'turnkey-crm-page', type: 'TK_LAUNCH', nonce: 'n9', recordId: 1, customerId: 'cust1', businessId: 'biz1' });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.type, 'TK_LAUNCH_ACK');
  assert.equal(posted[0].msg.nonce, 'n9');
});

test('TK_LAUNCH relays a background error as TK_LAUNCH_ERROR with the same nonce, not a silent failure', () => {
  const { posted, emit } = loadBridge({ onSendMessage: (msg, cb) => cb({ ok: false, error: 'no customer' }) });
  posted.length = 0;
  emit({ source: 'turnkey-crm-page', type: 'TK_LAUNCH', nonce: 'n5', recordId: 1, customerId: 'cust1', businessId: 'biz1' });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.type, 'TK_LAUNCH_ERROR');
  assert.equal(posted[0].msg.nonce, 'n5');
  assert.equal(posted[0].msg.error, 'no customer');
});

test('TK_LAUNCH without a nonce is ignored outright', () => {
  const { posted, emit } = loadBridge();
  posted.length = 0;
  emit({ source: 'turnkey-crm-page', type: 'TK_LAUNCH', recordId: 1, customerId: 'cust1', businessId: 'biz1' });
  assert.equal(posted.length, 0);
});
