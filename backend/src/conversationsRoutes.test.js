import test from 'node:test'
import assert from 'node:assert/strict'
import { installConversations, validateDraft } from './conversationsRoutes.js'
import { buildRawMessage, sendMessage, MAX_ATTACHMENT_BYTES } from './providers/gmail.js'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = id(1), other = id(2), acct = id(3), draftId = id(4), messageId = id(5)
function setup({ send, failMirror = false, status = 'draft', payload = {}, draftUser = user, failDraftFinalize = false } = {}) {
  const tables = {
    email_accounts: [{ id: acct, user_id: user, business_id: 'A', provider: 'gmail', email_address: 'me@example.com' }],
    conversation_drafts: [{ id: draftId, business_id: 'A', user_id: draftUser, status, updated_at: '2026-10-15T00:00:00Z', payload: { to: 'client@example.com', subject: 'Hello', bodyText: 'A message', attachments: [], ...payload } }],
    emails: [{ id: messageId, business_id: 'A', account_id: acct, thread_id: 'thread-1', provider_message_id: 'original' }, { id: id(6), business_id: 'B', account_id: id(9), thread_id: 'foreign' }],
    conversation_stars: [], attachments: []
  }
  const db = { from(table) {
    tables[table] ||= []; let filters = [], op = 'select', val, opts, one = false
    const q = {
      select() { return q }, order() { return q }, range() { return q }, limit() { return q },
      eq(k, v) { filters.push(r => r[k] === v); return q }, neq(k, v) { filters.push(r => r[k] !== v); return q },
      maybeSingle() { one = true; return q },
      update(v) { op = 'update'; val = v; return q }, delete() { op = 'delete'; return q },
      upsert(v, o) { op = 'upsert'; val = v; opts = o; return q },
      then(resolve, reject) {
        try {
          if (table === 'conversation_drafts' && op === 'update' && val.status === 'sent' && failDraftFinalize) return Promise.resolve({ error: Error('DB offline') }).then(resolve, reject)
          if (table === 'emails' && op === 'upsert' && failMirror) return Promise.resolve({ error: Error('DB offline') }).then(resolve, reject)
          let rows = tables[table].filter(r => filters.every(f => f(r)))
          if (op === 'update') rows.forEach(r => Object.assign(r, val))
          if (op === 'delete') tables[table] = tables[table].filter(r => !rows.includes(r))
          if (op === 'upsert') {
            const keys = (opts?.onConflict || 'id').split(','); const old = tables[table].find(r => keys.every(k => r[k] === val[k]))
            if (old && !opts?.ignoreDuplicates) Object.assign(old, val)
            if (!old) { const row = { status: 'draft', ...structuredClone(val) }; tables[table].push(row); rows = [row] } else rows = [old]
          }
          return Promise.resolve({ data: one ? rows[0] || null : structuredClone(rows), error: null }).then(resolve, reject)
        } catch (e) { return Promise.reject(e).then(resolve, reject) }
      }
    }; return q
  } }
  const routes = {}, guard = () => {}, calls = []
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, auth, handler) => { assert.equal(auth, guard); routes[method + ' ' + path] = handler }]))
  installConversations(app, { db, requireBusiness: guard, getValidAccessToken: async (businessId, userId, provider) => {
    assert.deepEqual([businessId, userId, provider], ['A', user, 'gmail']); return { accessToken: 'fake', account: tables.email_accounts[0] }
  }, provider: {
    getMessage: async () => ({ messageId: '<original@example.com>' }),
    sendMessage: async (...args) => { calls.push(args); return send ? send(...args) : { id: 'accepted', threadId: 'thread-1' } }
  } })
  return { tables, calls, db, async run(method, path, { body, params = {}, query = {}, userId = user } = {}) {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this }, json(value) { this.body = value; return this } }
    await routes[method + ' /api/conversations' + path]({ businessId: 'A', userId, body, params, query }, res)
    return res
  } }
}
test('all routes use business auth and mailbox list excludes another business/account', async () => {
  const h = setup(), res = await h.run('get', '/messages'); assert.equal(res.body.messages.length, 1)
})
test('draft lookup and star message enforce user/business ownership', async () => {
  const h = setup({ draftUser: other })
  assert.equal((await h.run('post', '/send', { body: { draftId } })).statusCode, 404)
  assert.equal((await h.run('put', '/stars/:messageId', { params: { messageId: id(6) }, body: { starred: true } })).statusCode, 404)
  assert.equal(h.calls.length, 0)
})
test('stars persist per user and removing one does not remove another user star', async () => {
  const h = setup(); h.tables.conversation_stars.push({ business_id: 'A', user_id: other, account_id: acct, thread_key: 'thread-1' })
  await h.run('put', '/stars/:messageId', { params: { messageId }, body: { starred: true } })
  assert.equal(h.tables.conversation_stars.length, 2)
  await h.run('put', '/stars/:messageId', { params: { messageId }, body: { starred: false } })
  assert.equal(h.tables.conversation_stars[0].user_id, other)
})
test('confirmed send is idempotent and preserves thread reply headers', async () => {
  const h = setup({ payload: { replyToId: messageId } })
  const res = await h.run('post', '/send', { body: { draftId } })
  assert.equal(res.body.id, 'accepted'); assert.equal(h.calls[0][1].inReplyTo, '<original@example.com>')
  assert.equal(h.calls[0][1].threadId, 'thread-1'); assert.equal(h.tables.conversation_drafts[0].status, 'sent')
  await h.run('post', '/send', { body: { draftId } }); assert.equal(h.calls.length, 1)
})
test('parallel sends claim a draft only once', async () => {
  const h = setup(); const results = await Promise.all([h.run('post', '/send', { body: { draftId } }), h.run('post', '/send', { body: { draftId } })])
  assert.equal(h.calls.length, 1); assert.ok(results.some(r => r.statusCode === 409))
})
test('provider rejection preserves editable draft; uncertain delivery prevents retries', async () => {
  for (const rejected of [true, false]) {
    const h = setup({ send: () => { throw Object.assign(Error('Gmail rejected the message (403)'), { code: rejected ? 'SEND_REJECTED' : '' }) } })
    const result = await h.run('post', '/send', { body: { draftId } })
    assert.equal(result.statusCode, rejected ? 502 : 504)
    assert.equal(h.tables.conversation_drafts[0].status, rejected ? 'draft' : 'unknown')
    assert.equal(h.tables.conversation_drafts[0].payload.bodyText, 'A message')
    if (!rejected) { assert.equal((await h.run('post', '/send', { body: { draftId } })).statusCode, 409); assert.equal(h.calls.length, 1) }
  }
})
test('confirmed delivery does not wait for mailbox-history indexing', async () => {
  const h = setup({ failMirror: true }); const result = await h.run('post', '/send', { body: { draftId } })
  assert.equal(result.body.ok, true); assert.equal(result.body.warning, undefined)
  assert.equal(h.tables.conversation_drafts[0].status, 'sent')
})
test('draft save cannot overwrite sent draft or another user draft', async () => {
  for (const opts of [{ status: 'sent' }, { draftUser: other }]) {
    const h = setup(opts); const res = await h.run('put', '/drafts/:id', { params: { id: draftId }, body: { bodyText: 'overwrite' } })
    assert.equal(res.statusCode, 409); assert.equal(h.tables.conversation_drafts[0].payload.bodyText, 'A message')
  }
})
test('attachment validation rejects header injection, malformed data and oversize combined payload', () => {
  assert.throws(() => validateDraft({ subject: 'Hi\r\nBcc: attacker@example.com' }), /subject/)
  assert.throws(() => validateDraft({ attachments: [{ filename: 'bad', contentBase64: '?' }] }), /attachment/)
  assert.throws(() => validateDraft({ attachments: [1, 2].map(() => ({ contentBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1).toString('base64') })) }), /12 MB/)
  assert.throws(() => buildRawMessage({ from: 'me@example.com', to: 'x\nBcc: y' }), /header/)
})
test('multiple attachments and old single attachment contract produce valid MIME separators', () => {
  const file = { filename: 'photo.png', mimeType: 'image/png', contentBase64: Buffer.from('photo').toString('base64') }
  const raw = Buffer.from(buildRawMessage({ from: 'me@example.com', to: 'you@example.com', subject: 'Kia ora ✓', bodyText: 'Hello', attachments: [file], attachment: { ...file, filename: 'quote.pdf', mimeType: 'application/pdf' } }), 'base64url').toString()
  assert.match(raw, /MIME-Version: 1.0\r\nContent-Type: multipart\/mixed;[^\r]+\r\n\r\n--turnkey_mix_/)
  assert.equal((raw.match(/Content-Disposition: attachment/g) || []).length, 2); assert.match(raw, /filename="quote.pdf"/)
})
test('Gmail HTTP send requires a message ID and propagates rejection safely (mock fetch only)', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }))
  await assert.rejects(sendMessage('fake', { from: 'a@b.co', to: 'c@d.co' }), e => e.code === 'SEND_REJECTED' && e.status === 403)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  await assert.rejects(sendMessage('fake', { from: 'a@b.co', to: 'c@d.co' }), /confirm/)
})
test('saved PDF references cannot cross business boundaries', async () => {
  const h = setup({ payload: { attachments: [{ savedAttachmentId: id(7) }] } })
  h.tables.attachments.push({ id: id(7), business_id: 'B', kind: 'quote_attachment', filename: 'quote.pdf', path: 'B/quote.pdf' })
  assert.equal((await h.run('post', '/send', { body: { draftId } })).statusCode, 404); assert.equal(h.calls.length, 0)
})

