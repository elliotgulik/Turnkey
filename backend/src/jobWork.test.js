import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installJobWork } from './jobWork.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BIZ = 'biz-a', OTHER_BIZ = 'biz-b'
const owner = id(1), worker = id(2), otherWorker = id(3), foreignUser = id(9)
const job = id(10), foreignJob = id(11)
const asset = id(20)

// Fake PostgREST-shaped db. Deliberately caps un-ranged selects at 1000 rows
// (PostgREST's real default page size) so a route that forgets to paginate
// a potentially-large table fails its test the same way it would fail in
// production, instead of silently "working" only because the fake has no
// such limit.
function makeDb(tables, { failUpload = false } = {}) {
  return {
    tables,
    from(table) {
      tables[table] ||= []
      let filters = [], op = 'select', val, one = false, orderKey = null, limitN = Infinity, bounds = null
      const q = {
        select() { return q },
        order(k) { orderKey = k; return q },
        limit(n) { limitN = n; return q },
        range(start, end) { bounds = [start, end]; return q },
        eq(k, v) { filters.push((r) => r[k] === v); return q },
        gte(k, v) { filters.push((r) => r[k] >= v); return q },
        lte(k, v) { filters.push((r) => r[k] <= v); return q },
        lt(k, v) { filters.push((r) => r[k] < v); return q },
        in(k, values) { filters.push((r) => values.includes(r[k])); return q },
        maybeSingle() { one = true; return q },
        single() { one = true; return q },
        insert(v) { op = 'insert'; val = v; return q },
        update(v) { op = 'update'; val = v; return q },
        then(resolve, reject) {
          try {
            if (op === 'insert') {
              const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...val }
              if (row.id && tables[table].some((r) => r.id === row.id)) {
                return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }).then(resolve, reject)
              }
              tables[table].push(row)
              return Promise.resolve({ data: one ? row : [row], error: null }).then(resolve, reject)
            }
            let rows = tables[table].filter((r) => filters.every((f) => f(r)))
            if (op === 'update') rows.forEach((r) => Object.assign(r, val))
            if (orderKey) rows = [...rows].sort((a, b) => (a[orderKey] > b[orderKey] ? 1 : -1))
            rows = bounds ? rows.slice(bounds[0], bounds[1] + 1) : rows.slice(0, Math.min(limitN, 1000))
            return Promise.resolve({ data: one ? (rows[0] || null) : structuredClone(rows), error: null }).then(resolve, reject)
          } catch (e) { return Promise.reject(e).then(resolve, reject) }
        }
      }
      return q
    },
    storage: {
      from(bucket) {
        return {
          async upload(storagePath, bytes) {
            if (failUpload) return { error: new Error('upload failed') }
            tables.__storage ||= new Map()
            tables.__storage.set(bucket + ':' + storagePath, bytes)
            return { error: null }
          },
          async createSignedUrl(storagePath, ttl) {
            if (!tables.__storage?.has(bucket + ':' + storagePath)) return { error: new Error('not found') }
            return { data: { signedUrl: `https://signed.example/${bucket}/${encodeURIComponent(storagePath)}?ttl=${ttl}` }, error: null }
          }
        }
      }
    }
  }
}

function makeApp() {
  const routes = {}
  const guard = () => {}
  const app = {}
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (routePath, auth, handler) => { assert.equal(auth, guard); routes[method + ' ' + routePath] = handler }
  }
  return { app, routes, guard }
}

function matchRoute(routes, method, reqPath) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ')
    if (m !== method) continue
    const parts = pattern.split('/'), given = reqPath.split('/')
    if (parts.length !== given.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = given[i]
      else if (parts[i] !== given[i]) { ok = false; break }
    }
    if (ok) return { handler: routes[key], params }
  }
  throw new Error('No route matches ' + method + ' ' + reqPath)
}

