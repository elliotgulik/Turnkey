// ServiceM8 integration. Facts below are sourced from developer.servicem8.com
// (fetched directly) unless marked UNVERIFIED — per this project's own rule
// ("do not invent support for undocumented ServiceM8 features"), anything
// not confirmed against the official docs or a live call stays flagged
// rather than silently assumed.
//
// Two auth paths (docs/authentication):
//   - Private API Key: a single ServiceM8 account's own key, sent as
//     X-API-Key on every request. No Development Partner registration
//     needed — good for single-company testing/use, not for a multi-tenant
//     SaaS connection.
//   - Public OAuth 2.0: requires registering as a Development Partner and
//     creating an add-on (issues an App ID + App Secret). Required for
//     connecting separate customer accounts and for webhooks.
// Only the OAuth half follows the isConfigured()/getAuthUrl()/
// exchangeCode()/refreshAccessToken() contract already used by
// providers/gmail.js and providers/googleCalendar.js. ServiceM8's API-key
// path has no handshake to speak of — see the plain functions below instead.

const AUTHORIZE_URL = 'https://go.servicem8.com/oauth/authorize'
const TOKEN_URL = 'https://go.servicem8.com/oauth/access_token'
// Webhook subscriptions are NOT under /api_1.0 — confirmed from the
// official webhooks overview page, which gives this as a bare path off the
// api host, distinct from every REST resource below.
const WEBHOOK_SUBSCRIPTIONS_URL = 'https://api.servicem8.com/webhook_subscriptions'
const API_BASE = 'https://api.servicem8.com/api_1.0'

const CLIENT_ID = process.env.SERVICEM8_CLIENT_ID || ''
const CLIENT_SECRET = process.env.SERVICEM8_CLIENT_SECRET || ''

export function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET)
}

// Minimum scopes for the handoff workflow this integration implements
// (create/read companies and jobs, their line items, attach a quote PDF,
// and read job payments for financial reporting). ServiceM8's own guidance
// is to request only what's needed ("unlocks a higher rate limit") and
// that scopes can be requested incrementally later — this list is a
// deliberate starting point, not exhaustive.
export const DEFAULT_SCOPES = [
  'read_customers', 'manage_customers',
  'read_jobs', 'manage_jobs', 'create_jobs',
  'read_job_materials', 'manage_job_materials',
  'read_job_attachments', 'manage_job_attachments',
  'read_job_payments', 'read_schedule'
]

export function getAuthUrl(redirectUri, state, scopes = DEFAULT_SCOPES) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: scopes.join(' '),
    redirect_uri: redirectUri,
    state
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error('ServiceM8 token request failed: ' + text)
    if (res.status === 401 || res.status === 400) err.code = 'AUTH_EXPIRED'
    throw err
  }
  return res.json()
}

export async function exchangeCode(code, redirectUri) {
  // { access_token, refresh_token, expires_in, token_type, scope } per docs/authentication
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: redirectUri
  })
}

// ServiceM8 rotates the refresh token on EVERY refresh (explicit in the
// official docs: "store the latest refresh token each time") — unlike
// Google, which often omits a new one on repeat grants. Callers must
// persist both tokens from this response, every time, or the next refresh
// will fail with a stale/already-used refresh token.
export async function refreshAccessToken(refreshToken) {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken
  })
}

// credential is either { mode:'api_key', apiKey } or { mode:'oauth', accessToken }
function authHeaders(credential, extra = {}) {
  const base = credential.mode === 'api_key'
    ? { 'X-API-Key': credential.apiKey }
    : { Authorization: 'Bearer ' + credential.accessToken }
  return { ...base, Accept: 'application/json', ...extra }
}

// Exposes status/headers/recordUuid — ServiceM8 returns a newly created
// record's UUID in the x-record-uuid response header (confirmed: both the
// official attaching-files guide and multiple developer-forum reports
// agree on this), not reliably in the JSON body.
async function sm8Request(credential, path, { method = 'GET', json, formData, base = API_BASE } = {}) {
  const headers = authHeaders(credential, json ? { 'Content-Type': 'application/json' } : {})
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : formData
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`ServiceM8 API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`)
    err.status = res.status
    if (res.status === 401) err.code = 'AUTH_EXPIRED'
    throw err
  }
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON success body, e.g. plain 200 OK */ }
  return { status: res.status, recordUuid: res.headers.get('x-record-uuid') || data?.uuid || null, data }
}