test('saved quote PDF is resolved from private storage and sent with its verified filename', async () => {
  const h = setup({ payload: { attachments: [{ savedAttachmentId: id(7), filename: 'spoofed.pdf' }] } })
  h.tables.attachments.push({ id: id(7), business_id: 'A', kind: 'quote_attachment', filename: 'Quote-101.pdf', path: 'A/quotes/101.pdf' })
  h.db.storage = { from(bucket) { assert.equal(bucket, 'turnkey-uploads'); return { async download(path) { assert.equal(path, 'A/quotes/101.pdf'); return { data: new Blob(['%PDF-1.7 test']), error: null } } } } }
  const res = await h.run('post', '/send', { body: { draftId } })
  assert.equal(res.body.ok, true); assert.equal(h.calls[0][1].attachments[0].filename, 'Quote-101.pdf')
})
test('Gmail acceptance with failed draft finalization stays successful and prevents automatic retry', async () => {
  const h = setup({ failDraftFinalize: true }); const res = await h.run('post', '/send', { body: { draftId } })
  assert.equal(res.body.ok, true); assert.match(res.body.warning, /Do not resend/)
  assert.equal((await h.run('post', '/send', { body: { draftId } })).statusCode, 409); assert.equal(h.calls.length, 1)
})

test('generated quote PDF and document context survive draft persistence without upload records', async () => {
  const h = setup();
  const payload = { to: 'client@example.com', subject: 'Your quote', bodyText: 'PDF attached', document: { mode: 'quote', recordId: '7', internalCost: 999 }, attachments: [{ filename: 'Quote-Q-1007.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.7 customer quote').toString('base64') }] }
  const saved = await h.run('put', '/drafts/:id', { params: { id: draftId }, body: payload })
  assert.equal(saved.statusCode, 200); assert.deepEqual(saved.body.draft.payload.document, { mode: 'quote', recordId: '7' })
  const list = await h.run('get', '/drafts'); assert.equal(list.body.drafts[0].payload.attachments[0].contentBase64, payload.attachments[0].contentBase64)
  assert.equal(h.tables.attachments.length, 0)
  const result = await h.run('post', '/send', { body: { draftId } }); assert.equal(result.body.ok, true)
  assert.equal(h.calls[0][1].attachments[0].filename, 'Quote-Q-1007.pdf')
  assert.throws(() => validateDraft({ document: { mode: 'quote', recordId: {} } }), /document/)
})

test('opportunity correlation survives draft saves but remains non-authoritative',()=>{
 assert.equal(validateDraft({opportunityId:'42'}).opportunityId,'42');
 assert.throws(()=>validateDraft({opportunityId:{}}),/opportunityId/);
});
