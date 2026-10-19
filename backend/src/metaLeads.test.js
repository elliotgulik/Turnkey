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

test("Meta retains every selected service and custom answer in notes without object coercion", async () => {
  let saved;
  await ingestMetaWebhook({
    ...signed(payloadFor("lead-answers")), appSecret: SECRET,
    lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async id => ({ ...lead(id), field_data: [...lead(id).field_data,
      { name: "Requested services", values: [" House wash ", "Driveway wash", {}, ["Roof wash"], null, true, ""] },
      { name: "best_time_to_call", values: ["Morning", "Afternoon"] },
      { name: "number_of_storeys", values: [2] },
      { name: "job_details", values: ["Details ".repeat(100)] },
      { name: "malformed", values: "ignored" },
      { name: "structured", values: [{ value: "ignored" }] },
    ] }),
    addLead: async payload => { saved = payload; return { id: "saved" }; },
  });
  assert.deepEqual(saved.requestedServices, ["House wash", "Driveway wash"]);
  assert.equal(saved.customer.notes, "requested services: House wash, Driveway wash\nbest_time_to_call: Morning, Afternoon\nnumber_of_storeys: 2\njob_details: " + "Details ".repeat(100).trim());
  assert.equal(saved.customer.email, "jane@example.com");
});

test("Meta service aliases preserve array answers", async () => {
  for (const name of ["requestedServices", "requested_services", "requested_service", "services", "service", "Services required"]) {
    await ingestMetaWebhook({
      ...signed(payloadFor("lead-services")), appSecret: SECRET,
      lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
      fetchLead: async id => ({ id, field_data: [{ name, values: ["House wash", "Roof wash"] }] }),
      addLead: async payload => {
        assert.deepEqual(payload.requestedServices, ["House wash", "Roof wash"]);
        assert.equal(payload.customer.notes, `${name.toLowerCase()}: House wash, Roof wash`);
        return { id: "saved" };
      },
    });
  }
});

test("Meta bounds custom fields, selected services and notes while retaining validator checks", async () => {
  let saved;
  await ingestMetaWebhook({
    ...signed(payloadFor("lead-bounded")), appSecret: SECRET,
    lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
    fetchLead: async id => ({ id, field_data: [
      { name: "services", values: Array(110).fill("x".repeat(600)) },
      ...Array(99).fill({ name: "custom", values: ["Answer"] }),
      { name: "email", values: ["beyond-field-limit"] },
    ] }),
    addLead: async payload => { saved = payload; return { id: "saved" }; },
  });
  assert.equal(saved.requestedServices.length, 100);
  assert.ok(saved.requestedServices.every(value => value.length === 500));
  assert.equal(saved.customer.notes.length, 4000);
  assert.equal(saved.customer.email, undefined);

  for (const field of [{ name: "full_name", values: ["x".repeat(201)] }, { name: "phone", values: ["1".repeat(41)] }]) {
    await assert.rejects(() => ingestMetaWebhook({
      ...signed(payloadFor("lead-invalid")), appSecret: SECRET,
      lookupPage: async () => ({ business_id: "business-a", pageToken: "token" }),
      fetchLead: async id => ({ id, field_data: [field, { name: "services", values: ["House wash", "Roof wash"] }] }),
      addLead: async () => assert.fail("invalid contact persisted"),
    }), error => error.status === 503 && /validation/.test(error.message));
  }
});

test("signed Meta entry.id supplies a missing page_id using only that page's tenant mapping", async () => {
  for (const pageId of ["page-a", 123]) {
    const body = { object: "page", business_id: "spoofed", entry: [{ id: pageId,
      changes: [{ field: "leadgen", value: { leadgen_id: "lead-entry", business_id: "spoofed" } }],
    }] };
    const result = await ingestMetaWebhook({
      ...signed(body), appSecret: SECRET,
      lookupPage: async id => { assert.equal(id, String(pageId)); return { business_id: `owner-${id}`, pageToken: "token" }; },
      fetchLead: async id => lead(id),
      addLead: async payload => {
        assert.equal(payload.business_id, `owner-${pageId}`);
        assert.equal(payload.external_id, "lead-entry");
        return { id: "saved", deduped: true };
      },
    });
    assert.deepEqual(result, { received: true, accepted: 0, duplicates: 1 });
  }
});

test("contradictory or invalid Meta page identities fail before any lookup, fetch or save", async () => {
  for (const [entryId, pageId] of [
    ["page-a", "page-b"], ["page-a", ""], ["page-a", {}], [{}, "page-a"],
    ["x".repeat(201), undefined], [undefined, undefined],
  ]) {
    const body = payloadFor("lead-1");
    body.entry[0].id = entryId;
    body.entry[0].changes[0].value.page_id = pageId;
    await assert.rejects(() => ingestMetaWebhook({
      ...signed(body), appSecret: SECRET,
      lookupPage: async () => assert.fail("invalid page looked up"),
      fetchLead: async () => assert.fail("invalid page fetched"),
      addLead: async () => assert.fail("invalid page persisted"),
    }), error => error.status === 400);
  }
});

test("matching entry and event page IDs accept numeric IDs normalized to strings", async () => {
  const body = payloadFor("lead-1");
  body.entry[0].id = 123;
  body.entry[0].changes[0].value.page_id = "123";
  await ingestMetaWebhook({
    ...signed(body), appSecret: SECRET,
    lookupPage: async id => { assert.equal(id, "123"); return { business_id: "business-a", pageToken: "token" }; },
    fetchLead: async id => lead(id), addLead: async () => ({ id: "saved" }),
  });
});
