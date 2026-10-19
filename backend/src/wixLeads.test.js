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
  test('leaves name empty for an unrecognised shape', () => {
    const c = mapWixPayload({ someWeirdField: 'whatever' })
    assert.equal(c.name, '')
  })
})

describe('handleWixLead', () => {
  const okSource = { business_id: 'biz-123' }

  test('valid submission is saved via addLead and returns 200', async () => {
    const addLeadCalls = []
    const result = await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe', email: 'jane@example.com' },
      lookupSource: async () => okSource,
      addLead: async (payload) => { addLeadCalls.push(payload); return { id: 'lead-1' } }
    })
    assert.equal(result.status, 200)
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

  test('duplicate delivery (addLead reports deduped) is still a 200 but flagged so the caller skips re-notifying', async () => {
    const result = await handleWixLead({
      token: 'good-token',
      body: { name: 'Jane Doe', submissionId: 'sub-1' },
      lookupSource: async () => okSource,
      addLead: async () => ({ id: 'lead-1', deduped: true })
    })
    assert.equal(result.status, 200)
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

test('empty, missing-name, whitespace and structured-name payloads never reach storage', async () => {
  for (const body of [undefined, null, {}, [], { message: 'hello' }, { email: 'jane@example.com' }, { name: '  ' }, { name: {} }, { data: {} }, { contact: { name: [] } }]) {
    const result = await handleWixLead({ token: 'test', body, lookupSource: async () => ({ business_id: 'A' }), addLead: async () => { assert.fail('invalid lead persisted') } })
    assert.equal(result.status, 400)
    assert.match(result.body.error, /name/i)
  }
})

test('supported wrappers preserve contact fields and nested submission identity', async () => {
  for (const wrapper of ['flat', 'data', 'contact']) {
    const fields = { first_name: ' Jane ', last_name: 'Doe', email_address: 'jane@example.com', phone_number: '0211234567', street_address: '1 Test St', comments: 'Please call', submissionId: 'sub-123' }
    const result = await handleWixLead({ token: 'test', body: wrapper === 'flat' ? fields : { [wrapper]: fields }, lookupSource: async () => ({ business_id: 'A' }), addLead: async payload => {
      assert.equal(payload.customer.name, 'Jane Doe'); assert.equal(payload.customer.email, 'jane@example.com'); assert.equal(payload.customer.phone, '0211234567'); assert.equal(payload.customer.notes, 'Please call'); assert.equal(payload.external_id, 'sub-123'); return { id: 'saved' }
    } })
    assert.equal(result.status, 200)
  }
})

test('concurrent Wix deliveries converge through Supabase unique violation recovery', async () => {
  const { createSupabaseStorage } = await import('./storage/supabase.js')
  const rows = new Map()
  const client = { from() { return {
    insert(row) { return { select() { return { async single() {
      // Both handlers race through the storage adapter. The unique index is
      // represented by one atomic insert check, as PostgreSQL provides.
      await new Promise(resolve => setImmediate(resolve))
      const key = [row.business_id, row.source, row.external_id].join(':')
      if (rows.has(key)) return { data: null, error: { code: '23505' } }
      const saved = { ...row, id: 'saved-' + rows.size, created_at: '2026-10-15T00:00:00Z' }; rows.set(key, saved)
      return { data: saved, error: null }
    } } } } },
    select() { const filters = []; const chain = { eq(key, value) { filters.push([key,value]); return chain }, async maybeSingle() { return { data: [...rows.values()].find(row => filters.every(([key,value]) => row[key] === value)), error: null } } }; return chain }
  } } }
  const storage = createSupabaseStorage('unused', 'unused', { client })
  const invoke = token => handleWixLead({ token, body: { data: { name: 'Jane', submissionId: 'same-submission' } }, lookupSource: async () => ({ business_id: token }), addLead: payload => storage.addLead(payload) })
  const results = await Promise.all([invoke('A'), invoke('A'), invoke('B')])
  assert.deepEqual(results.map(r => r.status), [200,200,200])
  assert.equal(results[0].body.id, results[1].body.id)
  assert.equal(results.filter(r => r.deduped).length, 1)
  assert.notEqual(results[0].body.id, results[2].body.id)
  assert.equal(rows.size, 2)
})

test('native Old Wix Forms answers and nested contact normalize without static placeholders', async()=>{
 const body={data:{submissionId:'native-event-1',contact:{name:{first:'Test',last:'Customer'},email:'test@example.test',phone:'+6421000000'},submissions:[{label:'Address',value:'Test address'},{label:'Requested service',value:'House wash'},{label:'Enquiry message',value:'Please quote'}]}};
 assert.deepEqual(mapWixPayload(body),{name:'Test Customer',email:'test@example.test',phone:'+6421000000',address:'Test address',notes:'Please quote',source:'Wix'});
 let saved;const result=await handleWixLead({token:'valid-native-token',body,lookupSource:async()=>({business_id:'business-a'}),addLead:async p=>{saved=p;return {id:'id'};}});
 assert.equal(result.status,200);assert.equal(saved.external_id,'native-event-1');assert.deepEqual(saved.requestedServices,['House wash']);
});
test('labelled native form values work without a contact object and reject structured identity',()=>{
 const c=mapWixPayload({submissions:[{label:'First name',value:'Test'},{label:'Last name',value:'Customer'},{label:'Email',value:'test@example.test'}]});assert.equal(c.name,'Test Customer');assert.equal(c.email,'test@example.test');
 assert.equal(mapWixPayload({data:{contact:{name:{first:{bad:true},last:[]}}}}).name,'');
});
test('nested Wix submission wrapper keeps identity and form values available for redelivery dedupe', async()=>{
 const body={data:{submission:{_id:'nested-sub-17',firstName:'Nested',lastName:'Customer',email:'nested@example.test',service:'Driveway wash'}}};
 let saved;
 const result=await handleWixLead({token:'t',body,lookupSource:async()=>({business_id:'business-a'}),addLead:async payload=>{saved=payload;return{id:'saved'};}});
 assert.equal(result.status,200);assert.equal(saved.external_id,'nested-sub-17');assert.equal(saved.customer.name,'Nested Customer');assert.deepEqual(saved.requestedServices,['Driveway wash']);
});
test('a storage adapter that does not confirm a lead id cannot cause a false 200', async()=>{
 const result=await handleWixLead({token:'t',body:{name:'Jane'},lookupSource:async()=>({business_id:'business-a'}),addLead:async()=>({})});
 assert.equal(result.status,500);assert.equal(result.body.ok,undefined);
});

test('requestedServices arrays survive common Wix wrappers without coercing structured values', async () => {
  const fields = { name: 'Jane', requestedServices: [' House wash ', 'Driveway wash', {}, ['Roof wash'], true, null, ''] }
  const bodies = [fields, { data: fields }, { contact: fields }, { submission: fields },
    { data: { contact: fields } }, { data: { submission: fields } }]
  for (const body of bodies) {
    const result = await handleWixLead({ token: 't', body, lookupSource: async () => ({ business_id: 'A' }),
      addLead: async payload => {
        assert.deepEqual(payload.requestedServices, ['House wash', 'Driveway wash'])
        return { id: 'saved' }
      } })
    assert.equal(result.status, 200)
  }
})

test('plural native service labels retain separate answers in flat and nested submissions', async () => {
  for (const label of ['Requested services', 'Requested service', 'Services', 'Services required']) {
    const fields = { submissions: [
      { label: 'Full name', value: ' Jane Doe ' },
      { label: 'Email address', value: 'jane@example.test' },
      { label, value: [' House wash ', 'Roof wash', { value: 'invalid' }] },
    ] }
    for (const body of [fields, { data: fields }, { submission: fields }, { data: { submission: fields } }]) {
      const result = await handleWixLead({ token: 't', body, lookupSource: async () => ({ business_id: 'A' }),
        addLead: async payload => {
          assert.equal(payload.customer.name, 'Jane Doe')
          assert.equal(payload.customer.email, 'jane@example.test')
          assert.deepEqual(payload.requestedServices, ['House wash', 'Roof wash'])
          return { id: 'saved' }
        } })
      assert.equal(result.status, 200)
    }
  }
})

test('Wix service answers and native field scans stay bounded', async () => {
  for (const body of [
    { name: 'Jane', requestedServices: Array(110).fill('x'.repeat(600)) },
    { name: 'Jane', submissions: [{ label: 'Requested services', value: Array(110).fill('x'.repeat(600)) }] },
  ]) {
    const result = await handleWixLead({ token: 't', body, lookupSource: async () => ({ business_id: 'A' }),
      addLead: async payload => {
        assert.equal(payload.requestedServices.length, 100)
        assert.ok(payload.requestedServices.every(value => value.length === 500))
        return { id: 'saved' }
      } })
    assert.equal(result.status, 200)
  }
  assert.equal(mapWixPayload({ submissions: [
    ...Array(100).fill({ label: 'Unknown', value: 'ignored' }), { label: 'Name', value: 'Too late' },
  ] }).name, '')
})

test('repeat contacts do not become duplicate submissions, but explicit submission IDs survive wrappers', async () => {
  const wrap = fields => [fields, { data: fields }, { submission: fields }, { data: { submission: fields } }]
  for (const contact of [{ id: 'same-contact' }, { _id: 'same-contact' }]) {
    for (const body of wrap({ name: 'Jane', contact })) {
      const externalIds = []
      const invoke = () => handleWixLead({ token: 't', body, lookupSource: async () => ({ business_id: 'A' }),
        addLead: async payload => { externalIds.push(payload.external_id); return { id: `saved-${externalIds.length}` } } })
      const first = await invoke(), second = await invoke()
      assert.deepEqual([first.status, second.status], [200, 200])
      assert.deepEqual(externalIds, [null, null])
      assert.notEqual(first.body.id, second.body.id)
    }
  }
  for (const body of wrap({ name: 'Jane', contact: { id: 'contact', submissionId: 'sub-explicit' } })) {
    const result = await handleWixLead({ token: 't', body, lookupSource: async () => ({ business_id: 'A' }),
      addLead: async payload => { assert.equal(payload.external_id, 'sub-explicit'); return { id: 'saved' } } })
    assert.equal(result.status, 200)
  }
})

test('native answer normalization still rejects invalid contact fields before storage', async () => {
  const result = await handleWixLead({ token: 't', body: { data: { submission: { submissions: [
    { label: 'Name', value: 'Jane' }, { label: 'Email', value: ['bad-email'] },
  ] } } }, lookupSource: async () => ({ business_id: 'A' }), addLead: async () => assert.fail('invalid lead persisted') })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /email/i)
})
