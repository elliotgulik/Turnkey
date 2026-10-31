import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installJobCalendar } from './jobCalendar.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BIZ = 'biz-a', OTHER_BIZ = 'biz-b'
const owner = id(1), manager = id(2), tech = id(3), otherTech = id(4), foreignUser = id(9)
const job = id(10), otherJob = id(11), foreignJob = id(12), cancelledJob = id(13), completedJob = id(14)
const customer = id(20)
const connection = id(30)

// Fake PostgREST-shaped db, same shape/limits as jobWork.test.js's (caps
// un-ranged selects at 1000 rows so a route that forgets to paginate fails
// the same way it would in production) plus delete() support for the
// availability_blocks DELETE route.
function makeDb(tables, { rpcImpl } = {}) {
  const db = {
    tables,
    from(table) {
      tables[table] ||= []
      let filters = [], op = 'select', val, one = false, orderKey = null, limitN = Infinity, bounds = null
      const q = {
        select() { return q },
        order(k) { orderKey = k; return q },
        limit(n) { limitN = n; return q },
        range(start, end) { bounds = [start, end]; return q },
        eq(k, v) { filters.push((r) => k.includes('->>') ? r[k.split('->>')[0]]?.[k.split('->>')[1]] === v : r[k] === v); return q },
        gte(k, v) { filters.push((r) => r[k] >= v); return q },
        lte(k, v) { filters.push((r) => r[k] <= v); return q },
        lt(k, v) { filters.push((r) => r[k] < v); return q },
        gt(k, v) { filters.push((r) => r[k] > v); return q },
        in(k, values) { filters.push((r) => values.includes(r[k])); return q },
        maybeSingle() { one = true; return q },
        single() { one = true; return q },
        insert(v) { op = 'insert'; val = v; return q },
        update(v) { op = 'update'; val = v; return q },
        delete() { op = 'delete'; return q },
        then(resolve, reject) {
          try {
            if (op === 'insert') {
              const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...val }
              tables[table].push(row)
              return Promise.resolve({ data: one ? row : [row], error: null }).then(resolve, reject)
            }
            let rows = tables[table].filter((r) => filters.every((f) => f(r)))
            if (op === 'update') rows.forEach((r) => Object.assign(r, val))
            if (op === 'delete') tables[table] = tables[table].filter((r) => !rows.includes(r))
            if (orderKey) rows = [...rows].sort((a, b) => (a[orderKey] > b[orderKey] ? 1 : -1))
            rows = bounds ? rows.slice(bounds[0], bounds[1] + 1) : rows.slice(0, Math.min(limitN, 1000))
            return Promise.resolve({ data: one ? (rows[0] || null) : structuredClone(rows), error: null }).then(resolve, reject)
          } catch (e) { return Promise.reject(e).then(resolve, reject) }
        }
      }
      return q
    }
  }
  db.rpc = rpcImpl || (async (name, p) => {
    if (name === 'job_calendar_delete_item') {
      const table = p.p_kind === 'block' ? 'availability_blocks' : 'calendar_events'
      const row = tables[table].find(r => r.id === p.p_id && r.business_id === p.p_business_id)
      const caller = tables.users.find(r => r.id === p.p_caller_id && r.business_id === p.p_business_id)
      if (!row) return { error: { code: '22023', message: 'Item not found' } }
      if (!caller || (!['owner','manager'].includes(caller.role) && row.user_id !== caller.id)) return { error: { code: '42501', message: 'You can only remove your own items' } }
      tables[table] = tables[table].filter(r => r !== row)
    }
    return { data: null, error: null }
  })
  return db
}

