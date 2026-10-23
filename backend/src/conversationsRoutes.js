import * as gmail from './providers/gmail.js'

const unwrap = async q => { const { data, error } = await q; if (error) throw error; return data }
const fail = (message, status = 400) => Object.assign(new Error(message), { publicMessage: message, status })
const scope = (q, req) => q.eq('business_id', req.businessId).eq('user_id', req.userId)
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
export function validateDraft(input = {}) {
  const out = {}
  for (const [key, max] of Object.entries({ to: 2000, subject: 998, bodyText: 100000, replyToId: 36, opportunityId: 100 })) {
    const value = input[key] ?? ''
    if (typeof value !== 'string' || value.length > max || (key !== 'bodyText' && /[\r\n]/.test(value))) throw fail('Invalid ' + key)
    out[key] = value
  }
  // Non-authoritative client correlation only. Authorization never uses it.
  if (input.document != null) {
    const d = input.document;
    if (!d || !['quote', 'invoice'].includes(d.mode) || typeof d.recordId !== 'string' || !d.recordId || d.recordId.length > 100) throw fail('Invalid document context')
    out.document = { mode: d.mode, recordId: d.recordId }
  }
  if (out.replyToId && !uuid(out.replyToId)) throw fail('Invalid reply message')
  if (!Array.isArray(input.attachments || []) || (input.attachments || []).length > 10) throw fail('Use at most 10 attachments')
  let bytes = 0
  out.attachments = (input.attachments || []).map(a => {
    if (a?.savedAttachmentId) {
      if (!uuid(a.savedAttachmentId)) throw fail('Invalid saved attachment')
      return { savedAttachmentId: a.savedAttachmentId, filename: String(a.filename || 'Quote.pdf').slice(0, 180) }
    }
    try {
      const [file] = gmail.validateAttachments([a]); bytes += Buffer.from(file.contentBase64, 'base64').length; return file
    } catch (e) { throw fail(e.message) }
  })
  if (bytes > gmail.MAX_ATTACHMENT_BYTES) throw fail('Attachments must total at most 12 MB')
  return out
}

