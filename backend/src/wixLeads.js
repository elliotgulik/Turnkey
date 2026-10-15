// Wix Automations webhook lead intake — kept separate from backend/src/index.js
// so the actual decision logic (token hashing, field mapping, validation,
// business lookup, dedupe) is a plain, dependency-injected function with no
// Express/Supabase coupling, and can be unit-tested directly (see
// wixLeads.test.js) without a running server or a real database.
import crypto from 'node:crypto'
import { validateLeadPayload } from './leadValidation.js'

// No OAuth for Wix — a per-business random token is generated in
// Connections and pasted into a Wix Automation. Only the SHA-256 hash is
// ever stored (lead_sources.external_id for provider='wix'); the raw token
// is shown once, at generation time, and is never persisted in reversible
// form — the same way most API-key UIs work, and it means there is nothing
// to decrypt or leak later even if the database is compromised.
export function generateWixToken() {
  return crypto.randomBytes(24).toString('base64url')
}

export function hashWixToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

// Wix Automations' "Send a webhook" action lets the business pick which
// fields to send — there is no single fixed schema across every form type,
// so this stays defensive: try the field names Wix's default trigger data
// commonly uses, fall back to anything with an obvious name, and never
// reject a submission just because it doesn't match one of these shapes —
// an unrecognised payload still becomes a lead (with whatever we could
// find); validateCustomerFromWixPayload below is what actually rejects a
// submission, and only for concrete reasons (no name, malformed email, …).
export function mapWixPayload(body) {
  const b = body || {}
  const data = (b.data && typeof b.data === 'object') ? b.data
    : (b.contact && typeof b.contact === 'object') ? b.contact
    : b
  const field = (...names) => {
    for (const n of names) {
      if (data[n] != null && data[n] !== '') return String(data[n])
      if (b[n] != null && b[n] !== '') return String(b[n])
    }
    return ''
  }
  const name = field('name', 'fullName', 'full_name', 'contactName') ||
    [field('firstName', 'first_name'), field('lastName', 'last_name')].filter(Boolean).join(' ')
  return {
    name: name || 'Wix lead',
    email: field('email', 'emailAddress', 'email_address') || undefined,
    phone: field('phone', 'phoneNumber', 'phone_number') || undefined,
    address: field('address', 'streetAddress', 'street_address') || undefined,
    notes: field('message', 'notes', 'comment', 'comments') || undefined,
    source: 'Wix'
  }
}

// A Wix submission's own id, if present, used as the idempotency key so a
// redelivered webhook event (Wix Automations retries on failure, same as
// most webhook senders) doesn't create a second, duplicate lead. Without
// one, there's nothing safe to dedupe on, so the lead is still accepted —
// just without redelivery protection for that one submission.
function extractExternalId(body) {
  const id = body?.submissionId ?? body?.id ?? body?._id
  return id != null ? String(id).slice(0, 200) : null
}

// The actual decision logic, as a plain async function: given the raw
// request (token + body) and two injected dependencies —
//   lookupSource(hash) -> { business_id } | null   (throws on DB failure)
//   addLead(payload)   -> { id, deduped? }          (throws on DB failure)
// — it returns a plain { status, body, ...meta } result the Express route
// turns into an HTTP response. No req/res, no Express, no real Supabase
// client — every branch is reachable with hand-written fakes, which is what
// wixLeads.test.js exercises.
//
// Security property that's worth calling out explicitly (and is covered by
// a test): the resulting payload's business_id ALWAYS comes from whatever
// lookupSource(hash) returns for the hashed token, never from anything in
// the request body — unlike the public POST /api/leads route (which trusts
// a client-supplied business_id, acceptable there because booking.html
// controls that value), a webhook token's hash is the only thing that may
// ever determine which business a Wix lead lands in.
export async function handleWixLead({ token, body, lookupSource, addLead }) {
  if (!token || typeof token !== 'string') {
    return { status: 400, body: { error: 'Missing token' } }
  }

  const hash = hashWixToken(token)
  let source
  try {
    source = await lookupSource(hash)
  } catch (err) {
    return { status: 500, body: { error: 'Failed to save lead' }, cause: err }
  }
  if (!source || !source.business_id) {
    return { status: 404, body: { error: 'Unknown or revoked webhook URL' } }
  }

  const customer = mapWixPayload(body)
  const payload = {
    business_id: source.business_id,
    customer,
    source: 'wix',
    external_id: extractExternalId(body),
    submittedAt: Date.now()
  }

  const validationError = validateLeadPayload(payload)
  if (validationError) {
    return { status: 400, body: { error: validationError } }
  }

  let lead
  try {
    lead = await addLead(payload)
  } catch (err) {
    return { status: 500, body: { error: 'Failed to save lead' }, cause: err }
  }

  return {
    status: 201,
    body: { ok: true, id: lead.id },
    businessId: source.business_id,
    customerName: customer.name,
    deduped: !!lead.deduped
  }
}