function setup({ rpc, failUpload } = {}) {
  const tables = {
    users: [
      { id: owner, business_id: BIZ, email: 'owner@biz.test', role: 'owner' },
      { id: worker, business_id: BIZ, email: 'worker@biz.test', role: 'technician' },
      { id: otherWorker, business_id: BIZ, email: 'other@biz.test', role: 'technician' },
      { id: foreignUser, business_id: OTHER_BIZ, email: 'foreign@biz.test', role: 'owner' }
    ],
    jobs: [
      { id: job, business_id: BIZ },
      { id: foreignJob, business_id: OTHER_BIZ }
    ],
    equipment_assets: [
      { id: asset, business_id: BIZ, name: 'Pressure washer', service_interval_hours: 100, baseline_hours: 10 }
    ],
    equipment_usage: [],
    equipment_service_events: [],
    attachments: []
  }
  const db = makeDb(tables, { failUpload })
  db.rpc = rpc || (async () => ({ data: { log_id: crypto.randomUUID(), deduped: false }, error: null }))
  const { app, routes, guard } = makeApp()
  installJobWork(app, { db, requireBusiness: guard })
  return {
    tables, db,
    async run(method, reqPath, { body = {}, query = {}, userId = worker, businessId = BIZ } = {}) {
      const { handler, params } = matchRoute(routes, method, reqPath)
      const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this }, json(v) { this.body = v; return this } }
      const req = { businessId, userId, body, query, params }
      await handler(req, res)
      return res
    }
  }
}

const validLog = () => ({ jobId: job, startAt: '2026-01-01T08:00:00Z', endAt: '2026-01-01T10:00:00Z', requestId: crypto.randomUUID() })

test('worker can log their own hours', async () => {
  const h = setup()
  const res = await h.run('post', '/api/job-work/logs', { body: validLog() })
  assert.equal(res.statusCode, 201)
  assert.equal(res.body.ok, true)
})

test('work-log job picker scopes employees to assigned jobs and hides other businesses', async () => {
  const h = setup()
  h.tables.jobs = [
    { id: job, business_id: BIZ, status: 'scheduled', scheduled_date: '2026-10-31', assigned_to: worker, customer_id: id(40), details: { services: [{ label: 'House wash' }] } },
    { id: id(12), business_id: BIZ, status: 'scheduled', scheduled_date: '2026-10-31', assigned_to: otherWorker, customer_id: id(41), details: { services: [{ label: 'Windows' }], assignedStaffIds: [worker] } },
    { id: id(13), business_id: BIZ, status: 'scheduled', scheduled_date: '2026-10-31', assigned_to: null, customer_id: id(43), details: {} },
    { id: foreignJob, business_id: OTHER_BIZ, status: 'scheduled', scheduled_date: '2026-10-31', assigned_to: worker, customer_id: id(42), details: {} }
  ]
  h.tables.customers = [
    { id: id(40), business_id: BIZ, name: 'Assigned customer', address: '1 Test St', suburb: 'Auckland' },
    { id: id(41), business_id: BIZ, name: 'Crew customer', address: '2 Test St', suburb: 'Auckland' },
    { id: id(43), business_id: BIZ, name: 'Unassigned customer', address: '4 Test St' },
    { id: id(42), business_id: OTHER_BIZ, name: 'Foreign customer', address: '3 Test St' }
  ]
  const own = await h.run('get', '/api/job-work/jobs', { query: { date: '2026-10-31' } })
  assert.equal(own.statusCode, 200)
  assert.deepEqual(own.body.jobs.map(row => row.name).sort(), ['Assigned customer', 'Crew customer'])
  const assigned = own.body.jobs.find(row => row.name === 'Assigned customer')
  assert.equal(assigned.address, '1 Test St, Auckland')
  assert.deepEqual(assigned.services, ['House wash'])
  const admin = await h.run('get', '/api/job-work/jobs', { userId: owner, query: { date: '2026-10-31' } })
  assert.deepEqual(admin.body.jobs.map(row => row.name).sort(), ['Assigned customer', 'Crew customer', 'Unassigned customer'])
  const invalid = await h.run('get', '/api/job-work/jobs', { query: { date: '2026-02-31' } })
  assert.equal(invalid.statusCode, 400)
})

