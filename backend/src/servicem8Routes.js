// Express routes for the ServiceM8 integration. Deliberately a self-
// contained router (mounted from index.js with `app.use('/api/servicem8',
// createServiceM8Router({...}))`) rather than inline routes in index.js —
// keeps the diff to that shared file to a couple of lines, which matters
// while it may be under concurrent edit elsewhere.
//
// All the actual decision logic lives in servicem8Sync.js /
// servicem8Webhooks.js (pure, unit-tested); everything here is thin
// plumbing: Supabase reads/writes, token encryption, and wiring the
// ServiceM8 provider's HTTP calls in as dependencies.
import express from 'express'
import crypto from 'node:crypto'
import * as sm8 from './providers/servicem8.js'
import { performServiceM8Handoff } from './servicem8Sync.js'
import { parseWebhookRequest, processServiceM8Event } from './servicem8Webhooks.js'
import { encryptToken, decryptToken } from './crypto.js'

// Mirrors index.js's own signState/verifyState (OAuth `state` CSRF
// protection) rather than importing it, deliberately — keeps this module
// mountable with a minimal diff to index.js while that file may be under
// concurrent edit elsewhere. Dedupe into a shared module later.
function signState(payload, secret) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url')
  return `${b64}.${sig}`
}
function verifyState(state, secret) {
  const [b64, sig] = String(state || '').split('.')
  if (!b64 || !sig) return null
  const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try { return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) } catch { return null }
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

// object/field pairs this integration subscribes to on /subscribe —
// matches servicem8_webhook_events' purpose and the spec's "track job
// creation, status changes, completion, other documented updates that
// support sales analytics". JobPayment is included for the financial-
// reporting phase (actual invoiced/paid totals).
const SUBSCRIBE_OBJECTS = [
  { object: 'job', fields: ['status'] },
  { object: 'jobpayment', fields: ['amount'] }
]

