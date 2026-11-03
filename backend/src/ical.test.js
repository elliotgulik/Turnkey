import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchIcs, pinnedFetch } from './ical.js'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const feed = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:one\r\nSUMMARY:Busy\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'
const publicIp = { address: '93.184.216.34', family: 4 }
const lookup = async (_host, options) => { assert.deepEqual(options, { all: true }); return [publicIp] }
const response = () => new Response(feed)
const options = { lookup, fetch: async () => response() }

test('public HTTPS calendar parses and the socket lookup pins the validated address', async () => {
  let calls = 0
  const events = await fetchIcs('https://calendar.example/feed', { lookup: async (...args) => { calls++; return lookup(...args) }, fetch: async (url, opts) => {
    assert.equal(url, 'https://calendar.example/feed')
    assert.equal(opts.redirect, 'manual')
    assert.ok(opts.signal instanceof AbortSignal)
    assert.deepEqual(await new Promise((resolve, reject) => opts.lookup('calendar.example', { all: true }, (e, a) => e ? reject(e) : resolve(a))), [publicIp])
    assert.deepEqual(await new Promise(resolve => opts.lookup('calendar.example', {}, (e, address, family) => resolve([e, address, family]))), [null, publicIp.address, 4])
    return response()
  } })
  assert.equal(calls, 1)
  assert.equal(events[0].title, 'Busy')
  assert.equal(events[0].start, '2026-11-03T09:00:00.000Z')
})

for (const address of ['127.0.0.1', '127.45.2.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fdff::1', '::ffff:127.0.0.1', '::ffff:a00:1', '::ffff:ac10:1', '::ffff:c0a8:1', '::ffff:a9fe:1', '::ffff:0:0']) {
  test(`rejects private or local address ${address} before fetch`, async () => {
    await assert.rejects(fetchIcs('https://calendar.example/', { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], fetch: async () => assert.fail('must not fetch') }), /not public/)
  })
}

test('all DNS answers must be public', async () => {
  await assert.rejects(fetchIcs('https://calendar.example', { lookup: async () => [publicIp, { address: '10.0.0.1', family: 4 }], fetch: async () => assert.fail() }), /not public/)
})

test('permits public IPv6 and edge IPv4 addresses', async () => {
  for (const address of ['2606:4700:4700::1111', '172.15.1.1', '172.32.1.1', '192.169.1.1']) {
    assert.equal((await fetchIcs('https://calendar.example', { ...options, lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] })).length, 1)
  }
})

test('HTTPS and absence of URL credentials are enforced before DNS', async () => {
  for (const url of ['http://calendar.example/', 'file:///etc/passwd', 'https://user:pass@calendar.example/']) {
    await assert.rejects(fetchIcs(url, { lookup: async () => assert.fail('must not resolve') }), /HTTPS/)
  }
})

test('redirects revalidate the destination and reject private hosts and downgrade', async () => {
  let requests = 0
  await assert.rejects(fetchIcs('https://calendar.example', { lookup: async host => host === 'private.example' ? [{ address: '10.0.0.1', family: 4 }] : [publicIp], fetch: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://private.example/' } }) } }), /not public/)
  assert.equal(requests, 1)
  await assert.rejects(fetchIcs('https://calendar.example', { lookup, fetch: async () => new Response(null, { status: 301, headers: { location: 'http://calendar.example/' } }) }), /HTTPS/)
})

test('allows three redirects, including relative locations, then stops', async () => {
  let requests = 0
  const fetch = async () => ++requests <= 3 ? new Response(null, { status: 307, headers: { location: '/next' } }) : response()
  assert.equal((await fetchIcs('https://calendar.example', { lookup, fetch })).length, 1)
  assert.equal(requests, 4)
  requests = 0
  await assert.rejects(fetchIcs('https://calendar.example', { lookup, fetch: async () => { requests++; return new Response(null, { status: 308, headers: { location: '/next' } }) } }), /Too many/)
  assert.equal(requests, 4)
})

test('bounds streamed bytes and cancels oversized feeds without a content length', async () => {
  let cancelled = false
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } })
  await assert.rejects(fetchIcs('https://calendar.example', { lookup, fetch: async () => new Response(body) }), /2 MB/)
  assert.ok(cancelled)
})

test('rejects an oversized content length and invalid feeds or HTTP errors', async () => {
  for (const res of [new Response(feed, { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }), new Response('not a calendar'), new Response('missing', { status: 404 })]) {
    await assert.rejects(fetchIcs('https://calendar.example', { lookup, fetch: async () => res }), /2 MB|Not a valid|HTTP 404/)
  }
})

test('deadline covers DNS, response headers and the streaming body', async () => {
  const never = () => new Promise(() => {})
  for (const deps of [ { lookup: never, fetch: response }, { lookup, fetch: never }, { lookup, fetch: async () => new Response(new ReadableStream({ pull: never })) } ]) {
    await assert.rejects(fetchIcs('https://calendar.example', { ...deps, timeoutMs: 15 }), /timed out/)
  }
})

test('late DNS results cannot start a connection after timeout', async () => {
  let resolve
  const request = fetchIcs('https://calendar.example', { lookup: () => new Promise(r => { resolve = r }), fetch: async () => assert.fail('late DNS must not connect'), timeoutMs: 10 })
  await assert.rejects(request, /timed out/)
  resolve([publicIp])
  await new Promise(r => setImmediate(r))
})

// Check the production transport, not just the mocked fetch contract: a fresh
// socket retains the original TLS hostname and uses the validated DNS hook.
test('HTTPS transport forwards pinned lookup and disables connection reuse', async t => {
  const controller = new AbortController()
  const pinnedLookup = () => {}
  t.mock.method(https, 'request', (url, options, onResponse) => {
    assert.equal(new URL(url).hostname, 'calendar.example')
    assert.equal(options.lookup, pinnedLookup)
    assert.equal(options.agent, false)
    assert.equal(options.signal, controller.signal)
    const req = new EventEmitter()
    req.end = () => {
      const res = new PassThrough()
      res.statusCode = 200
      res.headers = { 'content-type': 'text/calendar' }
      onResponse(res)
      res.end(feed)
    }
    return req
  })
  syncBuiltinESMExports()
  try {
    const res = await pinnedFetch('https://calendar.example/feed', { lookup: pinnedLookup, signal: controller.signal })
    assert.equal(res.ok, true)
    assert.equal(await new Response(res.body).text(), feed)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})
