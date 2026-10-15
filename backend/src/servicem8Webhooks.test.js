import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseWebhookRequest, processServiceM8Event } from './servicem8Webhooks.js'

describe('parseWebhookRequest', () => {
  test('recognises the verification handshake', () => {
    const r = parseWebhookRequest({ mode: 'subscribe', challenge: 'abc123' })
    assert.equal(r.kind, 'verification')
    assert.equal(r.challenge, 'abc123')
  })

  test('recognises an event payload', () => {
    const r = parseWebhookRequest({
      object: 'job',
      entry: [{ uuid: 'job-uuid-1', changed_fields: ['status'], time: '2026-01-01T00:00:00Z' }],
      resource_url: 'https://api.servicem8.com/api_1.0/job/job-uuid-1.json'
    })
    assert.equal(r.kind, 'event')
    assert.equal(r.object, 'job')
    assert.equal(r.entries.length, 1)
  })

  test('anything else is unknown, not mis-parsed as an event', () => {
    assert.equal(parseWebhookRequest({}).kind, 'unknown')
    assert.equal(parseWebhookRequest(null).kind, 'unknown')
    assert.equal(parseWebhookRequest({ foo: 'bar' }).kind, 'unknown')
  })
})

function baseDeps(overrides = {}) {
  const events = []
  const calls = { onObjectChanged: 0 }
  return {
    events,
    calls,
    deps: {
      recordEvent: async (row) => { const id = 'evt-' + (events.length + 1); events.push({ id, ...row }); return { id } },
      resolveBusinessId: async () => 'biz-1',
      fetchObject: async () => ({ uuid: 'job-uuid-1', status: 'Work Order' }),
      onObjectChanged: async () => { calls.onObjectChanged++ },
      markEventStatus: async (id, status, error) => { const e = events.find((e) => e.id === id); if (e) { e.status = status; e.error = error } },
      ...overrides
    }
  }
}

describe('processServiceM8Event', () => {
  test('happy path: records, resolves, re-fetches, applies, and marks processed', async () => {
    const { deps, events, calls } = baseDeps()
    const result = await processServiceM8Event({
      businessIdHint: null, object: 'job',
      entry: { uuid: 'job-uuid-1', changed_fields: ['status'] },
      resourceUrl: 'https://api.servicem8.com/api_1.0/job/job-uuid-1.json',
      rawPayload: {}, deps
    })
    assert.equal(result.status, 'processed')
    assert.equal(calls.onObjectChanged, 1)
    assert.equal(events[0].status, 'processed')
  })

  test('no connected business for this event — ignored, no side effect applied', async () => {
    const { deps, calls } = baseDeps({ resolveBusinessId: async () => null })
    const result = await processServiceM8Event({ object: 'job', entry: { uuid: 'x' }, rawPayload: {}, deps })
    assert.equal(result.status, 'ignored')
    assert.equal(calls.onObjectChanged, 0)
  })

  test('object missing on re-fetch (deleted) — ignored, not treated as an error', async () => {
    const { deps, calls } = baseDeps({ fetchObject: async () => null })
    const result = await processServiceM8Event({ object: 'job', entry: { uuid: 'x' }, rawPayload: {}, deps })
    assert.equal(result.status, 'ignored')
    assert.equal(calls.onObjectChanged, 0)
  })

  test('a failure applying the change is recorded as failed, not silently dropped', async () => {
    const { deps, events } = baseDeps({ onObjectChanged: async () => { throw new Error('db write failed') } })
    const result = await processServiceM8Event({ object: 'job', entry: { uuid: 'x' }, rawPayload: {}, deps })
    assert.equal(result.status, 'failed')
    assert.equal(events[0].status, 'failed')
    assert.match(events[0].error, /db write failed/)
  })

  test('processing the same event twice (a ServiceM8 redelivery) converges to the same stored state rather than compounding', async () => {
    const store = {}
    const { deps } = baseDeps({
      fetchObject: async () => ({ uuid: 'job-uuid-1', status: 'Work Order' }),
      onObjectChanged: async (businessId, object, record) => { store[record.uuid] = record.status } // overwrite, not append
    })
    await processServiceM8Event({ object: 'job', entry: { uuid: 'job-uuid-1' }, rawPayload: {}, deps })
    await processServiceM8Event({ object: 'job', entry: { uuid: 'job-uuid-1' }, rawPayload: {}, deps })
    assert.equal(store['job-uuid-1'], 'Work Order') // not duplicated, not list-appended
    assert.equal(Object.keys(store).length, 1)
  })
})
