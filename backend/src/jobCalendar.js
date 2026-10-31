import crypto from 'node:crypto'

/* =========================================================================
   Job Calendar: booking jobs onto a real calendar (date + time, not just a
   bare scheduled_date), assigning one or more staff, seeing busy days from
   availability blocks and connected Google Calendars, and (optionally)
   pushing a booked job onto the current user's own connected Google
   Calendar. Reuses jobs/customers/users/availability_blocks/calendar_events/
   calendar_connections — no new tables, no parallel pipeline. All writes
   that touch booking/blocking go through the job_calendar_book()/
   job_calendar_upsert_block()/job_calendar_set_google_status() SQL
   functions in the canonical migration
   (supabase/migrations/20261018094524_job_calendar_booking.sql) so the
   per-business serialization and overlap checks are enforced by Postgres,
   not by this file.

   Entirely separate from ServiceM8 (servicem8*.js) and the sales/quoting
   pipeline (salesPlatform.js, jobWork.js) — no shared write paths.
   ========================================================================= */

const unwrap = async (q) => { const { data, error } = await q; if (error) throw error; return data }
const fail = (message, status = 400) => Object.assign(new Error(message), { publicMessage: message, status })
const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const NOT_MIGRATED_CODES = new Set(['42P01', 'PGRST202', 'PGRST205'])
const MAX_RANGE_MS = 93 * 24 * 60 * 60 * 1000 // 93 days — generous for a calendar view, bounded against abuse
const MAX_STAFF_PER_BOOKING = 20
const BLOCK_TYPES = new Set(['holiday', 'sick', 'personal', 'training', 'unavailable', 'business_closed', 'public_holiday', 'other'])
const GOOGLE_TIMEOUT_MS = 10000

// Only these keys of a job's `details` blob are ever handed to the client
// from this module — `details` also carries pricing/cost/internal fields
// written by other parts of the app, and those must never leak through the
// calendar API.
const CALENDAR_DETAIL_KEYS = [
  'calendarStartAt', 'calendarEndAt', 'scheduledStartMin', 'scheduledDurationMin',
  'assignedStaffIds', 'calendarTeamLabel', 'calendarNotes', 'calendarGoogleSync', 'googleEventId',
  'calendarGoogleSyncState', 'calendarGoogleSyncError', 'calendarGoogleSyncedAt',
  'serviceM8Booking', 'serviceM8Status'
]
function filterCalendarDetails(details) {
  const out = {}
  if (!details || typeof details !== 'object') return out
  for (const k of CALENDAR_DETAIL_KEYS) if (Object.prototype.hasOwnProperty.call(details, k)) out[k] = details[k]
  return out
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// Confirms that, interpreted in `timeZone`, `startAt` falls on calendar day
// `dateISO` (YYYY-MM-DD) at local-minute `startMin` — catches a client
// sending a startAt that doesn't actually match the date/time it displayed.
function startMatchesLocalDateAndMinute(startAt, timeZone, dateISO, startMin) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(startAt)
  const get = (t) => parts.find((p) => p.type === t)?.value
  const localDate = `${get('year')}-${get('month')}-${get('day')}`
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const localMin = hour * 60 + minute
  return localDate === dateISO && localMin === Number(startMin)
}

// record_job_calendar_book/record_job_calendar_upsert_block raise plain
// exceptions (errcode 22023) for validation failures, 42501 for role
// failures, and a dedicated 23P01 for a genuine scheduling conflict — never
// leak the raw Postgres error text for anything else.
function mapRpcError(e) {
  if (e.code === '23P01') return fail(e.message, 409)
  if (e.code === '42501') return fail(e.message, 403)
  if (e.code === '22023') return fail(e.message, /not found/i.test(e.message) ? 404 : 400)
  return null
}

function sniffJobInterval(job) {
  const d = job.details || {}
  if (d.calendarStartAt && d.calendarEndAt) {
    const s = new Date(d.calendarStartAt), e = new Date(d.calendarEndAt)
    if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && e > s) return [s, e]
  }
  if (!job.scheduled_date) return null
  // No authoritative time-of-day on record — only used here to decide
  // whether a job falls inside the requested display range, NOT as the
  // conflict-checking authority (that's job_calendar_job_interval() in SQL,
  // which additionally knows the business's actual timezone). Treating the
  // bare date as one UTC day is a safe, deliberately coarse approximation
  // for "is this roughly in view".
  const s = new Date(`${job.scheduled_date}T00:00:00.000Z`)
  const e = new Date(s.getTime() + 24 * 60 * 60 * 1000)
  return [s, e]
}

