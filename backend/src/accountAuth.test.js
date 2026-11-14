import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Execute the real gate and lead handlers without server startup, environment
// loading, provider calls, or access to an actual Supabase project.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
function block(start, end) {
  const offset = source.indexOf(start)
  assert.ok(offset >= 0, start)
  const limit = source.indexOf(end, offset)
  assert.ok(limit > offset, end)
  return source.slice(offset, limit)
}
function harness({ user = { id: 'staff' }, authError = null, profile = { business_id: 'team', role: 'owner' }, profileError = null, throwsAt } = {}) {
  const calls = [], handlers = {}
  const authClient = {
    auth: { async getUser(token) {
      calls.push(['getUser', token])
      if (throwsAt === 'auth') throw new Error('private auth diagnostics and token')
      return { data: { user }, error: authError }
    } },
    from(table) {
      calls.push(['from', table])
      const q = {
        select(columns) { calls.push(['select', columns]); return q },
        eq(key, value) { calls.push(['eq', key, value]); return q },
        async maybeSingle() {
          if (throwsAt === 'profile') throw new Error('private database diagnostics')
          return { data: profile, error: profileError }
        }
      }
      return q
    }
  }
  const gate = vm.runInNewContext(
    block('async function resolveBusiness(', 'const storage =') +
    block('async function requireBusiness(', '// Deep checks') + ';requireBusiness', { authClient }
  )
  vm.runInNewContext(block("app.get('/api/leads/pending'", '/* ====================================================================='), {
    app: {
      get(path, _gate, handler) { handlers[path] = handler },
      post(path, _gate, handler) { handlers[path] = handler }
    }, requireBusiness: gate,
    storage: {
      async getPendingLeads(businessId) { calls.push(['pending', businessId]); return [{ id: 'lead', payload: {} }] },
      async ackLeads(businessId, ids) { calls.push(['ack', businessId, ids]); return { ok: true } }
    }
  })
  return { gate, calls, handlers }
}
function response() {
  return { code: 200, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
}
async function authorize(h, header = 'Bearer valid-token', path = '/api/leads/pending') {
  const req = { originalUrl: path, url: '/status', get: () => header, body: { businessId: 'foreign', userId: 'owner', role: 'owner' }, query: { businessId: 'foreign' } }
  const res = response()
  let passed = false
  await h.gate(req, res, () => { passed = true })
  return { req, res, passed }
}

test('missing and malformed bearer credentials never reach auth or tenant handlers', async () => {
  for (const header of ['', 'Basic password', 'Bearer ']) {
    const h = harness()
    const { res, passed } = await authorize(h, header)
    assert.equal(res.code, 401)
    assert.equal(passed, false)
    assert.deepEqual(h.calls, [])
  }
})

test('invalid, expired or deleted sessions stop before service-role profile access', async () => {
  for (const options of [{ user: null }, { authError: { message: 'expired private token' } }]) {
    const h = harness(options)
    const { res, passed } = await authorize(h)
    assert.equal(res.code, 401)
    assert.equal(res.body.error, 'Invalid session')
    assert.equal(passed, false)
    assert.deepEqual(h.calls, [['getUser', 'valid-token']])
  }
})

test('missing/deleted profiles and failed profile lookups fail closed', async () => {
  for (const options of [{ profile: null }, { profileError: { message: 'private SQL error' } }]) {
    const { res, passed } = await authorize(harness(options))
    assert.equal(res.code, 401)
    assert.equal(res.body.error, 'Invalid session')
    assert.equal(passed, false)
  }
})

test('profiles without a usable tenant cannot enter business routes', async () => {
  for (const business_id of [null, undefined, '', '   ', 42]) {
    const { res, passed } = await authorize(harness({ profile: { business_id } }))
    assert.equal(res.code, 401, String(business_id))
    assert.equal(passed, false)
  }
})

test('thrown auth and profile failures return a safe response without an unhandled rejection', async () => {
  for (const throwsAt of ['auth', 'profile']) {
    const { res, passed } = await authorize(harness({ throwsAt }))
    assert.equal(res.code, 503)
    assert.equal(res.body.error, 'Could not validate session')
    assert.equal(passed, false)
  }
})

test('staff, managers and owners use the verified current tenant and never body identities', async () => {
  for (const role of ['technician', 'manager', 'owner']) {
    const h = harness({ profile: { business_id: 'team', role } })
    const { req, res, passed } = await authorize(h, undefined, role === 'technician' ? '/api/job-work/portal' : '/api/leads/pending')
    assert.equal(passed, true)
    assert.equal(req.businessId, 'team')
    assert.equal(req.userId, 'staff')
    assert.ok(h.calls.some(call => JSON.stringify(call) === JSON.stringify(['eq', 'id', 'staff'])))
    if (role === 'technician') continue
    await h.handlers['/api/leads/pending'](req, res)
    req.body.ids = ['foreign-lead']
    await h.handlers['/api/leads/ack'](req, res)
    assert.deepEqual(h.calls.slice(-2), [['pending', 'team'], ['ack', 'team', ['foreign-lead']]])
  }
})

test('each request revalidates membership after a teammate is moved or removed', async () => {
  const profile = { business_id: 'team', role: 'owner' }
  const h = harness({ profile })
  assert.equal((await authorize(h)).req.businessId, 'team')
  profile.business_id = 'other-team'
  assert.equal((await authorize(h)).req.businessId, 'other-team')
  profile.business_id = null
  assert.equal((await authorize(h)).passed, false)
  assert.equal(h.calls.filter(call => call[0] === 'getUser').length, 3)
})

test('technicians are centrally denied private company APIs, including mounted routes and forged roles', async () => {
  for (const path of ['/api/email/send','/api/conversations','/api/sales/settings','/api/payments/status','/api/marketing/overview','/api/servicem8/status','/api/pricing-learning/settings','/api/calendar/connections','/api/extension/servicem8/jobs/id','/api/leads/pending','/api/job-calendar/range','/api/job-work-evil/portal']) {
    const h=harness({profile:{business_id:'team',role:'technician'}})
    const result=await authorize(h,undefined,path)
    assert.equal(result.res.code,403,path);assert.equal(result.passed,false,path)
  }
  for (const path of ['/api/job-work/portal?date=2026-11-14','/api/job-work/logs','/api/job-work/post-job/settings','/api/job-work/jobs/id/photos']) {
    assert.equal((await authorize(harness({profile:{business_id:'team',role:'technician'}}),undefined,path)).passed,true)
  }
  for (const role of [null,undefined,'owner-from-metadata']) assert.equal((await authorize(harness({profile:{business_id:'team',role}}))).passed,false)
})