test('a missing or invalid requestId is rejected, never silently generated', async () => {
  const h = setup()
  const missing = await h.run('post', '/api/job-work/logs', { body: { jobId: job, startAt: '2026-01-01T08:00:00Z', endAt: '2026-01-01T10:00:00Z' } })
  assert.equal(missing.statusCode, 400)
  const invalid = await h.run('post', '/api/job-work/logs', { body: { ...validLog(), requestId: 'not-a-uuid' } })
  assert.equal(invalid.statusCode, 400)
})

test('worker cannot log hours for someone else', async () => {
  const h = setup()
  const res = await h.run('post', '/api/job-work/logs', { body: { ...validLog(), userId: otherWorker } })
  assert.equal(res.statusCode, 403)
})

test('owner can log hours on behalf of a staff member in the same business', async () => {
  const h = setup()
  const res = await h.run('post', '/api/job-work/logs', { userId: owner, body: { ...validLog(), userId: worker } })
  assert.equal(res.statusCode, 201)
})

test('cannot log hours against a job or staff member from another business', async () => {
  const h = setup()
  const resJob = await h.run('post', '/api/job-work/logs', { body: { ...validLog(), jobId: foreignJob } })
  assert.equal(resJob.statusCode, 404)
  const resStaff = await h.run('post', '/api/job-work/logs', { userId: owner, body: { ...validLog(), userId: foreignUser } })
  assert.equal(resStaff.statusCode, 404)
})

test('rejects invalid/negative/too-long work windows', async () => {
  const h = setup()
  const backwards = await h.run('post', '/api/job-work/logs', { body: { ...validLog(), startAt: '2026-01-01T10:00:00Z', endAt: '2026-01-01T08:00:00Z' } })
  assert.equal(backwards.statusCode, 400)
  const tooLong = await h.run('post', '/api/job-work/logs', { body: { ...validLog(), startAt: '2026-01-01T00:00:00Z', endAt: '2026-01-02T01:00:00Z' } })
  assert.equal(tooLong.statusCode, 400)
  const badDate = await h.run('post', '/api/job-work/logs', { body: { ...validLog(), startAt: 'not-a-date' } })
  assert.equal(badDate.statusCode, 400)
})

test('rejects duplicate equipment asset entries and equipment hours beyond the work duration', async () => {
  const h = setup()
  const oneHourLog = { jobId: job, startAt: '2026-01-01T08:00:00Z', endAt: '2026-01-01T09:00:00Z', requestId: crypto.randomUUID() }
  const dup = await h.run('post', '/api/job-work/logs', { body: { ...oneHourLog, equipment: [{ assetId: asset, hours: 0.5 }, { assetId: asset, hours: 0.2 }] } })
  assert.equal(dup.statusCode, 400)
  const negative = await h.run('post', '/api/job-work/logs', { body: { ...oneHourLog, requestId: crypto.randomUUID(), equipment: [{ assetId: asset, hours: -1 }] } })
  assert.equal(negative.statusCode, 400)
  const beyondDuration = await h.run('post', '/api/job-work/logs', { body: { ...oneHourLog, requestId: crypto.randomUUID(), equipment: [{ assetId: asset, hours: 1.5 }] } })
  assert.equal(beyondDuration.statusCode, 400)
  assert.match(beyondDuration.body.error, /exceed the logged work duration/)
  const withinDuration = await h.run('post', '/api/job-work/logs', { body: { ...oneHourLog, requestId: crypto.randomUUID(), equipment: [{ assetId: asset, hours: 1 }] } })
  assert.equal(withinDuration.statusCode, 201)
})

test('an overlap rejection from the database becomes a 409, not a 500', async () => {
  const h = setup({ rpc: async () => { const e = new Error('conflicting key value violates exclusion constraint "job_work_logs_no_overlap"'); e.code = '23P01'; throw e } })
  const res = await h.run('post', '/api/job-work/logs', { body: validLog() })
  assert.equal(res.statusCode, 409)
})

