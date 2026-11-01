import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncHandoffContacts } from './handoffContacts.js'

const apiError = status => Object.assign(new Error(`ServiceM8 ${status}`), { status })

function fixture(scope = 'business-a') {
  const records = new Map([['company/company-1', { uuid: 'company-1', name: 'Old name', unknown: 'keep' }]])
  const maps = new Map()
  const calls = []
  const stamps = []
  const adoptions = []
  const customer = { id: 'customer-1', name: 'Jane Doe', email: 'jane@example.com', phone: '021 123 4567', mobile: '022 765 4321', address: '1 Test St', suburb: 'Takapuna' }
  const args = {
    companyUuid: 'company-1', jobUuid: 'job-1', customer,
    request: async (path, options) => {
      calls.push({ path, ...structuredClone(options) })
      const [pathname, query] = path.split('?')
      const match = pathname.match(/^\/(company|companycontact|jobcontact)(?:\/([^/]+))?\.json$/)
      assert.ok(match, `Unexpected path: ${path}`)
      const [, type, encodedUuid] = match
      const uuid = encodedUuid ? decodeURIComponent(encodedUuid) : undefined
      if (query) {
        const filter = new URLSearchParams(query).get('$filter')
        const [, field, parent] = filter.match(/^(company_uuid|job_uuid) eq '([^']+)'$/)
        return { data: [...records.entries()].filter(([key, row]) => key.startsWith(`${type}/`) && row[field] === parent).map(([, row]) => structuredClone(row)) }
      }
      if (options.method === 'GET') {
        if (!records.has(`${type}/${uuid}`)) throw apiError(404)
        return { data: structuredClone(records.get(`${type}/${uuid}`)) }
      }
      assert.equal(options.method, 'POST')
      if (uuid) {
        if (!records.has(`${type}/${uuid}`)) throw apiError(404)
        Object.assign(records.get(`${type}/${uuid}`), options.body)
      } else {
        const key = `${type}/${options.body.uuid}`
        if (records.has(key)) throw apiError(409)
        records.set(key, structuredClone(options.body))
      }
      return { data: null } // Successful ServiceM8 creates can have an empty body.
    },
    mapping: async (type, id) => {
      const key = `${type}/${id}`
      if (!maps.has(key)) maps.set(key, { external_uuid: `${scope}-${type}-${id}`, synced_at: null })
      return structuredClone(maps.get(key))
    },
    adopt: async (type, id, uuid) => {
      adoptions.push([type, id, uuid])
      maps.get(`${type}/${id}`).external_uuid = uuid
    },
    markSynced: async (type, id) => {
      stamps.push([type, id])
      if (maps.has(`${type}/${id}`)) maps.get(`${type}/${id}`).synced_at = 'done'
    }
  }
  return { args, records, maps, calls, stamps, adoptions, run: () => syncHandoffContacts(args) }
}

