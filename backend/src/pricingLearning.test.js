import test from 'node:test'
import assert from 'node:assert/strict'
import createPricingLearningRouter, { createPricingLearningRouter as named } from './pricingLearning.js'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const line = { lineKey: 'roof-0', svc: 'roof', unit: 'm²', quantity: 100, baselinePrice: 130,
  chosenPrice: 115, reason: 'pricing_correction', storeys: 1, access: 'hard' }
const payload = () => ({ quoteKey: 'quote:1', jobId: id(2), lines: [{ ...line }],
  context: { estimatedCost: 50, estimatedDurationMin: 40, travelKm: 10, travelMins: 20, targetMargin: .55, gstRegistered: true } })
function dbFor() {
  const p = payload()
  const tables = { users: [{ id: id(1), business_id: 'a', role: 'owner' }],
    jobs: [{ id: id(2), business_id: 'a', status: 'quoted', details: { total: 115, services: [{ svc: 'roof', qty: 100, fixedPrice: 100 }], quoteLearning: structuredClone(p) } }],
    pricing_learning_settings: [], pricing_learning_observations: [], job_work_logs: [], quotes: [] }
  const db = { tables, fail: null, writes: [], from(table) {
    let op = 'select', value, options, one = false, bounds, filters = []
    const q = {
      select() { return q }, eq(k, v) { filters.push(r => r[k] === v); return q },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return q }, order() { return q },
      range(a, b) { bounds = [a, b]; return q }, maybeSingle() { one = true; return q },
      upsert(v, opts) { op = 'upsert'; value = v; options = opts; return q },
      delete() { op = 'delete'; return q }, then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (db.fail?.table === table && (!db.fail.op || db.fail.op === op)) return { error: { code: db.fail.code || 'XX000', message: 'private db secret' } }
          let rows = tables[table].filter(r => filters.every(f => f(r)))
          if (op === 'upsert') {
            db.writes.push({ table, options })
            for (const v of Array.isArray(value) ? value : [value]) {
              const keys = options.onConflict.split(',')
              const existing = tables[table].find(r => keys.every(k => r[k] === v[k]))
              if (existing && !options.ignoreDuplicates) Object.assign(existing, structuredClone(v))
              if (!existing) tables[table].push({ id: id(100 + tables[table].length), ...structuredClone(v) })
            }
          }
          if (op === 'delete') tables[table] = tables[table].filter(r => !rows.includes(r))
          if (bounds) rows = rows.slice(bounds[0], bounds[1] + 1)
          return { data: one ? rows[0] || null : structuredClone(rows), error: null }
        }).then(resolve, reject)
      }
    }
    return q
  } }
  return db
}
// Exercise the actual Express router/middleware without binding a network port.
async function request(db, method, path, body, { businessId = 'a', userId = id(1) } = {}) {
  const router = createPricingLearningRouter({ db, requireBusiness(req, res, next) { req.businessId = businessId; req.userId = userId; next() } })
  return new Promise((resolve, reject) => {
    const req = { method, url: path, headers: {}, body }
    const res = { statusCode: 200, set() { return this }, status(n) { this.statusCode = n; return this },
      json(data) { resolve({ status: this.statusCode, body: data }) } }
    router.handle(req, res, e => e ? reject(e) : reject(new Error('No route response')))
  })
}
test('default and named factory match; defaults returned without storing settings', async () => {
  assert.equal(createPricingLearningRouter, named)
  const db = dbFor(), r = await request(db, 'GET', '/state')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { settings: { enabled: true, minSamples: 5, maxAdjustment: .25 }, observations: [], modelVersion: 1 })
})
test('authoritative allocated snapshot permits access premiums and preserves jobs', async () => {
  const db = dbFor(), before = structuredClone(db.tables.jobs)
  const r = await request(db, 'POST', '/observations', payload())
  assert.equal(r.status, 200)
  assert.deepEqual(db.tables.jobs, before)
  const row = db.tables.pricing_learning_observations[0]
  assert.equal(row.chosen_price, 115)
  assert.equal(row.business_id, 'a')
  assert.equal(row.context.estimatedCost, 50)
  assert.equal(row.context.estimatedDurationMin, 40)
  assert.equal(db.writes[0].options.onConflict, 'business_id,quote_key,line_key')
})
test('retries and concurrent submissions upsert once', async () => {
  const db = dbFor()
  const results = await Promise.all(Array.from({ length: 8 }, () => request(db, 'POST', '/observations', payload())))
  assert.ok(results.every(r => r.status === 200))
  assert.equal(db.tables.pricing_learning_observations.length, 1)
})
test('saved revisions update one quote-line decision and blank reasons remain excluded', async () => {
  const db = dbFor(), b = payload()
  await request(db, 'POST', '/observations', b)
  b.lines[0].chosenPrice = 120; b.lines[0].reason = ''
  db.tables.jobs[0].details.total = 120
  db.tables.jobs[0].details.quoteLearning = structuredClone(b)
  assert.equal((await request(db, 'POST', '/observations', b)).status, 200)
  assert.equal(db.tables.pricing_learning_observations.length, 1)
  assert.equal(db.tables.pricing_learning_observations[0].reason, 'unexplained')
  assert.equal(db.tables.pricing_learning_observations[0].chosen_price, 120)
})
test('foreign job cannot be submitted and foreign rows never appear in state', async () => {
  const db = dbFor()
  assert.equal((await request(db, 'POST', '/observations', payload(), { businessId: 'b' })).status, 404)
  await request(db, 'POST', '/observations', payload())
  assert.equal((await request(db, 'GET', '/state', null, { businessId: 'b' })).body.observations.length, 0)
})
test('tampered prices, baseline, reason, quantity, line identity and missing snapshot fail closed', async () => {
  for (const patch of [{ chosenPrice: 116 }, { baselinePrice: 150 }, { reason: 'discount' }, { quantity: 99 }, { svc: 'deck' }, { lineKey: 'other' }]) {
    const db = dbFor(), b = payload(); Object.assign(b.lines[0], patch)
    assert.equal((await request(db, 'POST', '/observations', b)).status, 409)
    assert.equal(db.tables.pricing_learning_observations.length, 0)
  }
  const db = dbFor(); delete db.tables.jobs[0].details.quoteLearning
  assert.equal((await request(db, 'POST', '/observations', payload())).status, 409)
})
test('saved quantity and original total must independently agree with snapshot', async () => {
  for (const mutate of [d => d.total = 100, d => d.services[0].qty = 99, d => d.services[0].svc = 'deck']) {
    const db = dbFor(); mutate(db.tables.jobs[0].details)
    assert.equal((await request(db, 'POST', '/observations', payload())).status, 409)
  }
})
test('accepted historical and closed rows cannot be used as new training evidence', async () => {
  for (const status of ['won', 'scheduled', 'completed', 'paid', 'cancelled']) {
    const db = dbFor(); db.tables.jobs[0].status = status
    assert.equal((await request(db, 'POST', '/observations', payload())).status, 409)
  }
  const db = dbFor(); db.tables.jobs[0].details.quoteStatus = 'accepted'
  assert.equal((await request(db, 'POST', '/observations', payload())).status, 409)
})
test('authoritative accepted quote blocks training even if the job status lags', async () => {
  const db = dbFor()
  db.tables.jobs[0].quote_id = id(3)
  db.tables.quotes.push({ id: id(3), business_id: 'a', status: 'accepted' })
  assert.equal((await request(db, 'POST', '/observations', payload())).status, 409)
  db.tables.quotes[0].status = 'sent'
  assert.equal((await request(db, 'POST', '/observations', payload())).status, 200)
  db.tables.quotes[0].status = 'accepted'
  assert.equal((await request(db, 'GET', '/state')).body.observations[0].quoteStatus, 'accepted')
  db.fail = { table: 'quotes' }
  assert.equal((await request(db, 'GET', '/state')).status, 503)
})
test('strict numeric, bounded identity, reason and Unicode unit validation', async () => {
  for (const patch of [{ chosenPrice: NaN }, { baselinePrice: Infinity }, { quantity: '100' }, { baselinePrice: -1 },
    { lineKey: '../bad' }, { storeys: 7 }, { access: 'unknown' }, { reason: 'Customer John discount' }, { unit: 'anything' }]) {
    const db = dbFor(), b = payload(); Object.assign(b.lines[0], patch)
    assert.equal((await request(db, 'POST', '/observations', b)).status, 400)
  }
  const db = dbFor(), b = payload(); b.lines.push({ ...b.lines[0] })
  assert.equal((await request(db, 'POST', '/observations', b)).status, 400)
})
test('measurement pairs retain raw quantity and match corrected service quantity', async () => {
  const db = dbFor(), b = payload()
  Object.assign(b.lines[0], { measuredQuantity: 80, verifiedQuantity: 100, measurementReason: 'site_measurement', reason: 'measurement_correction' })
  db.tables.jobs[0].details.quoteLearning = structuredClone(b)
  assert.equal((await request(db, 'POST', '/observations', b)).status, 200)
  assert.equal(db.tables.pricing_learning_observations[0].measured_quantity, 80)
  b.lines[0].verifiedQuantity = 101
  assert.equal((await request(db, 'POST', '/observations', b)).status, 400)
  delete b.lines[0].measuredQuantity
  assert.equal((await request(db, 'POST', '/observations', b)).status, 400)
})
test('unknown PII context is discarded and known context must match persisted snapshot', async () => {
  const db = dbFor(), b = payload(); b.context.customerName = 'Secret customer'
  assert.equal((await request(db, 'POST', '/observations', b)).status, 200)
  assert.ok(!JSON.stringify(db.tables.pricing_learning_observations).includes('Secret customer'))
  b.context.estimatedCost = 51
  assert.equal((await request(db, 'POST', '/observations', b)).status, 409)
  b.context.travelKm = NaN
  assert.equal((await request(db, 'POST', '/observations', b)).status, 400)
})
test('settings and sample deletion require business-scoped owner or manager', async () => {
  const db = dbFor(), s = { enabled: false, minSamples: 8, maxAdjustment: .1 }
  db.tables.users[0].role = 'technician'
  assert.equal((await request(db, 'POST', '/observations', payload())).status, 200)
  for (const [method, path, body] of [['PUT', '/settings', s], ['DELETE', '/observations'], ['DELETE', `/observations/${id(100)}`]]) {
    assert.equal((await request(db, method, path, body)).status, 403)
  }
  db.tables.users[0].role = 'manager'
  assert.equal((await request(db, 'PUT', '/settings', s)).status, 200)
  assert.deepEqual((await request(db, 'GET', '/state')).body.settings, s)
  assert.equal((await request(db, 'DELETE', '/observations', null, { businessId: 'b' })).status, 403)
})
test('settings enforce exact boolean, integer minimum and finite adjustment bounds', async () => {
  for (const patch of [{ enabled: 1 }, { minSamples: 4 }, { minSamples: 51 }, { minSamples: 5.5 }, { maxAdjustment: .36 }, { maxAdjustment: NaN }]) {
    assert.equal((await request(dbFor(), 'PUT', '/settings', { enabled: true, minSamples: 5, maxAdjustment: .25, ...patch })).status, 400)
  }
})
test('reset and individual deletion are tenant scoped and preserve settings', async () => {
  const db = dbFor()
  await request(db, 'POST', '/observations', payload())
  db.tables.pricing_learning_observations.push({ ...db.tables.pricing_learning_observations[0], id: id(101), business_id: 'b' })
  assert.equal((await request(db, 'DELETE', `/observations/${id(101)}`)).status, 404)
  assert.equal((await request(db, 'DELETE', `/observations/${id(100)}`)).status, 200)
  await request(db, 'POST', '/observations', payload())
  await request(db, 'PUT', '/settings', { enabled: true, minSamples: 6, maxAdjustment: .2 })
  assert.equal((await request(db, 'DELETE', '/observations')).status, 200)
  assert.deepEqual(db.tables.pricing_learning_observations.map(r => r.business_id), ['b'])
  assert.equal(db.tables.pricing_learning_settings.length, 1)
})
test('state reports actual worker minutes and status without fabricating actual costs', async () => {
  const db = dbFor(); await request(db, 'POST', '/observations', payload())
  db.tables.jobs[0].status = 'completed'; db.tables.jobs[0].details.quoteStatus = 'accepted'
  db.tables.job_work_logs.push({ id: id(50), business_id: 'a', job_id: id(2), start_at: '2026-11-01T00:00:00Z', end_at: '2026-11-01T01:30:00Z' },
    { id: id(51), business_id: 'b', job_id: id(2), start_at: '2026-11-01T00:00:00Z', end_at: '2026-11-01T10:00:00Z' })
  const [o] = (await request(db, 'GET', '/state')).body.observations
  assert.equal(o.actualWorkMinutes, 90)
  assert.equal(o.actualCost, null)
  assert.equal(o.quoteStatus, 'accepted')
  assert.equal(o.jobStatus, 'completed')
})
test('pagination returns all samples instead of silently dropping those after 1000', async () => {
  const db = dbFor(); await request(db, 'POST', '/observations', payload())
  const row = db.tables.pricing_learning_observations[0]
  db.tables.pricing_learning_observations = Array.from({ length: 1001 }, (_, i) => ({ ...row, id: id(i + 100) }))
  assert.equal((await request(db, 'GET', '/state')).body.observations.length, 1001)
})
test('every DB failure propagates without a successful acknowledgement or private error leak', async () => {
  for (const [method, path, body, table, op] of [
    ['POST', '/observations', payload(), 'jobs', 'select'], ['POST', '/observations', payload(), 'pricing_learning_observations', 'upsert'],
    ['PUT', '/settings', { enabled: true, minSamples: 5, maxAdjustment: .25 }, 'pricing_learning_settings', 'upsert'],
    ['DELETE', '/observations', null, 'pricing_learning_observations', 'delete'],
    ['DELETE', `/observations/${id(100)}`, null, 'pricing_learning_observations', 'delete'],
    ['GET', '/state', null, 'pricing_learning_settings', 'select'], ['GET', '/state', null, 'pricing_learning_observations', 'select']]) {
    const db = dbFor(); db.fail = { table, op }
    const r = await request(db, method, path, body)
    assert.equal(r.status, 503); assert.equal(r.body.ok, undefined)
    assert.ok(!JSON.stringify(r.body).includes('private db secret'))
  }
  const db = dbFor(); await request(db, 'POST', '/observations', payload()); db.fail = { table: 'job_work_logs' }
  assert.equal((await request(db, 'GET', '/state')).status, 503)
  db.fail.code = '42P01'
  assert.equal((await request(db, 'GET', '/state')).body.observations[0].actualWorkMinutes, null)
})
