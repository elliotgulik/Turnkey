import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import { Readable, Writable } from 'node:stream'
import * as gmail from './providers/gmail.js'

// Load isolated production blocks without booting the server or its pollers.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
function block(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) }
function run(code, deps = {}) {
  return vm.runInNewContext(code, { Buffer, URL, AbortController, setTimeout, clearTimeout, console, process: { env: {} }, ...deps })
}
const result = () => ({ code: 200, headers: {}, status(n) { this.code = n; return this }, set(k, v) { this.headers[k] = v; return this }, json(body) { this.body = body; return this } })
const auth = () => {}
const rateCode = block('function rateLimit(', 'const leadsRateLimit')

test('private CORS accepts only allowed browser origins; public webhooks and no-Origin clients work', async () => {
  let middleware
  run(block('const frontendOrigin', '// Parse Wix'), { cors, app: { use(fn) { middleware = fn } } })
  for (const [path, origin, allowed] of [
    ['/api/email/send', 'https://turnkeycrm.net', true],
    ['/api/email/send', 'http://localhost:5173', true],
    ['/api/email/send', 'chrome-extension://' + 'a'.repeat(32), true],
    ['/api/email/send', undefined, true],
    ['/api/health', undefined, true],
    ['/api/email/send', 'https://evil.example', false],
    ['/api/email/send', 'http://localhost.evil.example:5173', false],
    ['/api/email/send', 'https://turnkeycrm.net.evil.example', false],
    ['/api/email/send', 'null', false],
    ...['/api/leads', '/api/leads/meta', '/api/leads/wix/token', '/api/notifications/quote-viewed', '/api/payments/webhook', '/api/servicem8/webhook/account'].map(p => [p, 'https://public-booking.example', true]),
    ['/api/servicem8/config', 'https://public-booking.example', false]
  ]) {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, getHeader(k) { return this.headers[k.toLowerCase()] } }
    let next = false
    middleware({ path, method: 'GET', headers: { origin } }, res, () => { next = true })
    assert.ok(next, path)
    assert.equal(!!res.headers['access-control-allow-origin'], !!origin && allowed, path + ' ' + origin)
  }
})

test('automation credentials come only from the header and handle differing byte lengths', async () => {
  const gate = block("  const cronKey = process.env.AUTOMATION_CRON_KEY", '  try {')
  const handler = run('(req,res)=>{' + gate + ';return res.json({accepted:true})}', { crypto, process: { env: { AUTOMATION_CRON_KEY: 'correct-key' } } })
  for (const [header, query, expected] of [[undefined, 'correct-key', 401], ['wrong', 'correct-key', 401], ['é'.repeat(11), undefined, 401], ['correct-key', undefined, 200]]) {
    const res = result()
    handler({ get: () => header, query: { key: query } }, res)
    assert.equal(res.code, expected)
    assert.equal(res.body.accepted, expected === 200 ? true : undefined)
  }
})

test('marketing limit shares a quota across staff in one business and isolates other businesses', () => {
  let now = 1000
  const limiter = run(rateCode + ';rateLimit({windowMs:3600000,max:20,key:req=>req.businessId})', { Date: { now: () => now } })
  const hit = (businessId, ip) => { const res = result(); limiter({ businessId, ip }, res, () => { res.passed = true }); return res }
  for (let i = 0; i < 20; i++) assert.ok(hit('one', 'ip-' + i).passed)
  assert.equal(hit('one', 'fresh-ip').code, 429)
  assert.ok(hit('two', 'ip-1').passed)
  now += 3600001
  assert.ok(hit('one', 'ip-1').passed)
})

test('marketing denies technicians and foreign users, permits managers, and bounds model input', async () => {
  let handler, sent
  const make = role => run(rateCode + block('const ANTHROPIC_API_KEY', 'installSalesPlatform(app'), {
    process: { env: { ANTHROPIC_API_KEY: 'test' } }, requireBusiness: auth,
    app: { post(_path, _auth, _limit, fn) { handler = fn } },
    authClient: { from(table) { assert.equal(table, 'users'); const q = { select() { return q }, eq(k, v) { assert.ok((k === 'id' && v === 'staff') || (k === 'business_id' && v === 'mine')); return q }, maybeSingle: async () => ({ data: role ? { role } : null }) }; return q } },
    fetch: async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ text: 'copy' }] }) } }
  })
  for (const role of ['technician', null, 'manager', 'owner']) {
    sent = null; make(role)
    const res = result()
    await handler({ userId: 'staff', businessId: 'mine', body: { contentType: 'x'.repeat(200), businessContext: 'y'.repeat(5000) } }, res)
    assert.equal(res.code, ['owner', 'manager'].includes(role) ? 200 : 403)
    if (sent) {
      const message = sent.messages[0].content
      assert.ok(message.endsWith('Write a: ' + 'x'.repeat(100)))
      assert.ok(message.length < 4200)
    }
  }
})

