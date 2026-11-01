import { Router } from 'express'

/* SQL contract (service_role only; migration owned by main):
 * pricing_learning_settings: business_id PK, enabled bool default true,
 *   min_samples int default 5 (5..50), max_adjustment numeric default .25 (0...35).
 * pricing_learning_observations: id uuid PK default gen_random_uuid(),
 *   business_id, job_id uuid, quote_key text, line_key text, svc text, unit text,
 *   quantity, baseline_price, chosen_price numeric, reason text, storeys int,
 *   access text, measured_quantity/verified_quantity numeric NULL,
 *   measurement_reason text NULL, context jsonb default '{}', created_at timestamptz.
 * UNIQUE(business_id,quote_key,line_key). No customer data or free-text notes.
 * Mount: app.use('/api/pricing-learning', createPricingLearningRouter(deps)).
 * details.quoteLearning is the authoritative finalized snapshot, including
 * access-allocated line amounts; this module NEVER updates jobs/old quotes.
 */
const DEFAULTS = Object.freeze({ enabled: true, minSamples: 5, maxAdjustment: 0.25 })
const fail = (message, status = 400) => Object.assign(new Error(message), { status, publicMessage: message })
const unwrap = async query => { const { data, error } = await query; if (error) throw error; return data }
const object = v => v && typeof v === 'object' && !Array.isArray(v)
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)
const key = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(v)
const finite = v => typeof v === 'number' && Number.isFinite(v)
const number = (v, min, max, label) => { if (!finite(v) || v < min || v > max) throw fail(`Invalid ${label}`); return v }
const reasons = new Set(['unexplained', 'pricing_correction', 'discount', 'measurement_correction', 'difficult_access', 'extra_work'])
const measurementReasons = new Set(['verified_measurement', 'manual_measurement', 'site_measurement', 'measurement_correction'])
const units = new Set(['m', 'm²', 'm2', 'panes', 'pane', 'each', 'unit', 'units', 'job', 'sqm', 'lm'])
const close = (a, b, epsilon = 0.011) => finite(a) && finite(b) && Math.abs(a - b) <= epsilon
const storedNumber = v => typeof v === 'string' && v.trim() ? Number(v) : v

function validateSettings(s) {
  if (!object(s) || typeof s.enabled !== 'boolean' || !Number.isInteger(s.minSamples)) throw fail('Provide enabled, minSamples and maxAdjustment')
  return { enabled: s.enabled, minSamples: number(s.minSamples, 5, 50, 'minimum samples'), maxAdjustment: number(s.maxAdjustment, 0, 0.35, 'maximum adjustment') }
}
function sanitizeContext(c) {
  if (c == null) return {}
  if (!object(c) || JSON.stringify(c).length > 4096) throw fail('Invalid context')
  const out = {}
  for (const [k, max] of Object.entries({ estimatedCost: 1e7, estimatedDurationMin: 10080, travelKm: 20000, travelMins: 10080, targetMargin: 100 })) {
    if (c[k] != null) out[k] = number(c[k], 0, max, k)
  }
  if (c.gstRegistered != null) {
    if (typeof c.gstRegistered !== 'boolean') throw fail('Invalid GST setting')
    out.gstRegistered = c.gstRegistered
  }
  return out
}
function validateLine(l) {
  if (!object(l) || !key(l.lineKey) || typeof l.svc !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/i.test(l.svc) || !units.has(l.unit)) throw fail('Invalid service line identity or unit')
  const reason = l.reason == null || l.reason === '' ? 'unexplained' : l.reason
  if (!reasons.has(reason)) throw fail('Choose a supported correction reason')
  const storeys = l.storeys ?? 1, access = l.access ?? 'standard'
  if (!Number.isInteger(storeys) || storeys < 1 || storeys > 4 || !['easy', 'standard', 'hard'].includes(access)) throw fail('Invalid storeys or access')
  const out = { lineKey: l.lineKey, svc: l.svc, unit: l.unit,
    quantity: number(l.quantity, 0.000001, 1e7, 'quantity'), baselinePrice: number(l.baselinePrice, 0.01, 1e7, 'baseline price'),
    chosenPrice: number(l.chosenPrice, 0, 1e7, 'chosen price'), reason, storeys, access,
    measuredQuantity: null, verifiedQuantity: null, measurementReason: null }
  if (l.verifiedQuantity != null || l.measuredQuantity != null || l.measurementReason != null) {
    out.measuredQuantity = number(l.measuredQuantity, 0.000001, 1e7, 'measured quantity')
    out.verifiedQuantity = number(l.verifiedQuantity, 0.000001, 1e7, 'verified quantity')
    if (!measurementReasons.has(l.measurementReason)) throw fail('Choose an explicit measurement reason')
    if (!close(out.verifiedQuantity, out.quantity, 1e-6)) throw fail('Verified quantity must match the saved corrected quantity')
    out.measurementReason = l.measurementReason
  }
  if (['measurement_correction', 'extra_work'].includes(l.reason) && !out.verifiedQuantity) {
    // Extra work may be retained as excluded price evidence without measurements.
    if (l.reason === 'measurement_correction') throw fail('Measurement correction requires raw and verified quantities')
  }
  return out
}
function toRow(l) {
  return { line_key: l.lineKey, svc: l.svc, unit: l.unit, quantity: l.quantity,
    baseline_price: l.baselinePrice, chosen_price: l.chosenPrice, reason: l.reason,
    storeys: l.storeys, access: l.access, measured_quantity: l.measuredQuantity,
    verified_quantity: l.verifiedQuantity, measurement_reason: l.measurementReason }
}
function normalized(r) {
  return { id: r.id, businessId: r.business_id, jobId: r.job_id, quoteKey: r.quote_key,
    lineKey: r.line_key, svc: r.svc, unit: r.unit, quantity: Number(r.quantity),
    baselinePrice: Number(r.baseline_price), chosenPrice: Number(r.chosen_price), reason: r.reason,
    storeys: r.storeys, access: r.access, measuredQuantity: r.measured_quantity == null ? null : Number(r.measured_quantity),
    verifiedQuantity: r.verified_quantity == null ? null : Number(r.verified_quantity),
    measurementReason: r.measurement_reason, context: sanitizeContext(r.context), createdAt: r.created_at }
}
async function paged(build) {
  const rows = []
  for (let offset = 0; offset < 50000; offset += 500) {
    const page = await unwrap(build().order('id').range(offset, offset + 499))
    if (!Array.isArray(page)) throw fail('Invalid stored learning data', 503)
    rows.push(...page)
    if (page.length < 500) return rows
  }
  throw fail('Learning data limit reached', 413)
}

