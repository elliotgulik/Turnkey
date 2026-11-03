import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Isolate the production handlers: no environment loading, server startup,
// real database, OAuth refresh, email delivery, or Stripe requests.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
function block(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from)
  return source.slice(from, to)
}
function harness({ lookupError, lookupThrows, updateError, sendError } = {}) {
  const events = [], queries = [], writes = [], handlers = {}
  const rows = {
    customers: [{ id: 'customer', business_id: 'mine' }, { id: 'foreign-customer', business_id: 'foreign' }],
    quotes: [{ id: 'quote', business_id: 'mine' }, { id: 'foreign-quote', business_id: 'foreign' }],
    invoices: [{ id: 'invoice', business_id: 'mine' }, { id: 'foreign-invoice', business_id: 'foreign' }]
  }
  const authClient = { from(table) {
    const query = { table, filters: [], action: 'select' }
    const q = {
      select() { return q },
      eq(key, value) { query.filters.push([key, value]); return q },
      ilike(key, value) { query.filters.push([key, value]); return q },
      async maybeSingle() {
        queries.push(query); events.push('lookup:' + table)
        if (lookupThrows === table) throw new Error('private lookup details')
        if (lookupError === table) return { data: null, error: { message: 'private database details' } }
        const data = (rows[table] || []).find(row => query.filters.every(([k, v]) => row[k] === v)) || null
        return { data, error: null }
      },
      insert(data) { query.action = 'insert'; query.data = data; return q },
      update(data) { query.action = 'update'; query.data = data; return q },
      then(resolve, reject) {
        writes.push(query); events.push(query.action + ':' + table)
        return Promise.resolve({ error: query.action === 'update' && updateError ? { message: 'private update details' } : null }).then(resolve, reject)
      },
      catch(fn) { return q.then(value => value, fn) }
    }
    return q
  } }
  const context = {
    Buffer, URLSearchParams, authClient, requireBusiness() {},
    console: { error() {} },
    app: { post(path, _auth, handler) { handlers[path] = handler } },
    escLike: value => value,
    async getValidAccessToken(biz, user, provider) {
      assert.deepEqual([biz, user, provider], ['mine', 'staff', 'gmail'])
      events.push('token'); return { accessToken: 'fake', account: { id: 'account', email_address: 'staff@example.test' } }
    },
    gmail: { async sendMessage(token, message) {
      assert.equal(token, 'fake'); events.push('email'); events.push(message)
      if (sendError) throw new Error('private provider details')
      return { id: 'sent', threadId: 'thread' }
    } },
    isStripeConfigured: () => true, STRIPE_SECRET_KEY: 'fake-test-value',
    async fetch(url, options) {
      events.push({ url, params: Object.fromEntries(options.body) })
      return { ok: true, json: async () => url.endsWith('/prices') ? { id: 'price' } : { url: 'https://example.test/pay' } }
    }
  }
  vm.runInNewContext(block("app.post('/api/email/send', requireBusiness", '/* ====================================================================='), context)
  vm.runInNewContext(block("app.post('/api/payments/create-link'", '// Verifies a Stripe'), context)
  async function call(path, body) {
    const res = { code: 200, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
    await handlers[path]({ businessId: 'mine', userId: 'staff', body }, res)
    return res
  }
  return { events, queries, writes, call }
}
const email = { to: 'customer@example.test', subject: 'Quote', bodyText: 'Hello', type: 'quote' }
const payment = { amountCents: 15000, description: 'Invoice' }
const emailPath = '/api/email/send', paymentPath = '/api/payments/create-link'
const externalEvents = h => h.events.filter(e => e === 'token' || e === 'email' || e?.url)

for (const [key, table, own] of [['customerId', 'customers', 'customer'], ['quoteId', 'quotes', 'quote'], ['invoiceId', 'invoices', 'invoice']]) {
  test(`email rejects foreign and missing ${key} before any side effect, even without log type`, async () => {
    for (const id of ['foreign-' + own, 'missing']) {
      for (const type of ['quote', undefined]) {
        const h = harness()
        const res = await h.call(emailPath, { ...email, type, [key]: id, businessId: 'foreign' })
        assert.equal(res.code, 404)
        assert.equal(res.body.error, 'Email reference not found')
        assert.deepEqual(externalEvents(h), [])
        assert.deepEqual(h.writes, [])
        assert.deepEqual(h.queries[0].filters, [['business_id', 'mine'], ['id', id]])
      }
    }
  })
  test(`email ${key} lookup failures fail closed and never write failed logs with unverified references`, async () => {
    for (const failure of ['lookupError', 'lookupThrows']) {
      const h = harness({ [failure]: table })
      const res = await h.call(emailPath, { ...email, [key]: own })
      assert.equal(res.code, 500)
      assert.equal(res.body.error, 'Failed to send email')
      assert.deepEqual(externalEvents(h), [])
      assert.deepEqual(h.writes, [])
    }
  })
}

test('valid email references all validate before provider access and preserve payload and audit records', async () => {
  const h = harness()
  const attachment = { filename: 'quote.pdf', contentBase64: 'test' }
  const res = await h.call(emailPath, { ...email, customerId: 'customer', quoteId: 'quote', invoiceId: 'invoice', attachment })
  assert.equal(res.code, 200)
  assert.deepEqual(h.events.slice(0, 5), ['lookup:customers', 'lookup:quotes', 'lookup:invoices', 'token', 'email'])
  assert.equal(h.events[5].attachment, attachment)
  assert.equal(h.events[5].to, email.to)
  assert.deepEqual(h.writes.map(q => q.table), ['emails', 'activity_log', 'email_logs'])
  for (const q of h.writes) assert.equal(q.data.business_id, 'mine')
  assert.equal(h.writes[2].data.quote_id, 'quote')
  assert.equal(h.writes[2].data.invoice_id, 'invoice')
})

test('email without references remains supported and customer inference stays tenant-scoped', async () => {
  const h = harness()
  assert.equal((await h.call(emailPath, email)).code, 200)
  assert.equal(h.events[0], 'token')
  assert.deepEqual(h.queries[0].filters, [['business_id', 'mine'], ['email', email.to]])
})

test('email provider failure still records a failed log for validated references only', async () => {
  const h = harness({ sendError: true })
  assert.equal((await h.call(emailPath, { ...email, customerId: 'customer' })).code, 500)
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].data.status, 'failed')
  assert.equal(h.writes[0].data.customer_id, 'customer')
})