test('a reused request id with a changed payload is a 409 conflict, not a silent dedupe', async () => {
  const h = setup({ rpc: async () => { const e = new Error('Submission key already used for different work details'); e.code = '22023'; throw e } })
  const res = await h.run('post', '/api/job-work/logs', { body: validLog() })
  assert.equal(res.statusCode, 409)
})

test('a plain SQL validation error (not a conflict) is a 400', async () => {
  const h = setup({ rpc: async () => { const e = new Error('Invalid work window: end must be after start and within 24 hours'); e.code = '22023'; throw e } })
  const res = await h.run('post', '/api/job-work/logs', { body: validLog() })
  assert.equal(res.statusCode, 400)
})

test('GET logs forces a worker to their own entries even if a different userId is requested', async () => {
  const h = setup()
  h.tables.job_work_logs = [
    { id: id(30), business_id: BIZ, job_id: job, user_id: worker, start_at: '2026-01-01T08:00:00Z', end_at: '2026-01-01T09:00:00Z', minutes: 60 },
    { id: id(31), business_id: BIZ, job_id: job, user_id: otherWorker, start_at: '2026-01-01T08:00:00Z', end_at: '2026-01-01T09:00:00Z', minutes: 60 }
  ]
  const res = await h.run('get', '/api/job-work/logs', { query: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', userId: otherWorker } })
  assert.equal(res.body.logs.length, 1)
  assert.equal(res.body.logs[0].user_id, worker)
})

test('GET logs requires either a jobId or a from/to range, rejects a backwards or oversized range', async () => {
  const h = setup()
  const none = await h.run('get', '/api/job-work/logs', { query: {} })
  assert.equal(none.statusCode, 400)
  const backwards = await h.run('get', '/api/job-work/logs', { query: { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' } })
  assert.equal(backwards.statusCode, 400)
  const tooBig = await h.run('get', '/api/job-work/logs', { query: { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' } })
  assert.equal(tooBig.statusCode, 400)
})

test('GET logs date range is half-open: an entry starting exactly at `to` is excluded', async () => {
  const h = setup()
  h.tables.job_work_logs = [
    { id: id(32), business_id: BIZ, job_id: job, user_id: worker, start_at: '2026-01-08T00:00:00.000Z', end_at: '2026-01-08T01:00:00.000Z', minutes: 60 }
  ]
  const res = await h.run('get', '/api/job-work/logs', { userId: owner, query: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z' } })
  assert.equal(res.body.logs.length, 0)
})

test('equipment creation and editing require owner/manager; editing cannot change baseline hours', async () => {
  const h = setup()
  const denied = await h.run('post', '/api/job-work/equipment', { body: { name: 'Mower', serviceIntervalHours: 50 } })
  assert.equal(denied.statusCode, 403)
  const created = await h.run('post', '/api/job-work/equipment', { userId: owner, body: { name: 'Mower', serviceIntervalHours: 50, baselineHours: 20 } })
  assert.equal(created.statusCode, 201)
  assert.equal(created.body.asset.baseline_hours, 20)

  const edited = await h.run('patch', `/api/job-work/equipment/${created.body.asset.id}`, {
    userId: owner, body: { name: 'Mower (renamed)', serviceIntervalHours: 60, baselineHours: 999 }
  })
  assert.equal(edited.statusCode, 200)
  assert.equal(edited.body.asset.name, 'Mower (renamed)')
  assert.equal(edited.body.asset.service_interval_hours, 60)
  assert.equal(edited.body.asset.baseline_hours, 20) // untouched by the PATCH body's baselineHours
})

test('an asset with no service history counts its ENTIRE runtime (including baseline) toward the interval', async () => {
  const h = setup()
  // baseline 10h, no usage, no service events at all — due only once baseline+usage reaches the interval.
  h.tables.equipment_assets = [{ id: asset, business_id: BIZ, name: 'Washer', service_interval_hours: 100, baseline_hours: 95 }]
  h.tables.equipment_usage = [{ id: id(40), business_id: BIZ, log_id: id(41), asset_id: asset, hours: 10 }]
  const res = await h.run('get', '/api/job-work/equipment', { userId: owner })
  const a = res.body.equipment.find((x) => x.id === asset)
  assert.equal(a.runtimeHours, 105)
  assert.equal(a.hasServiceHistory, false)
  assert.equal(a.sinceServiceHours, 105) // NOT runtime - baseline (= 10) — baseline was never actually serviced
  assert.equal(a.due, true)
})

test('after a service event, sinceServiceHours resets relative to the recorded meter reading', async () => {
  const h = setup()
  h.tables.equipment_usage = [{ id: id(40), business_id: BIZ, log_id: id(41), asset_id: asset, hours: 105 }]
  h.tables.equipment_service_events = [{ id: id(42), business_id: BIZ, asset_id: asset, meter_hours: 115, serviced_at: '2026-01-02T00:00:00Z', author: owner }]
  const res = await h.run('get', '/api/job-work/equipment', { userId: owner })
  const a = res.body.equipment.find((x) => x.id === asset)
  assert.equal(a.runtimeHours, 115) // 10 baseline + 105 usage
  assert.equal(a.hasServiceHistory, true)
  assert.equal(a.sinceServiceHours, 0)
  assert.equal(a.remainingHours, 100)
  assert.equal(a.due, false)
})

test('equipment usage/service events are summed across every page, not truncated at 1000 rows', async () => {
  const h = setup()
  h.tables.equipment_usage = Array.from({ length: 1500 }, (_, i) => ({ id: id(1000 + i), business_id: BIZ, asset_id: asset, hours: 1 }))
  const res = await h.run('get', '/api/job-work/equipment', { userId: owner })
  const a = res.body.equipment.find((x) => x.id === asset)
  assert.equal(a.runtimeHours, 10 + 1500) // baseline + every one of the 1500 usage rows, not just the first page
})

test('marking equipment serviced requires owner/manager', async () => {
  const h = setup()
  const res = await h.run('post', `/api/job-work/equipment/${asset}/service`, { body: {} })
  assert.equal(res.statusCode, 403)
})

function dataUrlFor(bytes, mime) { return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

test('uploads a valid before/after photo and rejects non-image content', async () => {
  const h = setup()
  const ok = await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'before_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/jpeg') } })
  assert.equal(ok.statusCode, 201)
  assert.equal(h.tables.attachments.length, 1)
  assert.match(h.tables.attachments[0].path, new RegExp(`^${BIZ}/job-photos/${job}/before_photo/[0-9a-f]{64}\\.jpg$`))

  const fake = await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'after_photo', dataUrl: dataUrlFor(Buffer.from('<svg></svg>'), 'image/svg+xml') } })
  assert.equal(fake.statusCode, 400)

  const mismatch = await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'after_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/png') } })
  assert.equal(mismatch.statusCode, 400)
})

