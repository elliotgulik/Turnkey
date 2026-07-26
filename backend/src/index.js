import dotenv from 'dotenv'
dotenv.config()

import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { createFileStorage } from './storage/file.js'
import { createSupabaseStorage } from './storage/supabase.js'
import { encryptToken, decryptToken } from './crypto.js'
import * as gmail from './providers/gmail.js'
import * as googleCalendar from './providers/googleCalendar.js'
import { fetchIcs } from './ical.js'
import { sendNotification } from './services/notifications.js'

const PORT = Number(process.env.PORT || 3001)
const STORAGE = (process.env.STORAGE || 'file').toLowerCase()

if (STORAGE === 'supabase') {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      '❌ Supabase storage selected but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.'
    )
    process.exit(1)
  }

  console.log('✅ Supabase storage configured')
}

// Needed regardless of STORAGE mode — /api/leads/pending verifies the CRM's
// real Supabase session to derive the caller's own business_id server-side,
// rather than trusting a client-supplied value.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required (used to verify CRM sessions for lead polling, regardless of STORAGE mode).'
  )
  process.exit(1)
}
const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// Secret used to HMAC-sign the OAuth `state` param (see signState/verifyState
// below) so it can't be tampered with in transit through the user's browser.
// Falls back to SUPABASE_SERVICE_ROLE_KEY — already required and validated
// above — so this works out of the box without a new required env var;
// set OAUTH_STATE_SECRET explicitly on Render for a cleaner separation of
// secrets. (This used to be named SYNC_KEY, reusing the old shared-API-key
// variable from a since-removed route — that declaration was deleted when
// that route was removed, but signState/verifyState kept referencing the
// bare `SYNC_KEY` identifier, which had gone undeclared. That's a
// ReferenceError on every single call, i.e. every "Connect Google"/"Connect
// Gmail" click — see the OAuth start routes' try/catch for how that used to
// surface as a generic, misleading "check your internet" error.)
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY

async function resolveBusiness(accessToken) {
  const { data: userData, error: userErr } = await authClient.auth.getUser(accessToken)
  if (userErr || !userData?.user) return null

  const { data: profile, error: profileErr } = await authClient
    .from('users')
    .select('business_id')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (profileErr || !profile) return null
  return { businessId: profile.business_id, userId: userData.user.id }
}

const storage =
  STORAGE === 'supabase'
    ? createSupabaseStorage(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : createFileStorage(process.env.DATA_DIR || './data')


const app = express()

app.set('trust proxy', 1) // needed for req.ip to reflect the real client (behind Render's proxy), not the proxy itself
app.use(cors())
// `verify` captures the exact raw request bytes into req.rawBody alongside
// the normal parsed req.body — needed for the Stripe webhook below, which
// must verify its signature against the untouched raw payload, not a
// re-serialized copy of the parsed JSON (Stripe's HMAC won't match a
// re-stringified body, even if the content is logically identical). Capturing
// it here avoids the usual express.raw()-before-express.json() route-order
// dance for one route — every other route just ignores req.rawBody.
app.use(express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf } }))

// Lightweight in-memory rate limiter for the one truly public write route
// (POST /api/leads — no auth by design, since a customer submitting a quote
// has no Supabase session yet). Single-process/in-memory is fine for this
// app's actual deployment shape (one Render instance); it resets on restart
// and won't share state across horizontally-scaled instances, which is an
// acceptable, documented limitation rather than a full distributed limiter.
function rateLimit({ windowMs, max }) {
  const hits = new Map() // ip -> [timestamps]
  return (req, res, next) => {
    const now = Date.now()
    const ip = req.ip || 'unknown'
    const timestamps = (hits.get(ip) || []).filter((t) => now - t < windowMs)
    if (timestamps.length >= max) {
      return res.status(429).json({ error: 'Too many requests — please try again shortly' })
    }
    timestamps.push(now)
    hits.set(ip, timestamps)
    if (hits.size > 5000) { // simple unbounded-growth guard — drop the oldest-looking entries
      for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k) }
    }
    next()
  }
}
const leadsRateLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 12 })
// Higher ceiling than leads — a single quote page visit fires at most one
// quote-viewed and one quote-responded call, but many customers can share
// an office/mobile-carrier NAT IP visiting different quotes in the same window.
const notifyRateLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 40 })


async function requireBusiness(req, res, next) {
  const auth = req.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization bearer token' })
  }

  const resolved = await resolveBusiness(token)

  if (!resolved) {
    return res.status(401).json({ error: 'Invalid session' })
  }

  req.businessId = resolved.businessId
  req.userId = resolved.userId
  next()
}


app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    storage: STORAGE,
    timestamp: new Date().toISOString()
  })
})


// The old whole-app /api/state (GET/POST) has been removed — it stored one
// unscoped row keyed by a single shared SYNC_KEY, with no business_id at
// all, so any business's key could overwrite every other business's entire
// dataset in one shot. It was already unreachable from the CRM UI (nothing
// sets a sync key from Connections any more); real sync goes through the
// per-business Supabase tables under RLS instead.


// Basic shape/size validation for the one route the public can post to
// without any auth — rejects obviously-malformed or abusive payloads before
// they ever reach storage. Deliberately permissive on content (this isn't
// the place to second-guess a legitimate customer's address or notes), just
// bounds the shape so a scripted attacker can't stuff huge arrays/strings
// into a single quote request.
function validateLeadPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Invalid lead payload'
  const c = payload.customer
  if (!c || typeof c !== 'object') return 'Invalid lead payload'
  if (!c.name || typeof c.name !== 'string' || c.name.length > 200) return 'A valid name is required'
  if (c.email && (typeof c.email !== 'string' || c.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))) return 'That email address doesn\'t look right'
  if (c.phone && (typeof c.phone !== 'string' || c.phone.length > 40)) return 'That phone number doesn\'t look right'
  if (c.address && (typeof c.address !== 'string' || c.address.length > 500)) return 'That address is too long'
  if (c.notes && (typeof c.notes !== 'string' || c.notes.length > 4000)) return 'Notes are too long'
  if (payload.areas) {
    if (!Array.isArray(payload.areas) || payload.areas.length > 100) return 'Too many mapped areas'
    for (const a of payload.areas) {
      if (a && Array.isArray(a.points) && a.points.length > 500) return 'A mapped area has too many points'
    }
  }
  if (payload.photos && (!Array.isArray(payload.photos) || payload.photos.length > 12)) return 'Too many photos'
  return null
}

