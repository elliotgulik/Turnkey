import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStorage } from './supabase.js'

// A minimal fake of the one chain shape addLead() actually calls:
//   .from('leads').insert(row).select(cols).single()
//   .from('leads').select(cols).eq().eq().eq().maybeSingle()   (dedupe fallback)
// Configured with canned responses consumed in call order, so each test
// can simulate exactly the Postgres behavior it's exercising (a clean
// insert, a 23505 unique-violation redelivery, or a genuine failure)
// without a real database.
function fakeClient({ insertResponses = [], selectResponses = [] } = {}) {
  let insertIdx = 0
  let selectIdx = 0
  const insertCalls = []
  const selectCalls = []
  return {
    from(table) {
      return {
        insert(row) {
          insertCalls.push({ table, row })
          return {
            select() {
              return {
                async single() {
                  return insertResponses[insertIdx++] ?? { data: null, error: new Error('no insert response configured for this call') }
                }
              }
            }
          }
        },
        select(cols) {
          selectCalls.push({ table, cols })
          const chain = {
            eq() { return chain },
            async maybeSingle() {
              return selectResponses[selectIdx++] ?? { data: null, error: null }
            }
          }
          return chain
        }
      }
    },
    calls: { insertCalls, selectCalls }
  }
}

describe('createSupabaseStorage().addLead', () => {
  test('a clean insert returns the new row, untouched', async () => {
    const client = fakeClient({
      insertResponses: [{ data: { id: 'lead-1', payload: { customer: { name: 'A' } }, created_at: '2026-01-01T00:00:00Z' }, error: null }]
    })
    const storage = createSupabaseStorage('url', 'key', { client })
    const lead = await storage.addLead({ business_id: 'biz-1', customer: { name: 'A' } })
    assert.equal(lead.id, 'lead-1')
    assert.equal(lead.deduped, undefined)
  })

  test('source/external_id are passed through as real columns for webhook-sourced leads', async () => {
    const client = fakeClient({
      insertResponses: [{ data: { id: 'lead-1', payload: {}, created_at: '2026-01-01T00:00:00Z' }, error: null }]
    })
    const storage = createSupabaseStorage('url', 'key', { client })
    await storage.addLead({ business_id: 'biz-1', customer: { name: 'A' }, source: 'wix', external_id: 'sub-42' })
    assert.equal(client.calls.insertCalls[0].row.source, 'wix')
    assert.equal(client.calls.insertCalls[0].row.external_id, 'sub-42')
  })

  test('a redelivered webhook event (unique violation on business_id+source+external_id) is deduped, not duplicated', async () => {
    const existing = { id: 'lead-1', payload: { customer: { name: 'A' } }, created_at: '2026-01-01T00:00:00Z' }
    const client = fakeClient({
      insertResponses: [{ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }],
      selectResponses: [{ data: existing, error: null }]
    })
    const storage = createSupabaseStorage('url', 'key', { client })
    const lead = await storage.addLead({ business_id: 'biz-1', customer: { name: 'A' }, source: 'wix', external_id: 'sub-42' })
    assert.equal(lead.id, 'lead-1')
    assert.equal(lead.deduped, true)
    assert.equal(client.calls.insertCalls.length, 1) // only ever attempted once — no retry loop
  })

  test('a unique violation with no external_id (the plain public-booking path) is NOT treated as dedupeable — it throws', async () => {
    const client = fakeClient({
      insertResponses: [{ data: null, error: { code: '23505', message: 'some unrelated constraint' } }]
    })
    const storage = createSupabaseStorage('url', 'key', { client })
    await assert.rejects(
      () => storage.addLead({ business_id: 'biz-1', customer: { name: 'A' } }), // no source/external_id
      (err) => err.code === '23505'
    )
    assert.equal(client.calls.selectCalls.length, 0) // never attempted the dedupe fallback lookup
  })

  test('a unique violation whose fallback lookup also comes up empty still throws, rather than silently swallowing the lead', async () => {
    const client = fakeClient({
      insertResponses: [{ data: null, error: { code: '23505', message: 'duplicate key' } }],
      selectResponses: [{ data: null, error: null }]
    })
    const storage = createSupabaseStorage('url', 'key', { client })
    await assert.rejects(
      () => storage.addLead({ business_id: 'biz-1', customer: { name: 'A' }, source: 'wix', external_id: 'sub-42' }),
      (err) => err.code === '23505'
    )
  })

  test('a genuine database failure (not a unique violation) propagates as a rejected promise', async () => {
    const client = fakeClient({
      insertResponses: [{ data: null, error: { code: '57P03', message: 'cannot connect now' } }]
    })
    const storage = createSupabaseStorage('url', 'key', { client })
    await assert.rejects(
      () => storage.addLead({ business_id: 'biz-1', customer: { name: 'A' }, source: 'wix', external_id: 'sub-42' }),
      (err) => err.code === '57P03'
    )
  })
})