test('re-uploading identical photo bytes is idempotent (same deterministic id, no duplicate row)', async () => {
  const h = setup()
  const first = await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'before_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/jpeg') } })
  const second = await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'before_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/jpeg') } })
  assert.equal(h.tables.attachments.length, 1)
  assert.equal(second.body.deduped, true)
  assert.equal(first.body.attachment.id, second.body.attachment.id)
  assert.equal(first.body.attachment.path, second.body.attachment.path)
})

test('two concurrent uploads of the same photo race safely to exactly one row (PK-uniqueness-driven, not check-then-insert)', async () => {
  const h = setup()
  const upload = () => h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'before_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/jpeg') } })
  const [a, b] = await Promise.all([upload(), upload()])
  assert.equal(h.tables.attachments.length, 1)
  assert.equal([a.statusCode, b.statusCode].sort().join(','), '200,201')
  assert.equal(a.body.attachment.id, b.body.attachment.id)
})

test('oversized photo payload is rejected before touching storage', async () => {
  const h = setup()
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9 * 1024 * 1024)])
  const res = await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'before_photo', dataUrl: dataUrlFor(big, 'image/jpeg') } })
  assert.equal(res.statusCode, 400)
})

test('photos for a job in another business are not accessible', async () => {
  const h = setup()
  const upload = await h.run('post', `/api/job-work/jobs/${foreignJob}/photos`, { body: { kind: 'before_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/jpeg') } })
  assert.equal(upload.statusCode, 404)
  const list = await h.run('get', `/api/job-work/jobs/${foreignJob}/photos`)
  assert.equal(list.statusCode, 404)
})