app.post('/api/leads', leadsRateLimit, async (req, res) => {
  try {
    const payload = req.body

    if (!payload || !payload.customer) {
      return res.status(400).json({
        error: 'Invalid lead payload'
      })
    }

    if (!payload.business_id || typeof payload.business_id !== 'string') {
      return res.status(400).json({
        error: 'Missing business_id — check the booking page\'s ?biz= link'
      })
    }

    const validationError = validateLeadPayload(payload)
    if (validationError) {
      return res.status(400).json({ error: validationError })
    }

    const lead = await storage.addLead(payload)

    // Server-side, unlike the existing notifyOwner('new_lead',...) email
    // alert (index.html) which only fires while a CRM tab is open polling
    // /api/leads/pending — this fires the instant the booking form is
    // submitted, reaching the owner's phone even with TurnKey closed.
    // Fire-and-forget: a push failure must never fail the lead submission
    // itself (sendNotification already never throws, but the lead response
    // below doesn't wait on it either way).
    sendNotification(authClient, {
      business_id: payload.business_id,
      type: 'new_lead',
      title: 'New enquiry received',
      message: 'New customer enquiry from ' + (payload.customer.name || 'a customer'),
      url: '/index.html?open=pipeline'
    }).catch((err) => console.error('new_lead notification failed', err))

    res.status(201).json({
      ok: true,
      id: lead.id
    })

  } catch (err) {
    console.error('POST /api/leads', err)

    res.status(500).json({
      error: 'Failed to save lead'
    })
  }
})

/* =====================================================================
   PUSH NOTIFICATIONS (OneSignal) — one authenticated trigger for events
   that originate from a signed-in CRM action (job booked, quote marked
   won/accepted by staff, payment recorded manually), plus two
   unauthenticated-but-token-scoped triggers for events that originate from
   the public quote page (quote.html has no Supabase session). The actual
   OneSignal REST call and the in-app notification-history log both live in
   services/notifications.js — every route below just resolves the right
   business_id/title/message and calls the same sendNotification().
   ===================================================================== */

// Generic trigger for any CRM-originated event. The frontend already knows
// which of the 6 event types just happened and what the message should say
// (same string-building logic notifyOwner()'s email path already has) — this
// just needs req.businessId (from the caller's own session, never trusted
// from the request body) to resolve subscriptions and to scope the
// in-app-history row correctly.
app.post('/api/notifications/send', requireBusiness, async (req, res) => {
  const { type, title, message, url } = req.body || {}
  if (!title || !message) return res.status(400).json({ error: 'title and message are required' })
  try {
    const result = await sendNotification(authClient, { business_id: req.businessId, type, title, message, url })
    res.json(result)
  } catch (err) {
    console.error('POST /api/notifications/send', err)
    res.status(500).json({ error: 'Could not send notification' })
  }
})

// Called once by quote.html right after it successfully loads a quote via
// get_public_quote (that RPC stays a pure read, as documented in
// schema-public-quote.sql — this route does the one-time write instead).
// Looked up by the same unguessable public_token as the RPC, never by id —
// a client can't cause a push for a quote it doesn't hold the link to.
app.post('/api/notifications/quote-viewed', notifyRateLimit, async (req, res) => {
  const token = req.body?.token
  if (!token) return res.status(400).json({ error: 'Missing token' })
  try {
    const { data: quote, error: qErr } = await authClient
      .from('quotes').select('id, business_id, lead_id, viewed_at').eq('public_token', token).maybeSingle()
    if (qErr) throw qErr
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    if (quote.viewed_at) return res.json({ ok: true, alreadyViewed: true }) // one push per quote, not one per reload

    await authClient.from('quotes').update({ viewed_at: new Date().toISOString() }).eq('id', quote.id)
    const { data: customer } = await authClient.from('customers').select('name').eq('id', quote.lead_id).maybeSingle()
    await authClient.from('activity_log').insert({
      business_id: quote.business_id, customer_id: quote.lead_id, type: 'quote_viewed',
      summary: (customer?.name || 'A customer') + ' viewed their quote online.'
    })
    const result = await sendNotification(authClient, {
      business_id: quote.business_id, type: 'quote_viewed',
      title: 'Quote viewed',
      message: (customer?.name || 'A customer') + ' viewed your quote',
      url: '/index.html?open=pipeline'
    })
    res.json(result)
  } catch (err) {
    console.error('POST /api/notifications/quote-viewed', err)
    res.status(500).json({ error: 'Could not record quote view' })
  }
})

// Called by quote.html right after respond_to_public_quote('accept'/'decline')
// succeeds — that RPC already did the real state change (quotes.status,
// jobs.status, the activity_log row); this just fires the push, re-deriving
// the customer/amount from the DB by token rather than trusting whatever
// the client claims, so a tampered request can't fabricate a notification
// about a different business.
app.post('/api/notifications/quote-responded', notifyRateLimit, async (req, res) => {
  const { token, action } = req.body || {}
  if (!token || action !== 'accept') return res.json({ ok: true, skipped: 'not_an_acceptance' }) // only "approved" is a push event per the spec — decline/question aren't
  try {
    const { data: quote, error: qErr } = await authClient
      .from('quotes').select('id, business_id, lead_id').eq('public_token', token).maybeSingle()
    if (qErr) throw qErr
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    const { data: customer } = await authClient.from('customers').select('name').eq('id', quote.lead_id).maybeSingle()
    const result = await sendNotification(authClient, {
      business_id: quote.business_id, type: 'quote_accepted',
      title: 'Quote approved',
      message: (customer?.name || 'A customer') + ' approved your quote',
      url: '/index.html?open=pipeline'
    })
    res.json(result)
  } catch (err) {
    console.error('POST /api/notifications/quote-responded', err)
    res.status(500).json({ error: 'Could not send notification' })
  }
})

app.get('/api/leads/pending', requireBusiness, async (req, res) => {
  try {
    const leads = await storage.getPendingLeads(req.businessId)

    res.json({
      leads: leads.map((l) => ({
        id: l.id,
        payload: l.payload
      }))
    })

  } catch (err) {
    console.error('GET /api/leads/pending', err)

    res.status(500).json({
      error: 'Failed to load leads'
    })
  }
})


app.post('/api/leads/ack', requireBusiness, async (req, res) => {
  try {
    const ids = req.body?.ids ?? []

    const result = await storage.ackLeads(req.businessId, ids)

    res.json(result)

  } catch (err) {
    console.error('POST /api/leads/ack', err)

    res.status(500).json({
      error: 'Failed to ack leads'
    })
  }
})