// Always ordered by id — offset-based .range() pagination without a stable
// sort can skip or repeat rows if the table is written to between pages.
async function fetchAllPaged(queryFactory, pageSize = 1000) {
  const rows = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await unwrap(queryFactory().order('id').range(offset, offset + pageSize - 1))
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

// PostgREST/Postgres has a practical limit on how many values an `.in()`
// filter (and the URL it's sent over) can comfortably carry — chunk any
// caller-sized id list rather than sending it as one unbounded IN clause.
async function fetchChunkedIn(column, values, queryFactory, chunkSize = 100) {
  const rows = []
  for (let i = 0; i < values.length; i += chunkSize) {
    rows.push(...await fetchAllPaged(() => queryFactory().in(column, values.slice(i, i + chunkSize))))
  }
  return rows
}

function deterministicGoogleEventId(businessId, jobId, userId, connectionId) {
  // Google Calendar client-provided event ids must be lowercase a-v/0-9,
  // 5-1024 chars (developers.google.com/workspace/calendar/api/v3/reference/events/insert).
  // Hex digits (0-9a-f) are a subset of a-v, so a plain sha256 hex prefix
  // qualifies without any extra encoding step.
  const hex = crypto.createHash('sha256').update(`${businessId}/${jobId}/${userId}/${connectionId}`).digest('hex')
  return 'tk' + hex.slice(0, 40)
}

async function googleFetch(url, accessToken, { method = 'GET', body } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    let json = null
    try { json = await res.json() } catch { /* empty body, e.g. some 204s */ }
    return { ok: res.ok, status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

export function installJobCalendar(app, { db, requireBusiness, getGoogleCalendarToken, googleConfigured }) {
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (e) {
      if (NOT_MIGRATED_CODES.has(e.code)) {
        return res.status(503).json({ error: 'Job Calendar is not set up on this server yet — the job-calendar migration has not been applied.' })
      }
      if (e.status) return res.status(e.status).json({ error: e.publicMessage || e.message })
      console.error('[jobCalendar]', e)
      res.status(500).json({ error: 'Job Calendar request failed' })
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
    const job = await unwrap(db.from('jobs').select('*').eq('id', jobId).eq('business_id', req.businessId).maybeSingle())
    if (!job) throw fail('Job not found', 404)
    return job
  }

  function isAssignedToStaff(job, userId) {
    if (job.assigned_to === userId) return true
    const ids = job.details?.assignedStaffIds
    return Array.isArray(ids) && ids.includes(userId)
  }

  /* ========================= GET /range ========================= */
  app.get('/api/job-calendar/range', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    const privileged = isPrivileged(r)

    const from = new Date(req.query.from), to = new Date(req.query.to)
    if (!req.query.from || !req.query.to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw fail('from/to must be valid ISO timestamps')
    }
    if (to <= from) throw fail('to must be after from')
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw fail('Range cannot exceed 93 days')

    const allJobs = await fetchAllPaged(() => db.from('jobs').select('*').eq('business_id', req.businessId))
    const visibleJobs = allJobs.filter((j) => j.status !== 'cancelled' && (privileged || isAssignedToStaff(j, req.userId)))
    const jobs = visibleJobs.filter((j) => {
      if (!j.scheduled_date && !j.details?.calendarStartAt) return true // unscheduled — always surfaced for drag-in
      const interval = sniffJobInterval(j)
      return interval && interval[1] > from && interval[0] < to
    })

    const customerIds = [...new Set(jobs.map((j) => j.customer_id).filter(Boolean))]
    const customers = customerIds.length
      ? await fetchChunkedIn('id', customerIds, () => db.from('customers').select('id, name, address, suburb').eq('business_id', req.businessId))
      : []
    const customerById = new Map(customers.map((c) => [c.id, c]))

    const jobsOut = jobs.map((j) => ({
      id: j.id,
      status: j.status,
      assigned_to: j.assigned_to,
      scheduled_date: j.scheduled_date,
      updated_at: j.updated_at,
      customer: customerById.has(j.customer_id)
        ? { name: customerById.get(j.customer_id).name, address: customerById.get(j.customer_id).address, suburb: customerById.get(j.customer_id).suburb }
        : null,
      details: filterCalendarDetails(j.details)
    }))

    const staffRows = await fetchAllPaged(() => db.from('users').select('id, name, email, role').eq('business_id', req.businessId))
    const staff = privileged ? staffRows : staffRows.filter((u) => u.id === req.userId)

    // Overlap, not "starts inside the range" — a multi-day block/event that
    // started before `from` but is still ongoing into the requested window
    // must still show up, or a holiday/busy span spanning the view's edge
    // would silently vanish from one of the two weeks it touches.
    const eventRows = await fetchAllPaged(() => db.from('calendar_events')
      .select('id, user_id, title, start_time, end_time, busy_status, source, notes, connection_id, external_id').eq('business_id', req.businessId)
      .lt('start_time', to.toISOString()).gt('end_time', from.toISOString()))
    const blockRows = await fetchAllPaged(() => db.from('availability_blocks')
      .select('id, user_id, block_type, start_at, end_at, all_day, reason').eq('business_id', req.businessId)
      .lt('start_at', to.toISOString()).gt('end_at', from.toISOString()))
    const scoped = (rows) => privileged ? rows : rows.filter((x) => x.user_id === req.userId || x.user_id == null)

    const connection = await unwrap(db.from('calendar_connections').select('sync_status, last_synced_at')
      .eq('business_id', req.businessId).eq('user_id', req.userId).eq('provider', 'google').maybeSingle())

    res.json({
      jobs: jobsOut,
      staff,
      events: scoped(eventRows),
      blocks: scoped(blockRows),
      google: {
        connected: !!connection,
        email: null, // not persisted anywhere today — see report
        lastSyncedAt: connection?.last_synced_at || null,
        syncStatus: connection?.sync_status || null,
        configured: !!googleConfigured()
      },
      canManage: privileged
    })
  }))

  /* ========================= PUT /jobs/:id ========================= */
  app.put('/api/job-calendar/jobs/:id', requireBusiness, wrap(async (req, res) => {
    if (!uuid(req.params.id)) throw fail('Invalid job id')
    const r = await role(req)
    if (!isPrivileged(r)) throw fail('Only an owner or manager can manage bookings', 403)

    const body = req.body || {}
    const startAt = new Date(body.startAt), endAt = new Date(body.endAt)
    if (!body.startAt || !body.endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw fail('startAt/endAt must be valid ISO timestamps')
    }
    if (endAt <= startAt) throw fail('endAt must be after startAt')
    if (endAt.getTime() - startAt.getTime() > 24 * 60 * 60 * 1000) throw fail('A single booking cannot exceed 24 hours')
    if (!isValidTimeZone(body.timeZone)) throw fail('timeZone must be a valid IANA time zone')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.dateISO || ''))) throw fail('dateISO must be a YYYY-MM-DD date')
    const startMin = Number(body.startMin)
    if (!Number.isInteger(startMin) || startMin < 0 || startMin > 1439) throw fail('startMin must be a minute-of-day between 0 and 1439')
    if (!startMatchesLocalDateAndMinute(startAt, body.timeZone, body.dateISO, startMin)) {
      throw fail('dateISO/startMin do not match startAt in the given time zone')
    }

    const staffIds = [...new Set(Array.isArray(body.staffIds) ? body.staffIds : [])]
    if (!staffIds.length) throw fail('At least one staff member must be assigned')
    if (staffIds.length > MAX_STAFF_PER_BOOKING) throw fail(`Use at most ${MAX_STAFF_PER_BOOKING} staff per booking`)
    if (!staffIds.every(uuid)) throw fail('Invalid staff id')

    const teamLabel = body.teamLabel != null ? String(body.teamLabel).slice(0, 200) : null
    const notes = body.notes != null ? String(body.notes).slice(0, 2000) : null
    const durationMin = Math.round((endAt.getTime() - startAt.getTime()) / 60000)

    let job
    try {
      job = await unwrap(db.rpc('job_calendar_book', {
        p_business_id: req.businessId,
        p_caller_id: req.userId,
        p_job_id: req.params.id,
        p_start_at: startAt.toISOString(),
        p_end_at: endAt.toISOString(),
        p_timezone: body.timeZone,
        p_staff_ids: staffIds,
        p_team_label: teamLabel,
        p_notes: notes,
        p_sync_google: !!body.syncGoogle,
        p_schedule_start_min: startMin,
        p_schedule_duration_min: durationMin
      }))
    } catch (e) {
      throw mapRpcError(e) || e
    }
    const row = Array.isArray(job) ? job[0] : job

    // The booking write above is already durable at this point — whatever
    // happens with Google below must never turn a saved booking into a
    // failed HTTP response. job_calendar_book() decides the actual (merged,
    // sticky-once-true) sync intent; this just acts on it.
    let sync = { state: 'off', error: null, job: null }
    if (row.details?.calendarGoogleSync) {
      try {
        sync = await syncJobToGoogle(req, req.params.id)
      } catch (e) {
        console.error('[jobCalendar] Google sync threw unexpectedly', { businessId: req.businessId, jobId: req.params.id, message: e.message })
        sync = { state: 'error', error: 'Could not sync to Google Calendar', job: null }
      }
    }
    const effectiveJob = sync.job || row
    res.json({
      ok: true,
      job: { ...effectiveJob, details: filterCalendarDetails(effectiveJob.details) },
      googleSync: { status: sync.state, error: sync.error }
    })
  }))

  /* ========================= POST /blocks ========================= */
  app.post('/api/job-calendar/blocks', requireBusiness, wrap(async (req, res) => {
    const body = req.body || {}
    if (!uuid(body.id)) throw fail('A stable UUID id is required')
    const startAt = new Date(body.startAt), endAt = new Date(body.endAt)
    if (!body.startAt || !body.endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw fail('startAt/endAt must be valid ISO timestamps')
    }
    if (endAt <= startAt) throw fail('endAt must be after startAt')
    if (endAt.getTime() - startAt.getTime() > 366 * 24 * 60 * 60 * 1000) throw fail('A block cannot span more than 366 days')
    const blockType = String(body.blockType || 'unavailable')
    if (!BLOCK_TYPES.has(blockType)) throw fail('Invalid block type')
    const staffId = body.staffId == null ? null : body.staffId
    if (staffId != null && !uuid(staffId)) throw fail('Invalid staff id')
    const reason = body.reason != null ? String(body.reason).slice(0, 2000) : null

    let result
    try {
      result = await unwrap(db.rpc('job_calendar_upsert_block', {
        p_business_id: req.businessId,
        p_caller_id: req.userId,
        p_id: body.id,
        p_start_at: startAt.toISOString(),
        p_end_at: endAt.toISOString(),
        p_all_day: !!body.allDay,
        p_staff_id: staffId,
        p_block_type: blockType,
        p_reason: reason
      }))
    } catch (e) {
      throw mapRpcError(e) || e
    }
    const row = Array.isArray(result) ? result[0] : result
    res.status(201).json({ ok: true, block: row.block, conflictingJobs: row.conflicting_jobs })
  }))

  /* ========================= DELETE /blocks/:id ========================= */
  app.delete('/api/job-calendar/blocks/:id', requireBusiness, wrap(async (req, res) => {
    if (!uuid(req.params.id)) throw fail('Invalid block id')
    try {
      await unwrap(db.rpc('job_calendar_delete_item', {
        p_business_id: req.businessId, p_caller_id: req.userId, p_id: req.params.id, p_kind: 'block'
      }))
    } catch (e) { throw mapRpcError(e) || e }
    res.json({ ok: true })
  }))

  // Stable client UUID makes a retried create update the same native event.
  app.post('/api/job-calendar/events', requireBusiness, wrap(async (req, res) => {
    const body = req.body || {}
    if (!uuid(body.id) || !uuid(body.staffId)) throw fail('Valid event and staff UUIDs are required')
    const start = new Date(body.startAt), end = new Date(body.endAt)
    if (!body.startAt || !body.endAt || !Number.isFinite(+start) || !Number.isFinite(+end) || end <= start || end - start > 366 * 86400000) throw fail('Invalid event time window')
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw fail('Event title must be 1–200 characters')
    if (!['busy', 'free'].includes(body.busyStatus)) throw fail('Invalid busy status')
    if (!isValidTimeZone(body.timeZone)) throw fail('Invalid time zone')
    let result
    try {
      result = await unwrap(db.rpc('job_calendar_upsert_event', {
        p_business_id: req.businessId, p_caller_id: req.userId, p_id: body.id, p_staff_id: body.staffId,
        p_title: body.title.trim(), p_start_at: start.toISOString(), p_end_at: end.toISOString(),
        p_busy_status: body.busyStatus, p_notes: body.notes == null ? null : String(body.notes).slice(0, 2000), p_timezone: body.timeZone
      }))
    } catch (e) { throw mapRpcError(e) || e }
    res.status(201).json({ ok: true, event: Array.isArray(result) ? result[0] : result })
  }))

  app.delete('/api/job-calendar/events/:id', requireBusiness, wrap(async (req, res) => {
    if (!uuid(req.params.id)) throw fail('Invalid event id')
    try {
      await unwrap(db.rpc('job_calendar_delete_item', {
        p_business_id: req.businessId, p_caller_id: req.userId, p_id: req.params.id, p_kind: 'event'
      }))
    } catch (e) { throw mapRpcError(e) || e }
    res.json({ ok: true })
  }))

  app.post('/api/job-calendar/jobs/:id/unschedule', requireBusiness, wrap(async (req, res) => {
    if (!uuid(req.params.id)) throw fail('Invalid job id')
    if (!isPrivileged(await role(req))) throw fail('Only an owner or manager can manage bookings', 403)
    await withGoogleLock(`${req.businessId}:${req.params.id}`, async () => {
      let result
      try {
        result = await unwrap(db.rpc('job_calendar_unschedule', {
          p_business_id: req.businessId, p_caller_id: req.userId, p_job_id: req.params.id
        }))
      } catch (e) { throw mapRpcError(e) || e }
      const row = Array.isArray(result) ? result[0] : result
      res.json({ ok: true, job: { ...row, details: filterCalendarDetails(row.details) },
        googleWarning: 'Any Google Calendar copy remains unchanged. Remove it in Google Calendar if no longer needed.' })
    })
  }))

  // Serializes Google network calls per (business, job) within this single
  // process — a reschedule that fires a sync immediately followed by another
  // reschedule must not let the FIRST (now-stale) call's PATCH land after
  // the second one's, which would leave Google showing the old time. Each
  // locked turn reloads the job and fetches a fresh token AFTER acquiring
  // the lock (never before), so it always acts on the latest booking, not
  // a snapshot taken before it had to wait its turn.
  const googleSyncLocks = new Map()
  function withGoogleLock(key, fn) {
    const prev = googleSyncLocks.get(key) || Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    googleSyncLocks.set(key, next)
    next.finally(() => { if (googleSyncLocks.get(key) === next) googleSyncLocks.delete(key) }).catch(() => {})
    return next
  }

  // The one function that actually talks to Google for a job — used by
  // both the automatic sync-on-booking path (PUT) and the manual retry
  // route (POST .../google) below, so they can never drift into two
  // different ideas of "synced". Never throws: every outcome, including
  // "not configured"/"not connected"/a network failure, is persisted via
  // job_calendar_set_google_status() and returned as a normal result — a
  // failed sync must never fail the booking it's attached to.
  async function syncJobToGoogle(req, jobId) {
    return withGoogleLock(`${req.businessId}:${jobId}`, async () => {
      const job = await unwrap(db.from('jobs').select('*').eq('id', jobId).eq('business_id', req.businessId).maybeSingle())
      if (!job) return { state: 'error', reason: 'not_found', error: 'Job not found', eventId: null, job: null }
      if (job.status === 'cancelled') return { state: 'error', reason: 'cancelled', error: 'This job is lost/cancelled', eventId: null, job }
      if (!job.details?.calendarStartAt || !job.details?.calendarEndAt) {
        return { state: 'error', reason: 'not_booked', error: 'Not booked onto the calendar yet', eventId: null, job }
      }

      const persist = async (patch) => {
        const updated = await unwrap(db.rpc('job_calendar_set_google_status', { p_business_id: req.businessId, p_job_id: jobId, p_patch: patch }))
        return Array.isArray(updated) ? updated[0] : updated
      }

      if (!googleConfigured()) {
        const row = await persist({ calendarGoogleSync: true, calendarGoogleSyncState: 'error', calendarGoogleSyncError: 'Google Calendar is not configured on this server' })
        return { state: 'error', reason: 'not_configured', error: 'Google Calendar is not configured on this server', eventId: job.details.googleEventId || null, job: row }
      }

      const auth = await getGoogleCalendarToken(req.businessId, req.userId)
      if (!auth) {
        const row = await persist({ calendarGoogleSync: true, calendarGoogleSyncState: 'error', calendarGoogleSyncError: 'Google Calendar is not connected' })
        return { state: 'error', reason: 'not_connected', error: 'Connect Google Calendar first', eventId: job.details.googleEventId || null, job: row }
      }

      const customer = job.customer_id
        ? await unwrap(db.from('customers').select('name, address, suburb').eq('id', job.customer_id).eq('business_id', req.businessId).maybeSingle())
        : null
      const eventBody = {
        summary: customer?.name ? `Job — ${customer.name}` : 'TurnKey job',
        description: job.details.calendarNotes || undefined,
        location: customer ? ([customer.address, customer.suburb].filter(Boolean).join(', ') || undefined) : undefined,
        start: { dateTime: job.details.calendarStartAt },
        end: { dateTime: job.details.calendarEndAt }
      }
      const stableId = deterministicGoogleEventId(req.businessId, jobId, req.userId, auth.connection.id)
      const storedId = job.details.googleEventId
      const storedOwner = job.details._googleEventOwnerId
      const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

      async function insertOrPatchStable() {
        const inserted = await googleFetch(base, auth.accessToken, { method: 'POST', body: { id: stableId, ...eventBody } })
        if (inserted.ok) return stableId
        if (inserted.status === 409) {
          const patched = await googleFetch(`${base}/${encodeURIComponent(stableId)}`, auth.accessToken, { method: 'PATCH', body: eventBody })
          if (patched.ok) return stableId
          throw new Error(`Google PATCH (after 409) failed with status ${patched.status}`)
        }
        throw new Error(`Google insert failed with status ${inserted.status}`)
      }

      let finalEventId
      try {
        // Only trust a previously-stored event id for a PATCH if it's known
        // to have been created under this SAME user's own linkage —
        // otherwise go straight to the deterministic-id path rather than
        // risk patching the wrong user's/wrong calendar's event.
        if (storedId && storedOwner === req.userId) {
          const patched = await googleFetch(`${base}/${encodeURIComponent(storedId)}`, auth.accessToken, { method: 'PATCH', body: eventBody })
          if (patched.ok) finalEventId = storedId
          else if (patched.status === 404) finalEventId = await insertOrPatchStable()
          else throw new Error(`Google PATCH failed with status ${patched.status}`)
        } else {
          finalEventId = await insertOrPatchStable()
        }
      } catch (e) {
        // A successful googleEventId from a PRIOR sync is not proof this
        // (possibly rescheduled) appointment is synced now — always clear
        // the state/error to 'error' on a failure, never leave a stale
        // 'synced' claim standing. The old eventId itself is left as-is
        // (not deleted) so a later retry can still try to PATCH it first.
        console.error('[jobCalendar] Google sync failed', { businessId: req.businessId, jobId, message: e.message })
        const row = await persist({ calendarGoogleSync: true, calendarGoogleSyncState: 'error', calendarGoogleSyncError: 'Could not sync to Google Calendar' })
        return { state: 'error', reason: 'network', error: 'Could not sync to Google Calendar', eventId: job.details.googleEventId || null, job: row }
      }

      const row = await persist({
        googleEventId: finalEventId, calendarGoogleSync: true, _googleEventOwnerId: req.userId,
        calendarGoogleSyncState: 'synced', calendarGoogleSyncError: null, calendarGoogleSyncedAt: new Date().toISOString()
      })
      return { state: 'synced', reason: null, error: null, eventId: finalEventId, job: row }
    })
  }

  /* ========================= POST /jobs/:id/google ========================= */
  app.post('/api/job-calendar/jobs/:id/google', requireBusiness, wrap(async (req, res) => {
    const r = await role(req)
    const job = await requireJobInBusiness(req, req.params.id)
    if (!isPrivileged(r) && !isAssignedToStaff(job, req.userId)) throw fail('You can only sync your own bookings', 403)
    if (job.status === 'cancelled') throw fail('This job is lost/cancelled — change its stage before syncing it')
    if (!job.details?.calendarStartAt || !job.details?.calendarEndAt) throw fail('Book this job onto the calendar before syncing it to Google')

    const result = await syncJobToGoogle(req, job.id)
    if (result.state === 'synced') {
      return res.json({ ok: true, googleEventId: result.eventId, job: { ...result.job, details: filterCalendarDetails(result.job.details) } })
    }
    const statusCode = result.reason === 'not_configured' ? 503 : result.reason === 'not_connected' ? 400 : 502
    res.status(statusCode).json({ ok: false, error: result.error })
  }))
}