export function createPricingLearningRouter({ db, requireBusiness }) {
  if (!db || typeof requireBusiness !== 'function') throw new TypeError('db and requireBusiness are required')
  const router = Router()
  router.use(requireBusiness)
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!req.businessId || !req.userId) return res.status(403).json({ error: 'Business membership required' })
    next()
  })
  const wrap = fn => async (req, res) => {
    try { await fn(req, res) }
    catch (e) { res.status(e.status || 503).json({ error: e.publicMessage || 'Pricing learning request failed; retry or check the migration.' }) }
  }
  async function privileged(req) {
    const u = await unwrap(db.from('users').select('role').eq('id', req.userId).eq('business_id', req.businessId).maybeSingle())
    if (!u || !['owner', 'manager'].includes(u.role)) throw fail('Only an owner or manager can change learning settings or remove samples', 403)
  }
  router.get('/state', wrap(async (req, res) => {
    const s = await unwrap(db.from('pricing_learning_settings').select('*').eq('business_id', req.businessId).maybeSingle())
    const rows = await paged(() => db.from('pricing_learning_observations').select('*').eq('business_id', req.businessId))
    const jobs = [], logs = [], quotes = []
    const ids = [...new Set(rows.map(r => r.job_id))]
    let actualWorkAvailable = true
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100)
      jobs.push(...await paged(() => db.from('jobs').select('id,status,quote_id,details').eq('business_id', req.businessId).in('id', batch)))
      try {
        logs.push(...await paged(() => db.from('job_work_logs').select('id,job_id,start_at,end_at').eq('business_id', req.businessId).in('job_id', batch)))
      } catch (e) {
        if (!['42P01', 'PGRST205'].includes(e.code)) throw e
        actualWorkAvailable = false
      }
    }
    const quoteIds = [...new Set(jobs.map(j => j.quote_id).filter(Boolean))]
    for (let i = 0; i < quoteIds.length; i += 100) {
      quotes.push(...await paged(() => db.from('quotes').select('id,status').eq('business_id', req.businessId).in('id', quoteIds.slice(i, i + 100))))
    }
    const quoteById = new Map(quotes.map(q => [q.id, q]))
    const jobById = new Map(jobs.map(j => [j.id, j])), minutes = new Map()
    for (const log of logs) {
      const n = (Date.parse(log.end_at) - Date.parse(log.start_at)) / 60000
      if (Number.isFinite(n) && n > 0) minutes.set(log.job_id, (minutes.get(log.job_id) || 0) + n)
    }
    res.json({ settings: s ? validateSettings({ enabled: s.enabled, minSamples: s.min_samples, maxAdjustment: Number(s.max_adjustment) }) : DEFAULTS,
      observations: rows.map(r => {
        const j = jobById.get(r.job_id)
        return { ...normalized(r), jobStatus: j?.status || null, quoteStatus: quoteById.get(j?.quote_id)?.status || j?.details?.quoteStatus || null,
          actualWorkMinutes: actualWorkAvailable ? minutes.get(r.job_id) ?? null : null, actualCost: null }
      }), modelVersion: 1 })
  }))
  router.put('/settings', wrap(async (req, res) => {
    await privileged(req)
    const s = validateSettings(req.body)
    await unwrap(db.from('pricing_learning_settings').upsert({ business_id: req.businessId, enabled: s.enabled,
      min_samples: s.minSamples, max_adjustment: s.maxAdjustment }, { onConflict: 'business_id' }))
    res.json({ settings: s })
  }))
  router.post('/observations', wrap(async (req, res) => {
    const b = req.body
    if (!object(b) || !key(b.quoteKey) || !uuid(b.jobId) || !Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw fail('Provide a quote key, job ID and 1–100 finalized lines')
    const lines = b.lines.map(validateLine), context = sanitizeContext(b.context)
    if (new Set(lines.map(l => l.lineKey)).size !== lines.length) throw fail('Line keys must be unique')
    const job = await unwrap(db.from('jobs').select('id,status,quote_id,details').eq('id', b.jobId).eq('business_id', req.businessId).maybeSingle())
    if (!job) throw fail('Job not found', 404)
    const d = job.details || {}, saved = d.quoteLearning
    if (['won', 'scheduled', 'completed', 'paid', 'cancelled'].includes(job.status) || d.quoteStatus === 'accepted' || d.quoteAcceptedAt || d.acceptedAt) throw fail('Accepted or closed historical quotes cannot be submitted for training', 409)
    if (job.quote_id) {
      const quote = await unwrap(db.from('quotes').select('id,status').eq('id', job.quote_id).eq('business_id', req.businessId).maybeSingle())
      if (!quote || quote.status === 'accepted') throw fail('Quote is unavailable or already accepted', 409)
    }
    if (!object(saved) || saved.quoteKey !== b.quoteKey || !Array.isArray(saved.lines) || !Array.isArray(d.services) ||
      saved.lines.length !== lines.length || d.services.length !== lines.length) throw fail('Persist the finalized quote learning snapshot before submitting', 409)
    const savedLines = saved.lines.map(validateLine)
    if (JSON.stringify(sanitizeContext(saved.context)) !== JSON.stringify(context)) throw fail('Context does not match the saved quote', 409)
    lines.forEach((l, i) => {
      const expected = savedLines[i], service = d.services[i]
      if (JSON.stringify(l) !== JSON.stringify(expected) || l.svc !== service.svc ||
        !close(l.quantity, storedNumber(service.qty ?? service.quantity), 1e-6)) throw fail('Observation does not match the saved service line', 409)
    })
    if (!close(lines.reduce((sum, l) => sum + l.chosenPrice, 0), storedNumber(d.total))) throw fail('Finalized line prices do not match the original saved quote total', 409)
    // One SQL upsert statement and a composite unique key make concurrent retries
    // idempotent. A revised finalized decision replaces the same quote/line vote.
    await unwrap(db.from('pricing_learning_observations').upsert(lines.map(l => ({ business_id: req.businessId,
      job_id: job.id, quote_key: b.quoteKey, ...toRow(l), context })),
    { onConflict: 'business_id,quote_key,line_key' }))
    res.json({ ok: true })
  }))
  router.delete('/observations', wrap(async (req, res) => {
    await privileged(req)
    await unwrap(db.from('pricing_learning_observations').delete().eq('business_id', req.businessId))
    res.json({ ok: true })
  }))
  router.delete('/observations/:id', wrap(async (req, res) => {
    await privileged(req)
    if (!uuid(req.params.id)) throw fail('Invalid observation ID')
    const rows = await unwrap(db.from('pricing_learning_observations').delete().eq('business_id', req.businessId).eq('id', req.params.id).select('id'))
    if (!rows?.length) throw fail('Observation not found', 404)
    res.json({ ok: true })
  }))
  return router
}
export default createPricingLearningRouter