/* =====================================================================
   EMAIL — OAuth-connected mailboxes (Gmail now; Microsoft 365 later using
   the same shape). Every route here is requireBusiness-gated (Supabase
   session), never the shared SYNC_KEY — email is per-staff-member and must
   stay strictly multi-tenant. The one exception is the OAuth callback,
   which Google redirects the browser to directly (no Authorization header
   available), so it trusts a signed `state` param instead — see
   signState()/verifyState() below.

   PROVIDER CONTRACT (backend/src/providers/*.js): isConfigured(),
   getAuthUrl(redirectUri, state), exchangeCode(code, redirectUri),
   refreshAccessToken(refreshToken), listMessageIds(token, {afterUnix}),
   getMessage(token, id), sendMessage(token, {...}). Adding Microsoft 365
   later means writing providers/microsoft.js to this same contract and
   adding one line to PROVIDERS below — nothing else in this file changes.
   ===================================================================== */
const PROVIDERS = { gmail }

// Signs {businessId, userId, provider, nonce} with OAUTH_STATE_SECRET so a
// tampered state param is rejected — state travels through the user's own
// browser during the OAuth redirect, so it must be tamper-evident, not just
// opaque.
function signState(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(b64).digest('base64url')
  return `${b64}.${sig}`
}
function verifyState(state) {
  const [b64, sig] = String(state || '').split('.')
  if (!b64 || !sig) return null
  const expected = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(b64).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try { return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) } catch { return null }
}
function escLike(s) { return String(s || '').replace(/[%_\\]/g, '\\$&') }

async function getValidAccessToken(businessId, userId, providerName) {
  const provider = PROVIDERS[providerName]
  const { data: acct, error } = await authClient.from('email_accounts').select('*')
    .eq('business_id', businessId).eq('user_id', userId).eq('provider', providerName).maybeSingle()
  if (error || !acct) return null
  let accessToken = decryptToken(acct.access_token_enc)
  if (Date.now() > new Date(acct.token_expiry).getTime() - 60000) {
    const refreshed = await provider.refreshAccessToken(decryptToken(acct.refresh_token_enc))
    accessToken = refreshed.access_token
    await authClient.from('email_accounts').update({
      access_token_enc: encryptToken(accessToken),
      token_expiry: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString()
    }).eq('id', acct.id)
  }
  return { accessToken, account: acct }
}

app.get('/api/email/oauth/start', requireBusiness, (req, res) => {
  // Every code path below MUST end in a JSON response — an uncaught throw
  // here falls through to Express's default HTML error page, which the
  // frontend's `await res.json()` can't parse, throwing its own SyntaxError
  // and landing in a generic "check your internet" message that has nothing
  // to do with the real (server-side) failure. This is exactly how the
  // undeclared-SYNC_KEY bug above used to surface — wrapping in try/catch
  // and always returning JSON means any FUTURE bug here fails loudly and
  // specifically instead of the same way.
  try {
    const providerName = req.query.provider === 'microsoft' ? 'microsoft' : 'gmail'
    const provider = PROVIDERS[providerName]
    if (!provider || !provider.isConfigured()) {
      return res.status(503).json({ error: providerName + ' is not configured on this server yet' })
    }
    // The frontend's own origin travels inside the signed state (rather than a
    // fixed TURNKEY_FRONTEND_URL env var) so this works correctly regardless of
    // which domain the CRM is served from — and can't be tampered with in transit.
    const origin = String(req.query.origin || '').slice(0, 200)
    if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(origin)) {
      return res.status(400).json({ error: 'Missing or invalid origin' })
    }
    const redirectUri = `https://${req.get('host')}/api/email/oauth/callback/${providerName}`
    const state = signState({ businessId: req.businessId, userId: req.userId, provider: providerName, origin, nonce: crypto.randomUUID() })
    res.json({ url: provider.getAuthUrl(redirectUri, state) })
  } catch (err) {
    console.error('Email OAuth start failed', { provider: req.query.provider, businessId: req.businessId, error: err.message, stack: err.stack })
    res.status(500).json({ error: 'Could not start the connection: ' + err.message })
  }
})

app.get('/api/email/oauth/callback/:provider', async (req, res) => {
  const providerName = req.params.provider
  const claims = verifyState(req.query.state)
  const bounce = (status, msg) => res.redirect((claims?.origin || '/') + `/index.html?email_connect=${status}` + (msg ? `&msg=${encodeURIComponent(msg)}` : ''))

  if (req.query.error) return bounce('error', String(req.query.error))
  if (!claims) return bounce('error', 'That connection request expired or was invalid — please try again')
  const provider = PROVIDERS[providerName]
  if (!provider || !provider.isConfigured()) return bounce('error', providerName + ' is not configured')

  try {
    const redirectUri = `https://${req.get('host')}/api/email/oauth/callback/${providerName}`
    const tok = await provider.exchangeCode(req.query.code, redirectUri)
    const { error } = await authClient.from('email_accounts').upsert({
      business_id: claims.businessId, user_id: claims.userId, provider: providerName,
      email_address: tok.email,
      access_token_enc: encryptToken(tok.access_token),
      refresh_token_enc: encryptToken(tok.refresh_token),
      token_expiry: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
      scope: tok.scope
    }, { onConflict: 'business_id,user_id,provider' })
    if (error) throw error
    bounce('success')
  } catch (err) {
    console.error('OAuth callback failed', err)
    bounce('error', 'Could not finish connecting — check server logs')
  }
})

app.post('/api/email/disconnect', requireBusiness, async (req, res) => {
  const providerName = req.body?.provider === 'microsoft' ? 'microsoft' : 'gmail'
  const { error } = await authClient.from('email_accounts').delete()
    .eq('business_id', req.businessId).eq('user_id', req.userId).eq('provider', providerName)
  if (error) return res.status(500).json({ error: 'Failed to disconnect' })
  res.json({ ok: true })
})

