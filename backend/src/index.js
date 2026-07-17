import dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { createFileStorage } from './storage/file.js'
import { createSupabaseStorage } from './storage/supabase.js'

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

async function resolveBusinessId(accessToken) {
  const { data: userData, error: userErr } = await authClient.auth.getUser(accessToken)
  if (userErr || !userData?.user) return null

  const { data: profile, error: profileErr } = await authClient
    .from('users')
    .select('business_id')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (profileErr || !profile) return null
  return profile.business_id
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

  const businessId = await resolveBusinessId(token)

  if (!businessId) {
    return res.status(401).json({ error: 'Invalid session' })
  }

  req.businessId = businessId
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


// Gmail placeholders
const gmailConfigured =
  !!(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET
  )


app.get('/api/gmail/status', requireKey, (_req, res) => {
  res.json({
    ready: gmailConfigured,
    connected: false
  })
})


app.get('/api/gmail/connect', requireKey, (_req, res) => {

  if (!gmailConfigured) {
    return res.status(503).send(
      'Gmail OAuth not configured yet.'
    )
  }

  res.status(501).send(
    'Gmail OAuth wiring ready.'
  )
})


app.post('/api/gmail/disconnect', requireKey, (_req, res) => {
  res.json({
    ok: true
  })
})


app.listen(PORT, () => {
  console.log(`🚀 TurnKey backend running on port ${PORT}`)
  console.log(`📦 Storage mode: ${STORAGE}`)
})
