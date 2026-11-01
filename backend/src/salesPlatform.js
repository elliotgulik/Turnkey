import crypto from "node:crypto";
import { createRequire } from "node:module";
import { encryptToken, decryptToken } from "./crypto.js";
import * as SM from "./salesTransfer.js";
import * as serviceM8Provider from "./providers/servicem8.js";
import { performServiceM8Handoff } from "./servicem8Sync.js";
const require = createRequire(import.meta.url),
  METRICS = require("../../sales-metrics.js");
const unwrap = async (q) => {
  const { data, error } = await q;
  if (error) throw error;
  return data;
};
const safeError = (e) =>
  e instanceof SM.ServiceM8Error
    ? e.message
    : e.code === "AUTH_EXPIRED"
      ? "ServiceM8 access expired. Reconnect the account."
      : e.publicMessage ||
      "The sales database or integration request failed. Check that the sales migration is applied, then retry.";
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { publicMessage: message, status });
// Canonical hashing survives JSONB key ordering. Approval metadata is not quote content.
const canonical = (v) => JSON.stringify(v, (_, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
const quoteDetails = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { serviceM8Pricing, ...details } = value;
  return details;
};
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
const zoneParts = (date, timeZone) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
function serviceM8WallClock(value, timeZone) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(normalized)) {
    const date = new Date(normalized);
    return Number.isFinite(+date) ? date : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!m) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const calendar = new Date(target);
  if (+m[1] < 1000 || calendar.getUTCFullYear() !== +m[1] || calendar.getUTCMonth() + 1 !== +m[2] ||
      calendar.getUTCDate() !== +m[3] || +m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) return null;
  let guess = target;
  try {
    for (let i = 0; i < 3; i++) {
      const p = zoneParts(new Date(guess), timeZone || "UTC");
      const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      const adjustment = target - shown;
      guess += adjustment;
      if (!adjustment) break;
    }
  } catch { return null; }
  const date = new Date(guess);
  return Number.isFinite(+date) ? date : null;
}
const serviceM8Record = (data) => Array.isArray(data) ? data[0] || null : data || null;
async function serviceM8OptionalRecord(call, businessId, resource, uuid, generation) {
  if (!SM.uuid(uuid)) return null;
  try {
    return serviceM8Record((await call(businessId, `/${resource}/${uuid}.json`, { generation })).data);
  } catch (error) {
    if ([403, 404].includes(error.status)) return null;
    throw error;
  }
}
async function serviceM8OptionalList(listRemote, businessId, resource, filter, generation) {
  try {
    return await listRemote(businessId, `/${resource}.json${filter ? "?$filter=" + encodeURIComponent(filter) : ""}`, generation);
  } catch (error) {
    if ([403, 404].includes(error.status)) return [];
    throw error;
  }
}
// JobMaterial.price is the documented ex-tax SELLING unit price. Neither
// cost/displayed_cost nor a guessed GST rate may enter this display snapshot.
const serviceM8Number = value => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e12 ? number : null;
};
export function serviceM8PricingSnapshot(job, materials, { currency, updatedAt = new Date().toISOString() } = {}) {
  const items = (Array.isArray(materials) ? materials : []).filter(item => item &&
    (item.active == null || [1, "1", true].includes(item.active))).sort((a, b) =>
      (serviceM8Number(a.sort_order) ?? 0) - (serviceM8Number(b.sort_order) ?? 0)).map(item => {
    const quantity = serviceM8Number(item.quantity);
    const price = serviceM8Number(item.price);
    // A displayed amount can substitute only when explicitly ex-tax. Mixed
    // inclusive/exclusive line amounts would make a single tax label misleading.
    const exclusive = [false, 0, "0", "false"].includes(item.displayed_amount_is_tax_inclusive);
    const unitPrice = price ?? (exclusive ? serviceM8Number(item.displayed_amount) : null);
    const product = quantity !== null && unitPrice !== null ? quantity * unitPrice : null;
    return { name: String(item.name || "").trim().slice(0, 200), quantity, unitPrice,
      lineTotal: product !== null && Number.isFinite(product) ? Number(product.toPrecision(15)) : null };
  }).filter(item => item.name);
  return { items, total: serviceM8Number(job.total_invoice_amount),
    currency: typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : null,
    lineTaxLabel: "Line prices exclude tax", taxLabel: "Tax basis not specified", updatedAt, jobUuid: SM.uuid(job.uuid) ? job.uuid : null };
}
async function serviceM8DispatchDetails({ call, listRemote, businessId, job, activity, generation, cache, vendor }) {
  const staffIds = [...new Set([activity.staff_uuid, job.staff_uuid, job.assigned_staff_uuid].filter(SM.uuid))];
  const [company, contacts, materials, assignedStaff] = await Promise.all([
    cache ? cache.company.get(job.company_uuid) : serviceM8OptionalRecord(call, businessId, "company", job.company_uuid, generation),
    cache ? cache.contacts.get(job.company_uuid) || [] : SM.uuid(job.company_uuid)
      ? serviceM8OptionalList(listRemote, businessId, "companycontact", `company_uuid eq '${job.company_uuid}' and active eq 1`, generation)
      : [],
    cache ? cache.materials.get(job.uuid) || [] : SM.uuid(job.uuid)
      ? serviceM8OptionalList(listRemote, businessId, "jobmaterial", `job_uuid eq '${job.uuid}' and active eq 1`, generation)
      : [],
    cache ? staffIds.map(id => cache.staff.get(id)) : Promise.all(staffIds.map(id => serviceM8OptionalRecord(call, businessId, "staff", id, generation))),
  ]);
  const activeContacts = contacts.filter(contact => contact.active == null || ["1", 1, true].includes(contact.active));
  const contact = activeContacts.find(item => ["1", 1, true].includes(item.is_primary_contact)) || activeContacts[0] || null;
  const personName = [contact?.first, contact?.last].filter(Boolean).join(" ").trim() ||
    company?.name || job.company_name || job.client_name || "ServiceM8 booking";
  const serviceNames = materials.map(item => ({
    name: String(item.name || "").trim(),
    quantity: String(item.quantity || "").trim(),
  })).filter(item => item.name).slice(0, 40);
  const staffNames = assignedStaff.map(staff => [staff?.first, staff?.last].filter(Boolean).join(" ").trim()).filter(Boolean);
  const services = serviceNames.length ? serviceNames.map(item => item.name) :
    String(job.job_description || job.job_name || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 20);
  const pricing = serviceM8PricingSnapshot(job, materials, { currency: (cache?.vendor || vendor)?.currency });
  return {
    personName: personName.slice(0, 160),
    jobUuid: String(job.uuid || activity.job_uuid || "").slice(0, 80),
    companyName: String(company?.name || job.company_name || "").slice(0, 160),
    email: String(contact?.email || company?.email || "").slice(0, 254),
    phone: String(contact?.mobile || contact?.phone || company?.phone || "").slice(0, 80),
    address: [job.job_address, job.job_suburb, job.job_postcode].filter(Boolean).join(", ").slice(0, 500),
    services,
    lineItems: serviceNames,
    serviceM8LineItems: pricing.items,
    pricing,
    assignedStaffIds: staffIds.map(id => "servicem8:" + id),
    assignedStaff: [...new Set(staffNames)].map(name => name.slice(0, 120)),
    staffAssigned: staffIds.length > 0,
    status: String(job.status || "").slice(0, 80),
  };
}
// The reservation compares delivered/public content, not the entire CRM record.
// Full canonical version/payload validation below remains deliberately separate.
const contentFingerprint = (s) => {
  const d = s.details || {};
  return SM.hash(canonical({
    amount: s.amount,
    details: {
      ...pick(d, ["gstRegistered", "publicTerms", "jobNotes", "salesNotes"]),
      services: (d.services || []).map(line => pick(line, ["svc", "label", "qty", "priceSnapshot",
        "roofType", "storeys", "sides", "customRate", "fixedPrice"])),
      areaPolys: (d.areaPolys || []).map(area => ({
        ...pick(area, ["service", "svc"]),
        geoPts: area?.geoPts?.map(point => pick(point, ["lat", "lng"])),
        points: area?.points?.map(point => pick(point, ["x", "y"])),
      })),
    },
    customer: pick(s.customer, ["id", "business_id", "name", "email", "phone", "address"]),
    business: pick(s.business, ["id", "name", "phone", "email", "logo_url", "accent_color",
      "primary_color", "font_style", "header_style", "gst_number", "tax_number", "nzbn"]),
  }));
};
const publicVersion = (v) => {
  const s = v.snapshot || {}, d = s.details || {};
  return { id: v.id, fingerprint: v.fingerprint, createdAt: v.created_at,
    snapshot: { accepted: s.accepted === true, approvedAt: s.approvedAt || null, amount: s.amount,
      customer: { name: s.customer?.name, address: s.customer?.address },
      business: { name: s.business?.name },
      details: { gstRegistered: d.gstRegistered, publicTerms: d.publicTerms, jobNotes: d.jobNotes,
        services: (Array.isArray(d.services) ? d.services : []).map(l => ({ svc: l.svc, label: l.label,
          qty: l.qty, priceSnapshot: l.priceSnapshot })) } } };
};
export async function allRows(db, table, businessId, columns = "*", orderBy = "id") {
  let rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await unwrap(
      db
        .from(table)
        .select(columns)
        .eq("business_id", businessId)
        .order(orderBy)
        .range(offset, offset + 999),
    );
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
export function installSalesPlatform(
  app,
  {
    db,
    requireBusiness,
    sendNotification,
    env = process.env,
    fetchImpl = fetch,
    oauthProvider = serviceM8Provider,
  },
) {
  const backend = (env.PUBLIC_BACKEND_URL || "").replace(/\/$/, ""),
    frontend = (env.FRONTEND_URL || "https://turnkeycrm.net").replace(
      /\/$/,
      "",
    );
  const encryptionReady = (() => {
    if (!env.EMAIL_TOKEN_KEY) return false;
    try { encryptToken("servicem8-configuration-check"); return true; }
    catch { return false; }
  })();
  const oauthClientReady = !!(env.SERVICEM8_CLIENT_ID && env.SERVICEM8_CLIENT_SECRET) &&
    (typeof oauthProvider.isConfigured !== "function" || oauthProvider.isConfigured());
  const privateReady = encryptionReady && env.ENABLE_SERVICEM8_PRIVATE !== "false";
  const integrationKinds = ["handoff", "webhook", "refresh_job", "dispatch_seed"];
  const oauthReady = !!(
    oauthClientReady &&
    encryptionReady &&
    backend.startsWith("https://")
  );
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error("[Sales platform]", e.code || e.status || e.name);
      res.status(e.status || 503).json({ error: safeError(e),
        ...(e.publicCode === "LEGACY_REVIEW_REQUIRED" ? { code: e.publicCode,
          ...(e.missingFields ? { missingFields: e.missingFields } : {}) } : {}),
        ...(e instanceof SM.ServiceM8Error ? { code: e.code, providerStatus: e.status,
          ...(e.stage ? { stage: e.stage } : {}) } : {}) });
    }
  };
  const admin = async (req, res, next) => {
    try {
      const user = await unwrap(
        db
          .from("users")
          .select("role")
          .eq("id", req.userId)
          .eq("business_id", req.businessId)
          .maybeSingle(),
      );
      if (!user || !["owner", "manager"].includes(user.role))
        return res
          .status(403)
          .json({ error: "Only an owner or manager can change integrations." });
      next();
    } catch {
      res.status(503).json({ error: "Could not verify account permissions." });
    }
  };
  const conn = (businessId) =>
    unwrap(
      db
        .from("servicem8_connections")
        .select("*")
        .eq("business_id", businessId)
        .maybeSingle(),
    );
  function connectionHealth(c) {
    const configurationMissing = [
      !encryptionReady && "EMAIL_TOKEN_KEY",
      c?.auth_mode === "oauth" && (!env.SERVICEM8_CLIENT_ID || !oauthClientReady) && "SERVICEM8_CLIENT_ID",
      c?.auth_mode === "oauth" && (!env.SERVICEM8_CLIENT_SECRET || !oauthClientReady) && "SERVICEM8_CLIENT_SECRET",
    ].filter(Boolean);
    let credentialsReady = !!c && encryptionReady;
    if (credentialsReady) {
      try {
        credentialsReady = c.auth_mode === "api_key" ? !!decryptToken(c.api_key_enc)
          : c.auth_mode === "oauth" && !!decryptToken(c.access_token_enc) && !!decryptToken(c.refresh_token_enc);
      } catch { credentialsReady = false; }
    }
    const reconnectRequired = !!c && (!credentialsReady ||
      /ServiceM8 access expired|ServiceM8 rejected this API key|permissions are insufficient|credentials cannot be read|incomplete credentials|before refreshed credentials could be saved/i.test(c.last_error || ""));
    return { encryptionConfigured: encryptionReady, serverConfigured: !configurationMissing.length,
      configurationMissing, credentialsReady, reconnectRequired };
  }
  async function credentials(businessId) {
    let c = await conn(businessId);
    if (!c)
      throw fail("ServiceM8 is disconnected. Connect it in Connections.", 409);
    const readCredentials = (row) => {
      try {
        const creds = row.auth_mode === "api_key"
          ? { apiKey: decryptToken(row.api_key_enc) }
          : { access_token: decryptToken(row.access_token_enc), refresh_token: decryptToken(row.refresh_token_enc) };
        if (row.auth_mode === "api_key" ? !creds.apiKey : !creds.access_token || !creds.refresh_token)
          throw Error("Empty credentials");
        return creds;
      } catch {
        throw fail("ServiceM8 credentials cannot be read. Check EMAIL_TOKEN_KEY and reconnect the account.", 409);
      }
    };
    let creds = readCredentials(c);
    if (
      c.auth_mode === "api_key" ||
      Date.parse(c.token_expiry) > Date.now() + 60000
    )
      return { c, creds };
    const generation = c.generation;
    const lease = new Date(Date.now() + 60000).toISOString();
    const claimed = await unwrap(
      db
        .from("servicem8_connections")
        .update({ lease_until: lease })
        .eq("business_id", businessId)
        .eq("generation", c.generation)
        .or("lease_until.is.null,lease_until.lt." + new Date().toISOString())
        .select("business_id"),
    );
    if (!claimed.length)
      throw fail("ServiceM8 credentials are refreshing. Retry shortly.", 409);
    try {
      c = await conn(businessId);
      if (!c || c.generation !== generation || Date.parse(c.lease_until) !== Date.parse(lease))
        throw fail("ServiceM8 connection changed during credential refresh. Retry from Connections.", 409);
      creds = readCredentials(c);
      if (!(Date.parse(c.token_expiry) > Date.now() + 60000)) {
        creds = await oauthProvider.refreshAccessToken(creds.refresh_token);
        if (!creds?.access_token || !creds?.refresh_token ||
            !Number.isFinite(Number(creds.expires_in || 3600)) || Number(creds.expires_in || 3600) <= 0)
          throw fail("ServiceM8 returned incomplete credentials. Reconnect the account.", 409);
        const saved = await unwrap(
          db
            .from("servicem8_connections")
            .update({
              access_token_enc: encryptToken(creds.access_token),
              refresh_token_enc: encryptToken(creds.refresh_token),
              token_expiry: new Date(
                Date.now() + Number(creds.expires_in || 3600) * 1000,
              ).toISOString(),
            })
            .eq("business_id", businessId)
            .eq("generation", generation)
            .eq("lease_until", lease)
            .select("business_id"),
        );
        if (!saved.length)
          throw fail("ServiceM8 connection changed before refreshed credentials could be saved. Reconnect the account.", 409);
      }
      return { c, creds };
    } finally {
      await unwrap(
        db
          .from("servicem8_connections")
          .update({ lease_until: null })
          .eq("business_id", businessId)
          .eq("generation", generation)
          .eq("lease_until", lease),
      );
    }
  }
  const call = async (businessId, path, opts = {}) => {
    const { creds, c } = await credentials(businessId);
    if (opts.generation && opts.generation !== c.generation)
      throw fail(
        "ServiceM8 account changed during transfer. Review the connection before retrying.",
      );
    return SM.request(path, { credentials: creds, fetchImpl, ...opts });
  };
  async function account(creds) {
    let data;
    try {
      ({ data } = await SM.request("/vendor.json", { credentials: creds, fetchImpl }));
    } catch (e) {
      if (e instanceof SM.ServiceM8Error) e.stage = "account_verification";
      throw e;
    }
    const vendor = Array.isArray(data) ? data[0] : data;
    if (!vendor?.uuid)
      throw fail("ServiceM8 account identity could not be verified.");
    return vendor;
  }
  async function saveConnection(businessId, mode, creds) {
    const vendor = await account(creds),
      prior = await conn(businessId),
      token = crypto.randomBytes(32).toString("hex");
    if (prior && prior.account_uuid !== vendor.uuid)
      throw fail(
        "Disconnect the current ServiceM8 account before connecting a different company.",
        409,
      );
    const generation =
      prior?.generation ||
      SM.stableUuid("servicem8-account", businessId, vendor.uuid);
    const history = await unwrap(
      db
        .from("external_object_mappings")
        .select("connection_generation")
        .eq("business_id", businessId)
        .neq("connection_generation", generation)
        .limit(1),
    );
    if (history.length)
      throw fail(
        "This business has transfers linked to a different ServiceM8 connection. Reconnect the original account or arrange an account migration.",
        409,
      );
    await unwrap(
      db
        .from("servicem8_connections")
        .upsert(
          {
            business_id: businessId,
            auth_mode: mode === "private" ? "api_key" : "oauth",
            account_uuid: vendor.uuid,
            account_name:
              vendor.name || vendor.company_name || "ServiceM8 account",
            api_key_enc: mode === "private" ? encryptToken(creds.apiKey) : null,
            access_token_enc:
              mode === "oauth" ? encryptToken(creds.access_token) : null,
            refresh_token_enc:
              mode === "oauth" ? encryptToken(creds.refresh_token) : null,
            token_expiry:
              mode === "oauth"
                ? new Date(
                    Date.now() + Number(creds.expires_in || 3600) * 1000,
                  ).toISOString()
                : null,
            scope: mode === "oauth" ? (creds.scope || null) : null,
            webhook_token_hash: SM.hash(token),
            webhook_enc: encryptToken(token),
            generation,
            last_error: null,
            webhook_subscribed_at: null,
            auto_handoff: prior?.auto_handoff || false,
          },
          { onConflict: "business_id" },
        ),
    );
    return generation;
  }
  async function subscribe(businessId, objects = ["job", "jobpayment", "jobactivity"]) {
    const c = await conn(businessId);
    if (!c) throw fail("Connect ServiceM8 before connecting status updates.", 409);
    if (!c.webhook_enc) throw fail("The stored ServiceM8 webhook callback is missing. Reconnect the account.", 409);
    const generation = c.generation, tokenHash = c.webhook_token_hash;
    if (!backend.startsWith("https://"))
      throw fail("PUBLIC_BACKEND_URL must be the backend HTTPS origin.");
    const token = decryptToken(c.webhook_enc),
      callback = backend + "/api/servicem8/webhook/" + token;
    for (const object of objects) {
      await call(businessId, "/webhook_subscriptions/object", {
        base: "https://api.servicem8.com",
        generation,
        method: "POST",
        body: new URLSearchParams({
          object,
          fields: object === "job" ? "status,total_invoice_amount,invoice_sent,payment_received"
            : object === "jobpayment" ? "amount,active" : "job_uuid,staff_uuid,start_date,end_date,activity_was_scheduled,active",
          callback_url: callback,
          unique_id: "turnkey-" + c.generation + "-" + object,
        }),
      });
    }
    const saved = await unwrap(db.from("servicem8_connections")
      .update({ webhook_subscribed_at: new Date().toISOString() })
      .eq("business_id", businessId).eq("generation", generation)
      .eq("webhook_token_hash", tokenHash).select("business_id"));
    if (!saved.length) throw fail("ServiceM8 connection changed during webhook registration. Try again.", 409);
  }
  async function inspectWebhooks(businessId, c, previousFailures) {
    const result = await call(businessId, "/webhook_subscriptions?status=all", { generation: c.generation, base: "https://api.servicem8.com" });
    if (!Array.isArray(result.data)) throw fail("ServiceM8 returned unexpected webhook subscriptions.");
    const token = c.webhook_enc ? decryptToken(c.webhook_enc) : null;
    const callback = token ? backend + "/api/servicem8/webhook/" + token : null;
    const subscriptions = ["job", "jobpayment", "jobactivity"].map(object => {
      const matches = result.data.filter(row => row.object === object && (!row.type || row.type === "object") &&
        (callback ? row.callback_url === callback : row.unique_id === `turnkey-${c.generation}-${object}`));
      const row = matches.find(item => [true, 1, "1"].includes(item.active)) || matches[0];
      const reason = row?.last_failure_reason == null ? null : String(row.last_failure_reason)
        .replace(/https?:\/\/\S+/gi, "[redacted URL]").split(token || "\u0000").join("[redacted]").slice(0, 500);
      const fields = Array.isArray(row?.fields) ? row.fields : typeof row?.fields === "string" ? row.fields.split(",") : null;
      return { object, active: !!row && [true, 1, "1"].includes(row.active), missing: !row,
        ...(fields ? { fields: fields.map(field => String(field).trim()).filter(field => /^[a-z_]+$/.test(field)).slice(0, 50) } : {}),
        lastFailureReason: reason, lastFailureAt: row?.last_failure_at || null };
    });
    if (!previousFailures) {
      const stored = await unwrap(db.from("external_object_mappings").select("snapshot").eq("business_id", businessId)
        .eq("connection_generation", c.generation).eq("object_type", "webhook_status").eq("local_id", "servicem8:webhooks").maybeSingle());
      previousFailures = stored?.snapshot?.previousFailures || [];
    }
    const snapshot = { checkedAt: new Date().toISOString(), subscriptions, previousFailures };
    await unwrap(db.from("external_object_mappings").upsert({ business_id: businessId, connection_generation: c.generation,
      object_type: "webhook_status", local_id: "servicem8:webhooks", external_uuid: c.generation, snapshot,
      synced_at: snapshot.checkedAt }, { onConflict: "business_id,connection_generation,object_type,local_id" }));
    return snapshot;
  }
  async function enqueue(businessId, kind, key, payload) {
    const { error } = await db
      .from("integration_tasks")
      .insert({ business_id: businessId, kind, dedupe_key: key, payload });
    if (error && error.code !== "23505") throw error;
    // Wake the worker immediately rather than waiting up to 15s for its next
    // poll — fire-and-forget so an explicit transfer/save request never
    // blocks on (or fails because of) the delivery itself; the task row
    // just queued is the actual durable record of "queued," not this call.
    // Bulk seeds wait for the background poll, keeping import IO out of the
    // calendar request even when provider mocks or adapters resolve immediately.
    if (kind !== "dispatch_seed") tick().catch((e) => console.error("[Sales handoff] immediate wake failed", e.code || e.name));
  }
  app.get(
    "/api/sales/servicem8/status",
    requireBusiness,
    wrap(async (req, res) => {
      const c = await conn(req.businessId);
      if (!c)
        return res.json({
          connected: false,
          oauthConfigured: oauthReady,
          privateEnabled: privateReady,
          ...connectionHealth(null),
          webhookSubscribed: false,
          retryAvailable: false,
        });
      const tasks = await unwrap(
        db
          .from("integration_tasks")
          .select("state,attempts,next_attempt_at,last_error")
          .eq("business_id", req.businessId)
          .in("kind", integrationKinds)
          .neq("state", "succeeded"),
      );
      const mappings = await unwrap(
        db
          .from("external_object_mappings")
          .select("object_type,local_id,external_uuid,synced_at,snapshot")
          .eq("business_id", req.businessId)
          .eq("connection_generation", c.generation)
          .eq("object_type", "job"),
      );
      let webhookHealth;
      if (req.query.webhooks === "all") webhookHealth = await inspectWebhooks(req.businessId, c);
      else {
        const stored = await unwrap(db.from("external_object_mappings").select("snapshot")
          .eq("business_id", req.businessId).eq("connection_generation", c.generation)
          .eq("object_type", "webhook_status").eq("local_id", "servicem8:webhooks").maybeSingle());
        webhookHealth = stored?.snapshot || null;
      }
      const webhookDeliveryReady = ["job", "jobpayment", "jobactivity"].every(object =>
        webhookHealth?.subscriptions?.some(row => row.object === object && row.active === true));
      const health = connectionHealth(c);
      const failed = tasks.filter(x => x.state === "failed");
      res.json({
        connected: true,
        ...(webhookHealth ? { webhookSubscriptions: webhookHealth.subscriptions, webhookHealth } : {}),
        privateEnabled: privateReady,
        ...health,
        webhookSubscribed: webhookDeliveryReady,
        syncMode: webhookDeliveryReady ? "webhooks_and_periodic" : "periodic",
        syncWarning: webhookDeliveryReady ? null : "ServiceM8 webhook delivery is incomplete or unverified. Background sync checks for changes every 15 minutes.",
        webhookSubscribedAt: c.webhook_subscribed_at || null,
        dispatchSeededAt: c.dispatch_seeded_at || null,
        dispatchSeedVersion: "v3",
        reconciliationIntervalMinutes: 15,
        scheduleSyncPermissionMissing: c.auth_mode === "oauth" && !String(c.scope || "").split(/\s+/).includes("read_schedule"),
        retryAvailable: health.serverConfigured && health.credentialsReady && !health.reconnectRequired && failed.length > 0,
        exhausted: failed.filter(x => x.attempts >= 12).length,
        autoRetrying: failed.filter(x => x.attempts < 12).length,
        accountName: c.account_name,
        accountUuid: c.account_uuid,
        mode: c.auth_mode,
        autoHandoff: c.auto_handoff,
        lastSyncAt: c.last_sync_at,
        lastError: c.last_error,
        pending: tasks.filter(
          (x) => x.state === "pending" || x.state === "running",
        ).length,
        failed: tasks.filter((x) => x.state === "failed").length,
        mappings,
        oauthConfigured: oauthReady,
      });
    }),
  );
  app.post(
    "/api/sales/servicem8/private",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      if (env.ENABLE_SERVICEM8_PRIVATE === "false")
        throw fail("Private connections are disabled. Use OAuth.", 403);
      if (!encryptionReady)
        throw fail("Configure EMAIL_TOKEN_KEY on the backend before connecting ServiceM8.", 503);
      if (
        typeof req.body.apiKey !== "string" ||
        req.body.apiKey.length < 16 ||
        req.body.apiKey.length > 1000
      )
        throw fail("Enter a valid private API key.");
      await saveConnection(req.businessId, "private", {
        apiKey: req.body.apiKey,
      });
      try {
        await subscribe(req.businessId);
      } catch (e) {
        await unwrap(
          db
            .from("servicem8_connections")
            .update({
              last_error:
                "Connected; webhook registration failed. Use Refresh linked jobs, or reconnect after checking permissions.",
            })
            .eq("business_id", req.businessId),
        );
      }
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/sales/servicem8/oauth/prepare",
    wrap(async (req, res) => {
      const nonce = crypto.randomBytes(32).toString("hex");
      res.cookie("sm8_oauth", nonce, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 600000,
        path: "/api/sales/servicem8/oauth/callback",
      });
      res.set("Cache-Control", "no-store");
      res
        .type("html")
        .send(
          "<!doctype html><title>Connect ServiceM8</title><p>Preparing your secure connection…</p><script>if(window.opener)window.opener.postMessage(" +
            JSON.stringify({ type: "turnkey-servicem8-ready", nonce }) +
            "," +
            JSON.stringify(frontend) +
            ");</script>",
        );
    }),
  );
  app.get(
    "/api/sales/servicem8/oauth/start",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      if (!oauthReady)
        throw fail(
          "Configure ServiceM8 OAuth and PUBLIC_BACKEND_URL on Render.",
          503,
        );
      if (!/^[a-f0-9]{64}$/.test(req.query.browser || ""))
        throw fail("Open the ServiceM8 connection window again.");
      const state = crypto.randomBytes(32).toString("hex");
      await unwrap(
        db
          .from("integration_oauth_states")
          .insert({
            digest: SM.hash(state),
            browser_hash: SM.hash(req.query.browser),
            business_id: req.businessId,
            user_id: req.userId,
            expires_at: new Date(Date.now() + 600000).toISOString(),
          }),
      );
      const redirect = backend + "/api/sales/servicem8/oauth/callback/" + state;
      res.json({
        url: oauthProvider.getAuthUrl(redirect, state, SM.SCOPES.split(" ")),
      });
    }),
  );
  app.get(
    "/api/sales/servicem8/oauth/callback/:state",
    wrap(async (req, res) => {
      const state = req.params.state,
        cookie = String(req.get("cookie") || "")
          .split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith("sm8_oauth="))
          ?.slice(10);
      res.clearCookie("sm8_oauth", {
        path: "/api/sales/servicem8/oauth/callback",
      });
      res.set("Cache-Control", "no-store");
      if (
        !/^[a-f0-9]{64}$/.test(state) ||
        !/^[a-f0-9]{64}$/.test(cookie || "") ||
        req.query.state !== state ||
        req.query.error
      )
        throw fail(
          "OAuth browser verification failed. Start again from Connections.",
          403,
        );
      const rows = await unwrap(
        db
          .from("integration_oauth_states")
          .delete()
          .eq("digest", SM.hash(state))
          .eq("browser_hash", SM.hash(cookie))
          .gt("expires_at", new Date().toISOString())
          .select("*"),
      );
      if (!rows.length)
        throw fail(
          "This connection request expired, was already used or belongs to another browser.",
          403,
        );
      const row = rows[0];
      const user = await unwrap(
        db
          .from("users")
          .select("role")
          .eq("id", row.user_id)
          .eq("business_id", row.business_id)
          .maybeSingle(),
      );
      if (!user || !["owner", "manager"].includes(user.role))
        throw fail("Account permissions changed. Start again.", 403);
      if (typeof req.query.code !== "string" || req.query.code.length > 2000)
        throw fail("ServiceM8 authorization was not completed.");
      const redirect = backend + "/api/sales/servicem8/oauth/callback/" + state;
      const creds = await oauthProvider.exchangeCode(req.query.code, redirect);
      await saveConnection(row.business_id, "oauth", creds);
      try {
        await subscribe(row.business_id);
      } catch {
        await unwrap(
          db
            .from("servicem8_connections")
            .update({
              last_error:
                "Connected, but webhook registration failed. Reconnect or use manual refresh.",
            })
            .eq("business_id", row.business_id),
        );
      }
      res.clearCookie("sm8_oauth", {
        path: "/api/sales/servicem8/oauth/callback",
      });
      res.redirect(frontend + "/index.html?servicem8=connected");
    }),
  );
  app.post(
    "/api/sales/servicem8/disconnect",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      await unwrap(
        db
          .from("servicem8_connections")
          .delete()
          .eq("business_id", req.businessId),
      );
      await unwrap(
        db
          .from("integration_tasks")
          .update({
            state: "failed",
            attempts: 12,
            lease_until: null,
            lease_token: null,
            last_error: "ServiceM8 disconnected. Reconnect and manually retry.",
          })
          .eq("business_id", req.businessId)
          .in("kind", integrationKinds)
          .neq("state", "succeeded"),
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/sales/servicem8/settings",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      if (typeof req.body.autoHandoff !== "boolean")
        throw fail("Invalid handoff setting.");
      const updated = await unwrap(
        db
          .from("servicem8_connections")
          .update({ auto_handoff: req.body.autoHandoff })
          .eq("business_id", req.businessId)
          .select("business_id"),
      );
      if (!updated.length) throw fail("Connect ServiceM8 before changing settings.", 409);
      res.json({ ok: true, autoHandoff: req.body.autoHandoff });
    }),
  );
  app.post(
    "/api/sales/servicem8/webhooks",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      const c = await conn(req.businessId);
      if (!c) throw fail("Connect ServiceM8 before connecting status updates.", 409);
      const health = connectionHealth(c);
      if (!health.serverConfigured)
        throw fail("Configure " + health.configurationMissing.join(", ") + " on the backend before connecting status updates.", 503);
      if (!health.credentialsReady)
        throw fail("ServiceM8 credentials cannot be read. Check EMAIL_TOKEN_KEY and reconnect the account.", 409);
      // Registration uses the stored callback token and stable per-object unique IDs.
      // Repeated clicks are a no-op once both subscriptions have been recorded.
      try { await subscribe(req.businessId); }
      catch (e) {
        await unwrap(db.from("servicem8_connections")
          .update({ last_error: "ServiceM8 webhook registration failed. " + safeError(e) })
          .eq("business_id", req.businessId).eq("generation", c.generation)
          .eq("webhook_token_hash", c.webhook_token_hash));
        throw e;
      }
      if (/webhook registration failed/i.test(c.last_error || "")) await unwrap(db.from("servicem8_connections").update({ last_error: null })
        .eq("business_id", req.businessId).eq("generation", c.generation)
        .eq("webhook_token_hash", c.webhook_token_hash)
        .eq("last_error", c.last_error));
      const updated = await conn(req.businessId);
      if (!updated || updated.generation !== c.generation || updated.webhook_token_hash !== c.webhook_token_hash)
        throw fail("ServiceM8 connection changed during webhook registration. Try again.", 409);
      res.json({ ok: true, connected: true, ...connectionHealth(updated),
        webhookSubscribed: !!updated.webhook_subscribed_at,
        webhookSubscribedAt: updated.webhook_subscribed_at || null,
        lastError: updated.last_error || null });
    }),
  );
  app.post(
    "/api/sales/servicem8/handoff",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      if (!SM.uuid(req.body.jobId))
        throw fail("Invalid opportunity reference.");
      const job = await unwrap(
        db
          .from("jobs")
          .select("*")
          .eq("business_id", req.businessId)
          .eq("id", req.body.jobId)
          .maybeSingle(),
      );
      if (!job) throw fail("Opportunity not found.", 404);
      const mode = req.body.mode ?? "approved";
      if (!["quote", "approved"].includes(mode)) throw fail("Invalid handoff mode.");
      if (mode === "approved" && !["won", "scheduled", "completed", "paid"].includes(job.status))
        throw fail("Only won sales can be transferred.");
      if (mode === "quote" && ["cancelled", "completed", "paid"].includes(job.status))
        throw fail("This opportunity cannot be sent as a draft quote.");
      const c = await conn(req.businessId);
      if (!c) throw fail("Connect ServiceM8 first.", 409);
      const health = connectionHealth(c);
      if (!health.serverConfigured || !health.credentialsReady || health.reconnectRequired)
        throw fail("Check ServiceM8 configuration and reconnect before transferring.", 409);
      // Pre-quote-tracking legacy jobs (won/completed with no quotes row at
      // all) can only reach "approved" mode here, and only via an explicit
      // human review — never silently fabricated during a background sync.
      // The review captures the job's existing recorded amount/details as a
      // durable quote + snapshot; nothing about the historical price changes.
      if (!job.quote_id) {
        if (mode !== "approved" || !["won", "scheduled", "completed", "paid"].includes(job.status))
          throw fail("Save a quote before transferring.", 409);
        if (req.body.reviewLegacy !== true) {
          const amount = Number(job.details?.total);
          throw Object.assign(fail(
            "This opportunity predates quote tracking and has no saved quote. Review its recorded amount and services, then retry with reviewLegacy: true.", 409),
            { publicCode: "LEGACY_REVIEW_REQUIRED", missingFields: [
              ...(Number.isFinite(amount) && amount > 0 ? [] : ["amount"]),
              ...(typeof job.details?.gstRegistered !== "boolean" ? ["gstRegistered"] : []),
            ] });
        }
        const amount = Number(job.details?.total);
        if (!Number.isFinite(amount) || amount <= 0)
          throw fail("This legacy opportunity has no recorded amount to transfer. Enter and save a quote total first.", 409);
        const created = await unwrap(db.from("quotes").insert({
          business_id: req.businessId, lead_id: job.customer_id, amount, status: "accepted",
        }).select("id,status,amount").single());
        await unwrap(db.from("jobs").update({ quote_id: created.id })
          .eq("id", job.id).eq("business_id", req.businessId));
        job.quote_id = created.id;
      }
      const q = await unwrap(db.from("quotes").select("id,status,amount")
        .eq("business_id", req.businessId).eq("id", job.quote_id).maybeSingle());
      if (!q) throw fail("Quote not found.", 404);
      if (mode === "quote" && q.status === "accepted") throw fail("Use approved mode for an accepted quote.", 409);
      if (mode === "approved" && q.status !== "accepted") throw fail("The quote is not approved.", 409);
      let query = db.from("quote_versions").select("*")
        .eq("business_id", req.businessId).eq("quote_id", q.id);
      if (mode === "approved") query = query.eq("snapshot->>accepted", "true");
      const versions = await unwrap(query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1));
      let version = versions[0], legacy = false;
      if (!version && mode === "approved" && req.body.reviewLegacy === true) {
        const customer = await unwrap(db.from("customers").select("*").eq("business_id", req.businessId)
          .eq("id", job.customer_id).maybeSingle());
        const business = await unwrap(db.from("businesses").select("*").eq("id", req.businessId).maybeSingle());
        if (!customer?.name || !business?.name) throw fail("Review requires a saved customer and business.", 409);
        const savedGst = typeof job.details?.gstRegistered === "boolean";
        const snapshot = { provenance: "legacy-reviewed", quoteId: q.id, reviewedBy: req.userId,
          reviewedAt: new Date().toISOString(), gstProvenance: savedGst ? "saved-quote" : "explicit-review",
          amount: q.amount, details: { ...job.details,
            gstRegistered: savedGst ? job.details.gstRegistered : req.body.gstRegistered }, customer, business };
        if (typeof snapshot.details?.gstRegistered !== "boolean")
          throw Object.assign(fail("Legacy quote GST treatment is missing. Explicitly review GST and resend reviewLegacy: true with boolean gstRegistered; current business settings cannot substitute for it.", 409),
            { publicCode: "LEGACY_REVIEW_REQUIRED", missingFields: ["gstRegistered"] });
        version = { snapshot, fingerprint: contentFingerprint(snapshot) };
        legacy = true;
      }
      if (!version && mode === "approved") throw Object.assign(fail(
        "No immutable approved quote snapshot exists. Review the current quote amount and services, then retry with reviewLegacy: true.", 409),
        { publicCode: "LEGACY_REVIEW_REQUIRED",
          ...(typeof job.details?.gstRegistered !== "boolean" ? { missingFields: ["gstRegistered"] } : {}) });
      if (!version) throw fail("Save the quote to create a version before transferring.", 409);
      if (mode === "quote" && (Number(version.snapshot.amount) !== Number(q.amount) ||
          canonical(quoteDetails(version.snapshot.details)) !== canonical(quoteDetails(job.details))))
        throw fail("Saved quote version is out of date. Save the quote again.", 409);
      SM.approvedLines(version.snapshot, { mode });
      await enqueue(req.businessId, "handoff", [job.id, c.generation, mode, version.fingerprint].join(":"),
        { jobId: job.id, mode, generation: c.generation, quoteId: q.id, versionId: version.id,
          fingerprint: version.fingerprint, snapshot: version.snapshot,
          ...(legacy ? { reviewLegacy: true, snapshotHash: SM.hash(canonical(version.snapshot)) } : {}) });
      res.status(202).json({ queued: true });
    }),
  );
  app.get(
    "/api/sales/quotes/:quoteId/history",
    requireBusiness,
    wrap(async (req, res) => {
      if (!SM.uuid(req.params.quoteId)) throw fail("Invalid quote reference.");
      const quote = await unwrap(db.from("quotes").select("id").eq("business_id", req.businessId)
        .eq("id", req.params.quoteId).maybeSingle());
      if (!quote) throw fail("Quote not found.", 404);
      const versions = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await unwrap(db.from("quote_versions").select("id,fingerprint,created_at,snapshot")
          .eq("business_id", req.businessId).eq("quote_id", quote.id)
          .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 999));
        versions.push(...page);
        if (page.length < 1000) break;
      }
      res.set("Cache-Control", "no-store");
      res.json({ versions: versions
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
        .map(publicVersion) });
    }),
  );
  app.post(
    "/api/sales/servicem8/retry",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      const c = await conn(req.businessId);
      if (!c) throw fail("Connect ServiceM8 before retrying transfers.", 409);
      const health = connectionHealth(c);
      if (!health.serverConfigured) throw fail("Configure " + health.configurationMissing.join(", ") + " on the backend before retrying.", 503);
      if (health.reconnectRequired) throw fail("Reconnect ServiceM8 before retrying transfers.", 409);
      await unwrap(
        db
          .from("integration_tasks")
          .update({
            state: "pending",
            attempts: 0,
            lease_until: null,
            lease_token: null,
            last_error: null,
            next_attempt_at: new Date().toISOString(),
          })
          .eq("business_id", req.businessId)
          .in("kind", integrationKinds)
          .eq("state", "failed"),
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/sales/servicem8/refresh",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      const c = await conn(req.businessId);
      if (!c) throw fail("Connect ServiceM8 first.");
      const maps = await unwrap(
        db
          .from("external_object_mappings")
          .select("external_uuid")
          .eq("business_id", req.businessId)
          .eq("connection_generation", c.generation)
          .eq("object_type", "job"),
      );
      for (const m of maps)
        await enqueue(
          req.businessId,
          "refresh_job",
          m.external_uuid + ":" + Math.floor(Date.now() / 60000),
          { uuid: m.external_uuid },
        );
      res.status(202).json({ queued: maps.length });
    }),
  );
  app.post(
    "/api/job-calendar/servicem8/sync",
    requireBusiness,
    admin,
    wrap(async (req, res) => {
      const c = await conn(req.businessId);
      if (!c) throw fail("Connect ServiceM8 first.", 409);
      const key = "dispatch-seed-v3:" + c.generation;
      const previous = await unwrap(db.from("integration_tasks").select("id,state,attempts").eq("business_id", req.businessId)
        .eq("kind", "dispatch_seed").eq("dedupe_key", key).maybeSingle());
      if (previous?.state === "succeeded") return res.json({ ok: true, skipped: true, seededAt: c.dispatch_seeded_at, seedVersion: "v3" });
      if (previous?.state === "failed") await unwrap(db.from("integration_tasks").update({ state: "pending", attempts: 0,
        lease_until: null, lease_token: null, last_error: null, next_attempt_at: new Date().toISOString() })
        .eq("id", previous.id).eq("state", "failed").eq("attempts", previous.attempts));
      else await enqueue(req.businessId, "dispatch_seed", key, { generation: c.generation, version: "v3" });
      res.status(202).json({ ok: true, queued: true, seedVersion: "v3" });
    }),
  );
  app.get(
    "/api/sales/servicem8/jobs",
    requireBusiness,
    wrap(async (req, res) => {
      const status = String(req.query.status || "");
      if (status !== "Completed") throw fail("Only the Completed ServiceM8 list is available here.", 400);
      const c = await conn(req.businessId);
      if (!c) throw fail("Connect ServiceM8 first.", 409);
      const rows = await listRemote(req.businessId, "/job.json?$filter=" + encodeURIComponent("status eq 'Completed'"), c.generation);
      const jobs = rows.filter(job => job.uuid && job.status === "Completed").slice(0, 1000).map(job => ({
        uuid: job.uuid,
        reference: job.generated_job_id || "",
        customer: job.company_name || job.company_contact_name || "ServiceM8 customer",
        description: job.job_description || job.job_name || "Completed job",
        address: job.job_address || "",
        completedAt: job.completion_date || job.edit_date || null,
        amount: Number.isFinite(Number(job.total_invoice_amount)) ? Number(job.total_invoice_amount) : null,
      }));
      res.json({ jobs });
    }),
  );
  app.post(
    "/api/servicem8/webhook/:token",
    wrap(async (req, res) => {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(req.params.token))
        throw fail("Unknown webhook.", 404);
      const c = await unwrap(
        db
          .from("servicem8_connections")
          .select("business_id")
          .eq("webhook_token_hash", SM.hash(req.params.token))
          .maybeSingle(),
      );
      if (!c) throw fail("Unknown webhook.", 404);
      if (req.rawBody?.length > 262144)
        throw fail("Webhook payload too large.", 413);
      if (req.body.mode === "subscribe") {
        if (
          typeof req.body.challenge !== "string" ||
          req.body.challenge.length > 1000
        )
          throw fail("Invalid challenge.");
        return res.type("text").send(req.body.challenge);
      }
      if (
        !["job", "jobpayment", "jobactivity", "jobmaterial"].includes(req.body.object) ||
        !Array.isArray(req.body.entry) ||
        req.body.entry.length !== 1
      )
        throw fail("Invalid webhook event.");
      const entry = req.body.entry[0];
      if (
        !SM.uuid(entry.uuid) ||
        typeof entry.time !== "string" ||
        entry.time.length > 60 ||
        !Array.isArray(entry.changed_fields) ||
        entry.changed_fields.some(
          (x) => typeof x !== "string" || x.length > 100,
        )
      )
        throw fail("Invalid webhook entry.");
      const normalized = {
        object: req.body.object,
        uuid: entry.uuid,
        time: entry.time,
        fields: [...entry.changed_fields].sort(),
      };
      await enqueue(
        c.business_id,
        "webhook",
        SM.hash(JSON.stringify(normalized)),
        normalized,
      );
      res.json({ received: true });
    }),
  );
  async function mapping(c, type, localId) {
    const { data, error } = await db
      .from("external_object_mappings")
      .upsert(
        {
          business_id: c.business_id,
          connection_generation: c.generation,
          object_type: type,
          local_id: String(localId),
          external_uuid: SM.stableUuid("turnkey", c.generation, type, localId),
        },
        {
          onConflict: "business_id,connection_generation,object_type,local_id",
          ignoreDuplicates: true,
        },
      );
    if (error) throw error;
    return unwrap(
      db
        .from("external_object_mappings")
        .select("*")
        .eq("business_id", c.business_id)
        .eq("connection_generation", c.generation)
        .eq("object_type", type)
        .eq("local_id", String(localId))
        .single(),
    );
  }
  async function ensure(c, type, id, body) {
    const map = await mapping(c, type, id);
    if (map.synced_at) return map;
    const path = "/" + type + "/" + map.external_uuid + ".json";
    try {
      await call(c.business_id, path, { generation: c.generation });
    } catch (e) {
      if (e.status !== 404) throw e;
      try {
        await call(c.business_id, "/" + type + ".json", {
          method: "POST",
          generation: c.generation,
          body: { ...body, uuid: map.external_uuid },
        });
      } catch (createError) {
        if (createError.status !== 409) throw createError;
        await call(c.business_id, path, { generation: c.generation });
      }
    }
    await unwrap(
      db
        .from("external_object_mappings")
        .update({ synced_at: new Date().toISOString() })
        .eq("business_id", c.business_id)
        .eq("connection_generation", c.generation)
        .eq("object_type", type)
        .eq("local_id", String(id)),
    );
    return map;
  }
  async function transfer(task) {
    const c = await conn(task.business_id);
    if (!c) throw fail("ServiceM8 disconnected.");
    const job = await unwrap(
      db
        .from("jobs")
        .select("*")
        .eq("business_id", task.business_id)
        .eq("id", task.payload.jobId)
        .single(),
    );
    const mode = task.payload.mode || "approved";
    if (!["quote", "approved"].includes(mode)) throw fail("Invalid handoff mode.");
    if (task.payload.generation && task.payload.generation !== c.generation)
      throw fail("ServiceM8 connection changed. Queue a new handoff.", 409);
    if (!job || !job.quote_id || (mode === "approved" && !["won", "scheduled", "completed", "paid"].includes(job.status)))
      throw fail("Only an approved, quoted sale can be transferred.");
    const q = await unwrap(
      db
        .from("quotes")
        .select("*")
        .eq("business_id", task.business_id)
        .eq("id", job.quote_id)
        .single(),
    );
    if (!q) throw fail("Quote not found.", 404);
    if (mode === "approved" && q.status !== "accepted") throw fail("The quote is not approved.");
    if (mode === "quote" && (q.status === "accepted" || ["cancelled", "completed", "paid"].includes(job.status)))
      throw fail("Draft handoff is obsolete. Use approved mode or review the opportunity.", 409);
    if (task.payload.quoteId && task.payload.quoteId !== q.id) throw fail("The linked quote changed.", 409);
    let versionQuery = db.from("quote_versions").select("*")
      .eq("business_id", task.business_id).eq("quote_id", q.id);
    if (mode === "approved") versionQuery = versionQuery.eq("snapshot->>accepted", "true");
    if (task.payload.versionId) versionQuery = versionQuery.eq("id", task.payload.versionId);
    const versions = await unwrap(versionQuery.order("created_at", { ascending: false })
      .order("id", { ascending: false }).limit(1));
    let version = versions[0];
    if (!version && mode === "approved" && task.payload.reviewLegacy === true) {
      const s = task.payload.snapshot;
      if (!s || s.provenance !== "legacy-reviewed" || s.quoteId !== q.id ||
          task.payload.quoteId !== q.id || task.payload.generation !== c.generation ||
          typeof s.reviewedBy !== "string" || !s.reviewedBy || !Number.isFinite(Date.parse(s.reviewedAt)) ||
          s.accepted !== undefined || Number(s.amount) !== Number(q.amount) ||
          s.customer?.id !== job.customer_id || s.customer?.business_id !== task.business_id ||
          s.business?.id !== task.business_id || !s.customer?.name || !s.business?.name ||
          (typeof job.details?.gstRegistered === "boolean"
            ? s.gstProvenance !== "saved-quote" || canonical(quoteDetails(s.details)) !== canonical(quoteDetails(job.details))
            : s.gstProvenance !== "explicit-review" || typeof s.details?.gstRegistered !== "boolean" ||
              canonical(quoteDetails(s.details)) !== canonical(quoteDetails({ ...job.details, gstRegistered: s.details.gstRegistered }))) ||
          contentFingerprint(s) !== task.payload.fingerprint ||
          SM.hash(canonical(s)) !== task.payload.snapshotHash)
        throw fail("Legacy review no longer matches the accepted quote. Review its current amount and services again.", 409);
      version = { snapshot: s, fingerprint: task.payload.fingerprint };
    }
    if (!version) throw fail("No immutable approved quote snapshot exists. Review this legacy quote before transferring.");
    if (mode === "quote" && (!task.payload.versionId || !task.payload.fingerprint || !task.payload.snapshot))
      throw fail("Draft handoff requires a queued immutable quote version.", 409);
    if (task.payload.snapshot && (version.fingerprint !== task.payload.fingerprint ||
        canonical(version.snapshot) !== canonical(task.payload.snapshot)))
      throw fail("Queued quote snapshot does not match its saved version.", 409);
    if (mode === "quote" && (!version.snapshot.customer?.id || !version.snapshot.customer?.name || !version.snapshot.business?.name))
      throw fail("Saved draft is missing customer or business information. Save the quote again.", 409);
    const snapshot = version.snapshot,
      customer = snapshot.customer || await unwrap(
        db
          .from("customers")
          .select("*")
          .eq("business_id", task.business_id)
          .eq("id", job.customer_id)
          .single(),
      );
    const lines = SM.approvedLines(snapshot, { mode });
    const fingerprint = contentFingerprint(snapshot);
    const jobMap = await mapping(c, "job", job.id);
    const priorFingerprint = jobMap.snapshot?.handoffFingerprint;
    if (priorFingerprint && priorFingerprint !== fingerprint)
      throw fail("Quote content changed after transfer began. Reconcile the existing ServiceM8 quote before retrying.", 409);
    if (mode === "quote" && jobMap.synced_at && !priorFingerprint)
      throw fail("Existing legacy ServiceM8 job requires review before draft handoff.", 409);
    // An insert-only reservation fences different revisions across worker processes.
    // Task leases are per task, so they alone cannot serialize revisions of one job.
    await unwrap(db.from("external_object_mappings").upsert({ business_id: task.business_id,
      connection_generation: c.generation, object_type: "handoff_content", local_id: String(job.id),
      external_uuid: SM.stableUuid("turnkey", c.generation, "handoff_content", job.id),
      snapshot: { fingerprint } },
      { onConflict: "business_id,connection_generation,object_type,local_id", ignoreDuplicates: true }));
    const reservation = await mapping(c, "handoff_content", job.id);
    if (reservation.snapshot?.fingerprint !== fingerprint)
      throw fail("Quote content changed after transfer began. Reconcile the existing ServiceM8 quote before retrying.", 409);
    await unwrap(db.from("external_object_mappings").update({ snapshot: { ...jobMap.snapshot,
      handoffFingerprint: fingerprint, handoffMode: mode } })
      .eq("business_id", task.business_id).eq("connection_generation", c.generation)
      .eq("object_type", "job").eq("local_id", String(job.id)));
    const taxes = (
        await call(task.business_id, "/taxrate.json", {
          generation: c.generation,
        })
      ).data;
    const tax = (Array.isArray(taxes) ? taxes : []).find(
      (t) =>
        Number(t.active) !== 0 &&
        Number(t.amount) === (snapshot.details.gstRegistered ? 15 : 0),
    );
    if (!tax)
      throw fail(
        "Create a matching " +
          (snapshot.details.gstRegistered ? "15% GST" : "0%") +
          " tax rate in ServiceM8, then retry.",
      );
    const reference = "Q-" + q.id.slice(-6).toUpperCase();
    const description = [
      "TurnKey " + (mode === "quote" ? "draft" : "approved") + " quote " + reference,
      ...(snapshot.details.services || []).map((x) => `${x.svc}: ${x.qty}`),
      snapshot.details.jobNotes || "",
      snapshot.details.salesNotes || "",
    ]
      .filter(Boolean)
      .join("\n");
    const companyCreator = async (args) => {
      const m = await ensure(c, "company", customer.id, {
        name: args.name.slice(0, 100),
        address: args.address || "",
      });
      return { recordUuid: m.external_uuid };
    };
    const jobCreator = async (args) => {
      const company = await mapping(c, "company", customer.id);
      const m = await ensure(c, "job", job.id, {
        status: mode === "quote" ? "Quote" : "Work Order",
        company_uuid: company.external_uuid,
        job_address: args.jobAddress || "",
        job_description: args.description,
        purchase_order_number: reference,
      });
      return { recordUuid: m.external_uuid };
    };
    // The legacy decision engine catches errors. Retain the original adapter
    // failure so auth expiry/permissions still reach the worker's health status.
    let transferError;
    const preserveError = (fn) => async (...args) => {
      try { return await fn(...args); }
      catch (e) { transferError = e; throw e; }
    };
    const core = await performServiceM8Handoff({
      businessId: task.business_id,
      jobId: job.id,
      customer,
      job: { address: customer.address, description },
      materials: [],
      deps: {
        // Generation-scoped mappings establish identity; legacy handoffs may refer to another account.
        getExistingHandoff: async () => null,
        getObjectMap: async (biz, type, id, remote) => {
          const m = await unwrap(
            db
              .from("external_object_mappings")
              .select("external_uuid,synced_at")
              .eq("business_id", biz)
              .eq("connection_generation", c.generation)
              .eq("object_type", remote)
              .eq("local_id", String(id))
              .maybeSingle(),
          );
          return m?.synced_at ? { sm8_uuid: m.external_uuid } : null;
        },
        saveObjectMap: async (row) =>
          await unwrap(
            db
              .from("servicem8_object_map")
              .upsert(row, {
                onConflict: "business_id,local_type,local_id,sm8_type",
              }),
          ),
        saveHandoff: async (row) =>
          await unwrap(
            db
              .from("servicem8_handoffs")
              .upsert(
                {
                  ...row,
                  last_error: row.last_error
                    ? "ServiceM8 transfer failed. Retry from Connections."
                    : null,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "business_id,job_id" },
              ),
          ),
        createCompany: preserveError(companyCreator),
        createJob: preserveError(jobCreator),
      },
    });
    if (core.status !== "synced")
      throw transferError || fail(
        "ServiceM8 customer/job transfer failed. Review connection permissions and retry.",
      );
    const remote = { external_uuid: core.jobUuid };
    const remotePath = "/job/" + remote.external_uuid + ".json";
    const remoteJob = (await call(task.business_id, remotePath, { generation: c.generation })).data;
    if (mode === "approved" && remoteJob.status === "Quote")
      await call(task.business_id, remotePath, { generation: c.generation, method: "POST", body: { status: "Work Order" } });
    else if (mode === "quote" && remoteJob.status !== "Quote")
      throw fail("ServiceM8 job has progressed beyond Quote. Review it in ServiceM8.", 409);
    const name = customer.name.split(" ");
    await ensure(c, "companycontact", customer.id, {
      company_uuid: core.companyUuid,
      first: name.shift() || customer.name,
      last: name.join(" "),
      email: customer.email || "",
      phone: customer.phone || "",
      is_primary_contact: "1",
      type: "JOB",
    });
    for (let i = 0; i < lines.length; i++)
      await ensure(c, "jobmaterial", q.id + ":" + i, {
        ...lines[i],
        job_uuid: remote.external_uuid,
        tax_rate_uuid: tax.uuid,
      });
    const attachmentId = mode === "quote" ? q.id + ":quote:" + fingerprint : q.id;
    const attachment = await mapping(c, "attachment", attachmentId);
    if (!attachment.synced_at) {
      const business = snapshot.business || await unwrap(
        db
          .from("businesses")
          .select("name")
          .eq("id", task.business_id)
          .single(),
      );
      const pdf = SM.quotePdf({ reference, business, customer, snapshot, mode });
      const form = new FormData();
      form.set("uuid", attachment.external_uuid);
      form.set("related_object", "job");
      form.set("file_type", ".pdf");
      form.set("attachment_source", "QUOTE");
      form.set("related_object_uuid", remote.external_uuid);
      form.set("attachment_name", reference + (mode === "quote" ? "-draft.pdf" : "-approved.pdf"));
      form.set(
        "file",
        new Blob([pdf], { type: "application/pdf" }),
        reference + (mode === "quote" ? "-draft.pdf" : "-approved.pdf"),
      );
      try {
        let exists = false;
        try {
          const saved = (
            await call(
              task.business_id,
              "/attachment/" + attachment.external_uuid + ".json",
              { generation: c.generation },
            )
          ).data;
          if (!Number(saved.active))
            throw fail(
              "ServiceM8 PDF upload is pending. Review the attachment before retrying.",
            );
          exists = true;
        } catch (e) {
          if (e.status !== 404) throw e;
        }
        if (!exists)
          await call(task.business_id, "/attachment.json", {
            method: "POST",
            generation: c.generation,
            body: form,
          });
      } catch (e) {
        if (e.status !== 409) throw e;
        const saved = (
          await call(
            task.business_id,
            "/attachment/" + attachment.external_uuid + ".json",
            { generation: c.generation },
          )
        ).data;
        if (!Number(saved.active))
          throw fail(
            "ServiceM8 PDF upload is pending. Review the attachment in ServiceM8 before retrying.",
          );
      }
      await unwrap(
        db
          .from("external_object_mappings")
          .update({ synced_at: new Date().toISOString() })
          .eq("business_id", task.business_id)
          .eq("connection_generation", c.generation)
          .eq("object_type", "attachment")
          .eq("local_id", attachmentId),
      );
    }
    await refreshRemote(task.business_id, remote.external_uuid);
  }
  // Resource lists are fetched once per seed (plus pagination), never once per event.
  async function seedDispatch(task) {
    const businessId = task.business_id, c = await conn(businessId);
    if (!c || task.payload.generation !== c.generation) throw fail("ServiceM8 connection changed before dispatch import.", 409);
    let checkedAt = 0;
    const checkpoint = async (force = false) => {
      if (!force && Date.now() - checkedAt < 60000) return;
      const claimed = await unwrap(db.from("integration_tasks").update({ lease_until: new Date(Date.now() + 300000).toISOString() })
        .eq("id", task.id).eq("lease_token", task.lease_token).eq("state", "running").select("id"));
      if (!claimed.length) throw fail("Dispatch import lease changed. The current worker will retry.", 409);
      checkedAt = Date.now();
    };
    await checkpoint();
    const seedList = (business, path, generation) => listRemote(business, path, generation, checkpoint);
    // Webhooks are an optimization, not a prerequisite for snapshot import.
    // Import/reconciliation never registers subscriptions or writes upstream.
    try { await inspectWebhooks(businessId, c); }
    catch (error) {
      const snapshot = { checkedAt: new Date().toISOString(), inspectionError: safeError(error), subscriptions:
        ["job", "jobpayment", "jobactivity"].map(object => ({ object, active: false, unknown: true })) };
      await unwrap(db.from("external_object_mappings").upsert({ business_id: businessId, connection_generation: c.generation,
        object_type: "webhook_status", local_id: "servicem8:webhooks", external_uuid: c.generation, snapshot,
        synced_at: snapshot.checkedAt }, { onConflict: "business_id,connection_generation,object_type,local_id" }));
    }
    const vendor = serviceM8Record((await call(businessId, "/vendor.json", { generation: c.generation })).data);
    const timeZone = vendor?.timezone_name || "UTC";
    const activities = await seedList(businessId, "/jobactivity.json?$filter=" + encodeURIComponent("activity_was_scheduled eq 1"), c.generation);
    const jobs = await seedList(businessId, "/job.json", c.generation);
    // Optional OAuth resources may be unavailable. Only 403/404 are optional;
    // rate limiting and transient failures must fail the task for durable retry.
    const staff = await serviceM8OptionalList(seedList, businessId, "staff", "", c.generation);
    const companies = await serviceM8OptionalList(seedList, businessId, "company", "", c.generation);
    const contacts = await serviceM8OptionalList(seedList, businessId, "companycontact", "active eq 1", c.generation);
    const materials = await serviceM8OptionalList(seedList, businessId, "jobmaterial", "active eq 1", c.generation);
    const grouped = (rows, key) => {
      const groups = new Map();
      for (const row of rows) {
        if (!groups.has(row[key])) groups.set(row[key], []);
        groups.get(row[key]).push(row);
      }
      return groups;
    };
    const cache = { vendor, company: new Map(companies.map(row => [row.uuid, row])),
      staff: new Map(staff.map(row => [row.uuid, row])), contacts: grouped(contacts, "company_uuid"), materials: grouped(materials, "job_uuid") };
    for (const row of staff) {
      await checkpoint();
      if (!SM.uuid(row.uuid)) continue;
      await unwrap(db.from("external_object_mappings").upsert({ business_id: businessId, connection_generation: c.generation,
        object_type: "staff", local_id: "servicem8:" + row.uuid, external_uuid: row.uuid,
        snapshot: { name: [row.first, row.last].filter(Boolean).join(" ").trim().slice(0, 160), email: String(row.email || "").slice(0, 254) },
        synced_at: new Date().toISOString() }, { onConflict: "business_id,connection_generation,object_type,local_id" }));
    }
    const byJob = grouped(activities, "job_uuid");
    // Local profiles/pricing must not wait behind historical event writes.
    await reconcileJobs(businessId, c, jobs, checkpoint, { byJob, timeZone, cache });
    for (const job of jobs) {
      await checkpoint();
      if (!SM.uuid(job.uuid)) continue;
      await clearResumedSummary(businessId, c, job);
      const activeIds = await persistDispatch(businessId, c, job, byJob.get(job.uuid) || [], timeZone, cache, checkpoint);
      const previous = await unwrap(db.from("calendar_events").select("external_id,details").eq("business_id", businessId)
        .eq("source", "servicem8").filter("details->>jobUuid", "eq", job.uuid));
      for (const event of previous || []) {
        await checkpoint();
        if (job.status === "Completed") {
          await unwrap(db.from("calendar_events")
            .update({ details: { ...(event.details || {}), status: "Completed",
              pricing: serviceM8PricingSnapshot(job, cache.materials.get(job.uuid) || [], { currency: vendor?.currency }) } }).eq("business_id", businessId)
            .eq("source", "servicem8").eq("external_id", event.external_id));
        } else if (["Work Order", "Quote", "Unsuccessful", "Cancelled", "Canceled"].includes(job.status) &&
            event.details?.status !== "Completed" && !activeIds.has(event.external_id)) {
          // This job was explicitly returned and the full schedule list was
          // fetched successfully. Never infer cancellation from absent jobs.
          await unwrap(db.rpc("sync_servicem8_dispatch_event", { p_business_id: businessId, p_external_id: event.external_id, p_event: null }));
        }
      }
    }

    await checkpoint(true);
    // All event, directory and reconciliation writes must succeed before stamping.
    const saved = await unwrap(db.from("servicem8_connections").update({ last_sync_at: new Date().toISOString(),
      dispatch_seeded_at: c.dispatch_seeded_at || new Date().toISOString(), last_error: null }).eq("business_id", businessId).eq("generation", c.generation).select("business_id"));
    if (!saved.length) throw fail("ServiceM8 connection changed before dispatch import was saved.", 409);
  }
  async function reconcileJobs(businessId, c, remoteJobs, checkpoint, { byJob, timeZone, cache, allowReferences = true, syncStatuses = true }) {
    const [current, legacy, handoffs, records, batches, localJobs, customers] = await Promise.all([
      allRows(db, "external_object_mappings", businessId, "*", "external_uuid"), allRows(db, "servicem8_object_map", businessId),
      allRows(db, "servicem8_handoffs", businessId), allRows(db, "import_records", businessId),
      allRows(db, "import_batches", businessId), allRows(db, "jobs", businessId), allRows(db, "customers", businessId),
    ]);
    const locals = new Map(localJobs.map(job => [job.id, job])), candidates = new Map(), reverse = new Map(), blocked = new Set();
    const add = (external, local, snapshot) => {
      if (!SM.uuid(external) || !SM.uuid(local)) return;
      if (!locals.has(local)) { blocked.add(external); return; }
      const targets = candidates.get(external) || new Map();
      targets.set(local, snapshot || targets.get(local) || {}); candidates.set(external, targets);
      const sources = reverse.get(local) || new Set(); sources.add(external); reverse.set(local, sources);
    };
    for (const row of current) if (row.connection_generation === c.generation && row.object_type === "job") add(row.external_uuid, row.local_id, row.snapshot);
    for (const row of legacy) if (row.local_type === "job" && row.sm8_type === "job") add(row.sm8_uuid, row.local_id);
    for (const row of handoffs) if (row.status === "synced") add(row.sm8_job_uuid, row.job_id);
    const serviceM8Batches = new Set(batches.filter(row => row.source === "servicem8").map(row => row.id));
    const references = new Map();
    for (const job of remoteJobs) {
      const ref = String(job.generated_job_id || "").trim();
      if (ref) references.set(ref, [...(references.get(ref) || []), job.uuid]);
    }
    for (const row of records) {
      if (!allowReferences || row.entity_type !== "job" || !serviceM8Batches.has(row.batch_id) || !row.dedupe_key?.startsWith("servicem8:")) continue;
      const matches = references.get(row.dedupe_key.slice("servicem8:".length));
      if (matches?.length === 1) add(matches[0], row.entity_id);
    }
    const profileMatches = new Map(), detailByJob = new Map(), explicitlyLinked = new Set(reverse.keys());
    for (const job of remoteJobs) {
      await checkpoint();
      const booking = serviceM8Booking(byJob.get(job.uuid) || [], timeZone);
      if (!((job.status === "Work Order" && (job.active == null || Number(job.active) === 1) && booking) || job.status === "Completed") || candidates.has(job.uuid) || blocked.has(job.uuid)) continue;
      const details = await serviceM8DispatchDetails({ call, listRemote, businessId, job,
        activity: (byJob.get(job.uuid) || []).find(row => row.uuid === booking?.activityUuid) || {}, generation: c.generation, cache });
      detailByJob.set(job.uuid, details);
      const companyIds = new Set(current.filter(row => row.connection_generation === c.generation && row.object_type === "company" && row.external_uuid === job.company_uuid).map(row => row.local_id));
      for (const row of legacy) if (row.local_type === "customer" && row.sm8_type === "company" && row.sm8_uuid === job.company_uuid) companyIds.add(row.local_id);
      const profiles = strictDispatchProfiles(details, customers).filter(row => (!companyIds.size || companyIds.has(row.id)) &&
        !current.some(mapping => mapping.connection_generation === c.generation && mapping.object_type === "company" &&
          mapping.local_id === row.id && mapping.external_uuid !== job.company_uuid));
      if (profiles.length > 1) { blocked.add(job.uuid); continue; }
      if (profiles.length !== 1) continue;
      profileMatches.set(job.uuid, profiles[0]);
      const jobs = localJobs.filter(local => local.customer_id === profiles[0].id &&
        ["new", "quoted", "followup", "won", "scheduled"].includes(local.status) &&
        normalizeDispatchAddress(local.details?.address || profiles[0].address) === normalizeDispatchAddress(details.address) &&
        !explicitlyLinked.has(local.id));
      if (jobs.length > 1) { blocked.add(job.uuid); continue; }
      if (jobs.length === 1) add(job.uuid, jobs[0].id);
    }
    const linked = new Map();
    for (const job of remoteJobs) {
      await checkpoint();
      if (!SM.uuid(job.uuid) || blocked.has(job.uuid)) continue;
      const matches = candidates.get(job.uuid);
      if (matches && (matches.size !== 1 || reverse.get([...matches.keys()][0])?.size !== 1)) continue;
      let [localId, snapshot] = matches ? [...matches][0] : [null, {}];
      const booking = serviceM8Booking(byJob.get(job.uuid) || [], timeZone);
      const booked = job.status === "Work Order" && (job.active == null || Number(job.active) === 1) && booking;
      if (!localId && !booked) continue;
      if (booked) {
        const details = detailByJob.get(job.uuid) || await serviceM8DispatchDetails({ call, listRemote, businessId, job,
          activity: (byJob.get(job.uuid) || []).find(row => row.uuid === booking.activityUuid) || {}, generation: c.generation, cache });
        const local = localId ? locals.get(localId) : null;
        const customerId = await ensureDispatchCustomer(businessId, c, job, details, local, current, legacy, profileMatches.get(job.uuid));
        if (!localId) {
          localId = SM.stableUuid("servicem8-inbound-job", businessId, c.generation, job.uuid);
          const names = details.lineItems.length ? details.lineItems : details.services.map(name => ({ name, quantity: "1" }));
          await unwrap(db.from("jobs").upsert({ id: localId, business_id: businessId, customer_id: customerId,
            status: "scheduled", scheduled_date: serviceM8BookingDate(booking),
            details: { importedFrom: "servicem8", serviceM8JobUuid: job.uuid, serviceM8Status: job.status, serviceM8Booking: booking,
              assignedStaffIds: booking.assignedStaffIds, services: [], requestedServices: names.map(item => ({ name: item.name, service_id: null })),
              serviceM8LineItems: details.serviceM8LineItems,
              jobNotes: String(job.job_description || "").slice(0, 4000), name: details.personName, address: details.address } },
            { onConflict: "id", ignoreDuplicates: true }));
          const created = await unwrap(db.from("jobs").select("id,customer_id,details").eq("business_id", businessId).eq("id", localId).maybeSingle());
          if (!created || created.details?.serviceM8JobUuid !== job.uuid) throw fail("ServiceM8 job identity conflicts with an existing local record.", 409);
        } else if (!local.customer_id) {
          await unwrap(db.from("jobs").update({ customer_id: customerId }).eq("business_id", businessId).eq("id", localId).is("customer_id", null));
        }
      }
      if (!localId) continue;
      if (syncStatuses) await unwrap(db.rpc("sync_servicem8_job_state", { p_business_id: businessId, p_job_id: localId,
        p_status: String(job.status || "Unknown"), p_booking: job.status === "Completed" ? snapshot.booking || null : booking,
        p_schedule_permission_missing: job.status === "Completed" }));
      const profile = detailByJob.get(job.uuid) || await serviceM8DispatchDetails({ call, listRemote, businessId, job,
        activity: {}, generation: c.generation, cache });
      await saveServiceM8Pricing(businessId, localId, profile.pricing);
      const mapping = { business_id: businessId, connection_generation: c.generation, object_type: "job", local_id: localId,
        external_uuid: job.uuid, snapshot: { ...snapshot, profile, serviceM8LineItems: profile.serviceM8LineItems,
          status: job.status, completed: job.status === "Completed",
          booking: job.status === "Completed" ? snapshot.booking || null : booking }, synced_at: new Date().toISOString() };
      // Existing identity is immutable: a concurrent exact link must win over creation.
      await unwrap(db.from("external_object_mappings").upsert(mapping,
        { onConflict: "business_id,connection_generation,object_type,local_id" }));
      linked.set(job.uuid, mapping);
    }
    return linked;
  }
  function serviceM8Booking(activities, timeZone) {
    const valid = activities.filter(a => [1, "1", true].includes(a.activity_was_scheduled) &&
      (a.active == null || [1, "1", true].includes(a.active))).map(a => ({ activity: a,
        start: serviceM8WallClock(a.start_date, timeZone), end: serviceM8WallClock(a.end_date, timeZone) }))
      .filter(row => row.start && row.end && row.end > row.start && row.end - row.start <= 86400000).sort((a, b) => a.start - b.start);
    const selected = valid.find(row => +row.end > Date.now()) || valid.at(-1);
    if (!selected) return null;
    return { activityUuid: selected.activity.uuid, jobUuid: selected.activity.job_uuid, startAt: selected.start.toISOString(),
      endAt: selected.end.toISOString(), timeZone, source: "servicem8",
      assignedStaffIds: [...new Set(valid.map(row => row.activity.staff_uuid).filter(SM.uuid))].map(uuid => "servicem8:" + uuid) };
  }
  const serviceM8BookingDate = booking => {
    const parts = zoneParts(new Date(booking.startAt), booking.timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const normalizeDispatchAddress = value => {
    const aliases = { rd: "road", st: "street", ave: "avenue", av: "avenue", dr: "drive", cres: "crescent", cr: "crescent",
      pl: "place", ln: "lane", tce: "terrace", ct: "court", hwy: "highway", pde: "parade", cl: "close" };
    const normalized = String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}/]+/gu, " ").trim()
      .split(/\s+/).map(word => aliases[word] || word).join(" ");
    const match = /^(\d+[a-z]?(?:\/\d+[a-z]?)?) (.+?) (road|street|avenue|drive|crescent|place|lane|terrace|court|highway|parade|close|way|grove|rise|boulevard)\b/.exec(normalized);
    return match ? `${match[1]} ${match[2]} ${match[3]}` : "";
  };
  function strictDispatchProfiles(details, customers) {
    const email = value => String(value || "").trim().toLowerCase();
    const phone = value => String(value || "").replace(/\D/g, "").replace(/^00/, "");
    const address = normalizeDispatchAddress(details.address), remoteEmail = email(details.email), remotePhone = phone(details.phone);
    if (!address || (!remoteEmail && remotePhone.length < 7)) return [];
    return customers.filter(row => {
      if (normalizeDispatchAddress(row.address) !== address) return false;
      const localEmail = email(row.email), localPhone = phone(row.phone);
      const agrees = (remoteEmail && remoteEmail === localEmail) || (remotePhone.length >= 7 && remotePhone === localPhone);
      return agrees && !(remoteEmail && localEmail && remoteEmail !== localEmail) &&
        !(remotePhone.length >= 7 && localPhone.length >= 7 && remotePhone !== localPhone);
    });
  }
  async function ensureDispatchCustomer(businessId, c, job, details, local, current, legacy, profileMatch) {
    const get = id => unwrap(db.from("customers").select("*").eq("business_id", businessId).eq("id", id).maybeSingle());
    if (local?.customer_id) {
      if (!await get(local.customer_id)) throw fail("Linked ServiceM8 customer is missing from this business.", 409);
      return local.customer_id;
    }
    const ids = new Set(current.filter(row => row.connection_generation === c.generation && row.object_type === "company" && row.external_uuid === job.company_uuid).map(row => row.local_id));
    for (const row of legacy) if (row.local_type === "customer" && row.sm8_type === "company" && row.sm8_uuid === job.company_uuid) ids.add(row.local_id);
    if (ids.size > 1) throw fail("ServiceM8 company has conflicting customer links. Review the exact mappings.", 409);
    let customerId = [...ids][0];
    if (customerId) {
      if (!await get(customerId)) throw fail("ServiceM8 customer mapping points outside this business or to a missing profile.", 409);
      return customerId;
    }
    if (profileMatch) customerId = profileMatch.id;
    else customerId = SM.stableUuid("servicem8-inbound-customer", businessId, c.generation, SM.uuid(job.company_uuid) ? job.company_uuid : job.uuid);
    if (!profileMatch) await unwrap(db.from("customers").upsert({ id: customerId, business_id: businessId, name: details.personName,
      email: details.email || null, phone: details.phone || null, address: details.address || null, source: "servicem8" }, { onConflict: "id", ignoreDuplicates: true }));
    if (!await get(customerId)) throw fail("ServiceM8 customer identity conflicts with an existing record.", 409);
    if (SM.uuid(job.company_uuid)) await unwrap(db.from("external_object_mappings").upsert({ business_id: businessId,
      connection_generation: c.generation, object_type: "company", local_id: customerId, external_uuid: job.company_uuid,
      snapshot: { name: details.companyName }, synced_at: new Date().toISOString() },
      { onConflict: "business_id,connection_generation,object_type,local_id" }));
    return customerId;
  }
  async function clearResumedSummary(businessId, c, job) {
    const id = job.uuid;
    const clearCompleted = ["Work Order", "Quote", "Unsuccessful", "Cancelled", "Canceled"].includes(job.status);
    if (clearCompleted) {
      const removed = await unwrap(db.from("external_object_mappings").delete().eq("business_id", businessId)
        .eq("connection_generation", c.generation).eq("object_type", "completed_job").eq("external_uuid", id).select("external_uuid"));
      const summary = await unwrap(db.from("calendar_events").select("external_id").eq("business_id", businessId)
        .eq("source", "servicem8").eq("external_id", "completed:" + id).maybeSingle());
      if (removed?.length || summary) await unwrap(db.rpc("sync_servicem8_dispatch_event", {
        p_business_id: businessId, p_external_id: "completed:" + id, p_event: null,
      }));
    }
    return clearCompleted;
  }
  async function saveServiceM8Pricing(businessId, localId, pricing) {
    if (!SM.uuid(localId)) return;
    // Optimistic compare-and-swap keeps concurrent browser notes/quote edits.
    // Only the backend-owned display key is added; original services/total and
    // accepted quote/version rows are never rewritten by pricing sync.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await unwrap(db.from("jobs").select("id,details,updated_at").eq("business_id", businessId).eq("id", localId).maybeSingle());
      if (!row) return;
      let update = db.from("jobs").update({ details: { ...(row.details || {}), serviceM8Pricing: pricing } })
        .eq("business_id", businessId).eq("id", localId);
      if (row.updated_at) update = update.eq("updated_at", row.updated_at);
      const saved = await unwrap(update.select("id"));
      if (saved.length) return;
    }
    throw fail("Job changed while ServiceM8 prices were being saved. Background sync will retry.", 409);
  }
  async function persistDispatch(businessId, c, job, activities, timeZone, cache, checkpoint = async () => {}, refresh) {
    const completed = job.status === "Completed";
    if (!completed && (job.status !== "Work Order" || (job.active != null && Number(job.active) !== 1))) return new Set();
    const saved = new Set(), lookups = new Map();
    const memo = (key, read) => {
      if (!lookups.has(key)) lookups.set(key, read());
      return lookups.get(key);
    };
    const detailCall = (business, path, options) => memo(path, () => call(business, path, options));
    const detailList = (business, path, generation) => refresh && path.startsWith("/jobmaterial.json")
      ? Promise.resolve(refresh.materials) : memo(path, () => listRemote(business, path, generation));
    for (const activity of activities) {
      if (!SM.uuid(activity.uuid) || !["1", 1, true].includes(activity.activity_was_scheduled)) continue;
      if (!completed && activity.active != null && !["1", 1, true].includes(activity.active)) continue;
      const start = serviceM8WallClock(activity.start_date, timeZone), end = serviceM8WallClock(activity.end_date, timeZone);
      if (!start || !end || end <= start || end - start > 86400000) continue;
      await save(activity, start, end, activity.uuid, "jobactivity");
    }
    if (completed && !saved.size) {
      // Archive records without a booking still belong in Completed. Do not
      // invent a historical booking date; use a valid completion/edit instant.
      const parse = value => serviceM8WallClock(/^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value + " 00:00:00" : value, timeZone);
      const start = parse(job.completion_date) || parse(job.edit_date);
      const details = await serviceM8DispatchDetails({ call: detailCall, listRemote: detailList, businessId, job, activity: {}, generation: c.generation, cache, vendor: refresh?.vendor });
      await unwrap(db.from("external_object_mappings").upsert({ business_id: businessId, connection_generation: c.generation,
        object_type: "completed_job", local_id: "servicem8:" + job.uuid, external_uuid: job.uuid,
        snapshot: { ...details, source: "completed_summary", completedAt: start?.toISOString() || null }, synced_at: new Date().toISOString() },
        { onConflict: "business_id,connection_generation,object_type,local_id" }));
      if (start) await save({}, start, new Date(+start + 60000), "completed:" + job.uuid, "completed_summary", details);
    }
    return saved;
    async function save(activity, start, end, externalId, source, cachedDetails) {
      await checkpoint();
      const details = cachedDetails || await serviceM8DispatchDetails({ call: detailCall, listRemote: detailList, businessId, job, activity, generation: c.generation, cache, vendor: refresh?.vendor });
      details.source = source;
      const title = [details.personName, job.job_description || job.job_name].filter(Boolean).join(" · ");
      await unwrap(db.rpc("sync_servicem8_dispatch_event", { p_business_id: businessId, p_external_id: externalId,
        p_event: { title: title.slice(0, 200), start_time: start?.toISOString() || null, end_time: end?.toISOString() || null,
          notes: [details.address, `ServiceM8 job ${job.uuid}`].filter(Boolean).join("\n").slice(0, 2000), details } }));
      saved.add(externalId);
    }
  }
  async function refreshRemote(businessId, id, { allowUnmappedDispatch = false } = {}) {
    if (!SM.uuid(id)) throw fail("Invalid remote reference.");
    const c = await conn(businessId);
    if (!c) throw fail("ServiceM8 disconnected.");
    let map = await unwrap(
      db
        .from("external_object_mappings")
        .select("*")
        .eq("business_id", businessId)
        .eq("connection_generation", c.generation)
        .eq("object_type", "job")
        .eq("external_uuid", id)
        .maybeSingle(),
    );
    if (!map && !allowUnmappedDispatch) return;
    const job = serviceM8Record((await call(businessId, "/job/" + id + ".json", { generation: c.generation })).data) || {};
    job.uuid = job.uuid || id;
    const clearCompleted = await clearResumedSummary(businessId, c, job);
    let dispatchActivities = [], dispatchPermissionMissing = false, timeZone = "UTC";
    try {
      dispatchActivities = await listRemote(businessId, "/jobactivity.json?$filter=" + encodeURIComponent(
        "job_uuid eq '" + id + "' and activity_was_scheduled eq 1"), c.generation);
    } catch (error) {
      if (error.status !== 403) throw error;
      dispatchPermissionMissing = true;
    }
    const materials = await serviceM8OptionalList(listRemote, businessId, "jobmaterial", `job_uuid eq '${id}' and active eq 1`, c.generation);
    let vendor = null;
    if (!dispatchPermissionMissing || job.status === "Completed") {
      const needsDispatch = dispatchActivities.length || (job.status === "Completed" && (job.completion_date || job.edit_date));
      vendor = needsDispatch ? serviceM8Record((await call(businessId, "/vendor.json", { generation: c.generation })).data) : null;
      timeZone = vendor?.timezone_name || "UTC";
      const activeIds = await persistDispatch(businessId, c, job, dispatchActivities, timeZone, undefined, undefined, { materials, vendor });
      const existing = await unwrap(db.from("calendar_events").select("external_id,details").eq("business_id", businessId)
        .eq("source", "servicem8").filter("details->>jobUuid", "eq", id));
      for (const event of existing || []) {
        if (clearCompleted && event.external_id === "completed:" + id) continue;
        if (job.status === "Completed") {
          await unwrap(db.from("calendar_events").update({ details: { ...(event.details || {}), status: "Completed", pricing: serviceM8PricingSnapshot(job, materials, { currency: vendor?.currency }) } })
            .eq("business_id", businessId).eq("source", "servicem8").eq("external_id", event.external_id));
        } else if (event.details?.status !== "Completed" && !activeIds.has(event.external_id)) {
          await unwrap(db.rpc("sync_servicem8_dispatch_event", { p_business_id: businessId, p_external_id: event.external_id, p_event: null }));
        }
      }
    }
    if (!map && allowUnmappedDispatch && job.status === "Work Order" && !dispatchPermissionMissing) {
      const links = await reconcileJobs(businessId, c, [job], async () => {}, {
        byJob: new Map([[job.uuid, dispatchActivities]]), timeZone, allowReferences: false, syncStatuses: false,
      });
      map = links.get(job.uuid) || null;
    }
    if (!map) return;
    const pricing = serviceM8PricingSnapshot(job, materials, { currency: vendor?.currency });
    await saveServiceM8Pricing(businessId, map.local_id, pricing);
    let booking = null;
    let schedulePermissionMissing = dispatchPermissionMissing;
    try {
      if (dispatchPermissionMissing) throw { status: 403 };
      booking = serviceM8Booking(dispatchActivities, timeZone);
    } catch (e) {
      // Existing OAuth authorizations predate read_schedule. Keep job-status
      // sync working if a connection lacks permission or a schedule response
      // is temporarily unavailable. Booking data is optional to status sync.
      if (e.status === 403) {
        schedulePermissionMissing = true;
        // Do not erase a known booking or demote a scheduled TurnKey job
        // merely because this ServiceM8 authorization cannot read schedules.
        booking = map.snapshot?.booking || null;
      }
      else console.warn('[ServiceM8] schedule read failed', { businessId, error: safeError(e) });
    }
    let paymentTotal = null;
    try {
      const payments = await listRemote(
        businessId,
        "/jobpayment.json?$filter=" +
          encodeURIComponent("job_uuid eq '" + id + "' and active eq 1"),
        c.generation,
      );
      paymentTotal = payments.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    } catch (e) {
      if (e.status !== 403) throw e;
    }
    const snapshot = {
      ...(map.snapshot || {}),
      pricing,
      status: job.status,
      booking,
      schedulePermissionMissing,
      completed: job.status === "Completed",
      active: job.active == null ? null : Number(job.active) === 1,
      invoiceSent: Number(job.invoice_sent) === 1,
      paymentReceived: Number(job.payment_received) === 1,
      invoicedTotal:
        Number(job.invoice_sent) === 1 &&
        Number.isFinite(Number(job.total_invoice_amount))
          ? Number(job.total_invoice_amount)
          : null,
      collectedTotal: paymentTotal,
    };
    await unwrap(
      db
        .from("external_object_mappings")
        .update({ snapshot, synced_at: new Date().toISOString() })
        .eq("business_id", businessId)
        .eq("connection_generation", c.generation)
        .eq("object_type", "job")
        .eq("external_uuid", id),
    );
    await unwrap(db.rpc("sync_servicem8_job_state", {
      p_business_id: businessId,
      p_job_id: map.local_id,
      p_status: String(job.status || "Unknown"),
      p_booking: booking,
      p_schedule_permission_missing: schedulePermissionMissing || (job.status === "Completed" && !booking),
    }));
    await unwrap(
      db
        .from("servicem8_connections")
        .update({ last_sync_at: new Date().toISOString(), last_error: null })
        .eq("business_id", businessId)
        .eq("generation", c.generation),
    );
  }
  async function listRemote(businessId, path, generation, beforePage) {
    const separator = path.includes("?") ? "&" : "?";
    let list = [],
      next = path + separator + "cursor=-1";
    const seen = new Set();
    for (let page = 0; page < 1000; page++) {
      if (beforePage) await beforePage();
      const { data, nextCursor } = await call(businessId, next, { generation });
      if (!Array.isArray(data))
        throw fail("ServiceM8 returned an unexpected list.");
      list.push(...data);
      if (!nextCursor) return list;
      if (seen.has(nextCursor)) throw fail("ServiceM8 repeated a pagination cursor.");
      seen.add(nextCursor);
      next = path + separator + "cursor=" + encodeURIComponent(nextCursor);
    }
    throw fail("ServiceM8 pagination exceeded the safe processing limit.");
  }
  const reconciliationIntervalMs = 15 * 60000;
  let scheduling = false;
  async function scheduleReconciliation() {
    if (scheduling) return;
    scheduling = true;
    try {
      for (let offset = 0; ; offset += 1000) {
        const connections = await unwrap(db.from("servicem8_connections").select("*").order("business_id").range(offset, offset + 999));
        for (const c of connections) {
          if (!connectionHealth(c).credentialsReady) continue;
          const key = "dispatch-reconcile-v3:" + c.generation;
          const previous = await unwrap(db.from("integration_tasks").select("id,state,attempts,next_attempt_at")
            .eq("business_id", c.business_id).eq("kind", "dispatch_seed").eq("dedupe_key", key).maybeSingle());
          if (!previous) {
            const { error } = await db.from("integration_tasks").insert({ business_id: c.business_id, kind: "dispatch_seed", dedupe_key: key,
              payload: { generation: c.generation, recurring: true }, next_attempt_at:
                new Date(Math.max(Date.now(), (Date.parse(c.last_sync_at) || 0) + reconciliationIntervalMs)).toISOString() });
            if (error && error.code !== "23505") throw error;
          }
          else if (previous.state === "succeeded" || (previous.state === "failed" && previous.attempts >= 12 &&
              (!previous.next_attempt_at || Date.parse(previous.next_attempt_at) <= Date.now()))) {
            await unwrap(db.from("integration_tasks").update({ state: "pending", attempts: 0, lease_until: null,
              lease_token: null, next_attempt_at: new Date().toISOString() }).eq("id", previous.id)
              .eq("state", previous.state).eq("attempts", previous.attempts));
          }
        }
        if (connections.length < 1000) break;
      }
    } catch (error) {
      if (!["42P01", "PGRST202", "PGRST205"].includes(error.code)) console.error("[ServiceM8 reconciliation]", error.code || error.name);
    } finally { scheduling = false; }
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (let i = 0; i < 5; i++) {
        const tasks = await unwrap(db.rpc("claim_integration_task"));
        const task = tasks?.[0];
        if (!task) break;
        try {
          if (task.kind === "dispatch_seed") await seedDispatch(task);
          else if (task.kind === "handoff") await transfer(task);
          else if (task.kind === "refresh_job")
            await refreshRemote(task.business_id, task.payload.uuid);
          else if (task.kind === "reminder") {
            if (sendNotification)
              await sendNotification(db, {
                business_id: task.business_id,
                type: "general",
                title: "Sales follow-up due",
                message: task.payload.message,
                url: "/index.html?open=dashboard",
              });
          } else if (task.kind === "webhook") {
            let id = task.payload.uuid;
            if (task.payload.object === "jobmaterial") {
              try {
                const material = serviceM8Record((await call(task.business_id, "/jobmaterial/" + id + ".json")).data);
                id = material?.job_uuid;
              } catch (error) {
                if (error.status !== 404) throw error;
                // A deleted material has no parent in the payload. The durable
                // 15-minute full snapshot removes it from all pricing displays.
                id = null;
              }
            } else if (task.payload.object === "jobpayment") {
              const pay = (
                await call(task.business_id, "/jobpayment/" + id + ".json")
              ).data;
              id = pay.job_uuid;
            } else if (task.payload.object === "jobactivity") {
              let activity;
              try {
                activity = (await call(task.business_id, "/jobactivity/" + id + ".json")).data;
              } catch (error) {
                if (error.status !== 404) throw error;
                const c = await conn(task.business_id);
                if (!c) throw error;
                const previous = await unwrap(db.from("calendar_events").select("details")
                  .eq("business_id", task.business_id).eq("source", "servicem8")
                  .eq("external_id", id).maybeSingle());
                const linkedJobUuid = previous?.details?.jobUuid;
                // Completed dispatch history survives deleted remote activities.
                if (!SM.uuid(linkedJobUuid) && previous?.details?.status !== "Completed") await unwrap(db.rpc("sync_servicem8_dispatch_event", {
                  p_business_id: task.business_id, p_external_id: id, p_event: null,
                }));
                id = SM.uuid(linkedJobUuid) ? linkedJobUuid : null;
              }
              if (activity) {
                const c = await conn(task.business_id);
                if (!c) throw fail("ServiceM8 disconnected.");
                id = activity.job_uuid || null;
              }
            }
            if (id) await refreshRemote(task.business_id, id, { allowUnmappedDispatch: ["job", "jobactivity", "jobpayment", "jobmaterial"].includes(task.payload.object) });
          } else throw fail("Unknown integration task.");
          await unwrap(
            db
              .from("integration_tasks")
              .update({
                state: task.kind === "dispatch_seed" && task.payload.recurring ? "pending" : "succeeded",
                ...(task.kind === "dispatch_seed" && task.payload.recurring ? { attempts: 0,
                  next_attempt_at: new Date(Date.now() + reconciliationIntervalMs).toISOString() } : {}),
                completed_at: new Date().toISOString(),
                last_error: null,
                lease_until: null,
              })
              .eq("id", task.id)
              .eq("lease_token", task.lease_token)
              .eq("state", "running"),
          );
        } catch (e) {
          const message = safeError(e);
          const failed = await unwrap(
            db
              .from("integration_tasks")
              .update({
                state: "failed",
                last_error: message,
                next_attempt_at: new Date(
                  Date.now() +
                    Math.min(3600000, 30000 * 2 ** Math.min(task.attempts, 8)),
                ).toISOString(),
                lease_until: null,
              })
              .eq("id", task.id)
              .eq("lease_token", task.lease_token)
              .eq("state", "running")
              .select("id"),
          );
          if (!failed.length) continue;
          if (task.kind !== "reminder") await unwrap(
            db
              .from("servicem8_connections")
              .update({ last_error: message })
              .eq("business_id", task.business_id),
          );
          if (task.kind !== "reminder" && task.attempts === 1 && sendNotification)
            await sendNotification(db, {
              business_id: task.business_id,
              type: "general",
              title: "ServiceM8 transfer needs attention",
              message,
              url: "/index.html?open=dashboard",
            });
        }
      }
    } catch (e) {
      if (e.code !== "PGRST202" && e.code !== "42P01")
        console.error("[ServiceM8 worker]", e.code || e.name);
    } finally {
      running = false;
    }
  }
  let reminderRunning = false;
  async function reminders() {
    if (reminderRunning) return;
    reminderRunning = true;
    try {
      const jobs = await unwrap(
        db
          .from("jobs")
          .select("id,business_id,status,details")
          .not("details->>nextFollowUpAt", "is", null)
          .lt("details->>nextFollowUpAt", new Date().toISOString())
          .order("id")
          .limit(1000),
      );
      for (const j of jobs) {
        if (
          ["won", "scheduled", "completed", "paid", "cancelled"].includes(
            j.status,
          )
        )
          continue;
        await enqueue(
          j.business_id,
          "reminder",
          j.id + ":" + j.details.nextFollowUpAt,
          {
            message:
              "An opportunity has an overdue sales follow-up. Open Leads to review it.",
            jobId: j.id,
          },
        );
      }
    } catch (e) {
      if (e.code !== "42P01")
        console.error("[Sales reminders]", e.code || e.name);
    } finally {
      reminderRunning = false;
    }
  }
  // Bootstrap and maintain a durable recurring task, independently of browsers
  // and subscription delivery. Fixed keys dedupe across backend instances.
  const reconciliationStartup = setTimeout(scheduleReconciliation, 0);
  reconciliationStartup.unref();
  const reconciliationTimer = setInterval(scheduleReconciliation, 60000);
  reconciliationTimer.unref();
  const timer = setInterval(tick, 15000);
  timer.unref();
  const reminderTimer = setInterval(reminders, 60000);
  reminderTimer.unref();
  app.get(
    "/api/sales/metrics",
    requireBusiness,
    wrap(async (req, res) => {
      const start = Number(req.query.start),
        end = Number(req.query.end);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        end - start > 3660 * 86400000
      )
        throw fail("Choose a reporting range shorter than ten years.");
      const [jobs, customers, quotes, spend] = await Promise.all([
        allRows(db, "jobs", req.businessId),
        allRows(db, "customers", req.businessId),
        allRows(db, "quotes", req.businessId),
        allRows(db, "sales_spend", req.businessId),
      ]);
      const cs = new Map(customers.map((c) => [c.id, c])),
        qs = new Map(quotes.map((q) => [q.id, q]));
      const records = jobs.map((j) => {
        const c = cs.get(j.customer_id) || {},
          q = qs.get(j.quote_id);
        return {
          ...j.details,
          jobId: j.id,
          stage: j.status,
          name: c.name,
          source: c.source,
          total: q?.amount ?? j.details?.total ?? 0,
          createdAt: j.details?.createdAt || j.created_at,
        };
      });
      const settings = await unwrap(
        db
          .from("sales_settings")
          .select("probabilities")
          .eq("business_id", req.businessId)
          .maybeSingle(),
      );
      const report = METRICS.comparison(records, {
        range: { start, end },
        bucket: ["day", "week", "month"].includes(req.query.bucket)
          ? req.query.bucket
          : "day",
        spend,
        probabilities: settings?.probabilities || {},
      });
      const c = await conn(req.businessId);
      if (c) {
        const maps = await unwrap(
          db
            .from("external_object_mappings")
            .select("local_id,snapshot")
            .eq("business_id", req.businessId)
            .eq("connection_generation", c.generation)
            .eq("object_type", "job"),
        );
        const wins = records.filter(
          (r) =>
            METRICS.won(r) &&
            METRICS.winTime(r) >= start &&
            METRICS.winTime(r) < end,
        );
        const linked = wins
          .map((r) => maps.find((m) => m.local_id === r.jobId)?.snapshot)
          .filter(Boolean);
        report.invoicedRevenue =
          linked.length === wins.length &&
          linked.length > 0 &&
          linked.every((x) => x.invoicedTotal != null)
            ? linked.reduce((s, x) => s + x.invoicedTotal, 0)
            : null;
        report.collectedRevenue =
          linked.length === wins.length &&
          linked.length > 0 &&
          linked.every((x) => x.collectedTotal != null)
            ? linked.reduce((s, x) => s + x.collectedTotal, 0)
            : null;
        report.financialCoverage =
          linked.length +
          " of " +
          wins.length +
          " sales have linked ServiceM8 snapshots";
      }
      res.json(report);
    }),
  );
  // Mounted before the legacy router: connection writes must use the tenant-safe adapter.
  app.use("/api/servicem8", (req, res) =>
    res
      .status(410)
      .json({ error: "Use the sales Connections integration endpoints." }),
  );
  return {
    tick,
    scheduleReconciliation,
    stop: () => {
      clearTimeout(reconciliationStartup);
      clearInterval(reconciliationTimer);
      clearInterval(timer);
      clearInterval(reminderTimer);
    },
    transfer,
    refreshRemote,
  };
}
