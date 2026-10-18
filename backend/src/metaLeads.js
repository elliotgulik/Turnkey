import crypto from "node:crypto";
import { validateLeadPayload } from "./leadValidation.js";

export class MetaWebhookError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = "MetaWebhookError";
    this.status = status;
  }
}

async function dependencyCall(fn, ...args) {
  try {
    return await fn(...args);
  } catch (error) {
    if (error instanceof MetaWebhookError) throw error;
    throw new MetaWebhookError("Meta lead could not be processed");
  }
}

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || !signature || !appSecret)
    return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const received = Buffer.from(String(signature));
  const expectedBytes = Buffer.from(expected);
  return received.length === expectedBytes.length && crypto.timingSafeEqual(received, expectedBytes);
}

function getMetaEvents(body) {
  if (body?.object !== "page" || !Array.isArray(body.entry))
    throw new MetaWebhookError("Invalid Meta lead webhook payload", 400);
  const events = [];
  for (const entry of body.entry) {
    if (!Array.isArray(entry?.changes))
      throw new MetaWebhookError("Invalid Meta lead webhook payload", 400);
    for (const change of entry.changes) {
      if (change?.field !== "leadgen") continue;
      const value = change.value;
      const leadgenId = value?.leadgen_id;
      const pageId = value?.page_id;
      if (
        (typeof leadgenId !== "string" && typeof leadgenId !== "number") ||
        (typeof pageId !== "string" && typeof pageId !== "number") ||
        !String(leadgenId).trim() || !String(pageId).trim() ||
        String(leadgenId).length > 200 || String(pageId).length > 200
      ) throw new MetaWebhookError("Invalid Meta lead event", 400);
      events.push({ leadgenId: String(leadgenId), pageId: String(pageId) });
    }
  }
  if (events.length > 100)
    throw new MetaWebhookError("Too many Meta lead events in one request", 400);
  return events;
}

function metaFields(leadData) {
  if (!Array.isArray(leadData?.field_data))
    throw new MetaWebhookError("Meta returned an invalid lead record");
  const fields = Object.create(null);
  for (const item of leadData.field_data) {
    if (typeof item?.name !== "string" || !Array.isArray(item.values)) continue;
    const value = item.values.find(v => typeof v === "string" || typeof v === "number");
    if (value !== undefined) fields[item.name.toLowerCase()] = String(value).trim();
  }
  return fields;
}

/**
 * Verify and durably ingest each Meta lead before the HTTP route acknowledges
 * the webhook. If any fetch or insert fails, the caller returns a retryable
 * 5xx; existing (business_id, source, external_id) uniqueness makes replay
 * safe when an earlier event in the same batch was already stored.
 */
export async function ingestMetaWebhook({
  body,
  rawBody,
  signature,
  appSecret,
  lookupPage,
  fetchLead,
  addLead,
  onNewLead = () => {},
  now = Date.now,
}) {
  if (!appSecret) throw new MetaWebhookError("Meta webhook is not configured");
  if (!verifyMetaSignature(rawBody, signature, appSecret))
    throw new MetaWebhookError("Invalid Meta webhook signature", 401);
  const events = getMetaEvents(body);
  let accepted = 0;
  let duplicates = 0;

  for (const { pageId, leadgenId } of events) {
    const source = await dependencyCall(lookupPage, pageId);
    if (!source?.business_id || !source.pageToken)
      throw new MetaWebhookError("Meta Page is not connected to a business");

    const leadData = await dependencyCall(fetchLead, leadgenId, source.pageToken);
    if (!leadData || String(leadData.id) !== leadgenId)
      throw new MetaWebhookError("Meta returned a mismatched lead record");
    const fields = metaFields(leadData);
    const name = fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(" ") || "Meta lead";
    const payload = {
      business_id: source.business_id,
      customer: {
        name,
        email: fields.email || undefined,
        phone: fields.phone_number || fields.phone || undefined,
        address: [fields.street_address, fields.city].filter(Boolean).join(", ") || undefined,
        source: "Meta",
      },
      source: "meta",
      external_id: leadgenId,
      submittedAt: now(),
    };
    const validationError = validateLeadPayload(payload);
    if (validationError)
      throw new MetaWebhookError("Meta returned lead fields that failed validation");
    const saved = await dependencyCall(addLead, payload);
    if (!saved || !saved.id)
      throw new MetaWebhookError("Lead storage did not confirm a saved lead");
    if (saved.deduped) duplicates++;
    else {
      accepted++;
      try {
        Promise.resolve(onNewLead({ businessId: source.business_id, name })).catch(() => {});
      } catch {
        // A notification outage must not turn a successfully stored lead into
        // a failed webhook response and needless duplicate delivery.
      }
    }
  }

  return { received: true, accepted, duplicates };
}