export function createServiceM8Router({ authClient, requireBusiness, oauthStateSecret, backendPublicUrl }) {
  const router = express.Router()
  // The verification handshake (POST /webhook/:token with mode=subscribe)
  // is form-encoded per docs/webhooks-overview ("accept form-encoded POST
  // data"); real event deliveries are JSON (already parsed by index.js's
  // global express.json()). Scoped to this router only, rather than adding
  // a second global body parser to index.js's shared middleware chain.
  router.use(express.urlencoded({ extended: false }))

  async function getConnection(businessId) {
    const { data, error } = await authClient.from('servicem8_connections').select('*').eq('business_id', businessId).maybeSingle()
    if (error) throw error
    return data
  }

  async function credentialFor(conn) {
    if (!conn) return null
    if (conn.auth_mode === 'api_key') return { mode: 'api_key', apiKey: decryptToken(conn.api_key_enc) }
    let accessToken = decryptToken(conn.access_token_enc)
    if (conn.token_expiry && Date.now() > new Date(conn.token_expiry).getTime() - 60000) {
      // ServiceM8 rotates the refresh token on every refresh (see
      // providers/servicem8.js) — both tokens must be re-saved here, not
      // just the access token, or the NEXT refresh will fail.
      const refreshed = await sm8.refreshAccessToken(decryptToken(conn.refresh_token_enc))
      accessToken = refreshed.access_token
      await authClient.from('servicem8_connections').update({
        access_token_enc: encryptToken(refreshed.access_token),
        refresh_token_enc: encryptToken(refreshed.refresh_token),
        token_expiry: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', conn.id)
    }
    return { mode: 'oauth', accessToken }
  }

  // ----- status / connect / disconnect -----

  router.get('/status', requireBusiness, async (req, res) => {
    try {
      const conn = await getConnection(req.businessId)
      res.json({
        connected: !!conn,
        authMode: conn?.auth_mode || null,
        accountName: conn?.account_name || null,
        webhookSubscribed: !!conn?.webhook_subscribed_at,
        configured: sm8.isConfigured() // whether OAuth (SERVICEM8_CLIENT_ID/SECRET) is available; API-key mode needs no server config
      })
    } catch (err) {
      console.error('GET /api/servicem8/status', err)
      res.status(500).json({ error: 'Could not load ServiceM8 connection status' })
    }
  })

  router.post('/connect/api-key', requireBusiness, async (req, res) => {
    const apiKey = String(req.body?.apiKey || '').trim()
    if (!apiKey) return res.status(400).json({ error: 'An API key is required' })
    try {
      // Verify the key actually works before saving it — same "fail fast,
      // not on the first real sync" reasoning as the Meta Page token check.
      const vendor = await sm8.getVendor({ mode: 'api_key', apiKey })
      await authClient.from('servicem8_connections').upsert({
        business_id: req.businessId, auth_mode: 'api_key', api_key_enc: encryptToken(apiKey),
        account_uuid: vendor?.uuid || null, account_name: vendor?.name || null,
        access_token_enc: null, refresh_token_enc: null, token_expiry: null, scope: null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'business_id' })
      res.json({ ok: true, accountName: vendor?.name || null })
    } catch (err) {
      console.error('POST /api/servicem8/connect/api-key', err)
      res.status(400).json({ error: 'Could not verify that API key with ServiceM8 — check it was copied correctly' })
    }
  })

  router.get('/oauth/start', requireBusiness, (req, res) => {
    try {
      if (!sm8.isConfigured()) return res.status(503).json({ error: 'ServiceM8 is not configured on this server yet (missing SERVICEM8_CLIENT_ID/SECRET)' })
      const origin = String(req.query.origin || '').slice(0, 200)
      if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(origin)) return res.status(400).json({ error: 'Missing or invalid origin' })
      const redirectUri = `${backendPublicUrl(req)}/api/servicem8/oauth/callback`
      const state = signState({ businessId: req.businessId, origin, nonce: crypto.randomUUID() }, oauthStateSecret)
      res.json({ url: sm8.getAuthUrl(redirectUri, state) })
    } catch (err) {
      console.error('ServiceM8 OAuth start failed', err)
      res.status(500).json({ error: 'Could not start the connection: ' + err.message })
    }
  })

  router.get('/oauth/callback', async (req, res) => {
    const claims = verifyState(req.query.state, oauthStateSecret)
    const bounce = (status, msg) => res.redirect((claims?.origin || '') + `/index.html?servicem8_connect=${status}` + (msg ? `&msg=${encodeURIComponent(msg)}` : ''))
    if (req.query.error) return bounce('error', String(req.query.error))
    if (!claims) return bounce('error', 'That connection request expired or was invalid — please try again')
    if (!sm8.isConfigured()) return bounce('error', 'ServiceM8 is not configured')
    try {
      const redirectUri = `${backendPublicUrl(req)}/api/servicem8/oauth/callback`
      const tok = await sm8.exchangeCode(req.query.code, redirectUri)
      const vendor = await sm8.getVendor({ mode: 'oauth', accessToken: tok.access_token }).catch(() => null)
      await authClient.from('servicem8_connections').upsert({
        business_id: claims.businessId, auth_mode: 'oauth',
        access_token_enc: encryptToken(tok.access_token), refresh_token_enc: encryptToken(tok.refresh_token),
        token_expiry: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(), scope: tok.scope,
        account_uuid: vendor?.uuid || null, account_name: vendor?.name || null,
        api_key_enc: null, updated_at: new Date().toISOString()
      }, { onConflict: 'business_id' })
      bounce('success')
    } catch (err) {
      console.error('ServiceM8 OAuth callback failed', err)
      bounce('error', 'Could not finish connecting — check server logs')
    }
  })

  router.post('/disconnect', requireBusiness, async (req, res) => {
    await authClient.from('servicem8_connections').delete().eq('business_id', req.businessId)
    res.json({ ok: true })
  })

  // Registers (or re-registers, invalidating any previous token) this
  // business's webhook subscriptions. A fresh random token is generated
  // each call — same "regenerate invalidates the old one" semantics as
  // Wix's connect route — and only its hash is stored, consistent with how
  // the lookup in /webhook/:token below actually works (see the schema
  // migration's comment on webhook_token_hash for why this can't be
  // reversible encryption instead).
  router.post('/subscribe', requireBusiness, async (req, res) => {
    try {
      const conn = await getConnection(req.businessId)
      if (!conn) return res.status(400).json({ error: 'Connect ServiceM8 first' })
      const credential = await credentialFor(conn)
      const token = crypto.randomBytes(24).toString('base64url')
      const callbackUrl = `${backendPublicUrl(req)}/api/servicem8/webhook/${token}`
      const results = []
      for (const sub of SUBSCRIBE_OBJECTS) {
        try {
          await sm8.registerWebhookSubscription(credential, { ...sub, callbackUrl })
          results.push({ object: sub.object, ok: true })
        } catch (err) {
          results.push({ object: sub.object, ok: false, error: err.message })
        }
      }
      await authClient.from('servicem8_connections').update({
        webhook_token_hash: hashToken(token),
        webhook_subscribed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('business_id', req.businessId)
      res.json({ ok: results.every((r) => r.ok), results })
    } catch (err) {
      console.error('POST /api/servicem8/subscribe', err)
      res.status(500).json({ error: 'Could not register ServiceM8 webhooks' })
    }
  })

  // ----- outbound handoff (Won -> Company+Job) -----

  async function runHandoff(req, res) {
    try {
      const conn = await getConnection(req.businessId)
      if (!conn) return res.status(400).json({ error: 'Connect ServiceM8 first' })
      const credential = await credentialFor(conn)
      const { customer, job, materials, quotePdf } = req.body || {}
      if (!customer?.id || !customer?.name) return res.status(400).json({ error: 'customer (with id and name) is required' })

      const result = await performServiceM8Handoff({
        businessId: req.businessId, jobId: req.params.jobId, customer, job: job || {}, materials, quotePdf,
        deps: {
          getExistingHandoff: async (bizId, jobId) => (await authClient.from('servicem8_handoffs').select('*').eq('business_id', bizId).eq('job_id', jobId).maybeSingle()).data,
          getObjectMap: async (bizId, localType, localId, sm8Type) => (await authClient.from('servicem8_object_map').select('*').eq('business_id', bizId).eq('local_type', localType).eq('local_id', localId).eq('sm8_type', sm8Type).maybeSingle()).data,
          saveObjectMap: async (row) => { const { error } = await authClient.from('servicem8_object_map').upsert(row, { onConflict: 'business_id,local_type,local_id,sm8_type' }); if (error) throw error },
          saveHandoff: async (row) => { const { error } = await authClient.from('servicem8_handoffs').upsert(row, { onConflict: 'business_id,job_id' }); if (error) throw error },
          createCompany: (args) => sm8.createCompany(credential, args),
          createJob: (args) => sm8.createJob(credential, args),
          createJobMaterial: (args) => sm8.createJobMaterial(credential, args),
          attachFile: (args) => sm8.attachFile(credential, args)
        }
      })
      res.status(result.status === 'synced' ? 200 : 502).json(result)
    } catch (err) {
      console.error('ServiceM8 handoff failed', err)
      res.status(500).json({ error: 'Handoff failed: ' + err.message })
    }
  }

  router.post('/handoff/:jobId', requireBusiness, runHandoff)
  // Retry is the exact same idempotent code path, not a separate
  // implementation — performServiceM8Handoff resuming from whatever the
  // last attempt saved is what makes "retry" safe to begin with.
  router.post('/handoffs/:jobId/retry', requireBusiness, runHandoff)

  router.get('/handoffs', requireBusiness, async (req, res) => {
    const { data, error } = await authClient.from('servicem8_handoffs').select('*').eq('business_id', req.businessId).order('updated_at', { ascending: false }).limit(200)
    if (error) return res.status(500).json({ error: 'Could not load transfer history' })
    res.json({ handoffs: data || [] })
  })

  // ----- inbound webhooks -----

  router.post('/webhook/:token', async (req, res) => {
    const parsed = parseWebhookRequest(req.body)

    if (parsed.kind === 'verification') {
      // Must respond with ONLY the bare challenge value — no JSON wrapper,
      // per developer.servicem8.com/docs/webhooks-overview.
      return res.status(200).send(parsed.challenge)
    }
    if (parsed.kind !== 'event') return res.sendStatus(200) // unrecognised shape — ack anyway, nothing to retry

    // Ack fast, same reasoning as this backend's existing Stripe/Meta
    // webhook handlers — a downstream failure shouldn't make ServiceM8
    // retry-storm an event that may already be partially processed.
    res.status(200).json({ received: true })

    const hash = hashToken(req.params.token)
    for (const entry of parsed.entries) {
      await processServiceM8Event({
        businessIdHint: hash, object: parsed.object, entry, resourceUrl: parsed.resourceUrl, rawPayload: req.body,
        deps: {
          recordEvent: async (row) => { const { data, error } = await authClient.from('servicem8_webhook_events').insert(row).select('id').single(); if (error) throw error; return data },
          resolveBusinessId: async (tokenHash) => {
            const { data } = await authClient.from('servicem8_connections').select('business_id').eq('webhook_token_hash', tokenHash).maybeSingle()
            return data?.business_id || null
          },
          fetchObject: async (businessId, object, uuid) => {
            const conn = await getConnection(businessId)
            if (!conn) return null
            const credential = await credentialFor(conn)
            return sm8.getObject(credential, object, uuid).catch(() => null)
          },
          onObjectChanged: async (businessId, object, record, changedFields) => {
            // v1: durable log only (servicem8_webhook_events already
            // records this). Writing the status change back onto the
            // right TurnKey job/activity_log row needs a reverse lookup
            // through servicem8_object_map per object type — deliberately
            // left as a follow-up rather than guessed at here; the
            // re-fetch path above is what's actually being proven out.
            console.log('[ServiceM8 webhook] object changed', { businessId, object, uuid: record.uuid, changedFields })
          },
          markEventStatus: async (id, status, errorMessage) => {
            await authClient.from('servicem8_webhook_events').update({ status, last_error: errorMessage, processed_at: new Date().toISOString() }).eq('id', id)
          }
        }
      }).catch((err) => console.error('[ServiceM8 webhook] event processing failed', err))
    }
  })

  return router
}