function makeApp() {
  const routes = {}
  const guard = () => {}
  const app = {}
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
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

function setup({ rpcImpl, getGoogleCalendarToken, googleConfigured = () => true } = {}) {
  const tables = {
    users: [
      { id: owner, business_id: BIZ, name: 'Owner', email: 'owner@biz.test', role: 'owner' },
      { id: manager, business_id: BIZ, name: 'Manager', email: 'manager@biz.test', role: 'manager' },
      { id: tech, business_id: BIZ, name: 'Tech', email: 'tech@biz.test', role: 'technician' },
      { id: otherTech, business_id: BIZ, name: 'Other Tech', email: 'other@biz.test', role: 'technician' },
      { id: foreignUser, business_id: OTHER_BIZ, name: 'Foreign', email: 'foreign@biz.test', role: 'owner' }
    ],
    customers: [
      { id: customer, business_id: BIZ, name: 'Jane Smith', address: '1 Main St', suburb: 'Centraltown' }
    ],
    jobs: [
      { id: job, business_id: BIZ, customer_id: customer, status: 'new', assigned_to: null, scheduled_date: null, details: {}, updated_at: '2026-01-01T00:00:00Z' },
      { id: otherJob, business_id: BIZ, customer_id: null, status: 'new', assigned_to: tech, scheduled_date: null, details: { assignedStaffIds: [tech] }, updated_at: '2026-01-01T00:00:00Z' },
      { id: foreignJob, business_id: OTHER_BIZ, status: 'new', assigned_to: null, scheduled_date: null, details: {}, updated_at: '2026-01-01T00:00:00Z' },
      { id: cancelledJob, business_id: BIZ, status: 'cancelled', assigned_to: null, scheduled_date: null, details: { lostAt: 1 }, updated_at: '2026-01-01T00:00:00Z' },
      { id: completedJob, business_id: BIZ, status: 'completed', assigned_to: null, scheduled_date: '2024-05-10', details: {}, updated_at: '2024-05-10T00:00:00Z' }
    ],
    availability_blocks: [],
    calendar_events: [],
    calendar_connections: []
  }
  const db = makeDb(tables, { rpcImpl })
  const { app, routes, guard } = makeApp()
  installJobCalendar(app, { db, requireBusiness: guard, getGoogleCalendarToken: getGoogleCalendarToken || (async () => null), googleConfigured })
  return {
    tables, db,
    async run(method, reqPath, { body = {}, query = {}, userId = owner, businessId = BIZ } = {}) {
      const { handler, params } = matchRoute(routes, method, reqPath)
      const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this }, json(v) { this.body = v; return this } }
      const req = { businessId, userId, body, query, params }
      await handler(req, res)
      return res
    }
  }
}

/* ============================= GET /range ============================= */