const creates = f => f.calls.filter(call => call.method === 'POST' && /^\/(companycontact|jobcontact)\.json$/.test(call.path))
const updates = f => f.calls.filter(call => call.method === 'POST' && /\/[^/]+\//.test(call.path))
function seed(f, resource, type, uuid, extra = {}) {
  f.records.set(`${resource}/${uuid}`, {
    uuid, active: 1, type,
    [resource === 'companycontact' ? 'company_uuid' : 'job_uuid']: resource === 'companycontact' ? 'company-1' : 'job-1',
    first: 'Jane', last: 'Doe', email: 'jane@example.com', ...extra
  })
}

test('fresh handoff creates all four contacts with stable keys, both phones, full addresses and no deprecated job field', async () => {
  const f = fixture()
  assert.deepEqual(await f.run(), { companyUuid: 'company-1', jobUuid: 'job-1' })
  assert.equal(creates(f).length, 4)
  assert.deepEqual([...f.maps.keys()], ['companycontact/customer-1', 'companycontact/customer-1:billing', 'jobcontact/job-1:job', 'jobcontact/job-1:billing'])
  for (const call of creates(f)) {
    assert.equal(call.body.first, 'Jane')
    assert.equal(call.body.last, 'Doe')
    assert.equal(call.body.email, f.args.customer.email)
    assert.equal(call.body.phone, f.args.customer.phone)
    assert.equal(call.body.mobile, f.args.customer.mobile)
    if (call.path === '/jobcontact.json') assert.equal('is_primary_contact' in call.body, false)
    else assert.equal(call.body.is_primary_contact, call.body.type === 'JOB' ? '1' : '0')
  }
  assert.equal(f.records.get('company/company-1').address, '1 Test St, Takapuna')
  assert.equal(f.records.get('company/company-1').billing_address, '1 Test St, Takapuna')
  assert.equal(f.records.get('company/company-1').unknown, 'keep')
  assert.equal(f.stamps.length, 5)
  const writeCount = f.calls.filter(c => c.method === 'POST').length
  await f.run()
  assert.equal(f.calls.filter(c => c.method === 'POST').length, writeCount)
})

test('adopts auto-cloned JOB and BILLING contacts including documented type aliases', async () => {
  const f = fixture()
  for (const resource of ['companycontact', 'jobcontact']) {
    seed(f, resource, 'Job Contact', `${resource}-job`)
    seed(f, resource, 'Billing Contact', `${resource}-billing`)
    seed(f, resource, 'PropertyManager', `${resource}-manager`, { email: 'other@example.com' })
    seed(f, resource, 'JOB', `${resource}-inactive`, { active: '0' })
  }
  await f.run()
  assert.equal(creates(f).length, 0)
  assert.equal(f.adoptions.length, 4)
  for (const resource of ['companycontact', 'jobcontact']) {
    assert.equal(f.records.get(`${resource}/${resource}-job`).type, 'JOB')
    assert.equal(f.records.get(`${resource}/${resource}-billing`).type, 'BILLING')
    assert.equal(f.records.get(`${resource}/${resource}-manager`).email, 'other@example.com')
    assert.equal(f.records.get(`${resource}/${resource}-inactive`).active, '0')
  }
})

test('refreshes mapped contacts on customer corrections even when already stamped', async () => {
  const f = fixture()
  await f.run()
  Object.assign(f.args.customer, { name: 'Janet Smith', email: 'new@example.com', phone: '09999999', mobile: '02888888' })
  await f.run()
  assert.equal(creates(f).length, 4)
  for (const [key, row] of f.records) {
    if (key.startsWith('company/')) continue
    assert.equal(row.first, 'Janet')
    assert.equal(row.last, 'Smith')
    assert.equal(row.email, 'new@example.com')
    assert.equal(row.phone, '09999999')
    assert.equal(row.mobile, '02888888')
  }
})

test('name-only updates preserve legitimate email, phone, mobile, unknown fields and addresses', async () => {
  const f = fixture()
  await f.run()
  const contact = [...f.records.values()].find(row => row.type === 'JOB')
  contact.unknown = 'keep'
  f.args.customer = { id: 'customer-1', name: 'Janet' }
  await f.run()
  assert.equal(contact.first, 'Janet')
  assert.equal(contact.last, '')
  assert.equal(contact.email, 'jane@example.com')
  assert.equal(contact.phone, '021 123 4567')
  assert.equal(contact.mobile, '022 765 4321')
  assert.equal(contact.unknown, 'keep')
  assert.equal(f.records.get('company/company-1').address, '1 Test St, Takapuna')
})

test('phone fallback populates mobile for SMS and mobile-only customer populates phone', async () => {
  for (const field of ['phone', 'mobile']) {
    const f = fixture()
    f.args.customer = { id: 'customer-1', name: 'Jane Doe', [field]: '0211234567' }
    await f.run()
    for (const { body } of creates(f)) {
      assert.equal(body.phone, '0211234567')
      assert.equal(body.mobile, '0211234567')
    }
  }
})

test('preserves distinct remote billing address, honors explicit billing and avoids duplicate suburb', async () => {
  const f = fixture()
  f.records.get('company/company-1').billing_address = 'Property Manager, 50 Other Rd'
  f.args.customer.address = '1 Test St, TAKAPUNA'
  await f.run()
  assert.equal(f.records.get('company/company-1').address, '1 Test St, TAKAPUNA')
  assert.equal(f.records.get('company/company-1').billing_address, 'Property Manager, 50 Other Rd')
  f.args.customer.billing_address = 'PO Box 10, Wellington'
  await f.run()
  assert.equal(f.records.get('company/company-1').billing_address, 'PO Box 10, Wellington')
})

test('adopts identity match among alternates or sole active contact despite old identity', async () => {
  for (const identity of [{ email: 'JANE@EXAMPLE.COM', phone: '' }, { email: '', mobile: '021-123-4567' }]) {
    const f = fixture()
    seed(f, 'companycontact', 'JOB', 'intended', identity)
    seed(f, 'companycontact', 'JOB', 'alternate', { email: 'alternate@example.com', phone: '123' })
    seed(f, 'jobcontact', 'JOB', 'sole-old', { email: 'old@example.com' })
    await f.run()
    assert.equal(f.maps.get('companycontact/customer-1').external_uuid, 'intended')
    assert.equal(f.maps.get('jobcontact/job-1:job').external_uuid, 'sole-old')
    assert.equal(f.records.get('companycontact/alternate').email, 'alternate@example.com')
  }
})

test('ambiguous matches or multiple unidentified contacts fail with actionable public 409', async () => {
  for (const email of ['jane@example.com', 'unrelated@example.com']) {
    const f = fixture()
    seed(f, 'companycontact', 'JOB', 'one', { email })
    seed(f, 'companycontact', 'JOB', 'two', { email })
    await assert.rejects(f.run(), error => error.status === 409 && error.publicMessage === error.message && /Select\/merge/.test(error.message))
    assert.equal(creates(f).length, 0)
    assert.equal(f.stamps.length, 0)
  }
})

test('mapped parent, type and inactive mismatches fail before contact updates', async () => {
  for (const extra of [{ company_uuid: 'other-company' }, { type: 'BILLING' }, { active: 0 }]) {
    const f = fixture()
    seed(f, 'companycontact', 'JOB', 'mapped', extra)
    f.maps.set('companycontact/customer-1', { external_uuid: 'mapped', synced_at: 'done' })
    await assert.rejects(f.run(), error => error.status === 409 && error.publicMessage === error.message)
    assert.equal(creates(f).length, 0)
    assert.equal(updates(f).filter(c => c.path.startsWith('/companycontact/')).length, 0)
    assert.equal(f.stamps.length, 0)
  }
})

test('already mapped job aliases are validated and canonicalized', async () => {
  const f = fixture()
  seed(f, 'jobcontact', 'Job Contact', 'mapped-job')
  f.maps.set('jobcontact/job-1:job', { external_uuid: 'mapped-job', synced_at: 'done' })
  await f.run()
  assert.equal(f.records.get('jobcontact/mapped-job').type, 'JOB')
  assert.equal(f.adoptions.length, 0)
})

test('missing previously synced records recreate using the same reserved UUID', async () => {
  const f = fixture()
  await f.run()
  const uuid = f.maps.get('jobcontact/job-1:job').external_uuid
  f.records.delete(`jobcontact/${uuid}`)
  await f.run()
  assert.equal(creates(f).length, 5)
  assert.equal(creates(f).at(-1).body.uuid, uuid)
})

test('API denials propagate unchanged and prevent completion stamps', async () => {
  for (const deniedPath of ['/company/company-1.json', '/companycontact.json?$filter=', '/jobcontact.json']) {
    const f = fixture()
    const original = f.args.request
    const denied = apiError(403)
    f.args.request = async (path, options) => {
      if (path.startsWith(deniedPath)) throw denied
      return original(path, options)
    }
    await assert.rejects(f.run(), error => error === denied)
    assert.equal(f.stamps.length, 0)
  }
})

test('ambiguous successful POST followed by 409 recovers stable UUID and updates existing values', async () => {
  const f = fixture()
  const original = f.args.request
  let collided = false
  f.args.request = async (path, options) => {
    if (!collided && path === '/companycontact.json' && options.method === 'POST') {
      collided = true
      await original(path, { ...options, body: { ...options.body, first: 'Old' } })
      throw apiError(409)
    }
    return original(path, options)
  }
  await f.run()
  await f.run()
  assert.equal(creates(f).length, 4)
  assert.equal(f.records.get(`companycontact/${f.maps.get('companycontact/customer-1').external_uuid}`).first, 'Jane')
})

test('POST collision with wrong parent fails rather than claiming success', async () => {
  const f = fixture()
  const original = f.args.request
  f.args.request = async (path, options) => {
    if (path === '/jobcontact.json' && options.method === 'POST') {
      await original(path, { ...options, body: { ...options.body, job_uuid: 'other-job' } })
      throw apiError(409)
    }
    return original(path, options)
  }
  await assert.rejects(f.run(), error => error.status === 409 && /parent/.test(error.publicMessage))
  assert.equal(f.stamps.length, 0)
})

test('retry after uncertain POST failure reuses created contact without duplication', async () => {
  const f = fixture()
  const original = f.args.request
  let failed = false
  f.args.request = async (path, options) => {
    const result = await original(path, options)
    if (!failed && path === '/companycontact.json' && options.method === 'POST') {
      failed = true
      throw apiError(503)
    }
    return result
  }
  await assert.rejects(f.run(), { status: 503 })
  assert.equal(f.stamps.length, 0)
  await f.run()
  assert.equal(creates(f).length, 4)
})

test('business selection belongs exclusively to bound callbacks', async () => {
  const a = fixture('business-a')
  const b = fixture('business-b')
  a.args.customer.business_id = 'business-b'
  a.args.businessId = 'business-b'
  await Promise.all([a.run(), b.run()])
  for (const row of a.maps.values()) assert.ok(row.external_uuid.startsWith('business-a-'))
  for (const row of b.maps.values()) assert.ok(row.external_uuid.startsWith('business-b-'))
  assert.equal(a.adoptions.length, 0)
  assert.equal(b.adoptions.length, 0)
})