// Install after JSON parsing and requireBusiness has been defined. The token
// helper is the existing OAuth/refresh helper; no second credential store.
export function installConversations(app, { db, requireBusiness, getValidAccessToken, provider = gmail }) {
  const wrap = fn => async (req, res) => {
    try { await fn(req, res) } catch (e) {
      res.status(e.status || 503).json({ error: e.publicMessage || 'Conversations could not complete this request. Please retry.' })
    }
  }
  const route = (method, path, fn) => app[method]('/api/conversations' + path, requireBusiness, wrap(fn))
  const account = async req => unwrap(scope(db.from('email_accounts').select('id,email_address,provider').eq('provider', 'gmail'), req).maybeSingle())
  const ownMessage = async (req, id, acct) => {
    if (!uuid(id)) throw fail('Invalid message')
    const row = await unwrap(db.from('emails').select('*').eq('business_id', req.businessId).eq('account_id', acct.id).eq('id', id).maybeSingle())
    if (!row) throw fail('Message not found', 404)
    return row
  }
  const draft = async (req, id) => {
    if (!uuid(id)) throw fail('Invalid draft')
    const row = await unwrap(scope(db.from('conversation_drafts').select('*').eq('id', id), req).maybeSingle())
    if (!row) throw fail('Draft not found', 404)
    return row
  }
  route('get', '/messages', async (req, res) => {
    const acct = await account(req)
    if (!acct) return res.json({ account: null, messages: [], stars: [], hasMore: false })
    const offset = Math.max(0, Math.min(100000, Number.parseInt(req.query.offset, 10) || 0))
    const messages = await unwrap(db.from('emails').select('*').eq('business_id', req.businessId).eq('account_id', acct.id).order('sent_at', { ascending: false }).order('id').range(offset, offset + 199))
    const stars = await unwrap(scope(db.from('conversation_stars').select('thread_key').eq('account_id', acct.id), req))
    res.json({ account: acct, messages, stars: stars.map(s => s.thread_key), hasMore: messages.length === 200 })
  })
  route('put', '/stars/:messageId', async (req, res) => {
    const acct = await account(req); if (!acct) throw fail('Connect Gmail first')
    const row = await ownMessage(req, req.params.messageId, acct)
    const key = row.thread_id || row.id
    if (typeof req.body?.starred !== 'boolean') throw fail('Missing starred value')
    if (req.body.starred) await unwrap(db.from('conversation_stars').upsert({ business_id: req.businessId, user_id: req.userId, account_id: acct.id, thread_key: key }, { onConflict: 'business_id,user_id,account_id,thread_key' }))
    else await unwrap(scope(db.from('conversation_stars').delete().eq('account_id', acct.id).eq('thread_key', key), req))
    res.json({ ok: true })
  })
  route('get', '/drafts', async (req, res) => res.json({ drafts: await unwrap(scope(db.from('conversation_drafts').select('*').neq('status', 'sent'), req).order('updated_at', { ascending: false })) }))
  route('put', '/drafts/:id', async (req, res) => {
    if (!uuid(req.params.id)) throw fail('Invalid draft')
    const payload = validateDraft(req.body)
    // Insert if absent, then conditional update prevents stale composers from
    // resurrecting sent drafts or overwriting a send already in progress.
    await unwrap(db.from('conversation_drafts').upsert({ id: req.params.id, business_id: req.businessId, user_id: req.userId, payload }, { onConflict: 'id', ignoreDuplicates: true }))
    const saved = await unwrap(scope(db.from('conversation_drafts').update({ payload, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('status', 'draft'), req).select().maybeSingle())
    if (!saved) throw fail('This draft is being sent or has already been sent. Refresh Conversations.', 409)
    res.json({ draft: saved })
  })
  route('delete', '/drafts/:id', async (req, res) => {
    const row = await draft(req, req.params.id)
    if (row.status === 'sending') throw fail('A send is in progress; refresh before deleting', 409)
    await unwrap(scope(db.from('conversation_drafts').delete().eq('id', row.id).neq('status', 'sending'), req))
    res.json({ ok: true })
  })
  route('get', '/quote-attachments', async (req, res) => {
    const files = await unwrap(db.from('attachments').select('id,filename,job_id,customer_id,created_at').eq('business_id', req.businessId).eq('kind', 'quote_attachment').order('created_at', { ascending: false }).limit(200))
    res.json({ attachments: files.filter(f => /\.pdf$/i.test(f.filename || '')) })
  })
  const resolveFiles = async (req, files) => {
    const result = []
    let bytes = 0
    for (const file of files) {
      if (!file.savedAttachmentId) { result.push(file); bytes += Buffer.from(file.contentBase64, 'base64').length; continue }
      const saved = await unwrap(db.from('attachments').select('*').eq('id', file.savedAttachmentId).eq('business_id', req.businessId).eq('kind', 'quote_attachment').maybeSingle())
      if (!saved || !saved.path.startsWith(req.businessId + '/') || saved.path.split('/').includes('..') || !/\.pdf$/i.test(saved.filename || '')) throw fail('Saved quote PDF is unavailable', 404)
      const blob = await unwrap(db.storage.from('turnkey-uploads').download(saved.path))
      if (blob.size + bytes > gmail.MAX_ATTACHMENT_BYTES) throw fail('Attachments must total at most 12 MB')
      const buffer = Buffer.from(await blob.arrayBuffer())
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw fail('Saved attachment is not a PDF')
      bytes += buffer.length
      result.push({ filename: saved.filename, mimeType: 'application/pdf', contentBase64: buffer.toString('base64') })
    }
    try { return gmail.validateAttachments(result) } catch (e) { throw fail(e.message) }
  }
  route('post', '/send', async (req, res) => {
    const row = await draft(req, req.body?.draftId)
    if (row.status === 'sent') return res.json({ ok: true, id: row.sent_message_id, alreadySent: true })
    if (row.status !== 'draft') throw fail('Gmail confirmation is pending or unknown. Check Sent or sync before trying again.', 409)
    const payload = validateDraft(row.payload)
    if (!payload.to.trim() || !payload.subject.trim() || !payload.bodyText.trim()) throw fail('Recipient, subject and message are required')
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(payload.to)) throw fail('Enter one valid recipient email address')
    const auth = await getValidAccessToken(req.businessId, req.userId, 'gmail')
    if (!auth || auth.account.business_id !== req.businessId || auth.account.user_id !== req.userId) throw fail('Connect your Gmail account in Connections first')
    const files = await resolveFiles(req, payload.attachments)
    let reply = {}
    if (payload.replyToId) {
      const source = await ownMessage(req, payload.replyToId, auth.account)
      const original = await provider.getMessage(auth.accessToken, source.provider_message_id)
      reply = { threadId: source.thread_id, inReplyTo: original.messageId, references: original.messageId }
    }
    const claimed = await unwrap(scope(db.from('conversation_drafts').update({ status: 'sending', updated_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'draft').eq('updated_at', row.updated_at), req).select('id').maybeSingle())
    if (!claimed) throw fail('This draft is already being sent', 409)
    let sent
    try {
      sent = await provider.sendMessage(auth.accessToken, { from: auth.account.email_address, to: payload.to, subject: payload.subject, bodyText: payload.bodyText, attachments: files, ...reply })
      if (!sent?.id) throw Error('Missing confirmation')
    } catch (e) {
      const rejected = e.code === 'SEND_REJECTED'
      await scope(db.from('conversation_drafts').update({ status: rejected ? 'draft' : 'unknown' }).eq('id', row.id), req)
      return res.status(rejected ? 502 : 504).json({ error: rejected ? e.message : 'Gmail did not confirm delivery. Your draft is preserved. Check Sent or sync before sending again.', deliveryUnknown: !rejected })
    }
    // Once Gmail confirms acceptance, local persistence errors must never be
    // reported as send failures: that would encourage duplicate delivery.
    const warnings = []
    try {
      await unwrap(scope(db.from('conversation_drafts').update({ status: 'sent', sent_message_id: sent.id, updated_at: new Date().toISOString() }).eq('id', row.id), req))
    } catch { warnings.push('Gmail accepted the message, but the draft status could not be saved. Do not resend.') }
    // Gmail has accepted delivery and the idempotency guard is now `sent`.
    // Indexing the message is recoverable through mailbox sync, so keep it
    // off the critical response path that the composer is waiting on.
    void unwrap(db.from('emails').upsert({ business_id: req.businessId, account_id: auth.account.id, provider_message_id: sent.id, thread_id: sent.threadId || reply.threadId || null, direction: 'sent', from_address: auth.account.email_address, to_addresses: payload.to, subject: payload.subject, body_text: payload.bodyText, snippet: payload.bodyText.slice(0, 140), sent_at: new Date().toISOString() }, { onConflict: 'account_id,provider_message_id' }))
      .catch(() => console.error('[Conversations] Sent message indexing failed; mailbox sync can repair it.'))
    res.json({ ok: true, id: sent.id, threadId: sent.threadId, warning: warnings.join(' ') || undefined })
  })
}