test('GET photos returns short-TTL signed URLs, not permanent public ones', async () => {
  const h = setup()
  await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'after_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/jpeg') } })
  const res = await h.run('get', `/api/job-work/jobs/${job}/photos`)
  assert.equal(res.body.photos.length, 1)
  assert.match(res.body.photos[0].url, /ttl=300/)
})

test('storage upload failures surface as real errors, not a false success', async () => {
  const h = setup({ failUpload: true })
  const res = await h.run('post', `/api/job-work/jobs/${job}/photos`, { body: { kind: 'before_photo', dataUrl: dataUrlFor(JPEG_BYTES, 'image/jpeg') } })
  assert.equal(res.statusCode, 502)
  assert.equal(h.tables.attachments.length, 0)
})

test('a not-migrated database error becomes a clear 503, not a crash', async () => {
  const h = setup({ rpc: async () => { const e = new Error('relation "job_work_logs" does not exist'); e.code = '42P01'; throw e } })
  const res = await h.run('post', '/api/job-work/logs', { body: validLog() })
  assert.equal(res.statusCode, 503)
})

/* =========================================================================
   SQL-level tests against the CANONICAL migration (owned by the parent —
   never overwritten or copied-over from here). Not skipped if missing:
   that file is a tracked, committed part of this repo, not an ephemeral
   handoff artifact, so its absence is a real failure, not an expected gap.
   ========================================================================= */
const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations/20261018031355_job_work_records.sql')