app.post('/api/email/send', requireBusiness, async (req, res) => {
  // attachment: {filename, contentBase64, mimeType} — the client generates the
  // PDF itself (jsPDF, same renderer the old download button used) and hands
  // it over base64-encoded so nothing needs to touch the user's downloads
  // folder. quoteId/invoiceId/type are optional — set them to also record this
  // send in email_logs (the structured "quote/invoice sent" audit trail,
  // distinct from the `emails` table which mirrors the whole Gmail thread).
  const { to, subject, bodyText, bodyHtml, customerId, threadId, inReplyTo, references, attachment, quoteId, invoiceId, type } = req.body || {}
  if (!to || !subject) return res.status(400).json({ error: 'Missing to/subject' })
  let custId = customerId || null
  try {
    const auth = await getValidAccessToken(req.businessId, req.userId, 'gmail')
    if (!auth) return res.status(400).json({ error: 'Connect your Gmail account first (Connections)' })

    const sent = await gmail.sendMessage(auth.accessToken, {
      from: auth.account.email_address, to, subject, bodyText, bodyHtml, threadId, inReplyTo, references, attachment
    })

    if (!custId) {
      const { data: cust } = await authClient.from('customers').select('id')
        .eq('business_id', req.businessId).ilike('email', escLike(to)).maybeSingle()
      custId = cust?.id || null
    }
    await authClient.from('emails').insert({
      business_id: req.businessId, account_id: auth.account.id, customer_id: custId,
      provider_message_id: sent.id, thread_id: sent.threadId, direction: 'sent',
      from_address: auth.account.email_address, to_addresses: to, subject, body_text: bodyText, body_html: bodyHtml || null,
      snippet: (bodyText || (bodyHtml || '').replace(/<[^>]+>/g, ' ')).slice(0, 140), sent_at: new Date().toISOString()
    })
    if (custId) {
      await authClient.from('activity_log').insert({
        business_id: req.businessId, customer_id: custId, type: 'email_sent',
        summary: 'Email sent: ' + subject, created_by: req.userId
      })
    }
    if (type) {
      await authClient.from('email_logs').insert({
        business_id: req.businessId, customer_id: custId, quote_id: quoteId || null, invoice_id: invoiceId || null,
        type, recipient: to, subject, body: bodyText || bodyHtml || null, sent_at: new Date().toISOString(), status: 'sent'
      })
    }
    res.json({ ok: true, id: sent.id, threadId: sent.threadId })
  } catch (err) {
    console.error('POST /api/email/send', err)
    if (type) {
      await authClient.from('email_logs').insert({
        business_id: req.businessId, customer_id: custId, quote_id: quoteId || null, invoice_id: invoiceId || null,
        type, recipient: to, subject, body: bodyText || bodyHtml || null, sent_at: null, status: 'failed'
      }).catch(() => {})
    }
    res.status(500).json({ error: 'Failed to send email' })
  }
})

