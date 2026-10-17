// Tests that fetchSiteConfig() (extension/api/turnkey-api.js) parses
// config.js with allowlisted regexes only — never `eval`/`new Function` —
// which matters both because Manifest V3's extension-pages CSP forbids
// both outright, and because a malicious/compromised "TurnKey site" at a
// URL the operator was tricked into entering must not get arbitrary code
// execution inside the extension just by serving a crafted config.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

async function loadModule() {
  return import(path.join(__dirname, '..', 'api', 'turnkey-api.js'));
}

function mockFetchOnce(body, ok = true, status = 200) {
  global.fetch = async () => ({ ok, status, text: async () => body });
}

test('fetchSiteConfig extracts the known fields from a real-shaped config.js', async () => {
  const { fetchSiteConfig } = await loadModule();
  mockFetchOnce(`window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || {
    backendUrl: 'https://turnkey-backend.onrender.com',
    supabaseUrl: 'https://abc123.supabase.co',
    supabaseAnonKey: 'anon-key-value',
    mapsKey: 'maps-key-value',
  };`);
  const cfg = await fetchSiteConfig('https://example.netlify.app/');
  assert.equal(cfg.siteUrl, 'https://example.netlify.app');
  assert.equal(cfg.supabaseUrl, 'https://abc123.supabase.co');
  assert.equal(cfg.supabaseAnonKey, 'anon-key-value');
  assert.equal(cfg.mapsKey, 'maps-key-value');
  assert.equal(cfg.backendUrl, 'https://turnkey-backend.onrender.com');
});

test('fetchSiteConfig rejects a response with no TURNKEY_CONFIG at all', async () => {
  const { fetchSiteConfig } = await loadModule();
  mockFetchOnce('export default function notConfig() {}');
  await assert.rejects(() => fetchSiteConfig('https://not-turnkey.example'), /does not look like a TurnKey deployment/);
});

test('fetchSiteConfig rejects a config missing supabaseUrl/supabaseAnonKey', async () => {
  const { fetchSiteConfig } = await loadModule();
  mockFetchOnce(`window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || { backendUrl: 'https://x.example' };`);
  await assert.rejects(() => fetchSiteConfig('https://example.netlify.app'), /missing supabaseUrl\/supabaseAnonKey/);
});

test('fetchSiteConfig propagates a non-OK HTTP response as an error, not a parse attempt', async () => {
  const { fetchSiteConfig } = await loadModule();
  mockFetchOnce('', false, 404);
  await assert.rejects(() => fetchSiteConfig('https://example.netlify.app'), /HTTP 404/);
});

test('fetchSiteConfig never executes a malicious config.js payload (no eval/new Function)', async () => {
  const { fetchSiteConfig } = await loadModule();
  global.__tkPwned = false;
  // A config.js that would run arbitrary code if this were ever parsed
  // with eval()/new Function() instead of regex extraction.
  mockFetchOnce(`window.TURNKEY_CONFIG = window.TURNKEY_CONFIG || {
    supabaseUrl: 'https://real.supabase.co',
    supabaseAnonKey: 'real-anon-key' + (globalThis.__tkPwned = true, ''),
  };`);
  const cfg = await fetchSiteConfig('https://malicious.example');
  // The regex only captures the literal quoted string up to the closing
  // quote — the trailing `+ (...)` expression is just inert trailing text
  // to a regex-based extractor, never executed.
  assert.equal(cfg.supabaseAnonKey, 'real-anon-key');
  assert.equal(global.__tkPwned, false, 'malicious config.js source must never be executed');
  delete global.__tkPwned;
});

test('turnkey-api.js source contains no eval()/new Function() call', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'turnkey-api.js'), 'utf8');
  assert.doesNotMatch(src, /\bnew Function\s*\(/);
  assert.doesNotMatch(src, /(?<![.\w])eval\s*\(/);
});
