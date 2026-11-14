const unwrap = async q => { const { data, error } = await q; if (error) throw error; return data }
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

// Only explicit staff_identity links are authority: never infer identity from
// names/emails, and never accept a link left over from a previous connection.
export async function jobWorkStaffIds(db, businessId, userId) {
  const ids = new Set([userId])
  const connection = await unwrap(db.from('servicem8_connections').select('generation').eq('business_id', businessId).maybeSingle())
  if (!connection?.generation) return ids
  const links = await unwrap(db.from('external_object_mappings').select('external_uuid')
    .eq('business_id', businessId).eq('object_type', 'staff_identity')
    .eq('connection_generation', connection.generation).eq('local_id', userId))
  for (const link of links || []) if (uuid(link.external_uuid)) ids.add('servicem8:' + link.external_uuid)
  return ids
}

export function jobWorkAssigned(job, ids) {
  return ids.has(job.assigned_to) || (Array.isArray(job.details?.assignedStaffIds) && job.details.assignedStaffIds.some(id => ids.has(id)))
}

export async function jobWorkCanAccess(db, businessId, userId, job, ids) {
  ids ||= await jobWorkStaffIds(db, businessId, userId)
  if (jobWorkAssigned(job, ids)) return true
  if (ids.size < 2) return false
  return await unwrap(db.rpc('job_work_dispatch_access', {
    p_business_id: businessId, p_job_id: job.id, p_employee_id: userId
  })) === true
}

export function safeReviewUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) throw fail('reviewUrl must be an HTTPS URL of at most 1024 characters')
  const text = value.trim()
  if (!text) return ''
  let url
  try { url = new URL(text) } catch { throw fail('reviewUrl must be an HTTPS URL') }
  if (!/^https:\/\//i.test(text) || url.protocol !== 'https:' || !url.hostname || url.username || url.password || /[\s\\]/.test(text) || text.split('/')[2].includes('@')) throw fail('reviewUrl must use HTTPS without username or password')
  return text
}

export function installPostJobChecklist(app, { db, requireBusiness }) {
  const wrap = fn => async (req, res) => {
    try { await fn(req, res) } catch (error) {
      if (['42P01', '42703', 'PGRST202', 'PGRST205'].includes(error.code)) return res.status(503).json({ error: 'Post-job checklist is not set up on this server yet' })
      const status = error.status || ({ '22023': 400, '42501': 403, 'P0002': 404, '23514': 409 }[error.code])
      if (status) return res.status(status).json({ error: error.message })
      console.error('[postJobChecklist]', error)
      res.status(500).json({ error: 'Post-job checklist request failed' })
    }
  }
  const member = async req => {
    const user = await unwrap(db.from('users').select('id,name,role').eq('id', req.userId).eq('business_id', req.businessId).maybeSingle())
    if (!user) throw fail('Staff member not found for this business', 403)
    return user
  }
  const settings = business => {
    let reviewUrl = ''
    try { reviewUrl = safeReviewUrl(business.post_job_settings?.reviewUrl || '') } catch { /* fail closed for legacy malformed configuration */ }
    return { enabled: business.post_job_settings?.enabled !== false, reviewUrl, logoUrl: business.logo_url || '', businessName: business.name || '' }
  }
  const business = req => unwrap(db.from('businesses').select('post_job_settings,logo_url,name').eq('id', req.businessId).single())
  const identity = async (req, user) => ({ role: user.role, employee: {
    id: req.userId,
    name: await unwrap(db.rpc('post_job_employee_name', { p_business_id: req.businessId, p_employee_id: req.userId })),
    aliases: [...await jobWorkStaffIds(db, req.businessId, req.userId)]
  } })
  app.get('/api/job-work/portal', requireBusiness, wrap(async (req, res) => {
    const parseDate = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('Choose a valid YYYY-MM-DD date')
      const parsed = new Date(value + 'T00:00:00Z')
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw fail('Choose a valid YYYY-MM-DD date')
      return parsed
    }
    let from, to
    if (req.query.from != null || req.query.to != null) {
      if (req.query.date != null) throw fail('Use date or from/to, not both')
      from = parseDate(req.query.from); to = parseDate(req.query.to)
    } else {
      const date = parseDate(req.query.date ?? new Date().toISOString().slice(0, 10))
      from = new Date(date); from.setUTCDate(from.getUTCDate() - 14)
      to = new Date(date); to.setUTCDate(to.getUTCDate() + 31)
    }
    if (to <= from || to - from > 93 * 86400000) throw fail('Choose a forward range of at most 93 days')
    res.set?.('Cache-Control', 'no-store')
    res.json(await unwrap(db.rpc('job_work_portal', {
      p_business_id: req.businessId, p_employee_id: req.userId,
      p_from: from.toISOString().slice(0, 10), p_to: to.toISOString().slice(0, 10)
    })))
  }))
  app.get('/api/job-work/post-job/settings', requireBusiness, wrap(async (req, res) => {
    const user = await member(req)
    res.json({ settings: settings(await business(req)), ...await identity(req, user) })
  }))
  app.put('/api/job-work/post-job/settings', requireBusiness, wrap(async (req, res) => {
    const user = await member(req)
    if (!['owner', 'manager'].includes(user.role)) throw fail('Only an owner or manager can change checklist settings', 403)
    if (typeof req.body?.enabled !== 'boolean') throw fail('enabled must be a boolean')
    const reviewUrl = safeReviewUrl(req.body?.reviewUrl)
    const row = await unwrap(db.from('businesses').update({ post_job_settings: { enabled: req.body.enabled, reviewUrl } })
      .eq('id', req.businessId).select('post_job_settings,logo_url,name').single())
    res.json({ settings: settings(row) })
  }))
  const run = action => wrap(async (req, res) => {
    if (!uuid(req.params.jobId)) throw fail('Invalid job id')
    // The RPC checks membership, assignment and response types inside the same
    // transaction as the write. Never accept employee identity from the body.
    const result = await unwrap(db.rpc('post_job_checklist', {
      p_business_id: req.businessId, p_job_id: req.params.jobId,
      p_employee_id: req.userId, p_action: action, p_responses: req.body?.responses ?? null
    }))
    if (action === 'get') {
      result.settings = settings(await business(req))
      Object.assign(result, await identity(req, await member(req)))
    }
    if (result.statusManagedByServiceM8 !== undefined) result.statusManagedBySM8 = result.statusManagedByServiceM8
    res.json(result)
  })
  app.get('/api/job-work/jobs/:jobId/post-job', requireBusiness, run('get'))
  app.put('/api/job-work/jobs/:jobId/post-job', requireBusiness, run('save'))
  app.post('/api/job-work/jobs/:jobId/post-job/complete', requireBusiness, run('complete'))
}
