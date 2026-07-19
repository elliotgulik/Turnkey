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

const PORT = Number(process.env.PORT || 3001)
const SYNC_KEY = process.env.SYNC_KEY || ''
const STORAGE = (process.env.STORAGE || 'file').toLowerCase()

if (!SYNC_KEY || SYNC_KEY === 'change-me-to-a-long-random-secret') {
  console.warn('⚠️ Warning: set SYNC_KEY to a strong secret before going live.')
}

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

app.use(cors())
app.use(express.json({ limit: '25mb' }))


function requireKey(req, res, next) {
  const key = req.get('X-Turnkey-Key') || req.query.key

  if (!SYNC_KEY) {
    return res.status(500).json({
      error: 'SYNC_KEY not configured'
    })
  }

  if (key !== SYNC_KEY) {
    return res.status(401).json({
      error: 'Invalid access code'
    })
  }

  next()
}

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


app.get('/api/state', requireKey, async (_req, res) => {
  try {
    const data = await storage.getState()

    if (!data) {
      return res.json({
        state: null,
        savedAt: 0
      })
    }

    res.json(data)

  } catch (err) {
    console.error('GET /api/state', err)
    res.status(500).json({
      error: 'Failed to load state'
    })
  }
})


app.post('/api/state', requireKey, async (req, res) => {
  try {
    const { state, savedAt } = req.body ?? {}

    if (!state) {
      return res.status(400).json({
        error: 'Missing state'
      })
    }

    const result = await storage.saveState(
      state,
      savedAt || Date.now()
    )

    res.json(result)

  } catch (err) {
    console.error('POST /api/state', err)
    res.status(500).json({
      error: 'Failed to save state'
    })
  }
})


app.post('/api/leads', async (req, res) => {
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

    const lead = await storage.addLead(payload)

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

// Signs {businessId, userId, provider, nonce} with SYNC_KEY (already a long
// random secret every deployment sets) so a tampered state param is
// rejected — state travels through the user's own browser during the OAuth
// redirect, so it must be tamper-evident, not just opaque.
function signState(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SYNC_KEY).update(b64).digest('base64url')
  return `${b64}.${sig}`
}
function verifyState(state) {
  const [b64, sig] = String(state || '').split('.')
  if (!b64 || !sig) return null
  const expected = crypto.createHmac('sha256', SYNC_KEY).update(b64).digest('base64url')
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
  try {
    const { to, subject, bodyText, customerId, threadId, inReplyTo, references } = req.body || {}
    if (!to || !subject) return res.status(400).json({ error: 'Missing to/subject' })
    const auth = await getValidAccessToken(req.businessId, req.userId, 'gmail')
    if (!auth) return res.status(400).json({ error: 'Connect your Gmail account first (Connections)' })

    const sent = await gmail.sendMessage(auth.accessToken, {
      from: auth.account.email_address, to, subject, bodyText, threadId, inReplyTo, references
    })

    let custId = customerId || null
    if (!custId) {
      const { data: cust } = await authClient.from('customers').select('id')
        .eq('business_id', req.businessId).ilike('email', escLike(to)).maybeSingle()
      custId = cust?.id || null
    }
    await authClient.from('emails').insert({
      business_id: req.businessId, account_id: auth.account.id, customer_id: custId,
      provider_message_id: sent.id, thread_id: sent.threadId, direction: 'sent',
      from_address: auth.account.email_address, to_addresses: to, subject, body_text: bodyText,
      snippet: (bodyText || '').slice(0, 140), sent_at: new Date().toISOString()
    })
    if (custId) {
      await authClient.from('activity_log').insert({
        business_id: req.businessId, customer_id: custId, type: 'email_sent',
        summary: 'Email sent: ' + subject, created_by: req.userId
      })
    }
    res.json({ ok: true, id: sent.id, threadId: sent.threadId })
  } catch (err) {
    console.error('POST /api/email/send', err)
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


app.listen(PORT, () => {
  console.log(`🚀 TurnKey backend running on port ${PORT}`)
  console.log(`📦 Storage mode: ${STORAGE}`)
})
