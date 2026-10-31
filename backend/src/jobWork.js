import crypto from 'node:crypto'

/* =========================================================================
   Job records: worker-submitted work hours, TurnKey's own staff calendar
   (actual logged hours, not scheduling/payroll), and equipment runtime +
   service-due tracking. All writes that touch job_work_logs/equipment_usage
   go through the record_job_work()/mark_equipment_serviced() SQL functions
   in the canonical migration (supabase/migrations/20261018031355_job_work_records.sql)
   so the overlap/idempotency guarantees are enforced by Postgres, not by
   this file.

   Entirely separate from the ServiceM8 integration (servicem8*.js) — no
   shared tables, no shared routes.
   ========================================================================= */

const unwrap = async (q) => { const { data, error } = await q; if (error) throw error; return data }
const fail = (message, status = 400) => Object.assign(new Error(message), { publicMessage: message, status })
const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const NOT_MIGRATED_CODES = new Set(['42P01', 'PGRST202', 'PGRST205'])
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days — generous for a calendar view, bounded against abuse

// JPEG / PNG / WebP magic-byte sniffing — never trust the declared
// mimetype/extension alone (that's how an .svg-with-.jpg-name or similar
// would slip through if we only checked the dataURL's own prefix).
function sniffImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return { mime: 'image/png', ext: 'png' }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  return null
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024
const PHOTO_URL_TTL_SECONDS = 300

