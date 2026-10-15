import test from "node:test";
import assert from "node:assert/strict";
process.env.EMAIL_TOKEN_KEY ||= "sales-integration-test-only-key";
const { installSalesPlatform } = await import("./salesPlatform.js");
const { encryptToken } = await import("./crypto.js");
const SM = await import("./salesTransfer.js");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function database(tables = {}) {
  const db = {
    tables,
    fail: null,
    from(table) {
      tables[table] ||= [];
      let op = "select",
        value,
        options = {},
        filters = [],
        one = false;
      const q = {
        select() {
          return q;
        },
        eq(k, v) {
          filters.push((r) => r[k] === v);
          return q;
        },
        neq(k, v) {
          filters.push((r) => r[k] !== v);
          return q;
        },
        gt(k, v) {
          filters.push((r) => r[k] > v);
          return q;
        },
        or() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        maybeSingle() {
          one = true;
          return q;
        },
        single() {
          one = true;
          return q;
        },
        insert(v) {
          op = "insert";
          value = v;
          return q;
        },
        upsert(v, o = {}) {
          op = "upsert";
          value = v;
          options = o;
          return q;
        },
        update(v) {
          op = "update";
          value = v;
          return q;
        },
        delete() {
          op = "delete";
          return q;
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              if (db.fail?.(table, op, value))
                return {
                  error: { code: "TEST_DB", message: "secret database detail" },
                };
              let rows = tables[table].filter((r) =>
                filters.every((f) => f(r)),
              );
              if (op === "insert" || op === "upsert") {
                const keys = (options.onConflict || "id").split(",");
                const old =
                  op === "upsert"
                    ? tables[table].find((r) =>
                        keys.every((k) => r[k] === value[k]),
                      )
                    : table === "integration_tasks"
                      ? tables[table].find((r) =>
                          ["business_id", "kind", "dedupe_key"].every(
                            (k) => r[k] === value[k],
                          ),
                        )
                      : null;
                if (old && op === "insert") return { error: { code: "23505" } };
                if (old) {
                  if (!options.ignoreDuplicates) Object.assign(old, value);
                  rows = [old];
                } else {
                  const row = { ...value };
                  tables[table].push(row);
                  rows = [row];
                }
              }
              if (op === "update") rows.forEach((r) => Object.assign(r, value));
              if (op === "delete")
                tables[table] = tables[table].filter((r) => !rows.includes(r));
              return { data: one ? rows[0] || null : rows, error: null };
            })
            .then(resolve, reject);
        },
      };
      return q;
    },
    rpc: async () => ({ data: [] }),
  };
  return db;
}
function setup(
  db,
  fetchImpl = async () => {
    throw Error("Unexpected network");
  },
  options = {},
) {
  const routes = new Map();
  const app = {
    get: (p, ...h) => routes.set("GET " + p, h),
    post: (p, ...h) => routes.set("POST " + p, h),
    use: (p, ...h) => routes.set("USE " + p, h),
  };
  const worker = installSalesPlatform(app, {
    db,
    fetchImpl,
    requireBusiness: (req, res, next) => next(),
    env: {
      PUBLIC_BACKEND_URL: "https://backend.example",
      FRONTEND_URL: "https://frontend.example",
    },
    ...options,
  });
  worker.stop();
  return {
    worker,
    async route(method, path, req = {}) {
      req = { body: {}, query: {}, params: {}, get: () => "", ...req };
      const res = {
        statusCode: 200,
        status(n) {
          this.statusCode = n;
          return this;
        },
        json(v) {
          this.body = v;
          return this;
        },
        set() {
          return this;
        },
        clearCookie() {
          this.cleared = true;
          return this;
        },
      };
      const handlers = routes.get(method + " " + path);
      let n = 0;
      const next = async () => {
        const h = handlers[n++];
        if (h) await h(req, res, next);
      }; // Admin calls next synchronously; allow its downstream promise to settle.
      await next();
      await new Promise((r) => setImmediate(r));
      return res;
    },
  };
}
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
test("webhooks persist before acknowledgement, dedupe retries, and isolate tenants", async () => {
  const token = "a".repeat(64);
  const db = database({
    servicem8_connections: [
      { business_id: "A", webhook_token_hash: SM.hash(token) },
    ],
  });
  const { route } = setup(db);
  const req = {
    params: { token },
    body: {
      object: "job",
      entry: [{ uuid: id(9), time: "2026-10-15", changed_fields: ["status"] }],
    },
  };
  db.fail = (t, op) => t === "integration_tasks" && op === "insert";
  assert.equal(
    (await route("POST", "/api/servicem8/webhook/:token", req)).statusCode,
    503,
  );
  assert.equal(db.tables.integration_tasks.length, 0);
  db.fail = null;
  assert.equal(
    (await route("POST", "/api/servicem8/webhook/:token", req)).statusCode,
    200,
  );
  await route("POST", "/api/servicem8/webhook/:token", req);
  assert.equal(db.tables.integration_tasks.length, 1);
  assert.equal(db.tables.integration_tasks[0].business_id, "A");
  assert.equal(
    (
      await route("POST", "/api/servicem8/webhook/:token", {
        ...req,
        params: { token: "b".repeat(64) },
      })
    ).statusCode,
    404,
  );
});
test("foreign jobs and changed tenant roles cannot enqueue a handoff", async () => {
  const db = database({
    users: [{ id: "u", business_id: "A", role: "owner" }],
    jobs: [{ id: id(1), business_id: "B", status: "won" }],
  });
  const { route } = setup(db);
  assert.equal(
    (
      await route("POST", "/api/sales/servicem8/handoff", {
        userId: "u",
        businessId: "A",
        body: { jobId: id(1) },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await route("POST", "/api/sales/servicem8/handoff", {
        userId: "u",
        businessId: "B",
        body: { jobId: id(1) },
      })
    ).statusCode,
    403,
  );
  assert.equal(db.tables.integration_tasks, undefined);
});
test("rejected OAuth states clear browser cookie and never exchange credentials", async () => {
  const { route } = setup(database());
  const res = await route("GET", "/api/sales/servicem8/oauth/callback/:state", {
    params: { state: "a".repeat(64) },
    query: { state: "b".repeat(64) },
    get: () => `sm8_oauth=${"c".repeat(64)}`,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.cleared, true);
});
test("private reconnect upserts by business and status exposes no ciphertext", async () => {
  const db = database({
    users: [{ id: "u", business_id: "A", role: "owner" }],
  });
  const { route } = setup(db, async (url) =>
    url.endsWith("/vendor.json")
      ? response({ uuid: id(8), name: "Company" })
      : response({}),
  );
  const req = {
    userId: "u",
    businessId: "A",
    body: { apiKey: "test-private-key-123456" },
  };
  await route("POST", "/api/sales/servicem8/private", req);
  await route("POST", "/api/sales/servicem8/private", req);
  assert.equal(db.tables.servicem8_connections.length, 1);
  assert.equal(db.tables.servicem8_connections[0].auth_mode, "api_key");
  assert.notEqual(
    db.tables.servicem8_connections[0].api_key_enc,
    req.body.apiKey,
  );
  const res = await route("GET", "/api/sales/servicem8/status", req);
  assert.equal(res.body.connected, true);
  assert.doesNotMatch(
    JSON.stringify(res.body),
    /api_key_enc|test-private-key|webhook_enc/,
  );
});
test("financial readback cannot fetch another tenants mapping", async () => {
  let calls = 0;
  const db = database({
    servicem8_connections: [{ business_id: "A", generation: id(2) }],
    external_object_mappings: [
      {
        business_id: "B",
        connection_generation: id(2),
        object_type: "job",
        external_uuid: id(3),
      },
    ],
  });
  const { worker } = setup(db, async () => {
    calls++;
    return response({});
  });
  await worker.refreshRemote("A", id(3));
  assert.equal(calls, 0);
});
test("payment filters use corrected endpoint and approved rounding never yields negative lines", async () => {
  let url;
  await SM.request(
    "/jobpayment.json?$filter=" +
      encodeURIComponent("job_uuid eq '" + id(1) + "' and active eq 1"),
    {
      credentials: { apiKey: "test" },
      fetchImpl: async (u) => {
        url = u;
        return response([]);
      },
    },
  );
  assert.match(url, /jobpayment.json\?\$filter=/);
  const lines = SM.approvedLines({
    amount: 0.02,
    details: {
      gstRegistered: false,
      services: Array.from({ length: 4 }, () => ({ priceSnapshot: 1 })),
    },
  });
  assert.equal(
    lines.reduce((s, l) => s + Math.round(Number(l.displayed_amount) * 100), 0),
    2,
  );
  assert.ok(lines.every((l) => Number(l.displayed_amount) >= 0));
});
test("complete transfer resumes after attachment DB failure without duplicate remote objects", async () => {
  const generation = id(10),
    jobId = id(11),
    quoteId = id(12),
    customerId = id(13);
  const db = database({
    servicem8_connections: [
      {
        business_id: "A",
        generation,
        auth_mode: "api_key",
        api_key_enc: encryptToken("test-key"),
      },
    ],
    jobs: [
      {
        id: jobId,
        business_id: "A",
        status: "won",
        quote_id: quoteId,
        customer_id: customerId,
      },
    ],
    quotes: [{ id: quoteId, business_id: "A", status: "accepted" }],
    quote_versions: [
      {
        business_id: "A",
        quote_id: quoteId,
        snapshot: {
          amount: 115,
          details: {
            gstRegistered: true,
            services: [{ svc: "Wash", qty: 1, priceSnapshot: 115 }],
          },
        },
      },
    ],
    customers: [
      {
        id: customerId,
        business_id: "A",
        name: "Test Customer",
        address: "Test property",
      },
    ],
    businesses: [{ id: "A", name: "Test business" }],
  });
  const objects = new Map(),
    created = [];
  let failOnce = true;
  db.fail = (table, op) => {
    if (
      table === "external_object_mappings" &&
      op === "update" &&
      objects.has(
        "/attachment/" +
          SM.stableUuid("turnkey", generation, "attachment", quoteId) +
          ".json",
      ) &&
      failOnce
    ) {
      failOnce = false;
      return true;
    }
    return false;
  };
  const { worker } = setup(db, async (url, opts) => {
    const path = url.slice(SM.API.length);
    if (path === "/taxrate.json")
      return response([{ uuid: id(14), active: 1, amount: 15 }]);
    if (path.startsWith("/jobpayment.json?")) return response([]);
    if (opts.method === "POST") {
      const body =
        opts.body instanceof FormData
          ? { uuid: opts.body.get("uuid"), active: 1 }
          : JSON.parse(opts.body);
      const key = path.replace(".json", "/" + body.uuid + ".json");
      assert.equal(
        objects.has(key),
        false,
        "remote object must only be created once",
      );
      objects.set(key, { ...body, active: 1 });
      created.push(path);
      return response({});
    }
    return objects.has(path) ? response(objects.get(path)) : response({}, 404);
  });
  const task = { business_id: "A", payload: { jobId } };
  await assert.rejects(worker.transfer(task));
  await worker.transfer(task);
  await worker.transfer(task);
  assert.deepEqual(created.sort(), [
    "/attachment.json",
    "/company.json",
    "/companycontact.json",
    "/job.json",
    "/jobmaterial.json",
  ]);
  assert.equal(
    db.tables.external_object_mappings.filter((r) => r.synced_at).length,
    5,
  );
});
test("legacy integration routes are blocked before unsafe handlers", async () => {
  const { route } = setup(database());
  assert.equal((await route("USE", "/api/servicem8")).statusCode, 410);
});
test("missing OAuth expiry refreshes and persists rotated tokens before financial reads", async () => {
  const db = database({
    servicem8_connections: [
      {
        business_id: "A",
        generation: id(2),
        auth_mode: "oauth",
        token_expiry: null,
        access_token_enc: encryptToken("old-access"),
        refresh_token_enc: encryptToken("old-refresh"),
      },
    ],
    external_object_mappings: [
      {
        business_id: "A",
        connection_generation: id(2),
        object_type: "job",
        external_uuid: id(3),
      },
    ],
  });
  let refreshes = 0;
  const { worker } = setup(
    db,
    async (url, options) => {
      assert.equal(options.headers.Authorization, "Bearer new-access");
      return response(
        url.includes("/jobpayment.json")
          ? []
          : { status: "Completed", invoice_sent: 1, total_invoice_amount: 115 },
      );
    },
    {
      oauthProvider: {
        async refreshAccessToken(token) {
          assert.equal(token, "old-refresh");
          refreshes++;
          return {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          };
        },
      },
    },
  );
  await worker.refreshRemote("A", id(3));
  assert.equal(refreshes, 1);
  assert.ok(
    Date.parse(db.tables.servicem8_connections[0].token_expiry) > Date.now(),
  );
  assert.equal(
    db.tables.external_object_mappings[0].snapshot.invoicedTotal,
    115,
  );
});