test('SQL schema: idempotent, overlap-safe, tenant-locked, idempotent RPC retries', async (t) => {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8')
  const { PGlite } = await import('@electric-sql/pglite')
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist')
  const db = new PGlite({ extensions: { btree_gist } })
  const BIZ_A = 'test-biz-a'
  const uidOwner = '11111111-1111-4111-8111-111111111111'
  const uidA = '44444444-4444-4444-8444-444444444444'
  const uidA2 = '55555555-5555-4555-8555-555555555555'
  const jobA = '33333333-3333-4333-8333-333333333333'
  const assetA = '66666666-6666-4666-8666-666666666666'

  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    create table public.businesses(id text primary key);
    create table public.users(id uuid primary key, business_id text, role text);
    create table public.jobs(id uuid primary key default gen_random_uuid(), business_id text);
    insert into public.businesses values ('${BIZ_A}');
    insert into public.users(id, business_id, role) values
      ('${uidOwner}', '${BIZ_A}', 'owner'),
      ('${uidA}', '${BIZ_A}', 'technician'),
      ('${uidA2}', '${BIZ_A}', 'technician');
    insert into public.jobs(id, business_id) values ('${jobA}', '${BIZ_A}');
  `)
  await db.exec(schemaSql)
  await t.test('migration is idempotent', async () => { await db.exec(schemaSql) })

  await db.query(`insert into public.equipment_assets(id, business_id, name, service_interval_hours, baseline_hours) values ($1, $2, 'Washer', 100, 5)`, [assetA, BIZ_A])

  let firstLogId
  await t.test('record_job_work inserts a log plus equipment usage atomically', async () => {
    const { rows } = await db.query(
      `select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)`,
      [BIZ_A, jobA, uidA, '2026-01-01T08:00:00Z', '2026-01-01T10:00:00Z', 'shift one', '22222222-2222-4222-8222-222222222222', JSON.stringify([{ asset_id: assetA, hours: 2 }])]
    )
    firstLogId = rows[0].log_id
    assert.equal(rows[0].deduped, false)
    const usage = await db.query(`select * from equipment_usage where log_id = $1`, [firstLogId])
    assert.equal(usage.rows.length, 1)
    assert.equal(Number(usage.rows[0].hours), 2)
  })

  await t.test('retrying the exact same request id and payload is a no-op, not a duplicate', async () => {
    const before = await db.query(`select count(*)::int n from job_work_logs`)
    const { rows } = await db.query(
      `select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)`,
      [BIZ_A, jobA, uidA, '2026-01-01T08:00:00Z', '2026-01-01T10:00:00Z', 'shift one', '22222222-2222-4222-8222-222222222222', JSON.stringify([{ asset_id: assetA, hours: 2 }])]
    )
    assert.equal(rows[0].deduped, true)
    assert.equal(rows[0].log_id, firstLogId)
    const after = await db.query(`select count(*)::int n from job_work_logs`)
    assert.equal(after.rows[0].n, before.rows[0].n)
  })

  await t.test('reusing the same request id with a DIFFERENT payload is rejected, not silently accepted', async () => {
    await assert.rejects(
      db.query(
        `select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)`,
        [BIZ_A, jobA, uidA, '2026-01-01T08:00:00Z', '2026-01-01T10:00:00Z', 'a DIFFERENT note', '22222222-2222-4222-8222-222222222222', JSON.stringify([{ asset_id: assetA, hours: 2 }])]
      ),
      /already used for different/
    )
  })

  await t.test('a worker cannot have two overlapping work windows', async () => {
    await assert.rejects(
      db.query(
        `select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)`,
        [BIZ_A, jobA, uidA, '2026-01-01T09:00:00Z', '2026-01-01T11:00:00Z', 'overlap', '33333333-3333-4333-8333-333333333333', JSON.stringify([])]
      ),
      /exclusion constraint/
    )
  })

  await t.test('back-to-back entries (end exactly equals next start) do NOT falsely conflict — half-open range', async () => {
    const { rows } = await db.query(
      `select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)`,
      [BIZ_A, jobA, uidA, '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 'back to back', '44444444-4444-4444-8444-444444444444', JSON.stringify([])]
    )
    assert.equal(rows[0].deduped, false)
  })

  await t.test('the same equipment cannot be double-booked by two overlapping logs', async () => {
    await assert.rejects(
      db.query(
        `select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)`,
        [BIZ_A, jobA, uidA2, '2026-01-01T09:00:00Z', '2026-01-01T09:30:00Z', 'other worker', '55555555-5555-4555-8555-555555555555', JSON.stringify([{ asset_id: assetA, hours: 0.5 }])]
      ),
      /exclusion constraint/
    )
  })

  await t.test('equipment runtime hours cannot exceed the logged work duration', async () => {
    await assert.rejects(
      db.query(
        `select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)`,
        [BIZ_A, jobA, uidA2, '2026-02-01T09:00:00Z', '2026-02-01T10:00:00Z', 'too much runtime', '66666666-6666-4666-8666-666666666666', JSON.stringify([{ asset_id: assetA, hours: 5 }])]
      ),
      /between zero and the work duration/
    )
  })

  await t.test('mark_equipment_serviced requires an owner/manager author and computes meter_hours server-side', async () => {
    await assert.rejects(
      db.query(`select * from mark_equipment_serviced($1,$2,$3,$4)`, [BIZ_A, assetA, uidA, 'not privileged']),
      /not found/
    )
    const { rows } = await db.query(`select * from mark_equipment_serviced($1,$2,$3,$4)`, [BIZ_A, assetA, uidOwner, 'oil change'])
    assert.equal(Number(rows[0].meter_hours), 7) // 5 baseline + 2 usage hours logged above
  })

  await t.test('neither anon nor authenticated can read or write these tables directly', async () => {
    await db.exec('set role authenticated')
    try {
      await assert.rejects(db.query('select * from job_work_logs'), /permission denied/)
      await assert.rejects(db.query('select * from equipment_assets'), /permission denied/)
    } finally {
      await db.exec('reset role')
    }
  })

  await db.close()
})