// A deterministic (not random) UUID derived from the exact storage path —
// byte-identical re-uploads (retries, double-clicks) resolve to the exact
// same attachments.id, so a unique-key conflict on retry is the race-safety
// mechanism itself, not a separate check-then-insert that a concurrent
// request could still slip through.
function deterministicAttachmentId(seed) {
  const hex = crypto.createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function fetchAllPaged(queryFactory, pageSize = 1000) {
  const rows = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await unwrap(queryFactory().range(offset, offset + pageSize - 1))
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

// record_job_work raises plain exceptions (errcode 22023) for every
// validation failure AND for "same request id, different payload" — the
// latter is a real conflict (409), everything else is a client mistake
// (400). Exclusion-constraint violations (23P01) are always a scheduling
// conflict (409). Never leak the raw Postgres error to the client.
function mapRecordWorkError(e) {
  if (e.code === '23P01') return fail('That worker already has an overlapping work entry, or that equipment is already in use during that time', 409)
  if (e.code === '22023') return fail(e.message, /already used for different/i.test(e.message) ? 409 : 400)
  return null
}

export function installJobWork(app, { db, requireBusiness, bucket = 'turnkey-uploads' }) {
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (e) {
      if (NOT_MIGRATED_CODES.has(e.code)) {
        return res.status(503).json({ error: 'Job records / equipment tracking is not set up on this server yet — the job-work migration has not been applied.' })
      }
      if (e.status) return res.status(e.status).json({ error: e.publicMessage || e.message })
      console.error('[jobWork]', e)
      res.status(500).json({ error: 'Job records request failed' })
    }
  }

  async function role(req) {
    const u = await unwrap(db.from('users').select('role').eq('id', req.userId).eq('business_id', req.businessId).maybeSingle())
    if (!u) throw fail('Staff member not found for this business', 403)
    return u.role
  }
  const isPrivileged = (r) => r === 'owner' || r === 'manager'

  async function requireJobInBusiness(req, jobId) {
    if (!uuid(jobId)) throw fail('Invalid job id')
    const job = await unwrap(db.from('jobs').select('id, business_id').eq('id', jobId).eq('business_id', req.businessId).maybeSingle())
    if (!job) throw fail('Job not found', 404)
    return job
  }

  async function requireStaffInBusiness(req, userId) {
    const staff = await unwrap(db.from('users').select('id, business_id').eq('id', userId).eq('business_id', req.businessId).maybeSingle())
    if (!staff) throw fail('Staff member not found for this business', 404)
    return staff
  }

  /* ===================== staff (for calendar filters) ===================== */
  app.get('/api/job-work/staff', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    const rows = await fetchAllPaged(() => db.from('users').select('id, email, role').eq('business_id', req.businessId))
    const staff = isPrivileged(r) ? rows : rows.filter((u) => u.id === req.userId)
    res.json({ staff, role: r })
  }))

  app.get('/api/job-work/jobs', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    const date = String(req.query.date || '').slice(0, 10)
    const parsedDate = new Date(date + 'T00:00:00Z')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) throw fail('Choose a valid work date')
    const from = new Date(date + 'T00:00:00Z'); from.setUTCDate(from.getUTCDate() - 14)
    const to = new Date(date + 'T00:00:00Z'); to.setUTCDate(to.getUTCDate() + 31)
    const rows = await fetchAllPaged(() => db.from('jobs')
      .select('id, status, scheduled_date, assigned_to, customer_id, details')
      .eq('business_id', req.businessId).gte('scheduled_date', from.toISOString().slice(0, 10))
      .lt('scheduled_date', to.toISOString().slice(0, 10)).order('scheduled_date', { ascending: true }))
    const visible = rows.filter(job => {
      if (isPrivileged(r)) return true
      const assigned = Array.isArray(job.details?.assignedStaffIds) ? job.details.assignedStaffIds : []
      return job.assigned_to === req.userId || assigned.includes(req.userId)
    })
    const customerIds = [...new Set(visible.map(job => job.customer_id).filter(Boolean))]
    const customers = []
    for (let i = 0; i < customerIds.length; i += 100) {
      customers.push(...await fetchAllPaged(() => db.from('customers').select('id,name,address,suburb')
        .eq('business_id', req.businessId).in('id', customerIds.slice(i, i + 100))))
    }
    const byId = new Map(customers.map(customer => [customer.id, customer]))
    res.json({ jobs: visible.map(job => ({
      id: job.id, status: job.status, scheduled_date: job.scheduled_date,
      name: byId.get(job.customer_id)?.name || 'Customer',
      address: [byId.get(job.customer_id)?.address, byId.get(job.customer_id)?.suburb].filter(Boolean).join(', '),
      services: (Array.isArray(job.details?.services) ? job.details.services : []).map(service =>
        String(service.label || service.svc || '').slice(0, 120)).filter(Boolean).slice(0, 12),
    })) })
  }))

  /* ===================== work logs / calendar ===================== */

  function parseWindow(body) {
    const startAt = new Date(body?.startAt)
    const endAt = new Date(body?.endAt)
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) throw fail('startAt/endAt must be valid dates')
    if (endAt <= startAt) throw fail('endAt must be after startAt')
    if (endAt.getTime() - startAt.getTime() > 24 * 60 * 60 * 1000) throw fail('A single entry cannot exceed 24 hours')
    return { startAt, endAt }
  }

  app.post('/api/job-work/logs', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    const body = req.body || {}
    const job = await requireJobInBusiness(req, body.jobId)

    if (!uuid(body.requestId)) throw fail('requestId must be a valid UUID — generate it once per submission and reuse the same id if retrying the exact same entry')
    const requestId = body.requestId

    let targetUserId = req.userId
    if (body.userId && body.userId !== req.userId) {
      if (!isPrivileged(r)) throw fail('You can only log your own hours', 403)
      await requireStaffInBusiness(req, body.userId)
      targetUserId = body.userId
    }

    const { startAt, endAt } = parseWindow(body)
    const durationHours = (endAt.getTime() - startAt.getTime()) / 3600000
    const travelMinutes = body.travelMinutes == null ? 0 : Number(body.travelMinutes)
    if (!Number.isInteger(travelMinutes) || travelMinutes < 0 || travelMinutes > durationHours * 60) throw fail('Travel time must be whole minutes between zero and the logged shift length')
    const userNotes = body.notes != null ? String(body.notes).slice(0, 1800) : ''
    const travelNote = travelMinutes ? `[Travel: ${travelMinutes} min]` : ''
    const notes = [travelNote, userNotes].filter(Boolean).join(' · ').slice(0, 2000) || null
    const equipmentRunHours = Math.max(0, durationHours - travelMinutes / 60)

    const equipmentInput = Array.isArray(body.equipment) ? body.equipment : []
    if (equipmentInput.length > 20) throw fail('Use at most 20 equipment entries per submission')
    const seenAssets = new Set()
    const equipment = []
    for (const item of equipmentInput) {
      if (!uuid(item?.assetId)) throw fail('Invalid equipment asset id')
      if (seenAssets.has(item.assetId)) throw fail('Each equipment asset can only be listed once per entry')
      seenAssets.add(item.assetId)
      const hours = body.equipmentHoursAuto === true ? equipmentRunHours : Number(item.hours)
      if (!Number.isFinite(hours) || hours < 0) throw fail('Equipment hours must be zero or greater')
      if (hours > durationHours) throw fail('Equipment runtime hours cannot exceed the logged work duration')
      equipment.push({ asset_id: item.assetId, hours, notes: item.notes != null ? String(item.notes).slice(0, 500) : null })
    }

    let result
    try {
      result = await unwrap(db.rpc('record_job_work', {
        p_business_id: req.businessId,
        p_job_id: job.id,
        p_user_id: targetUserId,
        p_start_at: startAt.toISOString(),
        p_end_at: endAt.toISOString(),
        p_notes: notes,
        p_request_id: requestId,
        p_equipment: equipment
      }))
    } catch (e) {
      throw mapRecordWorkError(e) || e
    }
    const row = Array.isArray(result) ? result[0] : result
    res.status(201).json({ ok: true, logId: row.log_id, deduped: row.deduped })
  }))

  app.get('/api/job-work/logs', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    const buildQuery = () => {
    let q = db.from('job_work_logs').select('*').eq('business_id', req.businessId).order('start_at', { ascending: true }).order('id', {ascending:true})

    if (req.query.jobId) {
      if (!uuid(req.query.jobId)) throw fail('Invalid job id')
      q = q.eq('job_id', req.query.jobId)
    } else {
      if (!req.query.from || !req.query.to) throw fail('Provide either jobId, or a from/to ISO timestamp range')
      const from = new Date(req.query.from), to = new Date(req.query.to)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw fail('from/to must be valid ISO timestamps')
      if (to <= from) throw fail('to must be after from')
      if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw fail('Range cannot exceed 90 days')
      // Half-open range — matches the [) exclusion constraints in the
      // schema, so a log starting exactly at `to` belongs to the NEXT page,
      // not this one.
      q = q.gte('start_at', from.toISOString()).lt('start_at', to.toISOString())
    }

    if (!isPrivileged(r)) {
      q = q.eq('user_id', req.userId)
    } else if (req.query.userId) {
      if (!uuid(req.query.userId)) throw fail('Invalid user id')
      q = q.eq('user_id', req.query.userId)
    }

    return q
    }
    const logs = await fetchAllPaged(buildQuery)
    const logIds = logs.map((l) => l.id)
    const usage = []
    for(let offset=0;offset<logIds.length;offset+=100){
      usage.push(...await fetchAllPaged(() => db.from('equipment_usage').select('*').eq('business_id', req.businessId).in('log_id', logIds.slice(offset,offset+100)).order('id')))
    }
    res.json({ logs, usage })
  }))

  /* ===================== equipment ===================== */

  function computeAssetStatus(asset, usageRows, serviceEvents) {
    const runtimeHours = Number(asset.baseline_hours) + usageRows.reduce((sum, u) => sum + Number(u.hours), 0)
    const lastService = serviceEvents
      .filter((s) => s.asset_id === asset.id)
      .sort((a, b) => new Date(b.serviced_at) - new Date(a.serviced_at))[0] || null
    // An asset with no recorded service event has no known service
    // history at all — its baseline hours are NOT "serviced at onboarding",
    // they're simply unaccounted-for prior runtime. The full runtime
    // (baseline + logged usage) counts toward the next service, same as if
    // it had never been serviced, ever.
    const sinceServiceHours = runtimeHours - (lastService ? Number(lastService.meter_hours) : 0)
    const remainingHours = Number(asset.service_interval_hours) - sinceServiceHours
    return {
      ...asset,
      runtimeHours,
      sinceServiceHours,
      remainingHours,
      due: remainingHours <= 0,
      hasServiceHistory: !!lastService,
      lastServiceAt: lastService?.serviced_at || null,
      recentServiceEvents: serviceEvents.filter((s) => s.asset_id === asset.id).sort((a, b) => new Date(b.serviced_at) - new Date(a.serviced_at)).slice(0, 10)
    }
  }

  app.get('/api/job-work/equipment', requireBusiness, wrap(async (req, res) => {
    const [assets, usage, events] = await Promise.all([
      fetchAllPaged(() => db.from('equipment_assets').select('*').eq('business_id', req.businessId).order('name').order('id')),
      fetchAllPaged(() => db.from('equipment_usage').select('*').eq('business_id', req.businessId).order('id')),
      fetchAllPaged(() => db.from('equipment_service_events').select('*').eq('business_id', req.businessId).order('id'))
    ])
    const equipment = assets.map((a) => computeAssetStatus(a, usage.filter((u) => u.asset_id === a.id), events))
    res.json({ equipment })
  }))

  function validateAssetCore(body) {
    const name = String(body?.name || '').trim()
    if (!name) throw fail('Equipment name is required')
    if (name.length > 200) throw fail('Equipment name is too long')
    const serviceIntervalHours = Number(body?.serviceIntervalHours)
    if (!Number.isFinite(serviceIntervalHours) || serviceIntervalHours <= 0) throw fail('Service interval hours must be a positive number')
    return { name, serviceIntervalHours }
  }

  app.post('/api/job-work/equipment', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    if (!isPrivileged(r)) throw fail('Only an owner or manager can add equipment', 403)
    const { name, serviceIntervalHours } = validateAssetCore(req.body)
    const baselineHours = req.body?.baselineHours != null ? Number(req.body.baselineHours) : 0
    if (!Number.isFinite(baselineHours) || baselineHours < 0) throw fail('Baseline hours must be zero or greater')
    const row = await unwrap(db.from('equipment_assets').insert({
      business_id: req.businessId, name, service_interval_hours: serviceIntervalHours, baseline_hours: baselineHours
    }).select('*').single())
    res.status(201).json({ ok: true, asset: row })
  }))

  // Baseline hours are only ever set at creation — editing it later would
  // let someone silently rewrite an asset's runtime history (and therefore
  // its service-due status) after the fact, so this intentionally does not
  // accept baselineHours at all.
  app.patch('/api/job-work/equipment/:id', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    if (!isPrivileged(r)) throw fail('Only an owner or manager can edit equipment', 403)
    if (!uuid(req.params.id)) throw fail('Invalid equipment id')
    const { name, serviceIntervalHours } = validateAssetCore(req.body)
    const rows = await unwrap(db.from('equipment_assets').update({
      name, service_interval_hours: serviceIntervalHours
    }).eq('id', req.params.id).eq('business_id', req.businessId).select('*'))
    if (!rows.length) throw fail('Equipment not found', 404)
    res.json({ ok: true, asset: rows[0] })
  }))

  app.post('/api/job-work/equipment/:id/service', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    if (!isPrivileged(r)) throw fail('Only an owner or manager can mark equipment serviced', 403)
    if (!uuid(req.params.id)) throw fail('Invalid equipment id')
    const notes = req.body?.notes != null ? String(req.body.notes).slice(0, 2000) : null
    let event
    try {
      event = await unwrap(db.rpc('mark_equipment_serviced', {
        p_business_id: req.businessId, p_asset_id: req.params.id, p_author: req.userId, p_notes: notes
      }))
    } catch (e) {
      if (e.code === '22023') throw fail(e.message, 400)
      throw e
    }
    res.status(201).json({ ok: true, event: Array.isArray(event) ? event[0] : event })
  }))

  /* ===================== job photos (before/after) ===================== */

  app.post('/api/job-work/jobs/:jobId/photos', requireBusiness, wrap(async (req, res) => {
    const job = await requireJobInBusiness(req, req.params.jobId)
    const kind = req.body?.kind
    if (kind !== 'before_photo' && kind !== 'after_photo') throw fail('kind must be before_photo or after_photo')
    const dataUrl = req.body?.dataUrl
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([a-zA-Z0-9+/=]+)$/)
    if (!match) throw fail('Provide a base64 data URL image')
    const declaredMime = match[1]
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length > MAX_PHOTO_BYTES) throw fail('Photos must be 8MB or smaller')
    const sniffed = sniffImage(bytes)
    if (!sniffed) throw fail('Only JPEG, PNG or WebP photos are allowed')
    if (declaredMime && declaredMime !== sniffed.mime) throw fail('File content does not match its declared type')

    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex')
    const path = `${req.businessId}/job-photos/${job.id}/${kind}/${contentHash}.${sniffed.ext}`
    const photoId = deterministicAttachmentId(`${req.businessId}/${job.id}/${kind}/${path}`)

    const { error: uploadError } = await db.storage.from(bucket).upload(path, bytes, { contentType: sniffed.mime, upsert: true })
    if (uploadError) throw fail('Photo upload failed — try again', 502)

    const filename = req.body?.filename ? String(req.body.filename).slice(0, 180) : `${kind}.${sniffed.ext}`
    try {
      const row = await unwrap(db.from('attachments').insert({
        id: photoId, business_id: req.businessId, job_id: job.id, kind, path, filename
      }).select('*').single())
      return res.status(201).json({ ok: true, attachment: row, deduped: false })
    } catch (e) {
      if (e.code === '23505') {
        const existing = await unwrap(db.from('attachments').select('*').eq('id', photoId).eq('business_id', req.businessId).eq('job_id', job.id).eq('path', path).maybeSingle())
        if (existing) return res.status(200).json({ ok: true, attachment: existing, deduped: true })
      }
      throw fail('Could not save photo metadata — try again', 502)
    }
  }))

  app.get('/api/job-work/jobs/:jobId/photos', requireBusiness, wrap(async (req, res) => {
    const job = await requireJobInBusiness(req, req.params.jobId)
    const rows = await unwrap(db.from('attachments').select('*').eq('business_id', req.businessId).eq('job_id', job.id)
      .in('kind', ['before_photo', 'after_photo']).order('created_at', { ascending: false }))
    const photos = []
    for (const a of rows) {
      const { data, error } = await db.storage.from(bucket).createSignedUrl(a.path, PHOTO_URL_TTL_SECONDS)
      photos.push({ ...a, url: error ? null : data?.signedUrl || null })
    }
    res.json({ photos })
  }))
}