app.post('/api/email/sync', requireBusiness, async (req, res) => {
  try {
    const auth = await getValidAccessToken(req.businessId, req.userId, 'gmail')
    if (!auth) return res.status(400).json({ error: 'Connect your Gmail account first (Connections)' })

    const sinceUnix = auth.account.last_sync_at
      ? Math.floor(new Date(auth.account.last_sync_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 24 * 3600 // first sync: last 30 days
    const ids = await gmail.listMessageIds(auth.accessToken, { afterUnix: sinceUnix })

    let imported = 0
    for (const id of ids) {
      const { data: existing } = await authClient.from('emails').select('id')
        .eq('account_id', auth.account.id).eq('provider_message_id', id).maybeSingle()
      if (existing) continue

      const msg = await gmail.getMessage(auth.accessToken, id)
      const direction = msg.isSentByUs ? 'sent' : 'received'
      const counterpart = direction === 'sent' ? msg.to : msg.from
      const addrMatch = counterpart.match(/<([^>]+)>/)
      const addr = (addrMatch ? addrMatch[1] : counterpart).trim().toLowerCase()
      const { data: cust } = addr
        ? await authClient.from('customers').select('id').eq('business_id', req.businessId).ilike('email', escLike(addr)).maybeSingle()
        : { data: null }

      const { error: insErr } = await authClient.from('emails').insert({
        business_id: req.businessId, account_id: auth.account.id, customer_id: cust?.id || null,
        provider_message_id: msg.id, thread_id: msg.threadId, direction,
        from_address: msg.from, to_addresses: msg.to, subject: msg.subject,
        snippet: msg.snippet, body_html: msg.bodyHtml || null, body_text: msg.bodyText || null,
        sent_at: msg.date ? new Date(msg.date).toISOString() : new Date().toISOString()
      })
      if (!insErr) {
        imported++
        if (cust?.id) {
          await authClient.from('activity_log').insert({
            business_id: req.businessId, customer_id: cust.id,
            type: direction === 'sent' ? 'email_sent' : 'email_received',
            summary: (direction === 'sent' ? 'Email sent: ' : 'Email received: ') + (msg.subject || '(no subject)')
          })
        }
      }
    }
    await authClient.from('email_accounts').update({ last_sync_at: new Date().toISOString() }).eq('id', auth.account.id)
    res.json({ ok: true, imported })
  } catch (err) {
    console.error('POST /api/email/sync', err)
    if (err.code === 'AUTH_EXPIRED') return res.status(401).json({ error: 'Gmail connection expired — please reconnect in Connections' })
    res.status(500).json({ error: 'Sync failed' })
  }
})

/* =====================================================================
   CALENDAR — Google Calendar (OAuth, same signState()/encryptToken()
   machinery as email above) and Apple/iCal (read-only ICS feed subscription,
   no OAuth available for a generic public feed URL). Both write into the
   same calendar_connections/calendar_events tables so the scheduling UI
   doesn't need to know which provider a busy block came from.

   NOT LIVE without credentials: Google Calendar needs
   GOOGLE_CALENDAR_CLIENT_ID/SECRET (or reuses GMAIL_CLIENT_ID/SECRET, see
   providers/googleCalendar.js) set in the backend environment — every route
   below checks isConfigured() first and returns 503 until then. The iCal
   routes need no credentials and work as soon as the schema migration
   (schema-calendar-and-checklists.sql) has been run.
   ===================================================================== */
app.get('/api/calendar/connections', requireBusiness, async (req, res) => {
  const { data, error } = await authClient.from('calendar_connections_status').select('*')
    .eq('business_id', req.businessId).eq('user_id', req.userId)
  if (error) return res.status(500).json({ error: 'Failed to load calendar connections' })
  res.json({ connections: data || [], googleConfigured: googleCalendar.isConfigured() })
})

app.get('/api/calendar/oauth/start', requireBusiness, (req, res) => {
  // See the matching comment on /api/email/oauth/start — every path here
  // must return JSON, never let a throw fall through to Express's default
  // HTML error page (that's what made the undeclared-SYNC_KEY bug surface
  // client-side as a generic, misleading "check your internet" error).
  try {
    if (!googleCalendar.isConfigured()) return res.status(503).json({ error: 'Google Calendar is not configured on this server yet' })
    const origin = String(req.query.origin || '').slice(0, 200)
    if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(origin)) return res.status(400).json({ error: 'Missing or invalid origin' })
    const redirectUri = `https://${req.get('host')}/api/calendar/oauth/callback/google`
    const state = signState({ businessId: req.businessId, userId: req.userId, provider: 'google', origin, nonce: crypto.randomUUID() })
    res.json({ url: googleCalendar.getAuthUrl(redirectUri, state) })
  } catch (err) {
    console.error('Calendar OAuth start failed', { businessId: req.businessId, error: err.message, stack: err.stack })
    res.status(500).json({ error: 'Could not start the connection: ' + err.message })
  }
})

app.get('/api/calendar/oauth/callback/google', async (req, res) => {
  const claims = verifyState(req.query.state)
  const bounce = (status, msg) => res.redirect((claims?.origin || '/') + `/index.html?calendar_connect=${status}` + (msg ? `&msg=${encodeURIComponent(msg)}` : ''))
  if (req.query.error) return bounce('error', String(req.query.error))
  if (!claims) return bounce('error', 'That connection request expired or was invalid — please try again')
  if (!googleCalendar.isConfigured()) return bounce('error', 'Google Calendar is not configured')
  try {
    const redirectUri = `https://${req.get('host')}/api/calendar/oauth/callback/google`
    const tok = await googleCalendar.exchangeCode(req.query.code, redirectUri)
    const { error } = await authClient.from('calendar_connections').upsert({
      business_id: claims.businessId, user_id: claims.userId, provider: 'google', ical_url: '',
      encrypted_tokens: encryptToken(JSON.stringify({ access_token: tok.access_token, refresh_token: tok.refresh_token, expiry: Date.now() + (tok.expires_in || 3600) * 1000 })),
      sync_status: 'pending', sync_error: null
    }, { onConflict: 'business_id,user_id,provider,ical_url' })
    if (error) throw error
    bounce('success')
  } catch (err) {
    console.error('Calendar OAuth callback failed', err)
    bounce('error', 'Could not finish connecting — check server logs')
  }
})

app.post('/api/calendar/disconnect', requireBusiness, async (req, res) => {
  const provider = req.body?.provider === 'ical' ? 'ical' : 'google'
  const q = authClient.from('calendar_connections').delete().eq('business_id', req.businessId).eq('user_id', req.userId).eq('provider', provider)
  const { error } = provider === 'ical' && req.body?.icalUrl ? await q.eq('ical_url', req.body.icalUrl) : await q
  if (error) return res.status(500).json({ error: 'Failed to disconnect' })
  res.json({ ok: true })
})

async function getGoogleCalendarToken(businessId, userId) {
  const { data: conn } = await authClient.from('calendar_connections').select('*')
    .eq('business_id', businessId).eq('user_id', userId).eq('provider', 'google').maybeSingle()
  if (!conn || !conn.encrypted_tokens) return null
  const tok = JSON.parse(decryptToken(conn.encrypted_tokens))
  if (Date.now() > tok.expiry - 60000) {
    const refreshed = await googleCalendar.refreshAccessToken(tok.refresh_token)
    tok.access_token = refreshed.access_token
    tok.expiry = Date.now() + (refreshed.expires_in || 3600) * 1000
    await authClient.from('calendar_connections').update({
      encrypted_tokens: encryptToken(JSON.stringify(tok))
    }).eq('id', conn.id)
  }
  return { accessToken: tok.access_token, connection: conn }
}

app.post('/api/calendar/sync', requireBusiness, async (req, res) => {
  if (!googleCalendar.isConfigured()) return res.status(503).json({ error: 'Google Calendar is not configured on this server yet' })
  try {
    const auth = await getGoogleCalendarToken(req.businessId, req.userId)
    if (!auth) return res.status(400).json({ error: 'Connect Google Calendar first' })
    const timeMinIso = new Date().toISOString()
    const timeMaxIso = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
    const events = await googleCalendar.listEvents(auth.accessToken, { timeMinIso, timeMaxIso })
    for (const ev of events) {
      await authClient.from('calendar_events').upsert({
        business_id: req.businessId, user_id: req.userId, connection_id: auth.connection.id,
        external_id: ev.externalId, title: ev.title, start_time: ev.start, end_time: ev.end, busy_status: ev.busyStatus
      }, { onConflict: 'connection_id,external_id' })
    }
    await authClient.from('calendar_connections').update({ sync_status: 'ok', sync_error: null, last_synced_at: new Date().toISOString() }).eq('id', auth.connection.id)
    res.json({ ok: true, imported: events.length })
  } catch (err) {
    console.error('POST /api/calendar/sync', err)
    const msg = err.code === 'AUTH_EXPIRED' ? 'Google Calendar connection expired — please reconnect' : 'Sync failed'
    try {
      const { data: conn } = await authClient.from('calendar_connections').select('id').eq('business_id', req.businessId).eq('user_id', req.userId).eq('provider', 'google').maybeSingle()
      if (conn) await authClient.from('calendar_connections').update({ sync_status: 'error', sync_error: msg }).eq('id', conn.id)
    } catch { /* best-effort status update — sync failure itself is already being reported below */ }
    res.status(err.code === 'AUTH_EXPIRED' ? 401 : 500).json({ error: msg })
  }
})

// Push a TurnKey job onto the technician's connected Google Calendar as an
// event, keeping it in sync as the job is booked/rescheduled/cancelled.
// Silently no-ops (ok:true, skipped:true) if Google Calendar isn't connected
// — this route is called unconditionally from confirmSchedule()/cancelJob(),
// same "quietly do nothing extra" pattern as everywhere else in the app that
// only activates once a business has actually connected something.
app.post('/api/calendar/push-job', requireBusiness, async (req, res) => {
  if (!googleCalendar.isConfigured()) return res.json({ ok: true, skipped: true })
  try {
    const auth = await getGoogleCalendarToken(req.businessId, req.userId)
    if (!auth) return res.json({ ok: true, skipped: true })
    const { googleEventId, deleted, summary, description, startIso, endIso, location } = req.body || {}
    if (deleted) {
      if (googleEventId) await googleCalendar.deleteEvent(auth.accessToken, googleEventId)
      return res.json({ ok: true, deleted: true })
    }
    if (!summary || !startIso || !endIso) return res.status(400).json({ error: 'summary, startIso and endIso are required' })
    if (googleEventId) {
      await googleCalendar.updateEvent(auth.accessToken, googleEventId, { summary, description, startIso, endIso, location })
      return res.json({ ok: true, googleEventId })
    }
    const created = await googleCalendar.createEvent(auth.accessToken, { summary, description, startIso, endIso, location })
    res.json({ ok: true, googleEventId: created.id })
  } catch (err) {
    console.error('POST /api/calendar/push-job', err)
    // Best-effort: a push failure shouldn't block the job being scheduled in
    // TurnKey itself, so this reports ok:false without a 500 — the frontend
    // just skips updating the stored googleEventId and moves on.
    res.json({ ok: false, error: 'Could not sync to Google Calendar' })
  }
})

app.post('/api/calendar/ical/connect', requireBusiness, async (req, res) => {
  const url = String(req.body?.url || '').trim()
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'A valid https:// feed URL is required' })
  try {
    const events = await fetchIcs(url) // validate the feed actually parses before saving it
    const { data: conn, error } = await authClient.from('calendar_connections').upsert({
      business_id: req.businessId, user_id: req.userId, provider: 'ical', ical_url: url,
      sync_status: 'ok', sync_error: null, last_synced_at: new Date().toISOString()
    }, { onConflict: 'business_id,user_id,provider,ical_url' }).select('*').maybeSingle()
    if (error) throw error
    for (const ev of events) {
      await authClient.from('calendar_events').upsert({
        business_id: req.businessId, user_id: req.userId, connection_id: conn.id,
        external_id: ev.externalId, title: ev.title, start_time: ev.start, end_time: ev.end, busy_status: 'busy'
      }, { onConflict: 'connection_id,external_id' })
    }
    res.json({ ok: true, imported: events.length })
  } catch (err) {
    console.error('POST /api/calendar/ical/connect', err)
    res.status(400).json({ error: 'Could not read that calendar feed — check the URL and that it\'s a public iCal/ICS link' })
  }
})

