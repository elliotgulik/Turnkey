import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ingestMetaWebhook } from "./metaLeads.js";

const SECRET = "meta-test-secret";
const payloadFor = (...ids) => ({
  object: "page",
  entry: [{ changes: ids.map(id => ({ field: "leadgen", value: { page_id: "page-a", leadgen_id: id } })) }],
});
const signed = body => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
  return { body, rawBody, signature };
};
const lead = id => ({ id, field_data: [
  { name: "first_name", values: ["Jane"] },
  { name: "last_name", values: ["Doe"] },
  { name: "email", values: ["jane@example.com"] },
  { name: "phone_number", values: ["0211234567"] },
] });

test("valid signed Meta lead is stored with page-mapped tenant and normalized fields", async () => {
  let saved, notified;
  const result = await ingestMetaWebhook({
    ...signed(payloadFor("lead-1")), appSecret: SECRET,
    lookupPage: async id => { assert.equal(id, "page-a"); return { business_id: "business-a", pageToken: "private-token" }; },
    fetchLead: async (id, token) => { assert.equal(id, "lead-1"); assert.equal(token, "private-token"); return lead(id); },
    addLead: async p => { saved = p; return { id: "saved-1" }; },
    onNewLead: async value => { notified = value; }, now: () => 123,
  });
  assert.deepEqual(result, { received: true, accepted: 1, duplicates: 0 });
  assert.equal(saved.business_id, "business-a");
  assert.equal(saved.source, "meta");
  assert.equal(saved.external_id, "lead-1");
  assert.deepEqual(saved.customer, { name: "Jane Doe", email: "jane@example.com", phone: "0211234567", address: undefined, source: "Meta" });
  assert.equal(saved.submittedAt, 123);
  assert.deepEqual(notified, { businessId: "business-a", name: "Jane Doe" });
});

test("invalid signature is rejected before page lookup or persistence", async () => {
  let called = false;
  const input = signed(payloadFor("lead-1"));
  await assert.rejects(() => ingestMetaWebhook({
    ...input, signature: "sha256=" + "0".repeat(64), appSecret: SECRET,
    lookupPage: async () => { called = true; }, fetchLead: async () => {}, addLead: async () => {},
  }), error => error.status === 401);
  assert.equal(called, false);
});

test("unconnected page fails delivery so Meta can retry after the connection is repaired", async () => {
  await assert.rejects(() => ingestMetaWebhook({
    ...signed(payloadFor("lead-1")), appSecret: SECRET,
    lookupPage: async () => null, fetchLead: async () => {}, addLead: async () => {},
  }), error => error.status === 503);
});

test("Graph API failure rejects the webhook instead of silently acknowledging a lost lead", async () => {
  await assert.rejects(() => ingestMetaWebhook({
    ...signed(payloadFor("lead-1")), appSecret: SECRET,
    lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async () => { throw new Error("timeout"); }, addLead: async () => {},
  }), error => error.status === 503);
});

test("lead storage failure returns retryable failure and never reports accepted", async () => {
  await assert.rejects(() => ingestMetaWebhook({
    ...signed(payloadFor("lead-1")), appSecret: SECRET,
    lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async id => lead(id), addLead: async () => { throw new Error("database unavailable"); },
  }), error => error.status === 503);
});

test("partial batch retry is idempotent and notifies only for newly saved leads", async () => {
  const saved = new Set();
  const notifications = [];
  let failSecond = true;
  const run = () => ingestMetaWebhook({
    ...signed(payloadFor("lead-1", "lead-2")), appSecret: SECRET,
    lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async id => lead(id),
    addLead: async p => {
      if (p.external_id === "lead-2" && failSecond) { failSecond = false; throw new Error("temporary insert failure"); }
      if (saved.has(p.external_id)) return { id: "stored-" + p.external_id, deduped: true };
      saved.add(p.external_id); return { id: "stored-" + p.external_id };
    },
    onNewLead: value => notifications.push(value.name),
  });
  await assert.rejects(run, error => error.status === 503);
  assert.deepEqual([...saved], ["lead-1"]);
  const retry = await run();
  assert.deepEqual(retry, { received: true, accepted: 1, duplicates: 1 });
  assert.deepEqual([...saved], ["lead-1", "lead-2"]);
  assert.equal(notifications.length, 2);
});

test("malformed events and mismatched Graph objects are not persisted", async () => {
  let inserts = 0;
  const deps = {
    appSecret: SECRET, lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async id => lead("different-id"), addLead: async () => { inserts++; return { id: "x" }; },
  };
  await assert.rejects(() => ingestMetaWebhook({ ...signed({ object: "page", entry: [{ changes: [{ field: "leadgen", value: { page_id: "page-a" } }] }] }), ...deps }), error => error.status === 400);
  await assert.rejects(() => ingestMetaWebhook({ ...signed(payloadFor("lead-1")), ...deps }), error => error.status === 503);
  assert.equal(inserts, 0);
});

test("storage must return a durable lead id before Meta is acknowledged", async () => {
  await assert.rejects(() => ingestMetaWebhook({
    ...signed(payloadFor("lead-1")), appSecret: SECRET,
    lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async id => lead(id), addLead: async () => ({ deduped: true }),
  }), error => error.status === 503);
});

test("invalid Meta contact fields are rejected before storage", async () => {
  let inserted = false;
  await assert.rejects(() => ingestMetaWebhook({
    ...signed(payloadFor("lead-1")), appSecret: SECRET,
    lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async id => ({ id, field_data: [
      { name: "full_name", values: ["Jane Doe"] },
      { name: "email", values: ["not-an-email"] },
    ] }),
    addLead: async () => { inserted = true; return { id: "saved" }; },
  }), error => error.status === 503);
  assert.equal(inserted, false);
});
