// Inbound ServiceM8 -> TurnKey webhook handling: pure, dependency-injected
// logic, same shape as wixLeads.js's handleWixLead — testable without a
// real Express server or database.
//
// Two distinct request shapes hit the same callback URL (per
// developer.servicem8.com/docs/webhooks-overview):
//   - Verification: form-encoded { mode:'subscribe', challenge }, sent once
//     when a subscription is added/modified. Must respond with ONLY the
//     challenge value, nothing else.
//   - Event: JSON { object, entry:[{uuid,changed_fields,time}], resource_url }.
//     Carries only the changed object's uuid and which fields changed —
//     never the new values — so there is nothing to validate/trust in the
//     body itself; every event means "go re-fetch resource_url".
//
// No signature header is documented for event deliveries (unlike Meta's
// X-Hub-Signature-256 or Stripe's Stripe-Signature) — flagged as genuinely
// unverified, not assumed absent. The mitigation here is architectural
// rather than cryptographic: a forged POST can only ever trigger a re-fetch
// of whatever object_uuid it names, authenticated with OUR OWN stored
// credential, scoped to OUR OWN connected ServiceM8 account — it can never
// inject data directly, since the body's claims are never trusted, only
// used to decide what to re-fetch. Revisit if ServiceM8's docs turn out to
// describe a signature scheme this pass didn't surface.

export function parseWebhookRequest(body) {
  if (body && body.mode === 'subscribe' && body.challenge) {
    return { kind: 'verification', challenge: String(body.challenge) }
  }
  if (body && typeof body.object === 'string' && Array.isArray(body.entry)) {
    return { kind: 'event', object: body.object, entries: body.entry, resourceUrl: body.resource_url || null }
  }
  return { kind: 'unknown' }
}

// Processes one already-parsed event payload: records it for durability,
// resolves which business it belongs to (via the connection that owns this
// account — see resolveBusinessId), re-fetches the current object state,
// and hands it to onObjectChanged for the actual (job/company/payment-
// specific) side effect. Idempotent by construction: re-processing the
// same uuid just re-fetches and re-applies the same current state, never
// increments a counter or appends to a list.
export async function processServiceM8Event({
  businessIdHint,   // optional — null unless the caller already knows which connection this came in on
  object,
  entry,
  resourceUrl,
  rawPayload,
  deps
}) {
  const {
    recordEvent,        // async (row) -> { id }  — insert into servicem8_webhook_events, status 'pending'
    resolveBusinessId,  // async (hint) -> businessId | null
    fetchObject,        // async (businessId, object, uuid) -> record | null
    onObjectChanged,     // async (businessId, object, record, changedFields) -> void
    markEventStatus      // async (eventId, status, errorMessage) -> void
  } = deps

  const eventRow = await recordEvent({
    business_id: businessIdHint || null,
    object_type: object,
    object_uuid: entry.uuid,
    changed_fields: entry.changed_fields || null,
    event_time: entry.time || null,
    raw_payload: rawPayload
  })

  try {
    const businessId = await resolveBusinessId(businessIdHint)
    if (!businessId) {
      await markEventStatus(eventRow.id, 'ignored', 'No connected business found for this event')
      return { status: 'ignored' }
    }
    const record = await fetchObject(businessId, object, entry.uuid)
    if (!record) {
      await markEventStatus(eventRow.id, 'ignored', 'Object not found on re-fetch (deleted or inaccessible)')
      return { status: 'ignored' }
    }
    await onObjectChanged(businessId, object, record, entry.changed_fields || [])
    await markEventStatus(eventRow.id, 'processed', null)
    return { status: 'processed', businessId }
  } catch (err) {
    await markEventStatus(eventRow.id, 'failed', err.message)
    return { status: 'failed', error: err.message }
  }
}