app.post('/api/calendar/ical/sync', requireBusiness, async (req, res) => {
  const url = String(req.body?.url || '').trim()
  try {
    const { data: conn } = await authClient.from('calendar_connections').select('*')
      .eq('business_id', req.businessId).eq('user_id', req.userId).eq('provider', 'ical').eq('ical_url', url).maybeSingle()
    if (!conn) return res.status(404).json({ error: 'That calendar feed is not connected' })
    const events = await fetchIcs(url)
    for (const ev of events) {
      await authClient.from('calendar_events').upsert({
        business_id: req.businessId, user_id: req.userId, connection_id: conn.id,
        external_id: ev.externalId, title: ev.title, start_time: ev.start, end_time: ev.end, busy_status: 'busy'
      }, { onConflict: 'connection_id,external_id' })
    }
    await authClient.from('calendar_connections').update({ sync_status: 'ok', sync_error: null, last_synced_at: new Date().toISOString() }).eq('id', conn.id)
    res.json({ ok: true, imported: events.length })
  } catch (err) {
    console.error('POST /api/calendar/ical/sync', err)
    res.status(500).json({ error: 'Sync failed — the feed may be temporarily unreachable' })
  }
})

/* ===== Time-based lifecycle emails (day-before job reminders, overdue invoice
   nags) — these can't fire from a client state transition like the rest of the
   lifecycle emails do, so they're swept here instead. Not triggered by anything
   in this app: point an external scheduler (Render Cron Job, GitHub Actions
   scheduled workflow, cron-job.org, etc.) at this route once a day, e.g.:
     curl -X POST https://<this-backend>/api/automations/run-due -H "X-Automation-Key: <AUTOMATION_CRON_KEY>"
   Protected by a shared secret (not a business session) since it's meant to be
   called by infrastructure, not a signed-in user, and must sweep every
   business in one pass. */