test('payment rejects foreign/missing invoices without Stripe calls or invoice updates', async () => {
  for (const invoiceId of ['foreign-invoice', 'missing']) {
    const h = harness()
    const res = await h.call(paymentPath, { ...payment, invoiceId, businessId: 'foreign' })
    assert.equal(res.code, 404)
    assert.equal(res.body.error, 'Invoice not found')
    assert.deepEqual(externalEvents(h), [])
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.queries[0].filters, [['business_id', 'mine'], ['id', invoiceId]])
  }
})

test('payment lookup failures return safe errors without external side effects', async () => {
  for (const failure of ['lookupError', 'lookupThrows']) {
    const h = harness({ [failure]: 'invoices' })
    const res = await h.call(paymentPath, { ...payment, invoiceId: 'invoice' })
    assert.equal(res.code, 500)
    assert.equal(res.body.error, 'Could not create a payment link')
    assert.deepEqual(externalEvents(h), [])
    assert.deepEqual(h.writes, [])
  }
})

test('valid payment preserves Stripe payload and scopes invoice update by tenant and ID', async () => {
  const h = harness()
  assert.equal((await h.call(paymentPath, { ...payment, invoiceId: 'invoice' })).code, 200)
  assert.equal(h.events[0], 'lookup:invoices')
  const external = externalEvents(h)
  assert.equal(external.length, 2)
  assert.equal(external[0].params.unit_amount, '15000')
  assert.equal(external[1].params['metadata[invoice_id]'], 'invoice')
  assert.deepEqual(h.writes[0].filters, [['business_id', 'mine'], ['id', 'invoice']])
  assert.equal(h.writes[0].data.payment_link_url, 'https://example.test/pay')
})

test('payment without an invoice remains supported, while update failures cannot report success', async () => {
  const h = harness()
  assert.equal((await h.call(paymentPath, payment)).code, 200)
  assert.equal(externalEvents(h).length, 2)
  assert.deepEqual(h.writes, [])
  const failed = harness({ updateError: true })
  assert.equal((await failed.call(paymentPath, { ...payment, invoiceId: 'invoice' })).code, 500)
})

test('structured reference values are rejected before database or provider access', async () => {
  for (const [path, body] of [[emailPath, { ...email, quoteId: { id: 'quote' } }], [paymentPath, { ...payment, invoiceId: ['invoice'] }]]) {
    const h = harness()
    assert.equal((await h.call(path, body)).code, 400)
    assert.deepEqual(h.queries, [])
    assert.deepEqual(externalEvents(h), [])
    assert.deepEqual(h.writes, [])
  }
})