test('GET /range: technician is scoped to their own jobs/staff/blocks/events; owner sees everything', async () => {
  const h = setup()
  h.tables.jobs[0].assigned_to = tech
  h.tables.jobs[0].scheduled_date = '2026-02-01'
  h.tables.jobs[0].details = { calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z', assignedStaffIds: [tech] }
  h.tables.availability_blocks.push({ id: id(40), business_id: BIZ, user_id: otherTech, block_type: 'holiday', start_at: '2026-02-01T00:00:00Z', end_at: '2026-02-02T00:00:00Z', all_day: true, reason: 'leave' })

  const asTech = await h.run('get', '/api/job-calendar/range', { userId: tech, query: { from: '2026-02-01T00:00:00Z', to: '2026-02-08T00:00:00Z' } })
  assert.equal(asTech.body.canManage, false)
  assert.equal(asTech.body.staff.length, 1)
  assert.equal(asTech.body.blocks.length, 0) // otherTech's block is not visible to tech

  const asOwner = await h.run('get', '/api/job-calendar/range', { userId: owner, query: { from: '2026-02-01T00:00:00Z', to: '2026-02-08T00:00:00Z' } })
  assert.equal(asOwner.body.canManage, true)
  assert.ok(asOwner.body.staff.length >= 4)
  assert.equal(asOwner.body.blocks.length, 1)
})

test('GET /range: a job\'s details are whitelisted to calendar fields only, never pricing/cost/internal data', async () => {
  const h = setup()
  h.tables.jobs[0].details = {
    calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z',
    cost: 999, margin: 0.4, internalNotes: 'secret', _googleEventOwnerId: owner
  }
  h.tables.jobs[0].scheduled_date = '2026-02-01'
  const res = await h.run('get', '/api/job-calendar/range', { query: { from: '2026-02-01T00:00:00Z', to: '2026-02-08T00:00:00Z' } })
  const j = res.body.jobs.find((x) => x.id === job)
  assert.deepEqual(Object.keys(j.details).sort(), ['calendarEndAt', 'calendarStartAt'])
})

test('GET /range: unscheduled jobs are always included regardless of range', async () => {
  const h = setup()
  const res = await h.run('get', '/api/job-calendar/range', { query: { from: '2030-01-01T00:00:00Z', to: '2030-01-08T00:00:00Z' } })
  assert.ok(res.body.jobs.some((j) => j.id === job))
})

test('GET /range: completed jobs stay available to the Completed section outside the selected date range', async () => {
  const h = setup()
  const res = await h.run('get', '/api/job-calendar/range', { query: { from: '2030-01-01T00:00:00Z', to: '2030-01-08T00:00:00Z' } })
  assert.ok(res.body.jobs.some((j) => j.id === completedJob))
})

test('GET /range: saved ServiceM8 staff and completed events remain available across date views without exposing credentials',async()=>{
 const h=setup(),remote=id(80);
 h.tables.servicem8_connections=[{business_id:BIZ,generation:id(81),dispatch_seeded_at:'2026-10-01T00:00:00Z',api_key_enc:'must-never-leak',last_error:null}];
 h.tables.external_object_mappings=[{business_id:BIZ,connection_generation:id(81),object_type:'staff',local_id:'servicem8:'+remote,external_uuid:remote,snapshot:{name:'Jordan',email:'staff@example.test'}}];
 h.tables.calendar_events=[{id:id(82),business_id:BIZ,user_id:null,source:'servicem8',external_id:'completed:'+id(83),start_time:'2024-05-10T01:00:00Z',end_time:'2024-05-10T02:00:00Z',details:{jobUuid:id(83),status:'Completed',assignedStaff:['Jordan'],assignedStaffIds:['servicem8:'+remote],secret:'no'}}];
 const res=await h.run('get','/api/job-calendar/range',{query:{from:'2030-01-01T00:00:00Z',to:'2030-01-08T00:00:00Z'}});
 assert.equal(res.statusCode,200);assert.ok(res.body.staff.some(x=>x.id==='servicem8:'+remote&&x.readOnly));
 assert.equal(res.body.events.length,1);assert.equal(res.body.events[0].details.status,'Completed');
 assert.equal(res.body.events[0].details.jobUuid,id(83));assert.deepEqual(res.body.events[0].details.assignedStaffIds,['servicem8:'+remote]);
 assert.doesNotMatch(JSON.stringify(res.body),/must-never-leak|secret/);
 const techRes=await h.run('get','/api/job-calendar/range',{userId:tech,query:{from:'2030-01-01T00:00:00Z',to:'2030-01-08T00:00:00Z'}});
 assert.equal(techRes.body.staff.length,1);
});

test('GET /range: cancelled jobs are excluded', async () => {
  const h = setup()
  const res = await h.run('get', '/api/job-calendar/range', { query: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z' } })
  assert.ok(!res.body.jobs.some((j) => j.id === cancelledJob))
})

test('GET /range: rejects a backwards or oversized range', async () => {
  const h = setup()
  const backwards = await h.run('get', '/api/job-calendar/range', { query: { from: '2026-02-02T00:00:00Z', to: '2026-02-01T00:00:00Z' } })
  assert.equal(backwards.statusCode, 400)
  const tooBig = await h.run('get', '/api/job-calendar/range', { query: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' } })
  assert.equal(tooBig.statusCode, 400)
})

test('GET /range: google connection status never includes encrypted tokens', async () => {
  const h = setup()
  h.tables.calendar_connections.push({
    id: connection, business_id: BIZ, user_id: owner, provider: 'google',
    encrypted_tokens: 'super-secret-token-blob', sync_status: 'ok', last_synced_at: '2026-01-01T00:00:00Z'
  })
  const res = await h.run('get', '/api/job-calendar/range', { query: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z' } })
  assert.equal(res.body.google.connected, true)
  assert.equal(res.body.google.syncStatus, 'ok')
  assert.equal(JSON.stringify(res.body).includes('super-secret-token-blob'), false)
})

/* ============================= PUT /jobs/:id ============================= */

const validPut = () => ({
  startAt: '2026-02-01T20:00:00Z', endAt: '2026-02-01T22:00:00Z', dateISO: '2026-02-02', startMin: 9 * 60,
  timeZone: 'Pacific/Auckland', staffIds: [tech], teamLabel: 'Crew A', notes: 'bring ladder', syncGoogle: false
})

test('PUT /jobs/:id: technician cannot manage bookings', async () => {
  const h = setup()
  const res = await h.run('put', `/api/job-calendar/jobs/${job}`, { userId: tech, body: validPut() })
  assert.equal(res.statusCode, 403)
})

test('PUT /jobs/:id: owner/manager can book without changing sales stage; the RPC receives mapped params and response is detail-whitelisted', async () => {
  let received
  const h = setup({
    rpcImpl: async (fn, params) => {
      received = { fn, params }
      return { data: { id: job, status: 'new', assigned_to: tech, scheduled_date: '2026-02-01', updated_at: '2026-02-01T00:00:00Z', details: { calendarStartAt: params.p_start_at, calendarEndAt: params.p_end_at, cost: 1234 } }, error: null }
    }
  })
  const res = await h.run('put', `/api/job-calendar/jobs/${job}`, { userId: manager, body: validPut() })
  assert.equal(res.statusCode, 200)
  assert.equal(received.fn, 'job_calendar_book')
  assert.deepEqual(received.params.p_staff_ids, [tech])
  assert.equal(received.params.p_timezone, 'Pacific/Auckland')
  assert.equal(res.body.job.status, 'new')
  assert.deepEqual(Object.keys(res.body.job.details).sort(), ['calendarEndAt', 'calendarStartAt'])
})

test('PUT /jobs/:id: rejects a dateISO/startMin that does not match startAt in the given time zone', async () => {
  const h = setup()
  const res = await h.run('put', `/api/job-calendar/jobs/${job}`, { userId: owner, body: { ...validPut(), startMin: 1 } })
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /do not match/)
})

test('PUT /jobs/:id: rejects an invalid IANA time zone', async () => {
  const h = setup()
  const res = await h.run('put', `/api/job-calendar/jobs/${job}`, { userId: owner, body: { ...validPut(), timeZone: 'Not/AZone' } })
  assert.equal(res.statusCode, 400)
})

test('PUT /jobs/:id: rejects a booking window over 24 hours', async () => {
  const h = setup()
  const res = await h.run('put', `/api/job-calendar/jobs/${job}`, { userId: owner, body: { ...validPut(), endAt: '2026-02-03T20:00:00Z' } })
  assert.equal(res.statusCode, 400)
})

test('PUT /jobs/:id: a scheduling conflict from the database (multi-staff overlap) becomes 409, not a silent override', async () => {
  const h = setup({ rpcImpl: async () => { const e = new Error('Scheduling conflict: a staff member already has a booked job during this time'); e.code = '23P01'; throw e } })
  const res = await h.run('put', `/api/job-calendar/jobs/${job}`, { userId: owner, body: { ...validPut(), staffIds: [tech, otherTech] } })
  assert.equal(res.statusCode, 409)
})

test('PUT /jobs/:id: a lost/cancelled job cannot be booked until its stage changes', async () => {
  const h = setup({ rpcImpl: async () => { const e = new Error('This job is lost/cancelled — change its stage before booking it'); e.code = '22023'; throw e } })
  const res = await h.run('put', `/api/job-calendar/jobs/${cancelledJob}`, { userId: owner, body: validPut() })
  assert.equal(res.statusCode, 400)
})

/* ============================= POST /blocks ============================= */

test('POST /blocks: a technician can only block their own time', async () => {
  const h = setup({ rpcImpl: async () => { const e = new Error('You can only block your own time'); e.code = '42501'; throw e } })
  const res = await h.run('post', '/api/job-calendar/blocks', { userId: tech, body: { id: id(50), startAt: '2026-02-01T00:00:00Z', endAt: '2026-02-02T00:00:00Z', allDay: true, staffId: otherTech, blockType: 'holiday' } })
  assert.equal(res.statusCode, 403)
})

test('POST /blocks: coexists with existing jobs and reports a conflicting-jobs count rather than silently cancelling them', async () => {
  const h = setup({ rpcImpl: async () => ({ data: { block: { id: id(50) }, conflicting_jobs: 2 }, error: null }) })
  const res = await h.run('post', '/api/job-calendar/blocks', { userId: owner, body: { id: id(50), startAt: '2026-02-01T00:00:00Z', endAt: '2026-02-02T00:00:00Z', allDay: true, staffId: null, blockType: 'business_closed' } })
  assert.equal(res.statusCode, 201)
  assert.equal(res.body.conflictingJobs, 2)
})

test('POST /blocks: rejects an invalid block type and a non-UUID id', async () => {
  const h = setup()
  const badType = await h.run('post', '/api/job-calendar/blocks', { userId: owner, body: { id: id(50), startAt: '2026-02-01T00:00:00Z', endAt: '2026-02-02T00:00:00Z', blockType: 'vacation-on-mars' } })
  assert.equal(badType.statusCode, 400)
  const badId = await h.run('post', '/api/job-calendar/blocks', { userId: owner, body: { id: 'not-a-uuid', startAt: '2026-02-01T00:00:00Z', endAt: '2026-02-02T00:00:00Z', blockType: 'holiday' } })
  assert.equal(badId.statusCode, 400)
})

/* ============================= DELETE /blocks/:id ============================= */

test('DELETE /blocks/:id: a technician cannot remove someone else\'s block, but can remove their own', async () => {
  const h = setup()
  h.tables.availability_blocks.push({ id: id(60), business_id: BIZ, user_id: otherTech, block_type: 'sick', start_at: '2026-02-01T00:00:00Z', end_at: '2026-02-02T00:00:00Z' })
  h.tables.availability_blocks.push({ id: id(61), business_id: BIZ, user_id: tech, block_type: 'sick', start_at: '2026-02-01T00:00:00Z', end_at: '2026-02-02T00:00:00Z' })

  const denied = await h.run('delete', `/api/job-calendar/blocks/${id(60)}`, { userId: tech })
  assert.equal(denied.statusCode, 403)
  assert.equal(h.tables.availability_blocks.length, 2)

  const allowed = await h.run('delete', `/api/job-calendar/blocks/${id(61)}`, { userId: tech })
  assert.equal(allowed.statusCode, 200)
  assert.equal(h.tables.availability_blocks.length, 1)
})

test('DELETE /blocks/:id: a block from another business is not found, not deleted', async () => {
  const h = setup()
  h.tables.availability_blocks.push({ id: id(62), business_id: OTHER_BIZ, user_id: foreignUser, block_type: 'sick', start_at: '2026-02-01T00:00:00Z', end_at: '2026-02-02T00:00:00Z' })
  const res = await h.run('delete', `/api/job-calendar/blocks/${id(62)}`, { userId: owner })
  assert.equal(res.statusCode, 404)
  assert.equal(h.tables.availability_blocks.length, 1)
})

/* ============================= POST /jobs/:id/google ============================= */

function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  return fn().finally(() => { global.fetch = original })
}

test('POST /jobs/:id/google: 503 while Google Calendar is not configured on this server', async () => {
  const h = setup({ googleConfigured: () => false })
  h.tables.jobs[0].details = { calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z' }
  const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
  assert.equal(res.statusCode, 503)
})

test('POST /jobs/:id/google: 400 when the job has not been booked onto the calendar yet', async () => {
  const h = setup()
  const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /Book this job/)
})

test('POST /jobs/:id/google: 400 and records sync intent when the current user has no Google connection', async () => {
  let patched
  const h = setup({ rpcImpl: async (_name, p) => { patched = p; return { data: { id: job, details: p.p_patch }, error: null } } })
  h.tables.jobs[0].details = { calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z' }
  const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
  assert.equal(res.statusCode, 400)
  assert.equal(patched.p_patch.calendarGoogleSync, true) // intent recorded, never pretending synced
})

test('POST /jobs/:id/google: a technician can only sync a job they are assigned to', async () => {
  const h = setup({ getGoogleCalendarToken: async () => ({ accessToken: 'tok', connection: { id: connection } }) })
  h.tables.jobs[0].details = { calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z' }
  const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: tech })
  assert.equal(res.statusCode, 403)
})

test('POST /jobs/:id/google: fresh sync inserts with the deterministic stable id', async () => {
  const calls = []
  const h = setup({
    getGoogleCalendarToken: async () => ({ accessToken: 'tok', connection: { id: connection } }),
    rpcImpl: async (_name, p) => ({ data: { id: job, details: p.p_patch }, error: null })
  })
  h.tables.jobs[0].details = { calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z' }

  await withFetch(async (url, opts) => {
    calls.push({ url: String(url), method: opts.method })
    return { ok: true, status: 200, json: async () => ({ id: JSON.parse(opts.body).id }) }
  }, async () => {
    const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
    assert.equal(res.statusCode, 200)
    assert.match(res.body.googleEventId, /^tk[0-9a-f]{40}$/)
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
})

test('POST /jobs/:id/google: a lost/duplicate insert response (409) falls back to PATCHing the same stable id — no duplicate event, no crash', async () => {
  const h = setup({
    getGoogleCalendarToken: async () => ({ accessToken: 'tok', connection: { id: connection } }),
    rpcImpl: async (_name, p) => ({ data: { id: job, details: p.p_patch }, error: null })
  })
  h.tables.jobs[0].details = { calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z' }

  const calls = []
  await withFetch(async (url, opts) => {
    calls.push({ url: String(url), method: opts.method })
    if (opts.method === 'POST') return { ok: false, status: 409, json: async () => ({ error: 'already exists' }) }
    return { ok: true, status: 200, json: async () => ({ id: 'whatever' }) }
  }, async () => {
    const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
    assert.equal(res.statusCode, 200)
    assert.match(res.body.googleEventId, /^tk[0-9a-f]{40}$/)
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[1].method, 'PATCH')
  assert.ok(calls[1].url.endsWith(calls[0].url.endsWith('events') ? '' : '')) // sanity, exact id checked above
})

test('POST /jobs/:id/google: an existing event known to belong to the SAME current user is PATCHed directly, not re-inserted', async () => {
  const stableLikeId = 'tk' + 'a'.repeat(40)
  const h = setup({
    getGoogleCalendarToken: async () => ({ accessToken: 'tok', connection: { id: connection } }),
    rpcImpl: async (_name, p) => ({ data: { id: job, details: p.p_patch }, error: null })
  })
  h.tables.jobs[0].details = {
    calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z',
    googleEventId: stableLikeId, _googleEventOwnerId: owner
  }

  const calls = []
  await withFetch(async (url, opts) => {
    calls.push({ url: String(url), method: opts.method })
    return { ok: true, status: 200, json: async () => ({ id: stableLikeId }) }
  }, async () => {
    const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.googleEventId, stableLikeId)
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'PATCH')
})

test('POST /jobs/:id/google: an event id stored under a DIFFERENT user is never PATCHed — goes straight to the deterministic id path', async () => {
  const h = setup({
    getGoogleCalendarToken: async () => ({ accessToken: 'tok', connection: { id: connection } }),
    rpcImpl: async (_name, p) => ({ data: { id: job, details: p.p_patch }, error: null })
  })
  h.tables.jobs[0].details = {
    calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z',
    googleEventId: 'some-legacy-random-id', _googleEventOwnerId: manager // different user than the caller below
  }

  const calls = []
  await withFetch(async (url, opts) => {
    calls.push({ url: String(url), method: opts.method })
    return { ok: true, status: 200, json: async () => ({ id: JSON.parse(opts.body).id || 'some-legacy-random-id' }) }
  }, async () => {
    const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
    assert.equal(res.statusCode, 200)
    assert.notEqual(res.body.googleEventId, 'some-legacy-random-id')
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.ok(!calls[0].url.includes('some-legacy-random-id'))
})

test('POST /jobs/:id/google: an external failure keeps the booking durably saved, records out-of-sync intent, never leaks the raw Google error', async () => {
  let patched
  const h = setup({
    getGoogleCalendarToken: async () => ({ accessToken: 'tok', connection: { id: connection } }),
    rpcImpl: async (_name, p) => { patched = p; return { data: { id: job, details: p.p_patch }, error: null } }
  })
  h.tables.jobs[0].details = { calendarStartAt: '2026-02-01T08:00:00Z', calendarEndAt: '2026-02-01T09:00:00Z' }

  await withFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'super secret internal google trace xyz' } }) }), async () => {
    const res = await h.run('post', `/api/job-calendar/jobs/${job}/google`, { userId: owner })
    assert.equal(res.statusCode, 502)
    assert.equal(JSON.stringify(res.body).includes('super secret internal google trace'), false)
  })
  assert.equal(patched.p_patch.calendarGoogleSync, true)
  assert.equal(patched.p_patch.googleEventId, undefined) // never pretends synced
})

test('a not-migrated database error becomes a clear 503, not a crash', async () => {
  const h = setup({ rpcImpl: async () => { const e = new Error('relation "job_calendar" does not exist'); e.code = '42P01'; throw e } })
  const res = await h.run('put', `/api/job-calendar/jobs/${job}`, { userId: owner, body: validPut() })
  assert.equal(res.statusCode, 503)
})

/* =========================================================================
   SQL-level tests against the CANONICAL migration (owned by the parent —
   never overwritten or copied-over from here). Not skipped if missing:
   that file is a tracked, committed part of this repo, not an ephemeral
   handoff artifact, so its absence is a real failure, not an expected gap.
   ========================================================================= */
const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations/20261018094524_job_calendar_booking.sql')

test('SQL schema: tenant/role-checked, serialized, overlap-safe booking + idempotent blocks', async (t) => {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8')
  const { PGlite } = await import('@electric-sql/pglite')
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist')
  const db = new PGlite({ extensions: { btree_gist } })
  const BIZ_A = 'test-biz-a'
  const uidOwner = '11111111-1111-4111-8111-111111111111'
  const uidTechA = '44444444-4444-4444-8444-444444444444'
  const uidTechB = '55555555-5555-4555-8555-555555555555'
  const jobA = '33333333-3333-4333-8333-333333333333'
  const jobB = '77777777-7777-4777-8777-777777777777'
  const jobCancelled = '88888888-8888-4888-8888-888888888888'

  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    create table public.businesses(id text primary key);
    create table public.users(id uuid primary key, business_id text, role text);
    create table public.jobs(id uuid primary key default gen_random_uuid(), business_id text, customer_id uuid, assigned_to uuid, status text not null default 'new', scheduled_date date, details jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table public.availability_blocks(id uuid primary key default gen_random_uuid(), business_id text not null, user_id uuid, block_type text not null default 'unavailable', start_at timestamptz not null, end_at timestamptz not null, all_day boolean not null default true, reason text, created_by uuid, created_at timestamptz not null default now());
    create table public.calendar_events(id uuid primary key default gen_random_uuid(), business_id text not null, user_id uuid not null, connection_id uuid, external_id text, title text, start_time timestamptz not null, end_time timestamptz not null, busy_status text not null default 'busy', source text not null default 'external', notes text, created_by uuid, created_at timestamptz not null default now());
    insert into public.businesses values ('${BIZ_A}');
    insert into public.users(id, business_id, role) values
      ('${uidOwner}', '${BIZ_A}', 'owner'),
      ('${uidTechA}', '${BIZ_A}', 'technician'),
      ('${uidTechB}', '${BIZ_A}', 'technician');
    insert into public.jobs(id, business_id, status) values
      ('${jobA}', '${BIZ_A}', 'new'), ('${jobB}', '${BIZ_A}', 'new'), ('${jobCancelled}', '${BIZ_A}', 'cancelled');
  `)
  await db.exec(schemaSql)
  await t.test('migration is idempotent', async () => { await db.exec(schemaSql) })

  const book = (jobId, startAt, endAt, staff, caller = uidOwner) =>
    db.query(`select * from job_calendar_book($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [BIZ_A, caller, jobId, startAt, endAt, 'UTC', staff, 'Team A', 'notes', true, null, null])

  await t.test('owner books jobA for techA — sales stage stays unchanged', async () => {
    const { rows } = await book(jobA, '2026-02-01T08:00:00Z', '2026-02-01T10:00:00Z', [uidTechA])
    assert.equal(rows[0].status, 'new')
    assert.equal(rows[0].assigned_to, uidTechA)
  })

  await t.test('a technician cannot book (only owner/manager can manage bookings)', async () => {
    await assert.rejects(book(jobB, '2026-03-01T08:00:00Z', '2026-03-01T09:00:00Z', [uidTechA], uidTechA), /owner or manager/)
  })

  await t.test('overlapping staff across two different jobs is rejected as a conflict', async () => {
    await assert.rejects(book(jobB, '2026-02-01T09:00:00Z', '2026-02-01T09:30:00Z', [uidTechA]), /Scheduling conflict/)
  })

  await t.test('back-to-back bookings (end exactly equals next start) do NOT conflict — half-open range', async () => {
    const { rows } = await book(jobB, '2026-02-01T10:00:00Z', '2026-02-01T11:00:00Z', [uidTechA])
    assert.equal(rows[0].status, 'new')
  })

  await t.test('a lost/cancelled job cannot be booked', async () => {
    await assert.rejects(book(jobCancelled, '2026-02-05T08:00:00Z', '2026-02-05T09:00:00Z', [uidTechA]), /lost\/cancelled/)
  })

  await t.test('an availability block for a staff member blocks a new booking for them', async () => {
    await db.query(`select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [BIZ_A, uidOwner, '99999999-9999-4999-8999-999999999991', '2026-02-10T00:00:00Z', '2026-02-11T00:00:00Z', true, uidTechB, 'holiday', 'leave'])
    await assert.rejects(book(jobA, '2026-02-10T08:00:00Z', '2026-02-10T09:00:00Z', [uidTechB]), /unavailable/)
  })

  await t.test('a whole-business block (user_id null) blocks every staff member', async () => {
    await db.query(`select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [BIZ_A, uidOwner, '99999999-9999-4999-8999-999999999992', '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z', true, null, 'business_closed', 'closed for training'])
    await assert.rejects(book(jobA, '2026-03-10T08:00:00Z', '2026-03-10T09:00:00Z', [uidTechA]), /unavailable/)
  })

  await t.test('cached calendar busy time blocks a new booking, except the job\'s OWN previously-synced google event', async () => {
    await db.query(`insert into public.calendar_events(business_id, user_id, external_id, start_time, end_time, busy_status) values ($1,$2,$3,$4,$5,'busy')`,
      [BIZ_A, uidTechA, 'ext-busy-1', '2026-04-01T08:00:00Z', '2026-04-01T09:00:00Z'])
    await assert.rejects(book(jobB, '2026-04-01T08:00:00Z', '2026-04-01T09:00:00Z', [uidTechA]), /busy/)

    await db.query(`update public.jobs set details = jsonb_build_object('googleEventId','ext-busy-1') where id = $1`, [jobB])
    await db.query(`update public.calendar_events set external_id = 'ext-busy-1' where business_id = $1 and user_id = $2`, [BIZ_A, uidTechA])
    const { rows } = await book(jobB, '2026-04-01T08:00:00Z', '2026-04-01T09:00:00Z', [uidTechA])
    assert.equal(rows[0].status, 'new')
  })

  await t.test('a block is idempotent for a reused id with matching content, and reports a conflicting-jobs count instead of silently cancelling the job', async () => {
    const blockId = '99999999-9999-4999-8999-999999999993'
    const first = await db.query(`select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [BIZ_A, uidOwner, blockId, '2026-02-01T08:00:00Z', '2026-02-01T09:00:00Z', false, uidTechA, 'holiday', 'leave'])
    assert.ok(first.rows[0].conflicting_jobs >= 1) // jobA already booked for techA 08:00-10:00 that day
    const second = await db.query(`select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [BIZ_A, uidOwner, blockId, '2026-02-01T08:00:00Z', '2026-02-01T09:00:00Z', false, uidTechA, 'holiday', 'leave'])
    assert.equal(second.rows[0].block.id, first.rows[0].block.id)
    const count = await db.query(`select count(*)::int n from availability_blocks where id = $1`, [blockId])
    assert.equal(count.rows[0].n, 1)
  })

  await t.test('a technician can only block their own time, not someone else\'s', async () => {
    await assert.rejects(
      db.query(`select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [BIZ_A, uidTechA, '99999999-9999-4999-8999-999999999994', '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', true, uidTechB, 'sick', null]),
      /only block your own time/
    )
  })

  await t.test('job_calendar_set_google_status merges details rather than overwriting them', async () => {
    await db.query(`update public.jobs set details = $2 where id = $1`, [jobA, JSON.stringify({ calendarNotes: 'keep me' })])
    const { rows } = await db.query(`select * from job_calendar_set_google_status($1,$2,$3)`, [BIZ_A, jobA, JSON.stringify({ googleEventId: 'tkabc' })])
    assert.equal(rows[0].details.calendarNotes, 'keep me')
    assert.equal(rows[0].details.googleEventId, 'tkabc')
  })

  await t.test('neither anon nor authenticated can execute these functions directly', async () => {
    await db.exec('set role authenticated')
    try {
      await assert.rejects(
        db.query(`select * from job_calendar_book($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [BIZ_A, uidOwner, jobA, '2026-06-01T08:00:00Z', '2026-06-01T09:00:00Z', 'UTC', [uidTechA], 'x', 'y', true, null, null]),
        /permission denied/
      )
    } finally {
      await db.exec('reset role')
    }
  })

  await db.close()
})


test('native event routes validate input and forward trusted tenant/caller to private RPCs', async () => {
  const calls = []
  const h = setup({ rpcImpl: async (name, params) => { calls.push({ name, params }); return { data: { id: id(80) } } } })
  const body = { id: id(80), staffId: tech, title: 'Site visit', startAt: '2026-10-19T01:00Z', endAt: '2026-10-19T02:00Z', busyStatus: 'busy', timeZone: 'Pacific/Auckland', businessId: OTHER_BIZ, callerId: foreignUser }
  assert.equal((await h.run('post', '/api/job-calendar/events', { body })).statusCode, 201)
  assert.equal(calls[0].name, 'job_calendar_upsert_event')
  assert.equal(calls[0].params.p_business_id, BIZ)
  assert.equal(calls[0].params.p_caller_id, owner)
  for (const patch of [{ title: '' }, { id: 'bad' }, { staffId: 'bad' }, { endAt: body.startAt }, { busyStatus: 'other' }, { timeZone: 'invalid' }]) {
    assert.equal((await h.run('post', '/api/job-calendar/events', { body: { ...body, ...patch } })).statusCode, 400)
  }
  assert.equal(calls.length, 1)
})

test('event SQL auth/conflict/not-found failures map correctly, without raw failures leaking', async () => {
  for (const [code, message, status] of [['42501','External calendar events are read-only',403], ['23P01','Scheduling conflict',409], ['22023','Event not found',404], ['PGRST202','missing RPC',503], ['XX000','private trace',500]]) {
    const h = setup({ rpcImpl: async () => ({ error: { code, message } }) })
    const res = await h.run('delete', `/api/job-calendar/events/${id(80)}`)
    assert.equal(res.statusCode, status)
    assert.equal(JSON.stringify(res.body).includes('private trace'), false)
  }
})

test('unschedule is owner/manager only and returns filtered details with Google warning', async () => {
  let params
  const h = setup({ rpcImpl: async (_name, p) => { params = p; return { data: { id: job, status: 'quoted', scheduled_date: null, details: { total: 500, calendarGoogleSync: false, googleEventId: 'keep' } } } } })
  assert.equal((await h.run('post', `/api/job-calendar/jobs/${job}/unschedule`, { userId: tech })).statusCode, 403)
  assert.equal(params, undefined)
  const res = await h.run('post', `/api/job-calendar/jobs/${job}/unschedule`, { userId: manager })
  assert.equal(res.statusCode, 200)
  assert.equal(params.p_caller_id, manager)
  assert.equal(res.body.job.status, 'quoted')
  assert.equal(res.body.job.details.total, undefined)
  assert.equal(res.body.job.details.googleEventId, 'keep')
  assert.match(res.body.googleWarning, /remains unchanged/)
})