const AUTOMATION_LIFECYCLE_DEFAULTS = {
  day_before_reminder: { subject: 'Reminder: {{business_name}} is coming tomorrow', body: "Hi {{customer_name}}, just a reminder we'll be at {{job_address}} tomorrow ({{scheduled_date}}). Let us know if anything's changed." },
  invoice_overdue: { subject: 'Reminder: invoice from {{business_name}} is overdue', body: "Hi {{customer_name}}, just a friendly reminder that your invoice for {{invoice_total}} is now overdue. Reply if you'd like to sort out payment or have any questions." }
}
function fillAutomationTemplate(str, vars) {
  return (str || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (vars[k] != null ? vars[k] : m))
}
async function sendAutomationEmail(businessId, job, key, invoice) {
  const { data: already } = await authClient.from('lifecycle_email_log').select('id')
    .eq('business_id', businessId).eq('job_id', job.id).eq('key', key).maybeSingle()
  if (already) return false // already sent for this job+key — never double-send
  const { data: tplRow } = await authClient.from('lifecycle_emails').select('*')
    .eq('business_id', businessId).eq('key', key).maybeSingle()
  if (tplRow && tplRow.enabled === false) return false
  const { data: customer } = await authClient.from('customers').select('*').eq('id', job.customer_id).maybeSingle()
  if (!customer || !customer.email) return false
  const { data: accounts } = await authClient.from('email_accounts').select('*')
    .eq('business_id', businessId).eq('provider', 'gmail').limit(1)
  const acct = accounts && accounts[0]
  if (!acct) return false // no Gmail connected for this business — silent skip, same as the client-side sender
  const auth = await getValidAccessToken(businessId, acct.user_id, 'gmail')
  if (!auth) return false
  const { data: biz } = await authClient.from('businesses').select('*').eq('id', businessId).maybeSingle()
  const vars = {
    customer_name: (customer.name || '').split(' ')[0] || customer.name || 'there',
    business_name: (biz && biz.name) || 'Your Business',
    quote_total: '',
    invoice_total: invoice ? ('$' + Math.round(invoice.amount || 0).toLocaleString('en-NZ')) : '',
    job_address: [customer.address, customer.suburb].filter(Boolean).join(', ') || '—',
    scheduled_date: job.scheduled_date || 'to be confirmed'
  }
  const defaults = AUTOMATION_LIFECYCLE_DEFAULTS[key] || {}
  const subject = fillAutomationTemplate((tplRow && tplRow.subject) || defaults.subject || key, vars)
  const bodyText = fillAutomationTemplate((tplRow && tplRow.body) || defaults.body || '', vars)
  const bodyHtml = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;line-height:1.6"><p>${bodyText.replace(/\n/g, '<br>')}</p></div>`
  const sent = await gmail.sendMessage(auth.accessToken, { from: auth.account.email_address, to: customer.email, subject, bodyText, bodyHtml })
  await authClient.from('emails').insert({
    business_id: businessId, account_id: auth.account.id, customer_id: customer.id,
    provider_message_id: sent.id, thread_id: sent.threadId, direction: 'sent',
    from_address: auth.account.email_address, to_addresses: customer.email, subject,
    body_text: bodyText, body_html: bodyHtml, snippet: bodyText.slice(0, 140), sent_at: new Date().toISOString()
  })
  await authClient.from('lifecycle_email_log').insert({ business_id: businessId, job_id: job.id, key })
  await authClient.from('activity_log').insert({ business_id: businessId, customer_id: customer.id, job_id: job.id, type: 'email_sent', summary: subject })
  return true
}
app.post('/api/automations/run-due', async (req, res) => {
  const cronKey = process.env.AUTOMATION_CRON_KEY || ''
  if (!cronKey) return res.status(501).json({ error: 'AUTOMATION_CRON_KEY not configured — set it in the backend environment to enable this sweep' })
  const provided = req.get('X-Automation-Key') || req.query.key
  if (provided !== cronKey) return res.status(401).json({ error: 'Invalid automation key' })
  try {
    const results = { day_before_reminder: 0, invoice_overdue: 0, errors: 0 }
    const today = new Date(); today.setUTCHours(0, 0, 0, 0)
    const tomorrow = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    const tomorrowISO = tomorrow.toISOString().slice(0, 10)
    const todayISO = today.toISOString().slice(0, 10)

    const { data: jobs } = await authClient.from('jobs').select('*').eq('scheduled_date', tomorrowISO).eq('status', 'scheduled')
    for (const job of jobs || []) {
      try { if (await sendAutomationEmail(job.business_id, job, 'day_before_reminder')) results.day_before_reminder++ }
      catch (e) { console.error('day_before_reminder failed for job', job.id, e); results.errors++ }
    }

    const { data: invoices } = await authClient.from('invoices').select('*').eq('paid', false).lt('due_date', todayISO)
    for (const inv of invoices || []) {
      try {
        const { data: job } = await authClient.from('jobs').select('*').eq('id', inv.job_id).maybeSingle()
        if (!job) continue
        if (await sendAutomationEmail(job.business_id, job, 'invoice_overdue', inv)) results.invoice_overdue++
        // Owner-facing push, separate from the customer-facing reminder
        // email just above — this is the only one of the 6 events with no
        // real-time trigger to hook (nothing "happens" when an invoice
        // becomes overdue, it just is, as of today's date), so it rides on
        // this same daily sweep. overdue_push_log gives it its own
        // once-ever dedupe key (invoice_id) independent of
        // lifecycle_email_log's job_id+key key, since the two are logically
        // separate notifications that could legitimately have different
        // enabled/disabled states later.
        const { data: alreadyPushed } = await authClient.from('overdue_push_log').select('id').eq('invoice_id', inv.id).maybeSingle()
        if (!alreadyPushed) {
          await sendNotification(authClient, {
            business_id: job.business_id, type: 'invoice_overdue',
            title: 'Invoice overdue',
            message: 'Invoice requires attention',
            url: '/index.html?open=pipeline'
          })
          await authClient.from('overdue_push_log').insert({ invoice_id: inv.id })
        }
      } catch (e) { console.error('invoice_overdue failed for invoice', inv.id, e); results.errors++ }
    }
    res.json({ ok: true, results })
  } catch (err) {
    console.error('POST /api/automations/run-due', err)
    res.status(500).json({ error: 'Automation sweep failed' })
  }
})

/* =====================================================================
   PAYMENTS — Stripe Payment Links, via plain REST (Basic Auth with the
   secret key as username), matching this backend's no-heavy-SDK style. NOT
   LIVE until STRIPE_SECRET_KEY is set in the backend environment — gated by
   isStripeConfigured() so every route below returns a clear 501 until then,
   same pattern as Gmail/Google Calendar. Get a key at dashboard.stripe.com
   (test mode first — sk_test_... — before switching to a live key).
   ===================================================================== */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || ''
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
const isStripeConfigured = () => !!STRIPE_SECRET_KEY

// Lets the CRM show accurate "connected"/"not set up" state instead of a
// hardcoded "coming soon" that stayed wrong even once a business actually
// had this working (create-link has been functional all along whenever
// STRIPE_SECRET_KEY was set — the UI just never reflected that).
app.get('/api/payments/status', requireBusiness, (req, res) => {
  res.json({ configured: isStripeConfigured(), webhookConfigured: !!STRIPE_WEBHOOK_SECRET })
})

app.post('/api/payments/create-link', requireBusiness, async (req, res) => {
  if (!isStripeConfigured()) return res.status(501).json({ error: 'Stripe is not configured on this server yet — ask whoever manages your TurnKey deployment to add STRIPE_SECRET_KEY' })
  try {
    const { amountCents, description, invoiceId } = req.body || {}
    if (!amountCents || amountCents < 50) return res.status(400).json({ error: 'A valid amount (in cents, minimum 50) is required' })
    const authHeader = 'Basic ' + Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64')

    // Stripe Payment Links need a Price object first (one-off, inline price).
    const priceRes = await fetch('https://api.stripe.com/v1/prices', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        unit_amount: String(Math.round(amountCents)), currency: 'nzd',
        'product_data[name]': description || 'TurnKey invoice'
      })
    })
    if (!priceRes.ok) throw new Error('Stripe price creation failed: ' + await priceRes.text())
    const price = await priceRes.json()

    // metadata.invoice_id is what lets the webhook below know which invoice
    // a payment belongs to — Stripe carries Payment Link metadata through
    // onto the Checkout Session it creates when someone pays, so the
    // webhook event includes it without any extra lookup.
    const linkParams = new URLSearchParams({ 'line_items[0][price]': price.id, 'line_items[0][quantity]': '1' })
    if (invoiceId) linkParams.set('metadata[invoice_id]', String(invoiceId))
    const linkRes = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: linkParams
    })
    if (!linkRes.ok) throw new Error('Stripe payment link creation failed: ' + await linkRes.text())
    const link = await linkRes.json()

    if (invoiceId) await authClient.from('invoices').update({ payment_link_url: link.url }).eq('id', invoiceId)
    res.json({ ok: true, url: link.url })
  } catch (err) {
    console.error('POST /api/payments/create-link', err)
    res.status(500).json({ error: 'Could not create a payment link' })
  }
})

