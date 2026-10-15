import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { hashWixToken, generateWixToken, mapWixPayload, handleWixLead } from './wixLeads.js'

describe('hashWixToken / generateWixToken', () => {
  test('hashing is deterministic', () => {
    assert.equal(hashWixToken('abc'), hashWixToken('abc'))
  })
  test('different tokens hash differently', () => {
    assert.notEqual(hashWixToken('abc'), hashWixToken('xyz'))
  })
  test('generated tokens are unique and reasonably long', () => {
    const a = generateWixToken()
    const b = generateWixToken()
    assert.notEqual(a, b)
    assert.ok(a.length >= 24)
  })
})

describe('mapWixPayload', () => {
  test('maps a flat payload', () => {
    const c = mapWixPayload({ name: 'Jane Doe', email: 'jane@example.com', phone: '0211234567', address: '1 Test St' })
    assert.equal(c.name, 'Jane Doe')
    assert.equal(c.email, 'jane@example.com')
    assert.equal(c.source, 'Wix')
  })
  test('maps a nested data.* payload', () => {
    const c = mapWixPayload({ data: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' } })
    assert.equal(c.name, 'Jane Doe')
    assert.equal(c.email, 'jane@example.com')
  })
  test('falls back to a placeholder name rather than throwing on an unrecognised shape', () => {
    const c = mapWixPayload({ someWeirdField: 'whatever' })
    assert.equal(c.name, 'Wix lead')
  })
})

describe('handleWixLead', () => {
  const okSource = { business_id: 'biz-123' }

  test('valid submission is saved via addLead and returns 201', async () => {
    const addLeadCalls = []
    const result = await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe', email: 'jane@example.com' },
      lookupSource: async () => okSource,
      addLead: async (payload) => { addLeadCalls.push(payload); return { id: 'lead-1' } }
    })
    assert.equal(result.status, 201)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.id, 'lead-1')
    assert.equal(addLeadCalls.length, 1)
    assert.equal(addLeadCalls[0].business_id, 'biz-123')
    assert.equal(addLeadCalls[0].source, 'wix')
    assert.equal(addLeadCalls[0].customer.name, 'Jane Doe')
  })

  test('missing token is rejected before any lookup', async () => {
    let lookupCalled = false
    const result = await handleWixLead({
      token: '',
      body: { name: 'Jane' },
      lookupSource: async () => { lookupCalled = true; return okSource },
      addLead: async () => { throw new Error('should not be called') }
    })
    assert.equal(result.status, 400)
    assert.equal(lookupCalled, false)
  })

  test('unknown/revoked token returns 404 and never calls addLead', async () => {
    let addLeadCalled = false
    const result = await handleWixLead({
      token: 'revoked-token',
      body: { name: 'Jane' },
      lookupSource: async () => null,
      addLead: async () => { addLeadCalled = true; return { id: 'x' } }
    })
    assert.equal(result.status, 404)
    assert.equal(addLeadCalled, false)
  })

  test('invalid field data (malformed email) is rejected with 400, same validator as the public route', async () => {
    let addLeadCalled = false
    const result = await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe', email: 'not-an-email' },
      lookupSource: async () => okSource,
      addLead: async () => { addLeadCalled = true; return { id: 'x' } }
    })
    assert.equal(result.status, 400)
    assert.match(result.body.error, /email/i)
    assert.equal(addLeadCalled, false)
  })

  test('duplicate delivery (addLead reports deduped) is still a 201 but flagged so the caller skips re-notifying', async () => {
    const result = await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe', submissionId: 'sub-1' },
      lookupSource: async () => okSource,
      addLead: async () => ({ id: 'lead-1', deduped: true })
    })
    assert.equal(result.status, 201)
    assert.equal(result.deduped, true)
  })

  test('a spoofed business_id in the request body is ignored — business_id always comes from lookupSource', async () => {
    const addLeadCalls = []
    await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe', business_id: 'biz-evil-attacker-supplied' },
      lookupSource: async () => ({ business_id: 'biz-real-owner' }),
      addLead: async (payload) => { addLeadCalls.push(payload); return { id: 'lead-1' } }
    })
    assert.equal(addLeadCalls[0].business_id, 'biz-real-owner')
  })

  test('two different tokens for two different businesses never cross-map', async () => {
    const sourcesByHash = {
      [hashWixToken('token-for-biz-a')]: { business_id: 'biz-a' },
      [hashWixToken('token-for-biz-b')]: { business_id: 'biz-b' }
    }
    const lookupSource = async (hash) => sourcesByHash[hash] || null
    const addLeadCalls = []
    const addLead = async (payload) => { addLeadCalls.push(payload); return { id: 'lead-' + addLeadCalls.length } }

    await handleWixLead({ token: 'token-for-biz-a', body: { name: 'A' }, lookupSource, addLead })
    await handleWixLead({ token: 'token-for-biz-b', body: { name: 'B' }, lookupSource, addLead })

    assert.equal(addLeadCalls[0].business_id, 'biz-a')
    assert.equal(addLeadCalls[1].business_id, 'biz-b')
  })

  test('a database failure during the business lookup surfaces as a 500, not a silent miss', async () => {
    const result = await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe' },
      lookupSource: async () => { throw new Error('connection timeout') },
      addLead: async () => ({ id: 'x' })
    })
    assert.equal(result.status, 500)
    assert.ok(result.cause instanceof Error)
  })

  test('a database failure while saving the lead surfaces as a 500', async () => {
    const result = await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe' },
      lookupSource: async () => okSource,
      addLead: async () => { throw new Error('insert failed') }
    })
    assert.equal(result.status, 500)
    assert.ok(result.cause instanceof Error)
  })
})