export async function getVendor(credential) {
  return (await sm8Request(credential, '/vendor.json')).data
}

export async function getObject(credential, objectType, uuid) {
  return (await sm8Request(credential, `/${objectType}/${uuid}.json`)).data
}

// Company = ServiceM8's name for a Client/Customer (docs/rest-overview).
// No search/dedupe-by-email here deliberately — a $filter-based lookup
// wasn't verified against the live API in this pass, so rather than invent
// query syntax, v1 always creates a fresh Company on first handoff and
// relies on servicem8_object_map for idempotency on every handoff after
// that. Known limitation: if the business already had this customer in
// ServiceM8 before connecting TurnKey, the first handoff will create a
// second Company rather than finding the existing one — worth fixing once
// the filter syntax is confirmed, not before.
export async function createCompany(credential, { name, email, phone, address }) {
  return sm8Request(credential, '/company.json', {
    method: 'POST',
    json: { name, email, mobile: phone, billing_address: address, active: 1 }
  })
}

export async function createJob(credential, { companyUuid, jobAddress, description, status = 'Quote' }) {
  return sm8Request(credential, '/job.json', {
    method: 'POST',
    json: { company_uuid: companyUuid, job_address: jobAddress, job_description: description, status, active: 1 }
  })
}

export async function createJobMaterial(credential, { jobUuid, name, cost, price, quantity = 1 }) {
  return sm8Request(credential, '/jobmaterial.json', {
    method: 'POST',
    json: { job_uuid: jobUuid, name, cost, price, qty: quantity }
  })
}

// Modern single-request upload, per the official "Attaching files to a Job
// Diary" guide: multipart/form-data POST to /attachment.json, Content-Type
// left for fetch/FormData to set (with its boundary) rather than specified
// manually, binary content as a part named "file", NOT base64-encoded.
// (An older two-step JSON-then-.file flow is also documented as "still
// supported, not recommended for new uploads" — deliberately not used here.)
export async function attachFile(credential, { jobUuid, filename, fileBytes, mimeType }) {
  const form = new FormData()
  form.set('related_object', 'job')
  form.set('related_object_uuid', jobUuid)
  form.set('attachment_name', filename)
  form.set('file', new Blob([fileBytes], { type: mimeType || 'application/octet-stream' }), filename)
  return sm8Request(credential, '/attachment.json', { method: 'POST', formData: form })
}

// NOT independently verified in this pass (developer-forum reports
// disagree on whether PATCH works at all — one report got an HTML body
// back from PATCH, PUT worked for a full-record replace). Exported but
// deliberately unused by the default handoff flow (servicem8Sync.js),
// which only ever creates — never updates — a ServiceM8 record. Confirm
// against a live sandbox call before wiring this into anything.
export async function updateObjectUnverified(credential, objectType, uuid, fields) {
  return sm8Request(credential, `/${objectType}/${uuid}.json`, { method: 'PUT', json: fields })
}

// Webhook subscriptions (docs/webhooks-overview) — note the different base
// URL (no /api_1.0). ServiceM8 sends a one-time { mode:'subscribe',
// challenge } verification POST when a subscription is added/modified;
// respond with the bare challenge value (handled in servicem8Webhooks.js,
// not here — this module only talks outbound to ServiceM8's API).
export async function registerWebhookSubscription(credential, { object, fields, callbackUrl }) {
  return sm8Request(credential, '', { method: 'POST', json: { object, fields, url: callbackUrl }, base: WEBHOOK_SUBSCRIPTIONS_URL })
}

export async function listWebhookSubscriptions(credential, status = 'active') {
  return (await sm8Request(credential, `?status=${encodeURIComponent(status)}`, { base: WEBHOOK_SUBSCRIPTIONS_URL })).data
}