function tokenHelper({ refreshError, status = 'ok' } = {}) {
  const writes = [], filters = []
  const acct = { id: 'mailbox', status, access_token_enc: 'old-token', refresh_token_enc: 'refresh', token_expiry: new Date(0).toISOString() }
  const helper = run(block('async function getValidAccessToken', "app.get('/api/email/oauth/start'") + ';getValidAccessToken', {
    PROVIDERS: { gmail: { refreshAccessToken: async () => { if (refreshError) throw refreshError; return { access_token: 'new-token', expires_in: 3600 } } } },
    encryptToken: s => s, decryptToken: s => s,
    authClient: { from(table) { assert.equal(table, 'email_accounts'); const q = { select() { return q }, update(data) { writes.push(data); return q }, eq(k, v) { filters.push([k, v]); return q }, maybeSingle: async () => ({ data: acct }), then(resolve) { return Promise.resolve({ error: null }).then(resolve) } }; return q } }
  })
  return { helper, writes, filters }
}

test('Gmail invalid_grant and HTTP 401 persist scoped reconnect status and return null', async () => {
  for (const refreshError of [new Error('Gmail token refresh failed: {"error":"invalid_grant"}'), Object.assign(new Error('unauthorized'), { status: 401 })]) {
    const { helper, writes, filters } = tokenHelper({ refreshError })
    assert.equal(await helper('biz', 'staff', 'gmail'), null)
    assert.equal(writes[0].status, 'needs_reconnect')
    assert.ok(filters.some(([k, v]) => k === 'id' && v === 'mailbox'))
    assert.ok(filters.some(([k, v]) => k === 'business_id' && v === 'biz'))
  }
})

test('Gmail temporary failures remain retryable; successful refresh and reconnect state behave correctly', async () => {
  const error = Object.assign(new Error('temporary outage'), { status: 503 })
  const failed = tokenHelper({ refreshError: error })
  await assert.rejects(failed.helper('biz', 'staff', 'gmail'), /temporary outage/)
  assert.equal(failed.writes.length, 0)
  const reconnect = tokenHelper({ status: 'needs_reconnect' })
  assert.equal(await reconnect.helper('biz', 'staff', 'gmail'), null)
  assert.equal(reconnect.writes.length, 0)
  const success = tokenHelper()
  assert.equal((await success.helper('biz', 'staff', 'gmail')).accessToken, 'new-token')
})

test('Gmail provider preserves HTTP 401 independently of error body', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }))
  await assert.rejects(gmail.refreshAccessToken('test'), error => error.status === 401)
})

// Exercise the real Express body parsers using streams, without listening on a port.
async function parseRequest(app, path, body) {
  const req = Readable.from([Buffer.from(body)])
  Object.assign(req, { method: 'POST', url: path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, socket: {} })
  const res = new Writable({ write(_chunk, _encoding, cb) { cb() } })
  res.setHeader = () => {}; res.getHeader = () => undefined
  return new Promise(resolve => app.handle(req, res, error => resolve({ error, req })))
}

test('body parsing allows large legitimate uploads only and retains raw bytes for signatures', async () => {
  const app = express()
  run(block('const rawBody =', '// Lightweight in-memory'), { app, express })
  const body = JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) })
  for (const path of ['/api/leads', '/api/email/send']) {
    const { error, req } = await parseRequest(app, path, body)
    assert.equal(error, undefined)
    assert.equal(req.rawBody.toString(), body)
    assert.equal(req.body.data.length, 1024 * 1024 + 1)
  }
  for (const path of ['/api/payments/webhook', '/api/leads/meta', '/api/ai/marketing', '/api/email/disconnect']) {
    assert.equal((await parseRequest(app, path, body)).error.status, 413)
  }
  const small = await parseRequest(app, '/api/payments/webhook', '{"type":"event"}')
  assert.equal(small.req.rawBody.toString(), '{"type":"event"}')
})

test('deep health requires business auth; plain health stays public and checks are bounded', async () => {
  let gate, handler, authenticated = 0, aborted = false
  run(block('// Deep checks', '// The old whole-app'), {
    app: { get(_path, middleware, fn) { gate = middleware; handler = fn } }, STORAGE: 'file',
    requireBusiness(_req, _res, next) { authenticated++; next() },
    gmail: { isConfigured: () => true }, googleCalendar: { isConfigured: () => false }, isMetaConfigured: () => true, isStripeConfigured: () => false,
    process: { env: { EMAIL_TOKEN_KEY: 'configured' } },
    // Accelerate the production timeout for this test.
    setTimeout: (fn, ms) => { assert.equal(ms, 3000); return setTimeout(fn, 10) },
    authClient: { from(table) { assert.equal(table, 'businesses'); const q = { select() { return q }, eq(k, v) { assert.equal(k, 'id'); assert.equal(v, 'biz'); return q }, abortSignal(signal) { signal.addEventListener('abort', () => { aborted = true }); return q }, maybeSingle: () => new Promise(() => {}) }; return q } }
  })
  gate({ query: {} }, result(), () => {})
  assert.equal(authenticated, 0)
  const plain = result()
  await handler({ query: {} }, plain)
  assert.equal(plain.body.ok, true)
  gate({ query: { deep: '1' } }, result(), () => {})
  assert.equal(authenticated, 1)
  const deep = result()
  await handler({ query: { deep: '1' }, businessId: 'biz' }, deep)
  assert.deepEqual(JSON.parse(JSON.stringify(deep.body)), { supabase: false, gmail: true, calendar: false, meta: true, stripe: false })
  assert.ok(aborted)
})
