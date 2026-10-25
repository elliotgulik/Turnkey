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
      const pageId = value?.page_id ?? entry.id;
      const validId = id => (typeof id === "string" || (typeof id === "number" && Number.isFinite(id))) && String(id).trim() && String(id).length <= 200;
      if (
        !validId(leadgenId) || !validId(pageId) ||
        (entry.id != null && (!validId(entry.id) || String(entry.id).trim() !== String(pageId).trim()))
      ) throw new MetaWebhookError("Invalid Meta lead event", 400);
      events.push({ leadgenId: String(leadgenId).trim(), pageId: String(pageId).trim() });
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
  for (const item of leadData.field_data.slice(0, 100)) {
    if (typeof item?.name !== "string" || !item.name.trim() || item.name.length > 120 || !Array.isArray(item.values)) continue;
    const values = item.values.slice(0, 100)
      .filter(v => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))
      .map(v => String(v).trim()).filter(Boolean);
    if (values.length) fields[item.name.trim().toLowerCase()] = values;
  }
  return fields;
}

export function normalizeMetaLead(leadData, businessId, { historical = false, now = Date.now } = {}) {
  const leadgenId = String(leadData?.id || "");
  if (!leadgenId.trim() || leadgenId.length > 200 || !businessId) throw new MetaWebhookError("Meta returned an invalid lead identity");
  const fields = metaFields(leadData);
  const first = key => fields[key]?.[0] || "";
  const name = first("full_name") || [first("first_name"), first("last_name")].filter(Boolean).join(" ") || "Meta lead";
  const contactFields = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "phone", "street_address", "city"]);
  const serviceFields = new Set(["requestedservices", "requestedservice", "services", "service", "servicesrequired", "servicerequired", "selectservicesrequired", "whatservicesdoyourequire", "whatservicesdoyouneed"]);
  const requestedServices = [];
  let notes = "";
  for (const [key, values] of Object.entries(fields)) {
    if (contactFields.has(key)) continue;
    // Bound both the intermediate answer text and the stored notes, while
    // allowing a long custom answer to use the validator's full notes budget.
    if (notes.length < 4000) {
      const line = `${key}: ${values.map(value => value.slice(0, 4000)).join(", ")}`;
      notes += `${notes ? "\n" : ""}${line}`.slice(0, 4000 - notes.length);
    }
    if (serviceFields.has(key.replace(/[^a-z0-9]/g, "")))
      requestedServices.push(...values.slice(0, 100 - requestedServices.length).map(value => value.slice(0, 500)));
  }
  const payload = {
    business_id: businessId,
    customer: {
      name,
      email: first("email") || undefined,
      phone: first("phone_number") || first("phone") || undefined,
      address: [first("street_address"), first("city")].filter(Boolean).join(", ") || undefined,
      ...(notes ? { notes } : {}),
      source: "Meta",
    },
    source: "meta",
    requestedServices,
    ...(historical ? { historicalImport: true } : {}),
    ...(leadData.form_id ? { form_id: String(leadData.form_id) } : {}),
    ...(leadData.ad_id ? { ad_id: String(leadData.ad_id) } : {}),
    ...(leadData.campaign_id ? { campaign_id: String(leadData.campaign_id) } : {}),
    external_id: leadgenId,
    submittedAt: Number.isFinite(Date.parse(leadData.created_time)) ? Date.parse(leadData.created_time) : now(),
  };
  const validationError = validateLeadPayload(payload);
  if (validationError)
    throw new MetaWebhookError("Meta returned lead fields that failed validation");
  return payload;
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
    const payload = normalizeMetaLead(leadData, source.business_id, { now });
    const saved = await dependencyCall(addLead, payload);
    if (!saved || !saved.id)
      throw new MetaWebhookError("Lead storage did not confirm a saved lead");
    if (saved.deduped) duplicates++;
    else {
      accepted++;
      try {
        Promise.resolve(onNewLead({ businessId: source.business_id, name: payload.customer.name })).catch(() => {});
      } catch {
        // A notification outage must not turn a successfully stored lead into
        // a failed webhook response and needless duplicate delivery.
      }
    }
  }

  return { received: true, accepted, duplicates };
}