// Verifies a Stripe webhook's signature by hand (no stripe npm package, same
// no-heavy-SDK style as the rest of this backend) — implements Stripe's
// documented scheme: the header is `t=<timestamp>,v1=<hex hmac>[,v0=...]`,
// the signed payload is `${timestamp}.${rawBody}`, HMAC-SHA256'd with the
// webhook signing secret. Rejects anything older than 5 minutes (replay
// protection) same as Stripe's own official libraries do.
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!rawBody || !sigHeader || !secret) return false
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')))
  const timestamp = parts.t
  const expectedSig = parts.v1
  if (!timestamp || !expectedSig) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`
  const computed = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex')
  const a = Buffer.from(computed, 'hex')
  const b = Buffer.from(expectedSig, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// Stripe calls this directly (no CRM session — Stripe isn't a logged-in
// user), so it's deliberately NOT behind requireBusiness; the webhook
// signature is what proves the request is genuinely from Stripe instead.
// On a completed, paid checkout session, marks the matching invoice AND its
// job paid — the same two writes the CRM's own markPaid() does, done here
// so a customer paying via the link updates TurnKey without anyone in the
// business needing to notice and click "mark paid" themselves.
app.post('/api/payments/webhook', async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(501).json({ error: 'Stripe webhook secret not configured' })
  const sig = req.get('stripe-signature')
  if (!verifyStripeSignature(req.rawBody, sig, STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid signature' })
  }
  try {
    const event = req.body
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {}
      if (session.payment_status === 'paid') {
        const invoiceId = session.metadata?.invoice_id
        if (invoiceId) {
          const { data: invoice, error: invErr } = await authClient
            .from('invoices').select('id, job_id')
            .eq('id', invoiceId).maybeSingle()
          if (invErr) throw invErr
          if (invoice) {
            await authClient.from('invoices').update({
              paid: true, payment_status: 'paid', payment_date: new Date().toISOString(), payment_method: 'Card (Stripe)'
            }).eq('id', invoice.id)
            if (invoice.job_id) {
              await authClient.from('jobs').update({ status: 'paid' }).eq('id', invoice.job_id)
            }
            // This Stripe path bypasses markPaid() (index.html) entirely —
            // that's the only place the existing email notifyOwner(
            // 'payment_received',...) call lives, so without this a
            // Stripe-paid invoice got no owner alert of any kind. amount
            // comes from the invoice row itself (session.amount_total is in
            // cents and Stripe-specific; the invoice's own NZD amount is
            // what the rest of the app already displays everywhere else).
            const { data: invRow } = await authClient.from('invoices').select('business_id, amount').eq('id', invoice.id).maybeSingle()
            if (invRow) {
              let customerName = 'A customer'
              if (invoice.job_id) {
                const { data: job } = await authClient.from('jobs').select('customer_id, details').eq('id', invoice.job_id).maybeSingle()
                if (job?.customer_id) {
                  const { data: cust } = await authClient.from('customers').select('name').eq('id', job.customer_id).maybeSingle()
                  customerName = cust?.name || job.details?.name || customerName
                }
              }
              sendNotification(authClient, {
                business_id: invRow.business_id, type: 'payment_received',
                title: 'Payment received',
                message: 'Payment received from ' + customerName,
                url: '/index.html?open=pipeline'
              }).catch((e) => console.error('payment_received notification failed', e))
            }
          } else {
            console.error('Stripe webhook: no invoice found for id', invoiceId)
          }
        } else {
          console.error('Stripe webhook: checkout.session.completed with no invoice_id metadata — payment link may have been created before metadata support was added')
        }
      }
    }
    // Any other event type: acknowledge and ignore — Stripe retries on
    // anything but a 2xx, so unhandled-but-irrelevant events must still 200.
    res.json({ received: true })
  } catch (err) {
    console.error('POST /api/payments/webhook', err)
    // Still 200: our own error shouldn't make Stripe hammer retries for an
    // event we may have already partially processed (invoice updated,
    // job update failed, say) — the failure is logged for manual follow-up.
    res.json({ received: true, warning: 'Processed with errors — check server logs' })
  }
})

/* =====================================================================
   AI MARKETING — generates ad copy/captions/campaigns using Claude, grounded
   in the business's own real services/region so it never invents an offer
   that doesn't exist. NOT LIVE until ANTHROPIC_API_KEY is set in the backend
   environment.
   ===================================================================== */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const isAiConfigured = () => !!ANTHROPIC_API_KEY

app.post('/api/ai/marketing', requireBusiness, async (req, res) => {
  if (!isAiConfigured()) return res.status(501).json({ error: 'AI assistant is not configured on this server yet — ask whoever manages your TurnKey deployment to add ANTHROPIC_API_KEY' })
  try {
    const { contentType, brief, businessContext } = req.body || {}
    if (!contentType) return res.status(400).json({ error: 'A content type is required' })
    const system = 'You are a marketing copywriter for small local service businesses (exterior cleaning, roofing, ' +
      'pressure washing). Write ready-to-use copy — no placeholder brackets like [Business Name], no meta-commentary ' +
      'before or after, just the copy itself. Keep it grounded in the real business details given; don\'t invent ' +
      'services, prices, or offers the business didn\'t mention.'
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 700, system,
        messages: [{ role: 'user', content: `Business details:\n${JSON.stringify(businessContext || {}).slice(0, 4000)}\n\nWrite a: ${contentType}${brief ? '\n\nAdditional brief: ' + String(brief).slice(0, 1000) : ''}` }]
      })
    })
    if (!aiRes.ok) throw new Error('Anthropic API call failed: ' + await aiRes.text())
    const data = await aiRes.json()
    const content = (data.content || []).map(b => b.text || '').join('').trim() || 'No content returned.'
    res.json({ ok: true, content })
  } catch (err) {
    console.error('POST /api/ai/marketing', err)
    res.status(500).json({ error: 'Could not reach the AI assistant' })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 TurnKey backend running on port ${PORT}`)
  console.log(`📦 Storage mode: ${STORAGE}`)
})
