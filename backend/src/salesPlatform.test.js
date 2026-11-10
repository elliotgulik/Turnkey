import test from "node:test";
import assert from "node:assert/strict";
process.env.EMAIL_TOKEN_KEY ||= "sales-integration-test-only-key";
const { installSalesPlatform, serviceM8PricingSnapshot } = await import("./salesPlatform.js");
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
        one = false, orders = [], maxRows = Infinity, bounds;
      const q = {
        select() {
          return q;
        },
        eq(k, v) {
          filters.push((r) => k === "payload->>automaticCustomerFollowup" ? String(r.payload?.automaticCustomerFollowup) === v
            : k === "pricing_config" && typeof v === "string" ? JSON.stringify(r[k]) === v
            : k === "snapshot->>accepted" ? String(r.snapshot?.accepted) === v
            : k === "lease_until" && r[k] && v ? Date.parse(r[k]) === Date.parse(v) : r[k] === v);
          return q;
        },
        is(k, v) { filters.push(r => v === null ? r[k] == null : r[k] === v); return q; },
        filter(k, operator, v) {
          assert.equal(operator, "eq");
          filters.push(r => k === "details->>jobUuid" ? r.details?.jobUuid === v : r[k] === v);
          return q;
        },
        in(k, values) {
          filters.push(r => values.includes(r[k]));
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
        order(k, options = {}) { orders.push([k, options.ascending !== false]); return q; },
        limit(n) { maxRows = n; return q; },
        range(start, end) { bounds = [start, end]; return q; },
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
              if (op === "select") {
                rows = [...rows].sort((a, b) => {
                  for (const [key, asc] of orders) {
                    const cmp = String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
                    if (cmp) return asc ? cmp : -cmp;
                  }
                  return 0;
                }).slice(0, maxRows);
                if (bounds) rows = rows.slice(bounds[0], bounds[1] + 1);
              }
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
    put: (p, ...h) => routes.set("PUT " + p, h),
    use: (p, ...h) => routes.set("USE " + p, h),
  };
  const worker = installSalesPlatform(app, {
    db,
    fetchImpl,
    requireBusiness: (req, res, next) => next(),
    env: {
      PUBLIC_BACKEND_URL: "https://backend.example",
      FRONTEND_URL: "https://frontend.example",
      EMAIL_TOKEN_KEY: process.env.EMAIL_TOKEN_KEY,
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
        type(value) { this.contentType=value; return this; },
        send(value) { this.body=value; return this; },
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
          accepted: true,
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
    if (/^\/(companycontact|jobcontact)\.json\?/.test(path)) return response([]);
    if (path.startsWith("/jobpayment.json?") || path.startsWith("/jobactivity.json?")) return response([]);
    if (opts.method === "POST") {
      const body =
        opts.body instanceof FormData
          ? { uuid: opts.body.get("uuid"), active: 1 }
          : JSON.parse(opts.body);
      if (/^\/(company|companycontact|jobcontact|job)\/.+\.json$/.test(path)) {
        assert.ok(objects.has(path), "update must reference an existing remote record");
        Object.assign(objects.get(path), body); return response({});
      }
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
    "/companycontact.json",
    "/job.json",
    "/jobcontact.json",
    "/jobcontact.json",
    "/jobmaterial.json",
  ]);
  assert.equal(
    db.tables.external_object_mappings.filter((r) => r.synced_at).length,
    8,
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
        url.includes("/jobpayment.json") || url.includes("/jobactivity.json") || url.includes("/jobmaterial.json")
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
test('settings require a connected account and return the persisted toggle', async () => {
  const db=database({users:[{id:'u',business_id:'A',role:'owner'}]});
  const {route}=setup(db);
  const req={userId:'u',businessId:'A',body:{autoHandoff:true}};
  assert.equal((await route('POST','/api/sales/servicem8/settings',req)).statusCode,409);
  db.tables.servicem8_connections.push({business_id:'A'});
  const res=await route('POST','/api/sales/servicem8/settings',req);
  assert.equal(res.body.autoHandoff,true);
  assert.equal(db.tables.servicem8_connections[0].auto_handoff,true);
});
test('remote status readback preserves sales and quote state', async () => {
  const db=database({
    servicem8_connections:[{business_id:'A',generation:id(2),auth_mode:'api_key',api_key_enc:encryptToken('test')}],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3)}],
    jobs:[{id:id(4),business_id:'A',status:'won'}],quotes:[{id:id(5),status:'accepted'}]
  });
  const before=JSON.stringify([db.tables.jobs,db.tables.quotes]);
  const {worker}=setup(db,async url=>response(url.includes('jobactivity') || url.includes('jobmaterial') ? [] : url.includes('jobpayment')?[{amount:'40'},{amount:'75'}]:{status:'Completed',active:1,invoice_sent:1,payment_received:1,total_invoice_amount:'115'}));
  await worker.refreshRemote('A',id(3));
  assert.equal(JSON.stringify([db.tables.jobs,db.tables.quotes]),before);
  const {pricing,...state}=db.tables.external_object_mappings[0].snapshot;
  assert.equal(pricing.total,115);
  assert.deepEqual(state,{status:'Completed',booking:null,schedulePermissionMissing:false,completed:true,active:true,invoiceSent:true,paymentReceived:true,invoicedTotal:115,collectedTotal:115});
});
test('ServiceM8 scheduled activity syncs booking and status to its linked TurnKey job', async () => {
  const db=database({
    servicem8_connections:[{business_id:'A',generation:id(2),auth_mode:'api_key',api_key_enc:encryptToken('test')}],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3),local_id:id(4)}]
  });
  let localSync;
  db.rpc=async(name,args)=>{if(name==='sync_servicem8_job_state')localSync=args;return {data:null,error:null};};
  const {worker}=setup(db,async url=>{
    if(url.includes('/jobactivity.json?'))return response([{uuid:id(6),activity_was_scheduled:'1',active:'1',start_date:'2026-11-02 09:00:00',end_date:'2026-11-02 10:30:00'}]);
    if(url.includes('/jobpayment.json?') || url.includes('/jobmaterial.json?'))return response([]);
    return response({status:'Work Order',active:1});
  });
  await worker.refreshRemote('A',id(3));
  assert.equal(localSync.p_business_id,'A');
  assert.equal(localSync.p_job_id,id(4));
  assert.equal(localSync.p_status,'Work Order');
  assert.equal(localSync.p_schedule_permission_missing,false);
  assert.equal(localSync.p_booking.source,'servicem8');
  assert.equal(localSync.p_booking.startAt,'2026-11-02T09:00:00.000Z');
  assert.equal(db.tables.external_object_mappings[0].snapshot.booking.activityUuid,id(6));
});
test('schedule permission failures preserve the last confirmed booking during status refresh',async()=>{
  const previous={activityUuid:id(8),startAt:'2026-11-02T20:00:00.000Z',endAt:'2026-11-02T21:30:00.000Z',source:'servicem8'};
  const db=database({servicem8_connections:[privateConnection()],external_object_mappings:[{
    business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3),local_id:id(4),snapshot:{booking:previous}
  }]});let localSync;
  db.rpc=async(name,args)=>{assert.equal(name,'sync_servicem8_job_state');localSync=args;return {data:null,error:null};};
  const {worker}=setup(db,async url=>url.includes('/jobactivity.json?')?response({},403):url.includes('/jobpayment.json?')||url.includes('/jobmaterial.json?')?response([]):response({status:'Work Order',active:1}));
  await worker.refreshRemote('A',id(3));
  assert.equal(localSync.p_schedule_permission_missing,true);
  assert.deepEqual(localSync.p_booking,previous);
  assert.equal(db.tables.external_object_mappings[0].snapshot.schedulePermissionMissing,true);
});
test('a draft-only version can never be transferred even if the quote status says accepted',async()=>{
  const jobId=id(20),quoteId=id(21);
  const db=database({servicem8_connections:[{business_id:'A',generation:id(2)}],
    jobs:[{id:jobId,business_id:'A',quote_id:quoteId,status:'won'}],
    quotes:[{id:quoteId,business_id:'A',status:'accepted'}],
    quote_versions:[{business_id:'A',quote_id:quoteId,snapshot:{amount:115,details:{gstRegistered:true,services:[{priceSnapshot:115}]}}}]
  });
  const {worker}=setup(db);
  await assert.rejects(worker.transfer({business_id:'A',payload:{jobId}}),/immutable approved quote/);
  assert.equal(db.tables.external_object_mappings,undefined);
});
test('malformed approved line prices fail before remote line creation',()=>{
  for(const priceSnapshot of [-1,'NaN','not money']) assert.throws(()=>SM.approvedLines({amount:115,details:{gstRegistered:true,services:[{priceSnapshot}]}}),/invalid service price/);
});
test('payment readback starts at cursor=-1 and follows all pages',async()=>{
  const db=database({servicem8_connections:[{business_id:'A',generation:id(2),auth_mode:'api_key',api_key_enc:encryptToken('test')}],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3)}]});
  const cursors=[];
  const {worker}=setup(db,async url=>{
    if(url.includes('jobactivity') || url.includes('jobmaterial'))return response([]);
    if(!url.includes('jobpayment'))return response({status:'Completed'});
    const cursor=new URL(url).searchParams.get('cursor');cursors.push(cursor);
    return new Response(JSON.stringify([{amount:cursor==='-1'?40:75}]),{headers:cursor==='-1'?{'x-next-cursor':id(7)}:{}});
  });
  await worker.refreshRemote('A',id(3));
  assert.deepEqual(cursors,['-1',id(7)]);
  assert.equal(db.tables.external_object_mappings[0].snapshot.collectedTotal,115);
});
const privateConnection=(extra={})=>({business_id:'A',generation:id(2),auth_mode:'api_key',api_key_enc:encryptToken('synthetic-private-key'),...extra});
const owner={userId:'u',businessId:'A'};
const ownerRows=[{id:'u',business_id:'A',role:'owner'}];
test('status flags distinguish server configuration, unreadable credentials and webhook registration',async()=>{
  const unconfigured=setup(database(),undefined,{env:{}});
  let res=await unconfigured.route('GET','/api/sales/servicem8/status',{businessId:'A'});
  assert.equal(res.body.privateEnabled,false);assert.equal(res.body.oauthConfigured,false);
  assert.equal(res.body.encryptionConfigured,false);assert.deepEqual(res.body.configurationMissing,['EMAIL_TOKEN_KEY']);
  const db=database({users:ownerRows,servicem8_connections:[privateConnection({webhook_subscribed_at:'2026-10-15T00:00:00Z'})],integration_tasks:[
    {business_id:'A',kind:'handoff',state:'failed',attempts:12},
    {business_id:'A',kind:'reminder',state:'failed',attempts:1},
    {business_id:'B',kind:'handoff',state:'failed',attempts:1}
  ]});
  const {route}=setup(db);
  res=await route('GET','/api/sales/servicem8/status',owner);
  assert.equal(res.body.credentialsReady,true);assert.equal(res.body.serverConfigured,true);
  assert.equal(res.body.webhookSubscribed,false);assert.equal(res.body.syncMode,'periodic');assert.equal(res.body.retryAvailable,true);assert.equal(res.body.failed,1);assert.equal(res.body.exhausted,1);
  db.tables.servicem8_connections[0].last_error='Connected, but webhook registration failed. Reconnect or use manual refresh.';
  res=await route('GET','/api/sales/servicem8/status',owner);
  assert.equal(res.body.reconnectRequired,false,'webhook warning is not a credential failure');
  db.tables.servicem8_connections[0].api_key_enc='invalid-ciphertext';
  res=await route('GET','/api/sales/servicem8/status',owner);
  assert.equal(res.body.credentialsReady,false);assert.equal(res.body.reconnectRequired,true);assert.equal(res.body.retryAvailable,false);
  assert.doesNotMatch(JSON.stringify(res.body),/synthetic-private-key|invalid-ciphertext|_enc/);
});
function seedFixture({ extraJobs = [], extraActivities = [], tables = {}, failEvent = false, pages = false, denied = [], rateLimited = null, initialSubscriptions = [], keepInactive = false, subscriptionResponse } = {}) {
  const connection = privateConnection({ webhook_enc: encryptToken('e'.repeat(64)), webhook_token_hash: SM.hash('e'.repeat(64)) });
  const db = database({ users: ownerRows, servicem8_connections: [connection], jobs: [{ id:id(35), business_id:'A' }],
    external_object_mappings: [{business_id:'A',connection_generation:id(2),object_type:'job',local_id:id(35),external_uuid:id(34),snapshot:{booking:{startAt:'2026-10-30T20:00:00.000Z',endAt:'2026-10-30T21:00:00.000Z'}}}], ...tables });
  const activity = { uuid:id(30), job_uuid:id(31), staff_uuid:id(32), activity_was_scheduled:'1', active:'1',
    start_date:'2026-11-04 09:00:00', end_date:'2026-11-04 10:30:00' };
  const resources = {
    jobactivity: [activity, ...extraActivities],
    job: [{uuid:id(31),company_uuid:id(33),job_description:'House wash',job_address:'29 Selwyn Cres',status:'Work Order',active:1},
      {uuid:id(34),status:'Completed',completion_date:'2026-10-30'}, ...extraJobs],
    company: [{uuid:id(33),name:'Nova Exterior'}],
    companycontact: [{company_uuid:id(33),active:'1',is_primary_contact:'1',first:'Alex',last:'Smith',email:'alex@example.test',mobile:'021 555 0100'}],
    jobmaterial: [{job_uuid:id(31),name:'House wash',quantity:'1'},{job_uuid:id(31),name:'Window clean',quantity:'8'}],
    staff: [{uuid:id(32),first:'Jordan',last:'Lee',email:'jordan@example.test'}],
  };
  const calls = [], saved = [], stateSyncs = [], vendor = {timezone_name:'Pacific/Auckland'};
  const subscriptions = initialSubscriptions.map(object => ({object,unique_id:`turnkey-${id(2)}-${object}`,active:true,
    callback_url:'https://backend.example/api/servicem8/webhook/'+'e'.repeat(64)}));
  db.rpc = async (name, args) => {
    if (name === 'claim_integration_task') {
      const row = (db.tables.integration_tasks || []).find(row => (row.state == null || row.state === 'pending' || row.state === 'failed') && (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= Date.now()));
      if (!row) return {data:[]};
      Object.assign(row,{state:'running',lease_token:id(99),attempts:(row.attempts||0)+1});
      return {data:[structuredClone(row)]};
    }
    if (name === 'sync_servicem8_dispatch_event') {
      if (failEvent) return { error:{code:'TEST_WRITE'} };
      saved.push(args);
    }
    if (name === 'sync_servicem8_job_state') stateSyncs.push(args);
    return { data:null, error:null };
  };
  const tools = setup(db, async (url, options) => {
    calls.push({url,options});
    if (url.includes('/webhook_subscriptions/object')) {
      const object = new URLSearchParams(options.body).get('object');
      subscriptions.push({object,unique_id:`turnkey-${id(2)}-${object}`,active:!keepInactive,
        callback_url:'https://backend.example/api/servicem8/webhook/'+'e'.repeat(64)});
      return response({});
    }
    if (url.includes('/webhook_subscriptions?status=all')) return subscriptionResponse ? subscriptionResponse() : response(subscriptions);
    if (url.endsWith('/vendor.json')) return response(vendor);
    const resource = new URL(url).pathname.split('/').at(-1).replace('.json','');
    assert.ok(Object.hasOwn(resources, resource), 'no per-record provider calls: ' + url);
    if (resource === rateLimited) return response({},429);
    if (denied.includes(resource)) return response({},403);
    const cursor = new URL(url).searchParams.get('cursor');
    if (pages && resources[resource].length > 1) {
      assert.ok(['-1',id(999)].includes(cursor));
      return new Response(JSON.stringify(cursor === '-1' ? resources[resource].slice(0,1) : resources[resource].slice(1)),
        {headers:cursor === '-1' ? {'x-next-cursor':id(999)} : {}});
    }
    assert.equal(cursor, '-1');
    return response(resources[resource]);
  });
  return { ...tools, db, connection, resources, calls, saved, stateSyncs, subscriptions, vendor, retryWrites: () => { failEvent = false; } };
}
test('dispatch seed returns 202 without provider IO, dedupes v3, and imports once in the worker', async () => {
  const f = seedFixture();
  for (let n = 0; n < 2; n++) {
    const result = await f.route('POST','/api/job-calendar/servicem8/sync',owner);
    assert.equal(result.statusCode,202); assert.equal(result.body.queued,true);
  }
  assert.equal(f.calls.length,0);
  assert.equal(f.db.tables.integration_tasks.length,1);
  const task = f.db.tables.integration_tasks[0];
  assert.equal(task.kind,'dispatch_seed'); assert.equal(task.dedupe_key,'dispatch-seed-v3:'+id(2));
  await f.worker.tick();
  assert.equal(task.state,'succeeded');
  assert.equal(f.calls.length,8,'six resource lists, vendor and read-only webhook inspection');
  assert.equal(f.saved.length,2);
  const event = f.saved.find(row => row.p_external_id === id(30)).p_event;
  assert.equal(event.start_time,'2026-11-03T20:00:00.000Z');
  assert.match(event.title,/Alex Smith.*House wash/);
  assert.deepEqual(event.details.assignedStaffIds,['servicem8:'+id(32)]);
  assert.deepEqual(event.details.assignedStaff,['Jordan Lee']);
  assert.deepEqual(event.details.services,['House wash','Window clean']);
  const staff = f.db.tables.external_object_mappings.find(row => row.object_type === 'staff');
  assert.equal(staff.local_id,'servicem8:'+id(32));
  assert.deepEqual(staff.snapshot,{name:'Jordan Lee',email:'jordan@example.test'});
  assert.equal(f.stateSyncs.find(row=>row.p_job_id===id(35)).p_schedule_permission_missing,true);
  assert.ok(f.connection.dispatch_seeded_at);
  const count = f.calls.length;
  assert.equal((await f.route('POST','/api/job-calendar/servicem8/sync',owner)).body.skipped,true);
  assert.equal(f.calls.length,count);
});
test('seed keeps every staff activity and archives completed jobs with and without scheduling', async () => {
  const activities = Array.from({length:150},(_,n)=>({uuid:id(1000+n),job_uuid:id(31),staff_uuid:id(32+n%2),
    activity_was_scheduled:1,active:1,start_date:'2026-11-05 09:00:00',end_date:'2026-11-05 10:00:00'}));
  const f = seedFixture({extraActivities:[...activities,
    {uuid:id(1200),job_uuid:id(34),activity_was_scheduled:1,active:0,start_date:'2026-10-01 09:00:00',end_date:'2026-10-01 10:00:00'},
    {uuid:id(1201),job_uuid:id(34),activity_was_scheduled:1,active:0,start_date:'2026-10-02 09:00:00',end_date:'2026-10-02 10:00:00'}],
    extraJobs:[{uuid:id(80),status:'Completed',completion_date:'invalid',edit_date:'2026-10-29 12:00:00'},
      {uuid:id(81),status:'Completed',completion_date:'invalid',edit_date:'invalid'}]});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner); await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
  assert.equal(f.calls.length,8,'provider calls do not scale with activity count');
  assert.equal(f.saved.length,154,'151 work-order bookings, both historical activities, one dated archive');
  assert.ok(f.saved.some(row=>row.p_external_id==='completed:'+id(80) && row.p_event.details.source==='completed_summary'));
  assert.ok(f.db.tables.external_object_mappings.some(row=>row.object_type==='completed_job' && row.external_uuid===id(81) && row.snapshot.completedAt===null));
  assert.ok(f.saved.every(row=>row.p_event !== null),'seed never deletes absent jobs');
});
test('seed write failure leaves marker unset, reports failure and retries safely', async () => {
  const f = seedFixture({failEvent:true});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner); await f.worker.tick();
  const task = f.db.tables.integration_tasks[0];
  assert.equal(task.state,'failed'); assert.equal(f.connection.dispatch_seeded_at,undefined);
  assert.ok(task.next_attempt_at); assert.equal(f.saved.length,0);
  const status = await f.route('GET','/api/sales/servicem8/status',owner);
  assert.equal(status.body.failed,1); assert.equal(status.body.retryAvailable,true);
  f.retryWrites();
  await f.route('POST','/api/sales/servicem8/retry',owner); await f.worker.tick();
  assert.equal(task.state,'succeeded'); assert.ok(f.connection.dispatch_seeded_at);
  assert.equal(f.saved.length,2);
});
test('completed ServiceM8 job list includes every completed job and excludes other statuses', async () => {
  const db = database({ users: ownerRows, servicem8_connections: [privateConnection()] });
  let requested;
  const { route } = setup(db, async url => {
    requested = url;
    return response([
      { uuid: id(70), status: 'Completed', active: 1, company_name: 'Customer A', job_description: 'House wash', job_address: '1 Main Rd', completion_date: '2026-10-30', total_invoice_amount: '575' },
      { uuid: id(71), status: 'Work Order', active: 1, company_name: 'Customer B' },
      { uuid: id(72), status: 'Completed', active: 0, company_name: 'Inactive customer' },
    ]);
  });
  const res = await route('GET', '/api/sales/servicem8/jobs', { ...owner, query: { status: 'Completed' } });
  assert.equal(res.statusCode, 200);
  assert.match(requested, /status%20eq%20'Completed'/);
  assert.equal(res.body.jobs.length, 2, 'historical completed records are included even when inactive');
  assert.equal(res.body.jobs[0].amount, 575);
  assert.equal(res.body.jobs[1].customer, 'Inactive customer');
});
test('ServiceM8 activity webhooks keep unlinked dispatch bookings updated', async () => {
  const task = { id: id(40), business_id: 'A', kind: 'webhook', state: 'pending', attempts: 0,
    payload: { object: 'jobactivity', uuid: id(41) } };
  const db = database({ servicem8_connections: [privateConnection()], integration_tasks: [task] });
  const writes = [];
  let claimed = false;
  db.rpc = async (name, args) => {
    if (name === 'claim_integration_task') {
      if (claimed) return { data: [] };
      claimed = true; task.state = 'running'; task.lease_token = id(99); task.attempts++;
      return { data: [structuredClone(task)] };
    }
    writes.push({ name, args });
    return { data: null, error: null };
  };
  const activity = { uuid: id(41), job_uuid: id(42), staff_uuid: id(43), activity_was_scheduled: '1', active: '1',
    start_date: '2026-11-04 09:00:00', end_date: '2026-11-04 10:30:00' };
  const { worker } = setup(db, async url => url.endsWith('/jobactivity/' + id(41) + '.json') ? response(activity)
    : url.endsWith('/vendor.json') ? response({ timezone_name: 'Pacific/Auckland' })
      : url.endsWith('/job/' + id(42) + '.json') ? response({ uuid:id(42), status:'Work Order', company_name: 'Nova Exterior', job_description: 'House wash' })
        : url.includes('/jobactivity.json?') ? response([activity])
        : url.includes('/jobmaterial.json') || url.includes('/companycontact.json') || url.includes('/jobpayment.json') ? response([])
          : url.includes('/staff/') ? response({ first: 'Jordan', last: 'Lee' })
        : response({}));
  await worker.tick();
  const sync = writes.find(w => w.name === 'sync_servicem8_dispatch_event');
  assert.equal(task.state, 'succeeded');
  assert.equal(sync.args.p_business_id, 'A');
  assert.equal(sync.args.p_external_id, id(41));
  assert.equal(sync.args.p_event.start_time, '2026-11-03T20:00:00.000Z');
  assert.match(sync.args.p_event.title, /Nova Exterior.*House wash/);
  assert.equal(sync.args.p_event.details.jobUuid, id(42));
  assert.deepEqual(sync.args.p_event.details.assignedStaff, ['Jordan Lee']);
});
test('deleted ServiceM8 activity removes its calendar booking and clears the linked job schedule', async () => {
  const task={id:id(44),business_id:'A',kind:'webhook',state:'pending',attempts:0,payload:{object:'jobactivity',uuid:id(45)}};
  const db=database({servicem8_connections:[privateConnection()],integration_tasks:[task],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',local_id:id(46),external_uuid:id(47)}],
    calendar_events:[{id:id(48),business_id:'A',source:'servicem8',external_id:id(45),details:{jobUuid:id(47)}}]});
  let claimed=false;const syncs=[];
  db.rpc=async(name,args)=>{
    if(name==='claim_integration_task'){
      if(claimed)return {data:[]};claimed=true;Object.assign(task,{state:'running',lease_token:id(49),attempts:1});return {data:[structuredClone(task)]};
    }
    syncs.push({name,args});return {data:null,error:null};
  };
  const {worker}=setup(db,async url=>{
    if(url.endsWith('/jobactivity/'+id(45)+'.json'))return response({},404);
    if(url.endsWith('/job/'+id(47)+'.json'))return response({status:'Work Order',active:1});
    if(url.includes('/jobactivity.json?')||url.includes('/jobpayment.json?')||url.includes('/jobmaterial.json?'))return response([]);
    return response({});
  });
  await worker.tick();
  assert.equal(task.state,'succeeded');
  assert.equal(syncs.find(x=>x.name==='sync_servicem8_dispatch_event').args.p_event,null);
  const state=syncs.find(x=>x.name==='sync_servicem8_job_state');
  assert.equal(state.args.p_job_id,id(46));assert.equal(state.args.p_booking,null);
});
test('private connection requires encryption configuration before any remote request',async()=>{
  const db=database({users:ownerRows});const {route}=setup(db,undefined,{env:{}});
  const res=await route('POST','/api/sales/servicem8/private',{...owner,body:{apiKey:'synthetic-api-key-123456'}});
  assert.equal(res.statusCode,503);assert.match(res.body.error,/EMAIL_TOKEN_KEY/);assert.equal(db.tables.servicem8_connections,undefined);
});
test('webhook success stamps subscription readiness; failed registration retains safe manual refresh',async()=>{
  for(const failSubscription of [false,true]){
    const db=database({users:ownerRows});
    const {route}=setup(db,async url=>url.endsWith('/vendor.json')?response({uuid:id(8),name:'Synthetic'}):response({},failSubscription?403:200));
    await route('POST','/api/sales/servicem8/private',{...owner,body:{apiKey:'synthetic-api-key-123456'}});
    const res=await route('GET','/api/sales/servicem8/status',owner);
    assert.equal(res.body.connected,true);assert.equal(res.body.credentialsReady,true);
    assert.equal(res.body.webhookSubscribed,false,"registration timestamp alone does not verify delivery health");
    assert.equal(res.body.reconnectRequired,false);
    if(failSubscription) assert.match(res.body.lastError,/webhook registration failed/);
  }
});
test('retry requires a healthy connected account and never requeues reminders or another tenant',async()=>{
  const db=database({users:ownerRows,integration_tasks:[
    {id:id(50),business_id:'A',kind:'handoff',state:'failed',attempts:12,lease_token:id(9),last_error:'failed'},
    {id:id(51),business_id:'A',kind:'reminder',state:'failed',attempts:12},
    {id:id(52),business_id:'B',kind:'handoff',state:'failed',attempts:12},
    {id:id(53),business_id:'A',kind:'webhook',state:'running',attempts:1}
  ]});const {route}=setup(db);
  assert.equal((await route('POST','/api/sales/servicem8/retry',owner)).statusCode,409);
  assert.equal(db.tables.integration_tasks[0].attempts,12);
  db.tables.servicem8_connections.push(privateConnection({last_error:'ServiceM8 access expired. Reconnect the account.'}));
  assert.equal((await route('POST','/api/sales/servicem8/retry',owner)).statusCode,409);
  db.tables.servicem8_connections[0].last_error=null;
  assert.equal((await route('POST','/api/sales/servicem8/retry',owner)).statusCode,200);
  assert.equal(db.tables.integration_tasks[0].state,'pending');assert.equal(db.tables.integration_tasks[0].attempts,0);
  assert.equal(db.tables.integration_tasks[0].last_error,null);assert.equal(db.tables.integration_tasks[0].lease_token,null);
  assert.equal(db.tables.integration_tasks[1].state,'failed');assert.equal(db.tables.integration_tasks[2].state,'failed');assert.equal(db.tables.integration_tasks[3].state,'running');
});
function claimMock(db){
  const pending=[...(db.tables.integration_tasks||[])];
  db.rpc=async()=>{
    const row=pending.shift();if(!row)return {data:[]};
    row.state='running';row.lease_token=id(99);row.attempts=(row.attempts||0)+1;
    return {data:[structuredClone(row)]};
  };
}
test('durable jobpayment webhook worker reads parent job, persists only integration snapshot and clears retry errors',async()=>{
  const task={id:id(60),business_id:'A',kind:'webhook',payload:{object:'jobpayment',uuid:id(4)},last_error:'old failure'};
  const db=database({servicem8_connections:[privateConnection()],integration_tasks:[task],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3)}],
    jobs:[{id:id(5),business_id:'A',status:'won'}],quotes:[{id:id(6),status:'accepted'}]});
  claimMock(db);const before=JSON.stringify([db.tables.jobs,db.tables.quotes]);const requests=[];
  const {worker}=setup(db,async url=>{
    requests.push(url);
    if(url.includes('jobactivity') || url.includes('jobmaterial'))return response([]);
    return response(url.includes('/jobpayment/')?{job_uuid:id(3)}:url.includes('/jobpayment.json')?[{amount:115}]:{status:'Completed',invoice_sent:1,total_invoice_amount:115});
  });
  await worker.tick();assert.equal(task.state,'succeeded');assert.equal(task.last_error,null);
  assert.equal(db.tables.external_object_mappings[0].snapshot.collectedTotal,115);
  assert.equal(JSON.stringify([db.tables.jobs,db.tables.quotes]),before);
  assert.ok(requests.every(url=>url.startsWith(SM.API)));
});
test('failed remote readback persists retry timing and safe reconnect health',async()=>{
  const task={id:id(61),business_id:'A',kind:'refresh_job',payload:{uuid:id(3)}};
  const db=database({servicem8_connections:[privateConnection()],integration_tasks:[task],external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3)}]});
  claimMock(db);const {worker,route}=setup(db,async()=>response({},401));
  await worker.tick();assert.equal(task.state,'failed');assert.equal(task.lease_until,null);
  assert.ok(Date.parse(task.next_attempt_at)>Date.now());assert.match(task.last_error,/rejected this API key/);
  const health=(await route('GET','/api/sales/servicem8/status',owner)).body;
  assert.equal(health.reconnectRequired,true);assert.equal(health.retryAvailable,false);
});
test('disconnect fences active workers while leaving sales reminders alone',async()=>{
  const task={id:id(62),business_id:'A',kind:'refresh_job',payload:{uuid:id(3)}};
  const db=database({users:ownerRows,servicem8_connections:[privateConnection()],integration_tasks:[task,{id:id(63),business_id:'A',kind:'reminder',state:'pending'}],external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3)}]});
  // Only claim the refresh in this test.
  let claimed=false;db.rpc=async()=>{if(claimed)return {data:[]};claimed=true;Object.assign(task,{state:'running',lease_token:id(99),attempts:1});return {data:[structuredClone(task)]};};
  let route;
  const configured=setup(db,async()=>{
    await route('POST','/api/sales/servicem8/disconnect',owner);
    return response({},401);
  });route=configured.route;
  await configured.worker.tick();assert.equal(task.state,'failed');assert.equal(task.attempts,12);assert.equal(task.lease_token,null);
  assert.match(task.last_error,/disconnected/);assert.equal(db.tables.servicem8_connections.length,0);
  assert.equal(db.tables.integration_tasks[1].state,'pending');
});
test('webhook verification returns only the challenge and does not enqueue or fetch resources',async()=>{
  const token='c'.repeat(64),db=database({servicem8_connections:[privateConnection({webhook_token_hash:SM.hash(token)})]});
  const {route}=setup(db);
  const res=await route('POST','/api/servicem8/webhook/:token',{params:{token},body:{mode:'subscribe',challenge:'synthetic-challenge'}});
  assert.equal(res.statusCode,200);assert.equal(res.contentType,'text');assert.equal(res.body,'synthetic-challenge');
  assert.equal(db.tables.integration_tasks,undefined);
  assert.equal((await route('POST','/api/servicem8/webhook/:token',{params:{token},rawBody:Buffer.alloc(262145),body:{}})).statusCode,413);
});
const oauthConnection=()=>({business_id:'A',generation:id(2),auth_mode:'oauth',token_expiry:null,access_token_enc:encryptToken('old-access'),refresh_token_enc:encryptToken('old-refresh')});
const remoteJobMap=()=>({business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3)});
test('OAuth refresh uses timestamp-equivalent leases and preserves both rotated tokens',async()=>{
  const db=database({servicem8_connections:[oauthConnection()],external_object_mappings:[remoteJobMap()]});
  db.fail=(table,op)=>{const row=db.tables.servicem8_connections[0];if(table==='servicem8_connections'&&op==='select'&&row?.lease_until)row.lease_until=row.lease_until.replace(/Z$/,'+00:00');return false;};
  const {worker}=setup(db,async url=>response(url.includes('jobpayment') || url.includes('jobactivity') || url.includes('jobmaterial') ? []:{status:'Work Order'}),{oauthProvider:{refreshAccessToken:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600})}});
  await worker.refreshRemote('A',id(3));
  const {decryptToken}=await import('./crypto.js');
  assert.equal(decryptToken(db.tables.servicem8_connections[0].refresh_token_enc),'new-refresh');
  assert.equal(db.tables.servicem8_connections[0].lease_until,null);
});
test('changed account during refresh or incomplete token response stops before any resource request',async()=>{
  for(const scenario of ['changed','incomplete']){
    const db=database({servicem8_connections:[oauthConnection()],external_object_mappings:[remoteJobMap()]});let resourceRequests=0;
    const {worker}=setup(db,async()=>{resourceRequests++;return response({})},{oauthProvider:{refreshAccessToken:async()=>{
      if(scenario==='changed')db.tables.servicem8_connections[0].generation=id(7);
      return scenario==='incomplete'?{access_token:'incomplete'}:{access_token:'new-access',refresh_token:'new-refresh',expires_in:3600};
    }}});
    await assert.rejects(worker.refreshRemote('A',id(3)),/credentials|connection changed/);
    assert.equal(resourceRequests,0);
    const {decryptToken}=await import('./crypto.js');assert.equal(decryptToken(db.tables.servicem8_connections[0].access_token_enc),'old-access');
  }
});
test('handoff preserves authentication failures caught by the legacy decision engine',async()=>{
  const jobId=id(70),quoteId=id(71),customerId=id(72);
  const task={id:id(73),business_id:'A',kind:'handoff',payload:{jobId}};
  const db=database({users:ownerRows,servicem8_connections:[privateConnection()],integration_tasks:[task],
    jobs:[{id:jobId,business_id:'A',status:'won',quote_id:quoteId,customer_id:customerId}],
    quotes:[{id:quoteId,business_id:'A',status:'accepted'}],
    quote_versions:[{business_id:'A',quote_id:quoteId,snapshot:{accepted:true,amount:115,details:{gstRegistered:true,services:[{svc:'wash',qty:1,priceSnapshot:115}]}}}],
    customers:[{id:customerId,business_id:'A',name:'Synthetic Customer'}]});claimMock(db);
  const {worker,route}=setup(db,async(url,opts)=>{
    if(url.endsWith('/taxrate.json'))return response([{uuid:id(74),active:1,amount:15}]);
    return response({},opts.method==='POST'?403:404);
  });
  await worker.tick();assert.equal(task.state,'failed');assert.match(task.last_error,/permissions are insufficient/);
  const status=(await route('GET','/api/sales/servicem8/status',owner)).body;
  assert.equal(status.reconnectRequired,true);assert.equal(status.retryAvailable,false);
});
test('status never advertises OAuth ready when the loaded provider lacks server credentials',async()=>{
  const db=database({servicem8_connections:[oauthConnection()]});
  const {route}=setup(db,undefined,{env:{PUBLIC_BACKEND_URL:'https://backend.example',EMAIL_TOKEN_KEY:process.env.EMAIL_TOKEN_KEY,SERVICEM8_CLIENT_ID:'synthetic-id',SERVICEM8_CLIENT_SECRET:'synthetic-secret'},oauthProvider:{isConfigured:()=>false}});
  const health=(await route('GET','/api/sales/servicem8/status',owner)).body;
  assert.equal(health.oauthConfigured,false);assert.equal(health.serverConfigured,false);
  assert.equal(health.credentialsReady,true);assert.equal(health.retryAvailable,false);
  assert.deepEqual(health.configurationMissing,['SERVICEM8_CLIENT_ID','SERVICEM8_CLIENT_SECRET']);
});
test('HTTP-success ServiceM8 auth/rate-limit error envelopes preserve actionable error types without provider text',async()=>{
  for(const code of [401,403,429]) await assert.rejects(SM.request('/vendor.json',{credentials:{apiKey:'synthetic'},fetchImpl:async()=>response({errorCode:String(code),message:'sensitive provider body'})}),e=>e instanceof SM.ServiceM8Error && e.status===code && !e.message.includes('sensitive provider body'));
});
test('rejected private key identifies account verification without saving credentials or claiming OAuth expiry',async()=>{
  const db=database({users:ownerRows});let calls=0;
  const {route}=setup(db,async(url,opts)=>{
    calls++;assert.equal(url,SM.API+'/vendor.json');
    assert.equal(opts.headers['X-API-Key'],'synthetic-rejected-key');assert.equal(opts.headers.Authorization,undefined);
    return response({errorCode:401,message:'untrusted provider text'},401);
  });
  const res=await route('POST','/api/sales/servicem8/private',{...owner,body:{apiKey:'synthetic-rejected-key'}});
  assert.equal(res.statusCode,401);assert.equal(res.body.code,'SERVICEM8_API_KEY_REJECTED');
  assert.equal(res.body.stage,'account_verification');assert.equal(res.body.providerStatus,401);
  assert.match(res.body.error,/valid, active and copied in full/);assert.doesNotMatch(res.body.error,/expired|synthetic-rejected|untrusted/);
  assert.equal(calls,1);assert.equal(db.tables.servicem8_connections,undefined);
});
const webhookConnection=(extra={})=>{
  const token='d'.repeat(64);
  return privateConnection({webhook_enc:encryptToken(token),webhook_token_hash:SM.hash(token),webhook_subscribed_at:null,auto_handoff:true,...extra});
};
test('webhooks route refreshes all subscriptions from stored credentials, returning safe health',async()=>{
  const connection=webhookConnection({last_error:'Connected; webhook registration failed. Use manual refresh.'});
  const db=database({users:ownerRows,servicem8_connections:[connection]});const calls=[];
  const before={api_key_enc:connection.api_key_enc,auto_handoff:connection.auto_handoff,webhook_enc:connection.webhook_enc,webhook_token_hash:connection.webhook_token_hash};
  const {route}=setup(db,async(url,opts)=>{
    calls.push({url,body:new URLSearchParams(opts.body)});
    assert.equal(url,'https://api.servicem8.com/webhook_subscriptions/object');assert.equal(opts.method,'POST');
    assert.equal(opts.headers['X-API-Key'],'synthetic-private-key');return response({});
  });
  let res=await route('POST','/api/sales/servicem8/webhooks',owner);
  assert.equal(res.statusCode,200);assert.equal(res.body.webhookSubscribed,true);assert.ok(res.body.webhookSubscribedAt);
  assert.equal(res.body.credentialsReady,true);assert.equal(res.body.lastError,null);
  assert.deepEqual(calls.map(c=>c.body.get('object')),['job','jobpayment','jobactivity']);
  assert.deepEqual(calls.map(c=>c.body.get('unique_id')),[`turnkey-${id(2)}-job`,`turnkey-${id(2)}-jobpayment`,`turnkey-${id(2)}-jobactivity`]);
  assert.ok(calls.every(c=>c.body.get('callback_url').startsWith('https://backend.example/api/servicem8/webhook/')));
  res=await route('POST','/api/sales/servicem8/webhooks',owner);
  assert.equal(res.statusCode,200);assert.equal(calls.length,6);
  for(const [key,value] of Object.entries(before))assert.equal(connection[key],value);
  assert.equal(db.tables.integration_tasks,undefined);assert.equal(db.tables.jobs,undefined);
  assert.doesNotMatch(JSON.stringify(res.body),/synthetic-private-key|_enc|webhook_token_hash|dddddddd/);
});
test('webhooks route rejects disconnected, foreign-role and unreadable credentials without provider calls',async()=>{
  const db=database({users:ownerRows});const {route}=setup(db);
  assert.equal((await route('POST','/api/sales/servicem8/webhooks',owner)).statusCode,409);
  assert.equal((await route('POST','/api/sales/servicem8/webhooks',{userId:'u',businessId:'B'})).statusCode,403);
  db.tables.servicem8_connections.push(webhookConnection({api_key_enc:'unreadable'}));
  assert.equal((await route('POST','/api/sales/servicem8/webhooks',owner)).statusCode,409);
  assert.equal(db.tables.servicem8_connections[0].webhook_subscribed_at,null);
});
test('partial webhook provider failure remains unsubscribed and retries with identical IDs and callback',async()=>{
  const connection=webhookConnection(),db=database({users:ownerRows,servicem8_connections:[connection]});let failOnce=true;const calls=[];
  const {route}=setup(db,async(url,opts)=>{
    const body=new URLSearchParams(opts.body);calls.push(body.toString());
    if(failOnce&&body.get('object')==='jobpayment'){failOnce=false;return response({},403);}
    return response({});
  });
  let res=await route('POST','/api/sales/servicem8/webhooks',owner);
  assert.equal(res.statusCode,403);assert.equal(res.body.code,'SERVICEM8_PERMISSION_DENIED');assert.equal(connection.webhook_subscribed_at,null);
  assert.match(connection.last_error,/webhook registration failed/);assert.equal(connection.auto_handoff,true);
  res=await route('POST','/api/sales/servicem8/webhooks',owner);
  assert.equal(res.statusCode,200);assert.equal(res.body.webhookSubscribed,true);
  assert.equal(calls[0],calls[2]);assert.equal(calls[1],calls[3]);assert.equal(res.body.lastError,null);
  assert.equal(db.tables.integration_tasks,undefined);assert.equal(db.tables.jobs,undefined);
});

function quoteHandoffFixture() {
  const jobId=id(100), quoteId=id(101), customerId=id(102);
  const snapshot={amount:115,details:{gstRegistered:true,services:[{svc:'Wash',qty:1,priceSnapshot:115}],publicTerms:'Terms'},
    customer:{id:customerId,business_id:'A',name:'Customer',address:'Property'},business:{id:'A',name:'Business'}};
  const version={id:id(103),business_id:'A',quote_id:quoteId,fingerprint:'saved-revision-1',created_at:'2026-10-17T00:00:00Z',snapshot};
  const db=database({users:ownerRows,servicem8_connections:[privateConnection()],
    jobs:[{id:jobId,business_id:'A',quote_id:quoteId,customer_id:customerId,status:'followup',details:structuredClone(snapshot.details)}],
    quotes:[{id:quoteId,business_id:'A',status:'sent',amount:115}],quote_versions:[version],
    customers:[structuredClone(snapshot.customer)],businesses:[structuredClone(snapshot.business)]});
  const objects=new Map(), calls=[], pdfs=[];
  const fetchImpl=async(url,opts)=>{
    const path=url.slice(SM.API.length); calls.push({path,method:opts.method});
    if(path==='/taxrate.json')return response([{uuid:id(104),active:1,amount:15}]);
    if(/^\/(companycontact|jobcontact)\.json\?/.test(path))return response([]);
    if(path.startsWith('/jobpayment.json?') || path.startsWith('/jobactivity.json?'))return response([]);
    if(opts.method==='POST'){
      if(opts.body instanceof FormData){
        pdfs.push(await opts.body.get('file').text());
        const key='/attachment/'+opts.body.get('uuid')+'.json';
        assert.ok(!objects.has(key)); objects.set(key,{active:1}); return response({});
      }
      const body=JSON.parse(opts.body);
      if(/^\/(company|companycontact|jobcontact|job)\/.+\.json$/.test(path)){
        assert.ok(objects.has(path));Object.assign(objects.get(path),body);return response({});
      }
      const key=path.replace('.json','/'+body.uuid+'.json');
      assert.ok(!objects.has(key),'must never duplicate remote records');objects.set(key,{...body,active:1});return response({});
    }
    return objects.has(path)?response(objects.get(path)):response({},404);
  };
  return {db,jobId,quoteId,version,snapshot,objects,calls,pdfs,...setup(db,fetchImpl)};
}
const commercialState = value => JSON.stringify(value,(key,item)=>key==='serviceM8Pricing'?undefined:item);
const handoffRequest=(jobId,extra={})=>({...owner,body:{jobId,...extra}});

test('queueing a handoff wakes the worker immediately instead of waiting for its poll, without blocking the request',async()=>{
  const f=quoteHandoffFixture();
  // Mimics what the real claim_integration_task() SQL function does atomically
  // (assign id/lease_token, flip to running) — the JS fixture's generic insert()
  // mock does not simulate Postgres column defaults.
  let claimed=false;f.db.rpc=async()=>{
    if(claimed)return {data:[]};
    claimed=true;const task=f.db.tables.integration_tasks[0];
    Object.assign(task,{id:id(900),state:'running',lease_token:id(901),attempts:1});
    return {data:[task]};
  };
  const res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  assert.equal(res.statusCode,202,'The request itself resolves without waiting for delivery');
  for(let i=0;i<50 && f.db.tables.integration_tasks[0]?.state!=='succeeded';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded','Enqueue must wake the worker without an explicit tick() call');
});

test('explicit quote mode queues an immutable saved version, delivers Quote lines/PDF and repeats without duplicates',async()=>{
  const f=quoteHandoffFixture(),before=commercialState([f.db.tables.jobs,f.db.tables.quotes]);
  let res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  assert.equal(res.statusCode,202);const task=structuredClone(f.db.tables.integration_tasks[0]);
  assert.equal(task.payload.mode,'quote');assert.equal(task.payload.versionId,f.version.id);
  assert.equal(task.payload.snapshot.accepted,undefined);
  await f.worker.transfer(task);await f.worker.transfer(task);
  res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  assert.equal(res.statusCode,202);assert.equal(f.db.tables.integration_tasks.length,1);
  const remoteJob=[...f.objects.entries()].find(([p])=>p.startsWith('/job/'))[1];
  assert.equal(remoteJob.status,'Quote');assert.match(remoteJob.job_description,/draft quote/);
  assert.equal(f.calls.filter(c=>c.path==='/job.json'&&c.method==='POST').length,1);
  assert.equal(f.calls.filter(c=>c.path==='/jobmaterial.json'&&c.method==='POST').length,1);
  assert.equal(f.pdfs.length,1);assert.match(f.pdfs[0],/DRAFT QUOTE/);assert.doesNotMatch(f.pdfs[0],/APPROVED|Approved/);
  assert.equal(commercialState([f.db.tables.jobs,f.db.tables.quotes]),before);
});

test('approved handoff promotes SAME draft job and preserves Completed on repeated delivery',async()=>{
  const f=quoteHandoffFixture();
  await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
  f.db.tables.jobs[0].status='scheduled';f.db.tables.quotes[0].status='accepted';
  f.db.tables.quote_versions.push({...f.version,id:id(105),fingerprint:'accepted-revision',created_at:'2026-10-17T01:00:00Z',
    snapshot:{...structuredClone(f.snapshot),accepted:true,approvedAt:123}});
  const res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId));
  assert.equal(res.statusCode,202);const task=structuredClone(f.db.tables.integration_tasks[1]);
  await f.worker.transfer(task);
  const [path,job]=[...f.objects.entries()].find(([p])=>p.startsWith('/job/'));
  assert.equal(job.status,'Work Order');assert.equal(f.pdfs.length,2);assert.match(f.pdfs[1],/APPROVED QUOTE/);
  job.status='Completed';await f.worker.transfer(task);assert.equal(f.objects.get(path).status,'Completed');
  assert.equal(f.calls.filter(c=>c.path==='/job.json'&&c.method==='POST').length,1);
  assert.equal(f.calls.filter(c=>c.path===path&&c.method==='POST').length,1);
  assert.equal(f.db.tables.jobs[0].status,'scheduled');
});

test('edited quotes are fenced before writes, frozen deliveries do not read mutable edits, and tampering fails',async()=>{
  const f=quoteHandoffFixture();
  await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  const task=structuredClone(f.db.tables.integration_tasks[0]);
  f.db.tables.jobs[0].details.services[0].priceSnapshot=230;f.db.tables.quotes[0].amount=230;
  await f.worker.transfer(task); // Delivers the explicitly queued revision, not mutable job details.
  const newVersion={...structuredClone(f.version),id:id(106),fingerprint:'edited',created_at:'2026-10-17T02:00:00Z'};
  newVersion.snapshot.amount=230;newVersion.snapshot.details.services[0].priceSnapshot=230;
  f.db.tables.quote_versions.push(newVersion);
  assert.equal((await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}))).statusCode,202);
  const before=f.calls.length;
  await assert.rejects(f.worker.transfer(structuredClone(f.db.tables.integration_tasks[1])),/Reconcile/);
  assert.equal(f.calls.length,before);
  const tampered=structuredClone(task);tampered.payload.snapshot.amount=999;
  await assert.rejects(f.worker.transfer(tampered),/does not match/);
  const generation=structuredClone(task);generation.payload.generation=id(999);
  await assert.rejects(f.worker.transfer(generation),/connection changed/);
});

test('quote handoff validates tenant, role, mode, connection, saved quote and revision',async()=>{
  const f=quoteHandoffFixture();
  const post=(extra={})=>f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote',...extra}));
  assert.equal((await post({mode:'invalid'})).statusCode,400);
  assert.equal((await f.route('POST','/api/sales/servicem8/handoff',{...handoffRequest(f.jobId,{mode:'quote'}),businessId:'B'})).statusCode,403);
  f.db.tables.jobs[0].business_id='B';assert.equal((await post()).statusCode,404);f.db.tables.jobs[0].business_id='A';
  f.db.tables.quotes[0].business_id='B';assert.equal((await post()).statusCode,404);f.db.tables.quotes[0].business_id='A';
  f.db.tables.servicem8_connections[0].api_key_enc='broken';assert.equal((await post()).statusCode,409);
  f.db.tables.servicem8_connections[0]=privateConnection();
  f.db.tables.jobs[0].quote_id=null;assert.equal((await post()).statusCode,409);f.db.tables.jobs[0].quote_id=f.quoteId;
  f.db.tables.jobs[0].details={};assert.equal((await post()).statusCode,409);f.db.tables.jobs[0].details=f.snapshot.details;
  f.db.tables.quote_versions=[];assert.equal((await post()).statusCode,409);
  assert.equal(f.db.tables.integration_tasks,undefined);assert.equal(f.calls.length,0);
});

test('history is owned, read-only, newest first, paginated and strips secrets/costs',async()=>{
  const f=quoteHandoffFixture();
  f.version.snapshot.details.estimatedCost=91;f.version.snapshot.details.salesNotes='private';
  f.version.snapshot.business.secret='secret';f.version.snapshot.customer.email='private-email';
  for(let i=0;i<1001;i++)f.db.tables.quote_versions.push({...structuredClone(f.version),id:id(2000+i),created_at:'2026-10-18T00:00:00Z'});
  f.db.tables.quote_versions.push({...structuredClone(f.version),id:id(9000),business_id:'B'});
  const before=JSON.stringify(f.db.tables);
  const res=await f.route('GET','/api/sales/quotes/:quoteId/history',{...owner,params:{quoteId:f.quoteId}});
  assert.equal(res.statusCode,200);assert.equal(res.body.versions.length,1002);
  assert.equal(res.body.versions[0].id,id(3000));assert.equal(res.body.versions.at(-1).id,f.version.id);
  assert.doesNotMatch(JSON.stringify(res.body),/estimatedCost|salesNotes|secret|private-email|public_token/);
  assert.equal(JSON.stringify(f.db.tables),before);assert.equal(f.calls.length,0);
});

test('history distinguishes invalid/missing/foreign quotes, empty versions, and safe database failures',async()=>{
  const f=quoteHandoffFixture();const get=quoteId=>f.route('GET','/api/sales/quotes/:quoteId/history',{...owner,params:{quoteId}});
  assert.equal((await get('invalid')).statusCode,400);assert.equal((await get(id(900))).statusCode,404);
  f.db.tables.quotes[0].business_id='B';assert.equal((await get(f.quoteId)).statusCode,404);f.db.tables.quotes[0].business_id='A';
  f.db.tables.quote_versions=[];assert.deepEqual((await get(f.quoteId)).body,{versions:[]});
  for(const table of ['quotes','quote_versions']){
    f.db.fail=t=>t===table;const res=await get(f.quoteId);assert.equal(res.statusCode,503);
    assert.doesNotMatch(res.body.error,/secret database detail/);
  }
});

test('legacy approved handoff requires explicit review, captures server snapshot once and performs durable delivery',async()=>{
  const f=quoteHandoffFixture();f.db.tables.jobs[0].status='scheduled';f.db.tables.quotes[0].status='accepted';f.db.tables.quote_versions=[];
  let res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId));
  assert.equal(res.statusCode,409);assert.equal(res.body.code,"LEGACY_REVIEW_REQUIRED");assert.match(res.body.error,/reviewLegacy: true/);
  assert.equal(f.db.tables.integration_tasks,undefined);
  const before=commercialState([f.db.tables.quotes,f.db.tables.jobs,f.db.tables.quote_versions]);
  res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{reviewLegacy:true,snapshot:{amount:1}}));
  assert.equal(res.statusCode,202);const task=structuredClone(f.db.tables.integration_tasks[0]);
  assert.equal(task.payload.snapshot.amount,115);assert.equal(task.payload.snapshot.provenance,'legacy-reviewed');
  assert.equal(task.payload.snapshot.reviewedBy,owner.userId);assert.ok(task.payload.snapshot.reviewedAt);
  assert.equal(task.payload.snapshot.accepted,undefined);assert.ok(task.payload.snapshotHash);
  await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{reviewLegacy:true}));
  assert.equal(f.db.tables.integration_tasks.length,1);assert.deepEqual(f.db.tables.integration_tasks[0],task);
  Object.assign(f.db.tables.integration_tasks[0],{id:id(900),state:'running',lease_token:id(901),attempts:1});
  let claimed=false;f.db.rpc=async()=>({data:claimed?[]:(claimed=true,[f.db.tables.integration_tasks[0]])});
  await f.worker.tick();assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
  assert.equal([...f.objects.entries()].find(([p])=>p.startsWith('/job/'))[1].status,'Work Order');
  assert.equal(commercialState([f.db.tables.quotes,f.db.tables.jobs,f.db.tables.quote_versions]),before);
});

test('completed job with no quote row at all requires review, creates one quote from the recorded total and never retries silently',async()=>{
  const f=quoteHandoffFixture();
  f.db.tables.jobs[0].status='completed';f.db.tables.jobs[0].quote_id=null;
  f.db.tables.jobs[0].details={...f.db.tables.jobs[0].details,total:115};
  f.db.tables.quotes=[];f.db.tables.quote_versions=[];
  let res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId));
  assert.equal(res.statusCode,409);assert.equal(res.body.code,'LEGACY_REVIEW_REQUIRED');
  assert.equal(f.db.tables.quotes.length,0,'no quote fabricated before explicit review');
  res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{reviewLegacy:true}));
  assert.equal(res.statusCode,202);assert.equal(f.db.tables.quotes.length,1);
  assert.equal(f.db.tables.quotes[0].amount,115);assert.equal(f.db.tables.quotes[0].status,'accepted');
  assert.equal(f.db.tables.jobs[0].quote_id,f.db.tables.quotes[0].id);
  const task=structuredClone(f.db.tables.integration_tasks[0]);
  assert.equal(task.payload.snapshot.provenance,'legacy-reviewed');assert.equal(task.payload.snapshot.amount,115);
});

test('completed job with no quote row and no recorded total cannot be reviewed into a fabricated amount',async()=>{
  const f=quoteHandoffFixture();
  f.db.tables.jobs[0].status='completed';f.db.tables.jobs[0].quote_id=null;
  f.db.tables.jobs[0].details={...f.db.tables.jobs[0].details,total:0};
  f.db.tables.quotes=[];f.db.tables.quote_versions=[];
  const res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{reviewLegacy:true}));
  assert.equal(res.statusCode,409);assert.equal(f.db.tables.quotes.length,0);
});

test('legacy reviews fail closed for changed amount, quote link, customer, services, provenance, hash and approval',async()=>{
  for(const mutate of [
    f=>{f.db.tables.quotes[0].amount=230;}, f=>{f.db.tables.jobs[0].quote_id=id(999);},
    f=>{f.db.tables.jobs[0].customer_id=id(999);}, f=>{f.db.tables.jobs[0].details.services=[];},
    (f,t)=>{t.payload.snapshot.provenance='accepted';},(f,t)=>{t.payload.snapshotHash='bad';},
    f=>{f.db.tables.quotes[0].status='sent';},(f,t)=>{t.payload.reviewLegacy=false;}
  ]){
    const f=quoteHandoffFixture();f.db.tables.jobs[0].status='scheduled';f.db.tables.quotes[0].status='accepted';f.db.tables.quote_versions=[];
    await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{reviewLegacy:true}));
    const task=structuredClone(f.db.tables.integration_tasks[0]);mutate(f,task);
    await assert.rejects(f.worker.transfer(task));assert.equal(f.calls.length,0);
  }
});

test('legacy missing GST requires explicit boolean review, never current business settings',async()=>{
  const f=quoteHandoffFixture();f.db.tables.jobs[0].status='scheduled';f.db.tables.quotes[0].status='accepted';f.db.tables.quote_versions=[];
  delete f.db.tables.jobs[0].details.gstRegistered;f.db.tables.businesses[0].gst_registered=true;
  const post=extra=>f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,extra));
  for(const extra of [{},{reviewLegacy:true},{reviewLegacy:true,gstRegistered:'true'}]){
    const res=await post(extra);assert.equal(res.statusCode,409);assert.equal(res.body.code,'LEGACY_REVIEW_REQUIRED');
    assert.deepEqual(res.body.missingFields,['gstRegistered']);assert.equal(f.db.tables.integration_tasks,undefined);
  }
  const res=await post({reviewLegacy:true,gstRegistered:true});assert.equal(res.statusCode,202);
  const task=structuredClone(f.db.tables.integration_tasks[0]);assert.equal(task.payload.snapshot.gstProvenance,'explicit-review');
  await f.worker.transfer(task);assert.equal(f.db.tables.jobs[0].details.gstRegistered,undefined);
});

test('handoff enqueue database failure is safe and quote auth middleware runs before reads',async()=>{
  const f=quoteHandoffFixture();f.db.fail=(t,op)=>t==='integration_tasks'&&op==='insert';
  const res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  assert.equal(res.statusCode,503);assert.equal(f.calls.length,0);assert.doesNotMatch(res.body.error,/secret/);
  let reads=0;const db={from(){reads++;throw Error('must authenticate first');}};
  const {route}=setup(db,undefined,{requireBusiness:(req,res)=>res.status(401).json({error:'Authentication required'})});
  assert.equal((await route('GET','/api/sales/quotes/:quoteId/history',{params:{quoteId:id(1)}})).statusCode,401);
  assert.equal((await route('POST','/api/sales/servicem8/handoff',{body:{jobId:id(1),mode:'quote'}})).statusCode,401);
  assert.equal(reads,0);
});

test('quote mode accepts draft quote and quoting opportunity without inventing sent timestamps',async()=>{
  const f=quoteHandoffFixture();f.db.tables.quotes[0].status='draft';f.db.tables.jobs[0].status='quoting';
  const res=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  assert.equal(res.statusCode,202);await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
  assert.equal(f.db.tables.quotes[0].status,'draft');assert.equal(f.db.tables.jobs[0].status,'quoting');
  assert.equal(f.db.tables.jobs[0].details.quoteSentAt,undefined);
  const remote=[...f.objects.entries()].find(([p])=>p.startsWith('/job/'))[1];
  assert.equal(remote.status,'Quote');assert.equal(remote.quote_sent,undefined);
});

test('changed draft-to-approved prices are blocked before promotion or line writes, including automatic trigger payloads',async()=>{
  for(const retainReadbackFingerprint of [true,false]){
    const f=quoteHandoffFixture();
    await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
    await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
    const jobMap=f.db.tables.external_object_mappings.find(m=>m.object_type==='job');
    if(!retainReadbackFingerprint)jobMap.snapshot={status:'Quote'};
    const accepted=structuredClone(f.snapshot);accepted.accepted=true;accepted.amount=230;
    accepted.details.services[0].priceSnapshot=230;
    f.db.tables.jobs[0].status='scheduled';f.db.tables.quotes[0].status='accepted';f.db.tables.quotes[0].amount=230;
    f.db.tables.quote_versions.push({...f.version,id:id(980),fingerprint:'changed-accepted',created_at:'2026-10-19T00:00:00Z',snapshot:accepted});
    const before=f.calls.length,remoteBefore=JSON.stringify([...f.objects]);
    // This matches the DB trigger's legacy payload: no generation or fingerprint.
    await assert.rejects(f.worker.transfer({business_id:'A',payload:{jobId:f.jobId}}),/Reconcile/);
    assert.equal(f.calls.length,before,'revision lock must run before ANY provider call');
    assert.equal(JSON.stringify([...f.objects]),remoteBefore,'existing draft prices and Quote status must remain untouched');
  }
});

test('draft-to-approved metadata changes preserve commercial fingerprint and promote the same job',async()=>{
  const f=quoteHandoffFixture();
  f.snapshot.details.areaPolys=[{id:'draft-area',service:'driveway',points:[{x:0,y:0},{x:10,y:0},{x:10,y:10}]}];
  f.db.tables.jobs[0].details=structuredClone(f.snapshot.details);
  await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
  await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
  const accepted=structuredClone(f.snapshot);
  Object.assign(accepted,{accepted:true,approvedAt:456});
  Object.assign(accepted.details,{salesHistory:[{stage:'won'}],wonAt:456,quoteSentAt:123,
    nextFollowUpAt:789,followup:'Later',salespersonId:'new-owner',estimatedCost:99,estimatedMarginPct:10,
    transientCache:{preview:'different'}});
  accepted.details.services[0].cachedEstimate=999;
  Object.assign(accepted.details.areaPolys[0],{id:'regenerated-id',notes:'internal area note',photoPaths:['internal']});
  accepted.details.areaPolys[0].points[0].cache='internal';
  Object.assign(accepted.business,{pricing_config:{rates:{driveway:999},costs:{wages:888}},updated_at:'later',home_address:'private depot'});
  Object.assign(accepted.customer,{updated_at:'later',notes:'private customer note'});
  f.db.tables.jobs[0].status='scheduled';f.db.tables.jobs[0].details=structuredClone(accepted.details);
  f.db.tables.quotes[0].status='accepted';
  f.db.tables.quote_versions.push({...f.version,id:id(981),fingerprint:'metadata-accepted',created_at:'2026-10-19T00:00:00Z',snapshot:accepted});
  // Queue validates the entire accepted version, while the reservation compares only public content.
  assert.equal((await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId))).statusCode,202);
  const approvedTask=structuredClone(f.db.tables.integration_tasks[1]);
  const tampered=structuredClone(approvedTask);tampered.payload.snapshot.details.followup='Tampered payload';
  const before=f.calls.length;
  await assert.rejects(f.worker.transfer(tampered),/does not match/);
  assert.equal(f.calls.length,before,'full queued snapshot validation must still reject metadata tampering');
  await f.worker.transfer(approvedTask);
  assert.equal(f.calls.filter(c=>c.path==='/job.json'&&c.method==='POST').length,1);
  assert.equal(f.calls.filter(c=>c.path==='/jobmaterial.json'&&c.method==='POST').length,1);
  assert.equal([...f.objects.entries()].find(([p])=>p.startsWith('/job/'))[1].status,'Work Order');
});

test('draft-to-approved commercial, terms, geometry and public identity changes remain fenced before provider calls',async()=>{
  const changes={
    service:s=>{s.details.services[0].svc='roof';},
    customUnit:s=>{s.details.services[0].unit='hour';},
    customUnitPrice:s=>{s.details.services[0].unitPrice=115;},
    customPricingMode:s=>{s.details.services[0].pricingMode='fixed';},
    price:s=>{s.details.services[0].priceSnapshot=230;},
    amount:s=>{s.amount=230;},
    gst:s=>{s.details.gstRegistered=false;},
    terms:s=>{s.details.publicTerms='Changed scope and terms';},
    geometry:s=>{s.details.areaPolys[0].points[0].x=5;},
    geoGeometry:s=>{s.details.areaPolys[0].geoPts[0].lat=-37.0001;},
    customerIdentity:s=>{s.customer.id=id(999);},
    address:s=>{s.customer.address='Different property';},
    branding:s=>{s.business.name='Changed business';},
    notes:s=>{s.details.salesNotes='Different delivered notes';},
  };
  for(const [name,change] of Object.entries(changes)){
    const f=quoteHandoffFixture();
    f.snapshot.details.areaPolys=[{service:'driveway',points:[{x:0,y:0},{x:10,y:0},{x:10,y:10}],
      geoPts:[{lat:-37,lng:174},{lat:-37,lng:174.001},{lat:-37.001,lng:174.001}]}];
    f.db.tables.jobs[0].details=structuredClone(f.snapshot.details);
    await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
    await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
    const accepted=structuredClone(f.snapshot);accepted.accepted=true;change(accepted);
    f.db.tables.jobs[0].status='scheduled';f.db.tables.quotes[0].status='accepted';f.db.tables.quotes[0].amount=accepted.amount;
    f.db.tables.quote_versions.push({...f.version,id:id(982),fingerprint:'commercial-accepted',created_at:'2026-10-19T00:00:00Z',snapshot:accepted});
    const before=f.calls.length,remoteBefore=JSON.stringify([...f.objects]);
    await assert.rejects(f.worker.transfer({business_id:'A',payload:{jobId:f.jobId}}),/Reconcile/,name);
    assert.equal(f.calls.length,before,name);assert.equal(JSON.stringify([...f.objects]),remoteBefore,name);
  }
});

test('seed paginates lists and optional scope denial does not create per-record fallbacks', async () => {
  const f = seedFixture({pages:true,denied:['company','companycontact','jobmaterial','staff']});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner); await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
  assert.equal(f.saved.length,2);
  assert.equal(f.calls.filter(call=>call.url.includes('/job.json?')).length,2);
  assert.ok(f.calls.every(call=>! /\/(job|company|staff)\/[a-f0-9-]+\.json/.test(call.url)));
});
test('rate-limited batch resources fail durably and never stamp a successful seed', async () => {
  const f = seedFixture({rateLimited:'staff'});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner); await f.worker.tick();
  const task = f.db.tables.integration_tasks[0];
  assert.equal(task.state,'failed'); assert.match(task.last_error,/rate limit/i);
  assert.equal(f.connection.dispatch_seeded_at,undefined); assert.equal(f.saved.length,0);
});
test('completed reconciliation accepts only exact unique tenant links or ServiceM8 batch references', async () => {
  const localIds = [35,201,202,203,204,205,206,207,208,209].map(id);
  const f = seedFixture({extraJobs:[
    {uuid:id(101),status:'Completed'}, {uuid:id(102),status:'Completed'}, {uuid:id(103),status:'Completed',generated_job_id:'14'},
    {uuid:id(104),status:'Completed',generated_job_id:'15'}, {uuid:id(105),status:'Completed',generated_job_id:'16'},
    {uuid:id(106),status:'Completed',generated_job_id:'16'}, {uuid:id(107),status:'Completed'}, {uuid:id(108),status:'Completed'},
  ], tables:{
    jobs:localIds.map(local=>({id:local,business_id:'A',status:'quoted'})),
    servicem8_object_map:[{id:id(301),business_id:'A',local_type:'job',sm8_type:'job',local_id:id(201),sm8_uuid:id(101)},
      {id:id(302),business_id:'A',local_type:'job',sm8_type:'job',local_id:id(207),sm8_uuid:id(107)}],
    servicem8_handoffs:[{id:id(303),business_id:'A',job_id:id(202),sm8_job_uuid:id(102),status:'synced'},
      {id:id(304),business_id:'A',job_id:id(208),sm8_job_uuid:id(107),status:'synced'},
      {id:id(305),business_id:'B',job_id:id(209),sm8_job_uuid:id(108),status:'synced'}],
    import_batches:[{id:id(401),business_id:'A',source:'servicem8'},{id:id(402),business_id:'A',source:'generic'}],
    import_records:[{id:id(501),business_id:'A',batch_id:id(401),entity_type:'job',entity_id:id(203),dedupe_key:'servicem8:14'},
      {id:id(502),business_id:'A',batch_id:id(402),entity_type:'job',entity_id:id(204),dedupe_key:'generic:15'},
      {id:id(503),business_id:'A',batch_id:id(401),entity_type:'job',entity_id:id(205),dedupe_key:'servicem8:16'},
      {id:id(504),business_id:'A',batch_id:id(402),entity_type:'job',entity_id:id(206),dedupe_key:'servicem8:15'}],
  }});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner); await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
  assert.deepEqual(f.stateSyncs.filter(row=>row.p_status==='Completed').map(row=>row.p_job_id).sort(),[id(35),id(201),id(202),id(203)].sort());
  assert.ok(f.stateSyncs.filter(row=>row.p_status==='Completed').every(row=>row.p_schedule_permission_missing===true));
  assert.ok(f.db.tables.external_object_mappings.some(row=>row.object_type==='job' && row.local_id===id(203) && row.external_uuid===id(103)));
});
test('mapped activity refresh updates dispatch details and converts linked bookings in vendor timezone', async () => {
  const task={id:id(601),business_id:'A',kind:'webhook',payload:{object:'jobactivity',uuid:id(602)}};
  const db=database({servicem8_connections:[privateConnection()],integration_tasks:[task],external_object_mappings:[{
    business_id:'A',connection_generation:id(2),object_type:'job',local_id:id(604),external_uuid:id(603)}],
    calendar_events:[{business_id:'A',source:'servicem8',external_id:id(602),details:{jobUuid:id(603),status:'Work Order',personName:'Old name'}}]});
  claimMock(db); const claim=db.rpc, writes=[];
  db.rpc=async(name,args)=>name==='claim_integration_task'?claim(name,args):(writes.push({name,args}),{data:null});
  const activity={uuid:id(602),job_uuid:id(603),activity_was_scheduled:1,active:1,start_date:'2026-11-04 09:00:00',end_date:'2026-11-04 10:00:00'};
  const {worker}=setup(db,async url=>url.includes('/jobactivity/')?response(activity)
    :url.includes('/jobactivity.json?')?response([activity])
      :url.endsWith('/vendor.json')?response({timezone_name:'Pacific/Auckland'})
        :url.includes('/jobpayment.json?')||url.includes('/jobmaterial.json?')?response([])
          :response({uuid:id(603),status:'Work Order',company_name:'Updated customer'}));
  await worker.tick(); assert.equal(task.state,'succeeded');
  const dispatch=writes.filter(row=>row.name==='sync_servicem8_dispatch_event');
  assert.equal(dispatch.length,1); assert.equal(dispatch[0].args.p_external_id,id(602));
  assert.equal(dispatch[0].args.p_event.details.personName,'Updated customer');
  const booking=writes.find(row=>row.name==='sync_servicem8_job_state').args.p_booking;
  assert.equal(booking.startAt,'2026-11-03T20:00:00.000Z'); assert.equal(booking.timeZone,'Pacific/Auckland');
});
test('unlinked completed webhook keeps historical events and adds an unscheduled archive', async () => {
  const task={id:id(701),business_id:'A',kind:'webhook',payload:{object:'job',uuid:id(702)}};
  const existing={business_id:'A',source:'servicem8',external_id:id(703),details:{jobUuid:id(702),status:'Work Order'}};
  const db=database({servicem8_connections:[privateConnection()],integration_tasks:[task],calendar_events:[existing]});
  claimMock(db); const claim=db.rpc, writes=[];
  db.rpc=async(name,args)=>name==='claim_integration_task'?claim(name,args):(writes.push({name,args}),{data:null});
  const {worker}=setup(db,async url=>url.endsWith('/vendor.json')?response({timezone_name:'Pacific/Auckland'})
    :url.includes('/jobactivity.json?')||url.includes('/jobmaterial.json?')?response([])
      :response({uuid:id(702),status:'Completed',completion_date:'2026-10-30'}));
  await worker.tick(); assert.equal(task.state,'succeeded');
  assert.equal(existing.details.status,'Completed');
  assert.equal(writes.length,1); assert.equal(writes[0].args.p_external_id,'completed:'+id(702));
  assert.equal(writes[0].args.p_event.start_time,'2026-10-29T11:00:00.000Z');
});
test('status explicitly diagnoses inactive subscriptions with status=all without exposing callbacks', async () => {
  const db=database({users:ownerRows,servicem8_connections:[privateConnection()]}); let requested;
  const {route}=setup(db,async url=>{requested=url; return response([
    {object:'job',unique_id:'turnkey-'+id(2)+'-job',active:false,last_failure_reason:'Timeout',last_failure_at:'2026-10-30 01:00:00',callback_url:'secret'},
    {object:'job',unique_id:'other-integration',active:false,callback_url:'secret'},
  ]);});
  const ordinary=await route('GET','/api/sales/servicem8/status',owner);
  assert.equal(requested,undefined); assert.equal(ordinary.body.dispatchSeedVersion,'v3');
  const result=await route('GET','/api/sales/servicem8/status',{...owner,query:{webhooks:'all'}});
  assert.equal(requested,'https://api.servicem8.com/webhook_subscriptions?status=all');
  assert.deepEqual(result.body.webhookSubscriptions[0],{object:'job',active:false,missing:false,lastFailureReason:'Timeout',lastFailureAt:'2026-10-30 01:00:00'});
  assert.equal(result.body.webhookSubscribed,false);
  assert.equal(result.body.webhookSubscriptions.length,3);
  assert.doesNotMatch(JSON.stringify(result.body),/secret|callback_url|_enc/);
});

test('deleted activity checks completed parent before removing historical calendar event', async () => {
  const task={id:id(801),business_id:'A',kind:'webhook',payload:{object:'jobactivity',uuid:id(802)}};
  const event={business_id:'A',source:'servicem8',external_id:id(802),details:{jobUuid:id(803),status:'Work Order'}};
  const db=database({servicem8_connections:[privateConnection()],integration_tasks:[task],calendar_events:[event]});
  claimMock(db); const claim=db.rpc, writes=[];
  db.rpc=async(name,args)=>name==='claim_integration_task'?claim(name,args):(writes.push({name,args}),{data:null});
  const {worker}=setup(db,async url=>url.includes('/jobactivity/')?response({},404)
    :url.includes('/jobactivity.json?')||url.includes('/jobmaterial.json?')?response([])
      :response({uuid:id(803),status:'Completed'}));
  await worker.tick(); assert.equal(task.state,'succeeded');
  assert.equal(event.details.status,'Completed');
  assert.equal(writes.length,0,'no delete or invented calendar date');
  assert.ok(db.tables.external_object_mappings.some(row=>row.object_type==='completed_job' && row.external_uuid===id(803)));
});
test('completed refresh without schedule permission keeps dates and stores an unlinked archive', async () => {
  const db=database({servicem8_connections:[privateConnection()],external_object_mappings:[{
    business_id:'A',connection_generation:id(2),object_type:'job',local_id:id(904),external_uuid:id(903)}]});
  const syncs=[]; db.rpc=async(name,args)=>(syncs.push({name,args}),{data:null});
  const {worker}=setup(db,async url=>url.includes('/jobactivity.json?')?response({},403)
    :url.endsWith('/vendor.json')?response({timezone_name:'Pacific/Auckland'})
      :url.includes('/jobmaterial.json?')||url.includes('/jobpayment.json?')?response([])
        :response({uuid:id(903),status:'Completed',completion_date:'2026-10-30'}));
  await worker.refreshRemote('A',id(903));
  const completed=syncs.find(row=>row.name==='sync_servicem8_job_state').args;
  assert.equal(completed.p_schedule_permission_missing,true); assert.equal(completed.p_booking,null);
  assert.equal(syncs.find(row=>row.name==='sync_servicem8_dispatch_event').args.p_external_id,'completed:'+id(903));
});
test('seed storage failures in directory and final marker never report success', async () => {
  for (const stage of ['directory','marker']) {
    const f=seedFixture();
    f.db.fail=(table,op,value)=>stage==='directory'
      ? table==='external_object_mappings' && op==='upsert' && value.object_type==='staff'
      : table==='servicem8_connections' && op==='update' && !!value.dispatch_seeded_at;
    await f.route('POST','/api/job-calendar/servicem8/sync',owner); await f.worker.tick();
    assert.equal(f.db.tables.integration_tasks[0].state,'failed'); assert.equal(f.connection.dispatch_seeded_at,undefined);
    f.db.fail=null;
    await f.route('POST','/api/sales/servicem8/retry',owner); await f.worker.tick();
    assert.equal(f.db.tables.integration_tasks[0].state,'succeeded'); assert.ok(f.connection.dispatch_seeded_at);
  }
});

test('inactive webhook health never blocks snapshot import or registers upstream', async () => {
  const f=seedFixture({keepInactive:true});
  f.connection.webhook_subscribed_at='2026-10-16T00:00:00Z';
  await f.route('POST','/api/job-calendar/servicem8/sync',owner); await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
  assert.ok(f.connection.dispatch_seeded_at); assert.equal(f.saved.length,2);
  assert.ok(f.db.tables.jobs.some(row=>row.status==='scheduled'));
  assert.equal(f.calls.filter(call=>call.url.includes('/webhook_subscriptions/object')).length,0);
  const status=await f.route('GET','/api/sales/servicem8/status',owner);
  assert.equal(status.body.webhookSubscribed,false);
  assert.ok(status.body.webhookSubscriptions.every(row=>!row.active));
});
test('explicit resumed or unsuccessful webhook clears only its completed summary and synthetic event', async () => {
  for (const status of ['Work Order','Quote','Unsuccessful']) {
    const task={id:id(950),business_id:'A',kind:'webhook',payload:{object:'job',uuid:id(951)}};
    const summary=(business,generation)=>({business_id:business,connection_generation:generation,object_type:'completed_job',
      local_id:'servicem8:'+id(951),external_uuid:id(951),snapshot:{status:'Completed'}});
    const db=database({servicem8_connections:[privateConnection()],integration_tasks:[task],
      external_object_mappings:[summary('A',id(2)),summary('B',id(2)),summary('A',id(99))],
      calendar_events:[{business_id:'A',source:'servicem8',external_id:'completed:'+id(951),details:{jobUuid:id(951),status:'Completed'}},
        {business_id:'A',source:'servicem8',external_id:id(952),details:{jobUuid:id(951),status:'Completed'}}]});
    claimMock(db); const claim=db.rpc,writes=[];
    db.rpc=async(name,args)=>name==='claim_integration_task'?claim(name,args):(writes.push({name,args}),{data:null});
    const {worker}=setup(db,async url=>url.includes('/jobactivity.json?')||url.includes('/jobmaterial.json?')?response([]):response({uuid:id(951),status}));
    await worker.tick(); assert.equal(task.state,'succeeded');
    assert.equal(db.tables.external_object_mappings.length,2);
    assert.ok(db.tables.external_object_mappings.every(row=>row.business_id==='B'||row.connection_generation===id(99)));
    assert.deepEqual(writes,[{name:'sync_servicem8_dispatch_event',args:{p_business_id:'A',p_external_id:'completed:'+id(951),p_event:null}}]);
  }
});

test('v3 imports despite a v2 marker and exhausted task, and explicitly resets failed v3 attempts', async () => {
  const f=seedFixture(); f.connection.dispatch_seeded_at='2026-10-31T00:00:00Z';
  f.db.tables.integration_tasks=[{id:id(2001),business_id:'A',kind:'dispatch_seed',dedupe_key:'dispatch-seed-v2:'+id(2),state:'failed',attempts:12}];
  let res=await f.route('POST','/api/job-calendar/servicem8/sync',owner);
  assert.equal(res.statusCode,202);assert.equal(res.body.seedVersion,'v3');assert.equal(f.calls.length,0);
  const task=f.db.tables.integration_tasks.find(row=>row.dedupe_key==='dispatch-seed-v3:'+id(2));
  Object.assign(task,{id:id(2002),state:'failed',attempts:12,last_error:'old failure',lease_token:id(77)});
  res=await f.route('POST','/api/job-calendar/servicem8/sync',owner);
  assert.equal(res.statusCode,202);assert.equal(task.attempts,0);assert.equal(task.lease_token,null);
  await f.worker.tick();assert.equal(task.state,'succeeded');
  assert.ok(f.db.tables.jobs.some(row=>row.status==='scheduled'));
});
test('snapshot creates real booked customer/job once, stores safe service requests, and preserves local booking day', async () => {
  const f=seedFixture();f.resources.jobmaterial[0].amount='115';f.resources.jobmaterial[0].price='100';
  await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
  const job=f.db.tables.jobs.find(row=>row.details?.serviceM8JobUuid===id(31));
  const customer=f.db.tables.customers.find(row=>row.id===job.customer_id);
  assert.equal(job.status,'scheduled');assert.equal(job.scheduled_date,'2026-11-04');
  assert.equal(job.details.serviceM8Booking.startAt,'2026-11-03T20:00:00.000Z');
  assert.equal(customer.name,'Alex Smith');assert.equal(customer.email,'alex@example.test');assert.equal(customer.phone,'021 555 0100');
  assert.equal(customer.address,'29 Selwyn Cres');assert.equal(customer.business_id,'A');
  assert.deepEqual(job.details.services,[]);
  assert.deepEqual(job.details.requestedServices,[{name:'House wash',service_id:null},{name:'Window clean',service_id:null}]);
  assert.deepEqual(job.details.serviceM8LineItems[0],{name:'House wash',quantity:1,unitPrice:100,lineTotal:100});
  const counts=[f.db.tables.jobs.length,f.db.tables.customers.length];
  await f.worker.scheduleReconciliation();
  const recurring=f.db.tables.integration_tasks.find(row=>row.payload.recurring);recurring.next_attempt_at=new Date(0).toISOString();
  await f.worker.tick();
  assert.deepEqual([f.db.tables.jobs.length,f.db.tables.customers.length],counts);
  assert.equal(f.calls.length,16,'two snapshots use only paginated resource lists');
  assert.ok(f.calls.every(row=>row.options.method==='GET'),'background import never writes upstream');
});
test('strict contact plus address fallback reuses a unique existing Meta/Wix customer and lead job', async () => {
  for(const channel of ['Meta','Wix']){
    const f=seedFixture({tables:{customers:[{id:id(2101),business_id:'A',source:channel,name:'Existing lead',email:'ALEX@example.test',phone:'0215550100',address:'29 Selwyn Cres'}],
      jobs:[{id:id(2102),business_id:'A',customer_id:id(2101),status:'quoted',details:{services:[],notes:'Keep lead notes'}}],external_object_mappings:[]}});
    await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
    assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
    assert.equal(f.db.tables.customers.length,1);assert.equal(f.db.tables.jobs.length,1);
    const link=f.db.tables.external_object_mappings.find(row=>row.object_type==='job');
    assert.equal(link.local_id,id(2102));assert.equal(link.external_uuid,id(31));
    const sync=f.stateSyncs.find(row=>row.p_job_id===id(2102));
    assert.equal(sync.p_status,'Work Order');assert.equal(sync.p_booking.timeZone,'Pacific/Auckland');
    assert.equal(f.db.tables.jobs[0].details.notes,'Keep lead notes');
  }
});
test('name alone, contact without matching address, ambiguous profiles and foreign tenants cannot steal a lead', async () => {
  const scenarios=[
    [{id:id(2201),business_id:'A',name:'Alex Smith',address:'29 Selwyn Cres'}],
    [{id:id(2201),business_id:'A',name:'Alex Smith',email:'alex@example.test',address:'Different address'}],
    [{id:id(2201),business_id:'B',name:'Alex Smith',email:'alex@example.test',address:'29 Selwyn Cres'}],
  ];
  for(const customers of scenarios){
    const f=seedFixture({tables:{customers,jobs:[{id:id(2202),business_id:customers[0].business_id,customer_id:id(2201),status:'quoted'}],external_object_mappings:[]}});
    await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
    const link=f.db.tables.external_object_mappings.find(row=>row.object_type==='job');
    assert.notEqual(link.local_id,id(2202));assert.equal(f.db.tables.jobs[0].status,'quoted');
  }
  const f=seedFixture({tables:{customers:[2201,2202].map(n=>({id:id(n),business_id:'A',email:'alex@example.test',address:'29 Selwyn Cres'})),jobs:[],external_object_mappings:[]}});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
  assert.equal(f.db.tables.jobs.length,0,'ambiguous contact/address identity is not linked or duplicated');
});
test('recurring snapshot completes exact old links, preserves calendar history and updates the booked date', async () => {
  const event={id:id(2301),business_id:'A',source:'servicem8',external_id:id(2302),start_time:'2026-08-30T00:00:00Z',
    details:{jobUuid:id(34),status:'Work Order',personName:'Historical customer'}};
  const f=seedFixture({tables:{calendar_events:[event]}});
  await f.worker.scheduleReconciliation();await f.worker.tick();
  const task=f.db.tables.integration_tasks[0];assert.equal(task.state,'pending');assert.equal(task.attempts,0);
  assert.ok(Date.parse(task.next_attempt_at)>Date.now()+14*60000);
  assert.equal(event.details.status,'Completed');assert.equal(event.start_time,'2026-08-30T00:00:00Z');
  const sync=f.stateSyncs.find(row=>row.p_job_id===id(35));assert.equal(sync.p_status,'Completed');assert.equal(sync.p_schedule_permission_missing,true);
  const remote=f.resources.job.find(row=>row.uuid===id(31));remote.status='Completed';
  task.next_attempt_at=new Date(0).toISOString();await f.worker.tick();
  const local=f.db.tables.jobs.find(row=>row.details?.serviceM8JobUuid===id(31));
  assert.equal(f.stateSyncs.findLast(row=>row.p_job_id===local.id).p_status,'Completed');
});
test('inspection outage/malformed response imports and status reports periodic mode instead of timestamp health', async () => {
  for(const subscriptionResponse of [()=>response({},503),()=>response({unexpected:'shape'})]){
    const f=seedFixture({subscriptionResponse});f.connection.webhook_subscribed_at='2026-10-16T00:00:00Z';
    await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
    assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');assert.ok(f.connection.dispatch_seeded_at);
    const result=await f.route('GET','/api/sales/servicem8/status',owner);
    assert.equal(result.body.webhookSubscribed,false);assert.equal(result.body.syncMode,'periodic');
    assert.match(result.body.syncWarning,/15 minutes/);assert.ok(result.body.webhookHealth.inspectionError);
  }
});
test('recurring scheduler dedupes tenants, retries exhausted tasks and never requires a browser', async () => {
  const f=seedFixture();f.db.tables.servicem8_connections.push(privateConnection({business_id:'B',generation:id(2401)}));
  await f.worker.scheduleReconciliation();await f.worker.scheduleReconciliation();
  assert.equal(f.db.tables.integration_tasks.length,2);assert.equal(f.calls.length,0);
  const task=f.db.tables.integration_tasks.find(row=>row.business_id==='A');
  Object.assign(task,{id:id(2402),state:'failed',attempts:12,next_attempt_at:new Date(0).toISOString()});
  await f.worker.scheduleReconciliation();assert.equal(task.state,'pending');assert.equal(task.attempts,0);
  assert.equal(f.db.tables.integration_tasks.length,2);
});
test('official subscription array accepts current callback identity despite a legacy unique_id', async () => {
  const f=seedFixture();
  f.subscriptions.push({type:'object',object:'job',callback_url:'https://backend.example/api/servicem8/webhook/'+'e'.repeat(64),
    unique_id:'old-subscription-id',fields:['uuid','status'],active:1,last_failure_reason:null,last_failure_at:null});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
  const result=await f.route('GET','/api/sales/servicem8/status',owner);
  assert.equal(result.body.webhookSubscriptions.find(row=>row.object==='job').active,true);
  assert.equal(result.body.webhookSubscribed,false);
  assert.deepEqual(result.body.webhookSubscriptions.find(row=>row.object==='job').fields,['uuid','status']);
});

test('Completed can link one strong existing lead without creating new completed profiles or altering totals/history', async () => {
  const lead={id:id(2501),business_id:'A',customer_id:id(2502),status:'quoted',scheduled_date:'2026-08-30',details:{total:650,services:[],notes:'Keep local note'}};
  const f=seedFixture({tables:{jobs:[lead],customers:[{id:id(2502),business_id:'A',email:'alex@example.test',address:'29 Selwyn Crescent'}],external_object_mappings:[]}});
  f.resources.job[0].status='Completed';
  await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
  assert.equal(f.db.tables.jobs.length,1);assert.equal(f.db.tables.customers.length,1);
  const sync=f.stateSyncs.find(row=>row.p_job_id===lead.id);assert.equal(sync.p_status,'Completed');assert.equal(sync.p_schedule_permission_missing,true);
  assert.equal(lead.scheduled_date,'2026-08-30');assert.equal(lead.details.total,650);assert.equal(lead.details.notes,'Keep local note');
  const map=f.db.tables.external_object_mappings.find(row=>row.object_type==='job');assert.equal(map.snapshot.profile.email,'alex@example.test');
});
test('strict address identity compares numbered street line with road aliases despite extra SM8 suburb/postcode', async () => {
  const f=seedFixture({tables:{jobs:[{id:id(2601),business_id:'A',customer_id:id(2602),status:'quoted'}],
    customers:[{id:id(2602),business_id:'A',phone:'0215550100',address:'39 puhinui rd manukau'}],external_object_mappings:[]}});
  f.resources.job[0].job_address='39 Puhinui Rd';f.resources.job[0].job_suburb='Manukau City Centre Auckland';f.resources.job[0].job_postcode='2104';
  await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
  assert.equal(f.db.tables.jobs.length,1);assert.equal(f.db.tables.customers.length,1);
  assert.equal(f.db.tables.external_object_mappings.find(row=>row.object_type==='job').local_id,id(2601));
});

test('periodic full snapshot retires explicitly cancelled/rescheduled bookings while preserving completed and absent-job history', async () => {
  const event=(n,job,status='Work Order',business='A')=>({id:id(n),business_id:business,source:'servicem8',external_id:id(n),details:{jobUuid:id(job),status}});
  const f=seedFixture({extraJobs:[{uuid:id(2701),status:'Unsuccessful'}],tables:{calendar_events:[
    event(2702,2701),event(2703,31),event(2704,31,'Completed'),event(2705,2799),event(2706,2701,'Work Order','B')]}});
  await f.worker.scheduleReconciliation();await f.worker.tick();
  const removals=f.saved.filter(row=>row.p_event===null);
  assert.deepEqual(removals.map(row=>row.p_external_id).sort(),[id(2702),id(2703)].sort());
  assert.ok(f.saved.some(row=>row.p_external_id===id(30)&&row.p_event));
  assert.ok(removals.every(row=>row.p_business_id==='A'));
  const broken=seedFixture({rateLimited:'jobactivity',tables:{calendar_events:[event(2707,31)]}});
  await broken.worker.scheduleReconciliation();await broken.worker.tick();
  assert.equal(broken.db.tables.integration_tasks[0].state,'failed');assert.equal(broken.saved.length,0,'failed full schedule fetch never deletes events');
});

test('documented selling prices distinguish zero/missing/discount and never use costs or invent GST',()=>{
  const pricing=serviceM8PricingSnapshot({uuid:id(3101),total_invoice_amount:'0'},[
    {name:'House wash',quantity:'2',price:'100',displayed_amount:'115',displayed_amount_is_tax_inclusive:'1',cost:'7'},
    {name:'Discount',quantity:'1',price:'-10'},
    {name:'Free service',quantity:'0',price:'0'},
    {name:'Unknown',quantity:'',price:null,amount:'900',billableprice:'900',cost:'800',displayed_cost:'920'},
    {name:'Inclusive only',quantity:'1',displayed_amount:'115',displayed_amount_is_tax_inclusive:'1'},
    {name:'No GST',quantity:'1.5',displayed_amount:'20',displayed_amount_is_tax_inclusive:'0'},
    {name:'Deleted',quantity:'1',price:'999',active:0},
  ],{currency:'NZD',updatedAt:'2026-11-01T00:00:00Z'});
  assert.deepEqual(pricing.items.map(row=>[row.quantity,row.unitPrice,row.lineTotal]),[[2,100,200],[1,-10,-10],[0,0,0],[null,null,null],[1,null,null],[1.5,20,30]]);
  assert.equal(pricing.total,0);assert.equal(pricing.currency,'NZD');assert.equal(pricing.taxLabel,'Tax basis not specified');
  assert.equal(pricing.lineTaxLabel,'Line prices exclude tax');
  assert.doesNotMatch(JSON.stringify(pricing.items),/cost|billableprice|900|800|920/);
  for(const total of [undefined,null,'','NaN',Infinity])assert.equal(serviceM8PricingSnapshot({total_invoice_amount:total},[]).total,null);
  assert.equal(serviceM8PricingSnapshot({},[],{currency:'unknown'}).currency,null);
});
test('seed saves accepted-job display pricing before historical writes without touching original financial fields',async()=>{
  const f=seedFixture({failEvent:true});f.vendor.currency='NZD';f.resources.job[0].total_invoice_amount='690';
  f.resources.jobmaterial[0].price='300';f.resources.jobmaterial[0].quantity='2';f.resources.jobmaterial[0].cost='50';
  const local={id:id(3201),business_id:'A',quote_id:id(3202),status:'scheduled',details:{total:575,services:[{svc:'Wash',priceSnapshot:575}],notes:'keep'}};
  const quote={id:id(3202),business_id:'A',status:'accepted',amount:575};
  f.db.tables.jobs.push(local);f.db.tables.quotes=[quote];
  f.db.tables.external_object_mappings.push({business_id:'A',connection_generation:id(2),object_type:'job',local_id:local.id,external_uuid:id(31)});
  const original=structuredClone({services:local.details.services,total:local.details.total,quote});
  await f.route('POST','/api/job-calendar/servicem8/sync',owner);await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'failed','historical event storage is deliberately unavailable');
  assert.equal(local.details.serviceM8Pricing.total,690);assert.equal(local.details.serviceM8Pricing.currency,'NZD');
  assert.equal(local.details.serviceM8Pricing.items[0].lineTotal,600);
  assert.deepEqual({services:local.details.services,total:local.details.total,quote},original);
  assert.equal(local.details.notes,'keep');assert.equal(f.calls.length,8,'batch resource calls remain constant');
});
test('refresh updates price display with a compare-and-swap while preserving concurrent notes and accepted totals',async()=>{
  const local={id:id(3301),business_id:'A',quote_id:id(3302),status:'scheduled',updated_at:'2026-11-01T00:00:00Z',details:{total:575,services:[{svc:'Wash',priceSnapshot:575}],notes:'old'}};
  const db=database({servicem8_connections:[privateConnection()],jobs:[local],quotes:[{id:id(3302),business_id:'A',status:'accepted',amount:575}],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',local_id:local.id,external_uuid:id(3303)}]});
  let changed=false,materialCalls=0;
  db.fail=(table,op,value)=>{if(!changed&&table==='jobs'&&op==='update'&&value.details?.serviceM8Pricing){changed=true;local.updated_at='2026-11-01T00:00:01Z';local.details.notes='concurrent note';}return false;};
  const {worker}=setup(db,async url=>{
    if(url.includes('/jobmaterial.json?')){materialCalls++;return response([{name:'Roof wash',quantity:'2',price:'100',cost:'1'}]);}
    if(url.includes('/jobactivity.json?'))return response([{uuid:id(3304),activity_was_scheduled:1,active:1,start_date:'2026-11-04 09:00:00',end_date:'2026-11-04 10:00:00'}]);
    if(url.includes('/jobpayment.json?'))return response([]);
    if(url.endsWith('/vendor.json'))return response({currency:'NZD',timezone_name:'Pacific/Auckland'});
    return response({uuid:id(3303),status:'Work Order',total_invoice_amount:'230'});
  });
  await worker.refreshRemote('A',id(3303));
  assert.equal(materialCalls,1);assert.equal(local.details.serviceM8Pricing.total,230);assert.equal(local.details.serviceM8Pricing.items[0].lineTotal,200);
  assert.equal(local.details.serviceM8Pricing.currency,'NZD');assert.equal(local.details.notes,'concurrent note');
  assert.equal(local.details.total,575);assert.equal(db.tables.quotes[0].amount,575);assert.deepEqual(local.details.services,[{svc:'Wash',priceSnapshot:575}]);
});

test('handoff copies current owned contact details to job and billing contacts without repricing the saved quote',async()=>{
 const f=quoteHandoffFixture(),customer=f.db.tables.customers[0];
 customer.name='Current Customer';customer.email='correct@example.test';customer.phone='+64 21 123 4567';customer.address='10 Current Road';customer.suburb='Takapuna';
 const frozen=JSON.stringify(f.version.snapshot);
 assert.equal((await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}))).statusCode,202);
 await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
 for(const type of ['JOB','BILLING']){
  const contact=[...f.objects.entries()].find(([path,row])=>path.startsWith('/jobcontact/')&&row.type===type)?.[1];
  assert(contact,`Missing ${type} contact`);assert.equal(contact.email,'correct@example.test');assert.equal(contact.phone,'+64 21 123 4567');assert.equal(contact.mobile,'+64 21 123 4567');assert.equal(contact.first,'Current');assert.equal(contact.last,'Customer');
 }
 assert.equal(JSON.stringify(f.version.snapshot),frozen);
 customer.email='changed@example.test';
 const queued=f.db.tables.integration_tasks.length;
 assert.equal((await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}))).statusCode,202);
 assert.equal(f.db.tables.integration_tasks.length,queued+1);
 const creates=f.calls.filter(c=>c.method==='POST'&&c.path==='/jobcontact.json').length;
 await f.worker.transfer(structuredClone(f.db.tables.integration_tasks.at(-1)));
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/jobcontact.json').length,creates);
 assert([...f.objects.entries()].filter(([p])=>p.startsWith('/jobcontact/')).every(([,row])=>row.email==='changed@example.test'));
 assert.equal(JSON.stringify(f.version.snapshot),frozen);
});

test('handoff refuses a missing or foreign contact profile before any external write',async()=>{
 const f=quoteHandoffFixture();f.db.tables.customers[0].business_id='B';
 const result=await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
 assert.equal(result.statusCode,409);assert.equal(f.calls.length,0);
});

test('a contact-only quote revision refreshes contacts while changed commercial terms still stay fenced',async()=>{
 const f=quoteHandoffFixture();
 await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
 await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
 const next=structuredClone(f.version);next.id=id(501);next.fingerprint='contact-revision';next.created_at='2026-11-01T00:00:00Z';next.snapshot.customer.name='Corrected Name';next.snapshot.customer.email='corrected@example.test';
 f.db.tables.quote_versions.push(next);f.db.tables.customers[0].name='Corrected Name';f.db.tables.customers[0].email='corrected@example.test';
 assert.equal((await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}))).statusCode,202);
 await f.worker.transfer(structuredClone(f.db.tables.integration_tasks.at(-1)));
 assert.equal(f.calls.filter(c=>c.path==='/job.json'&&c.method==='POST').length,1);
 assert.equal(f.calls.filter(c=>c.path==='/jobmaterial.json'&&c.method==='POST').length,1);
 assert([...f.objects.entries()].filter(([p])=>p.startsWith('/jobcontact/')).every(([,row])=>row.email==='corrected@example.test'));
 const changed=structuredClone(next);changed.id=id(502);changed.fingerprint='price-changed';changed.created_at='2026-11-01T01:00:00Z';changed.snapshot.amount=230;changed.snapshot.details.services[0].priceSnapshot=230;
 f.db.tables.quotes[0].amount=230;f.db.tables.jobs[0].details=structuredClone(changed.snapshot.details);f.db.tables.quote_versions.push(changed);
 await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
 await assert.rejects(f.worker.transfer(structuredClone(f.db.tables.integration_tasks.at(-1))),/Reconcile/);
});

test('corrected contacts during approval retain the approved PDF and promote the existing job once',async()=>{
 const f=quoteHandoffFixture();
 await f.route('POST','/api/sales/servicem8/handoff',handoffRequest(f.jobId,{mode:'quote'}));
 await f.worker.transfer(structuredClone(f.db.tables.integration_tasks[0]));
 const accepted=structuredClone(f.snapshot);accepted.accepted=true;accepted.customer.email='approved@example.test';
 f.db.tables.customers[0].email='approved@example.test';f.db.tables.jobs[0].status='scheduled';f.db.tables.quotes[0].status='accepted';
 f.db.tables.quote_versions.push({...f.version,id:id(503),fingerprint:'approved-contact-revision',created_at:'2026-11-01T02:00:00Z',snapshot:accepted});
 await f.worker.transfer({business_id:'A',payload:{jobId:f.jobId}});
 assert.equal([...f.objects.entries()].find(([p])=>p.startsWith('/job/'))[1].status,'Work Order');
 assert.equal(f.pdfs.length,2);assert.match(f.pdfs[1],/APPROVED QUOTE/);
 assert.equal(f.calls.filter(c=>c.path==='/job.json'&&c.method==='POST').length,1);
 assert([...f.objects.entries()].filter(([p])=>p.startsWith('/jobcontact/')).every(([,row])=>row.email==='approved@example.test'));
});

test('follow-up reminders only notify for the current overdue schedule, never after completion or rescheduling',async()=>{
 const due=new Date(Date.now()-3600000).toISOString();
 for(const [status,currentDue,expected] of [['quoted',due,1],['quoted',null,0],['quoted',new Date(Date.now()+86400000).toISOString(),0],['completed',due,0],['cancelled',due,0]]){
  const job={id:id(91),business_id:'A',status,details:{nextFollowUpAt:currentDue}},task={id:id(92),business_id:'A',kind:'reminder',dedupe_key:job.id+':'+due,payload:{jobId:job.id,message:'Customer follow-up'}};
  const db=database({jobs:[job],integration_tasks:[task]});claimMock(db);const alerts=[];
  const {worker}=setup(db,undefined,{sendNotification:async(_,alert)=>alerts.push(alert)});await worker.tick();assert.equal(alerts.length,expected);assert.equal(task.state,'succeeded');
 }
});

test('customer follow-up opt-out suppresses queued reminders across jobs without changing stages',async()=>{
 const due=new Date(Date.now()-3600000).toISOString(),customerId=id(90),job={id:id(91),customer_id:customerId,business_id:'A',status:'quoted',details:{nextFollowUpAt:due}},task={id:id(92),business_id:'A',kind:'reminder',dedupe_key:job.id+':'+due,payload:{jobId:job.id,message:'Follow up'}};
 const db=database({jobs:[job],customers:[{id:customerId,business_id:'A',followups_disabled:true}],integration_tasks:[task]});claimMock(db);const alerts=[];const {worker}=setup(db,undefined,{sendNotification:async(_,alert)=>alerts.push(alert)});await worker.tick();assert.equal(alerts.length,0);assert.equal(job.status,'quoted');assert.equal(task.state,'succeeded');
});

const fullImportPath = '/api/sales/servicem8/import';
const fullImportMarker = f => f.db.tables.external_object_mappings.find(row => row.business_id === 'A' &&
  row.connection_generation === id(2) && row.object_type === 'full_import');
const fullImportJobs = () => [
  { uuid:id(4101), status:'Quote', active:1, total_invoice_amount:'230', date:'2026-10-01 09:00:00' },
  { uuid:id(4102), status:'Work Order', active:1, total_invoice_amount:'0' },
  { uuid:id(4103), status:'Completed', active:1, total_invoice_amount:'345' },
  { uuid:id(4104), status:'Unsuccessful', active:1 },
];

test('full import: admin enqueue is durable, generation scoped and dedupes concurrent requests without provider IO', async () => {
  const f=seedFixture();
  const results=await Promise.all([f.route('POST',fullImportPath,owner),f.route('POST',fullImportPath,owner)]);
  assert.ok(results.every(res=>res.statusCode===202));
  assert.equal(f.calls.length,0);
  assert.equal(f.db.tables.integration_tasks.length,1);
  const task=f.db.tables.integration_tasks[0];
  assert.equal(task.kind,'dispatch_seed');
  assert.deepEqual(task.payload,{generation:id(2),fullImport:true});
  assert.equal(task.business_id,'A');
  assert.deepEqual(results[0].body,{ok:true,queued:true,generation:id(2),fullImport:true});
  assert.equal((await f.route('POST',fullImportPath,{userId:'outsider',businessId:'A'})).statusCode,403);
  assert.equal((await f.route('POST',fullImportPath,{userId:'u',businessId:'B'})).statusCode,403);
  f.db.tables.users.push({id:'manager',business_id:'B',role:'manager'});
  assert.equal((await f.route('POST',fullImportPath,{userId:'manager',businessId:'B'})).statusCode,409);
  f.db.fail=(table,op)=>table==='integration_tasks'&&op==='insert';
  f.db.tables.integration_tasks=[];
  const failed=await f.route('POST',fullImportPath,owner);
  assert.equal(failed.statusCode,503);assert.equal(failed.body.queued,undefined);
});

test('full import: all active supported statuses import, repeats reuse IDs and periodic sync retains full mode', async () => {
  const f=seedFixture({extraJobs:[...fullImportJobs(),
    {uuid:id(4105),status:'Quote',active:0},{uuid:id(4106),status:'Mystery',active:1}],tables:{jobs:[],external_object_mappings:[]}});
  await f.route('POST',fullImportPath,owner);await f.worker.tick();
  const task=f.db.tables.integration_tasks[0];assert.equal(task.state,'succeeded');
  const marker=fullImportMarker(f).snapshot;
  assert.equal(marker.fullImport,true);assert.equal(marker.linked,6);assert.equal(marker.skipped,2);
  assert.equal(marker.warnings.length,2);
  const jobs=f.db.tables.jobs;
  for(const [uuid,status] of [[4101,'quoted'],[4102,'won'],[4103,'completed'],[4104,'cancelled']]){
    const job=jobs.find(row=>row.details?.serviceM8JobUuid===id(uuid));
    assert.equal(job.id,SM.stableUuid('servicem8-inbound-job','A',id(2),id(uuid)));
    assert.equal(job.status,status);assert.equal(job.scheduled_date,null);
    assert.equal(job.details.wonAt,undefined);assert.equal(job.details.acceptedAt,undefined);
    assert.equal(job.details.estimatedCost,undefined);assert.equal(job.details.lostAt,undefined);
  }
  assert.equal(jobs.find(row=>row.details?.serviceM8JobUuid===id(4101)).details.createdAt,'2026-09-30T20:00:00.000Z');
  const originalIds=jobs.map(row=>row.id).sort();
  await f.route('POST',fullImportPath,owner);await f.worker.tick();
  assert.equal(task.state,'succeeded');assert.deepEqual(jobs.map(row=>row.id).sort(),originalIds);
  await f.worker.scheduleReconciliation();
  const recurring=f.db.tables.integration_tasks.find(row=>row.payload.recurring);
  recurring.next_attempt_at=new Date(0).toISOString();
  f.resources.job.push({uuid:id(4107),status:'Quote',active:1});
  await f.worker.tick();
  assert.equal(recurring.state,'pending');
  assert.ok(jobs.some(row=>row.details?.serviceM8JobUuid===id(4107)));
  assert.equal((await f.route('GET','/api/sales/servicem8/status',owner)).body.fullImport.fullImport,true);
  assert.ok(f.calls.every(row=>row.options.method==='GET'));
});

test('full import: concurrent workers converge on deterministic job/customer IDs and immutable mappings', async () => {
  const f=seedFixture({extraJobs:fullImportJobs(),tables:{jobs:[],external_object_mappings:[]}});
  await f.route('POST',fullImportPath,owner);
  // Two independent workers process full snapshots with the same database. The
  // fake below enforces both mapping constraints used by PostgreSQL.
  const originalFrom=f.db.from.bind(f.db);
  f.db.from=table=>{
    const query=originalFrom(table);
    if(table==='external_object_mappings'){
      const upsert=query.upsert;
      query.upsert=(value,options)=>{
        const conflict=f.db.tables.external_object_mappings.find(row=>row.business_id===value.business_id&&
          row.connection_generation===value.connection_generation&&row.object_type===value.object_type&&
          row.external_uuid===value.external_uuid&&row.local_id!==value.local_id);
        if(conflict)return {then:resolve=>Promise.resolve({error:{code:'23505'}}).then(resolve)};
        return upsert(value,options);
      };
    }
    return query;
  };
  const task=f.db.tables.integration_tasks[0];
  const second={...task,id:id(4199),dedupe_key:'concurrent-test',payload:{generation:id(2),fullImport:true}};
  f.db.tables.integration_tasks.push(second);
  const peer=setup(f.db,async(url,options)=>{
    if(url.includes('/webhook_subscriptions?'))return response([]);
    if(url.endsWith('/vendor.json'))return response(f.vendor);
    const resource=new URL(url).pathname.split('/').at(-1).replace('.json','');
    assert.ok(Object.hasOwn(f.resources,resource));assert.equal(options.method,'GET');
    return response(f.resources[resource]);
  });
  await Promise.all([f.worker.tick(),peer.worker.tick()]);
  assert.equal(task.state,'succeeded');assert.equal(second.state,'succeeded');
  assert.equal(f.db.tables.jobs.length,6);
  assert.equal(new Set(f.db.tables.jobs.map(row=>row.id)).size,6);
  assert.equal(new Set(f.db.tables.customers.map(row=>row.id)).size,f.db.tables.customers.length);
  const links=f.db.tables.external_object_mappings.filter(row=>row.object_type==='job');
  assert.equal(links.length,6);assert.equal(new Set(links.map(row=>row.external_uuid)).size,6);
});

test('full import: accepted originals and unique existing customer links survive reconciliation', async () => {
  const customer={id:id(4201),business_id:'A',source:'Wix',name:'Original',email:'alex@example.test',phone:'0215550100',address:'29 Selwyn Cres'};
  const local={id:id(4202),business_id:'A',customer_id:customer.id,quote_id:id(4203),status:'won',
    details:{total:575,estimatedCost:200,gstRegistered:true,acceptedAt:'2026-10-01T00:00:00Z',
      salesHistory:[{type:'accepted',at:'2026-10-01T00:00:00Z'}],services:[{svc:'housewash',priceSnapshot:575}],notes:'keep'}};
  const quote={id:id(4203),business_id:'A',amount:575,status:'accepted'};
  const f=seedFixture({tables:{jobs:[local],customers:[customer],quotes:[quote],external_object_mappings:[]}});
  f.resources.job[0].total_invoice_amount='690';
  const original=structuredClone({customer,quote,details:local.details});
  await f.route('POST',fullImportPath,owner);await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
  assert.equal(f.db.tables.jobs.filter(row=>row.details?.serviceM8JobUuid===id(31)).length,0,'unique existing job is reused');
  const {serviceM8Pricing,...details}=local.details;
  assert.equal(serviceM8Pricing.total,690);
  assert.deepEqual({customer,quote,details},original);
  assert.equal(local.customer_id,customer.id);
  assert.ok(f.db.tables.external_object_mappings.some(row=>row.object_type==='job'&&row.local_id===local.id&&row.external_uuid===id(31)));
});

test('full import: ambiguous matches and foreign-tenant identities are skipped with visible warnings', async () => {
  const ambiguous=seedFixture({tables:{jobs:[],external_object_mappings:[],customers:[4301,4302].map(n=>({
    id:id(n),business_id:'A',email:'alex@example.test',address:'29 Selwyn Cres'}))}});
  await ambiguous.route('POST',fullImportPath,owner);await ambiguous.worker.tick();
  assert.equal(ambiguous.db.tables.integration_tasks[0].state,'succeeded');
  assert.ok(!ambiguous.db.tables.jobs.some(row=>row.details?.serviceM8JobUuid===id(31)));
  assert.ok(fullImportMarker(ambiguous).snapshot.warnings.some(row=>row.jobUuid===id(31)&&/Multiple customer/.test(row.reason)));
  const foreign={id:id(4310),business_id:'B',status:'quoted',details:{notes:'untouched'}};
  const f=seedFixture({tables:{jobs:[foreign],customers:[{id:id(4311),business_id:'B',name:'Foreign'}],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',local_id:foreign.id,external_uuid:id(31)}]}});
  const before=structuredClone(foreign);
  await f.route('POST',fullImportPath,owner);await f.worker.tick();
  assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');assert.deepEqual(foreign,before);
  assert.ok(!f.stateSyncs.some(row=>row.p_job_id===foreign.id));
  assert.ok(fullImportMarker(f).snapshot.warnings.some(row=>row.jobUuid===id(31)&&/outside this business/.test(row.reason)));
});

test('full import: database failures never stamp completion and retries preserve stable IDs', async () => {
  for(const failedTable of ['jobs','customers','external_object_mappings']){
    const f=seedFixture({tables:{jobs:[],external_object_mappings:[]}});
    f.db.fail=(table,op,value)=>table===failedTable&&op==='upsert'&&
      (table!=='external_object_mappings'||value.object_type==='full_import');
    await f.route('POST',fullImportPath,owner);await f.worker.tick();
    const task=f.db.tables.integration_tasks[0];assert.equal(task.state,'failed');
    assert.equal(fullImportMarker(f),undefined);
    const ids=f.db.tables.jobs.map(row=>row.id);
    f.db.fail=null;
    await f.route('POST',fullImportPath,owner);await f.worker.tick();
    assert.equal(task.state,'succeeded');assert.equal(fullImportMarker(f).snapshot.fullImport,true);
    assert.ok(ids.every(id=>f.db.tables.jobs.filter(row=>row.id===id).length===1));
  }
});

const metricsRange={start:Date.parse('2026-10-01T00:00:00Z'),end:Date.parse('2026-11-01T00:00:00Z')};
test('analytics coalesces repeated intake without collapsing separate customer jobs',async()=>{
  const details={externalSource:'wix',externalId:'same-submission',createdAt:'2026-10-03T00:00:00Z'};
  const jobs=[{id:id(4501),business_id:'A',customer_id:id(4500),status:'new',details:{...details,total:0}},
    {id:id(4502),business_id:'A',customer_id:id(4500),quote_id:id(4504),status:'quoted',details:{...details,total:465}},
    {id:id(4503),business_id:'A',customer_id:id(4500),quote_id:id(4505),status:'quoted',details:{...details,externalId:'different-submission',total:300}}];
  const db=database({jobs,customers:[{id:id(4500),business_id:'A',name:'One Customer',source:'Wix'}],
    quotes:[{id:id(4504),business_id:'A',amount:465},{id:id(4505),business_id:'A',amount:300}]});
  const before=structuredClone(jobs),{route}=setup(db);
  const res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.statusCode,200);
  assert.equal(res.body.leads,2);
  assert.deepEqual(jobs,before);
});
test('full import: analytics uses verified current prices including zero without rewriting quote/cost/history', async () => {
  for(const total of [0,690]){
    const snapshot=serviceM8PricingSnapshot({uuid:id(4401),total_invoice_amount:String(total)},[],{currency:'NZD'});
    const job={id:id(4402),business_id:'A',customer_id:id(4403),quote_id:id(4404),status:'won',created_at:'2026-10-01T00:00:00Z',
      details:{total:575,opportunityValue:575,estimatedCost:200,gstRegistered:true,acceptedAt:'2026-10-05T00:00:00Z',
        salesHistory:[{type:'accepted',at:'2026-10-05T00:00:00Z'}],serviceM8Pricing:snapshot}};
    const quote={id:id(4404),business_id:'A',amount:575,status:'accepted'};
    const db=database({servicem8_connections:[privateConnection()],jobs:[job],quotes:[quote],
      customers:[{id:id(4403),business_id:'A',source:'Wix'}],external_object_mappings:[{
        business_id:'A',connection_generation:id(2),object_type:'job',local_id:job.id,external_uuid:id(4401),snapshot:{profile:{pricing:snapshot}}}]});
    const before=structuredClone({job,quote});
    const {route}=setup(db);
    const res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
    assert.equal(res.statusCode,200);assert.equal(res.body.bookedSales,total);
    assert.equal(res.body.source[0].revenue,total);
    assert.equal(res.body.estimatedProfit,null);assert.equal(res.body.costCoverage.known,0);
    assert.deepEqual(res.body.pricing,{source:'Current ServiceM8 snapshots for linked jobs; saved quote/job totals for other jobs',
      taxLabel:'Tax basis not specified',linked:1,currentTotals:1,unknownTotals:0});
    assert.deepEqual({job,quote},before);
  }
});

test('full import: analytics rejects wrong UUID/generation/tenant snapshots and leaves win dates unknown', async () => {
  const snapshot=serviceM8PricingSnapshot({uuid:id(4501),total_invoice_amount:'999'},[]);
  const job={id:id(4502),business_id:'A',status:'completed',created_at:'2026-10-01T00:00:00Z',details:{total:123,serviceM8Pricing:snapshot}};
  const db=database({servicem8_connections:[privateConnection()],jobs:[job],external_object_mappings:[
    {business_id:'B',connection_generation:id(2),object_type:'job',local_id:job.id,external_uuid:id(4501),snapshot:{profile:{pricing:snapshot}}},
    {business_id:'A',connection_generation:id(999),object_type:'job',local_id:job.id,external_uuid:id(4501),snapshot:{profile:{pricing:snapshot}}},
    {business_id:'A',connection_generation:id(2),object_type:'job',local_id:job.id,external_uuid:id(4503),snapshot:{profile:{pricing:snapshot}}},
  ]});
  const {route}=setup(db);
  let res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.body.bookedSales,0);assert.equal(res.body.cohortWonValue,0);
  assert.equal(res.body.unknownWinDates,1);assert.equal(res.body.pricing.unknownTotals,1);
  db.tables.external_object_mappings.pop();
  res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.body.cohortWonValue,123,'unlinked saved total remains available');assert.equal(res.body.pricing.linked,0);
  db.fail=(table,op)=>table==='external_object_mappings'&&op==='select';
  res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.statusCode,503);assert.equal(res.body.bookedSales,undefined);
});

test('full import: analytics prefers the newest verified snapshot and never falls back from an unknown latest total', async () => {
  const old=serviceM8PricingSnapshot({uuid:id(4601),total_invoice_amount:'575'},[],{updatedAt:'2026-10-01T00:00:00Z'});
  const current=serviceM8PricingSnapshot({uuid:id(4601),total_invoice_amount:'0'},[],{updatedAt:'2026-10-02T00:00:00Z'});
  const job={id:id(4602),business_id:'A',status:'won',created_at:'2026-10-01T00:00:00Z',
    details:{total:575,acceptedAt:'2026-10-05T00:00:00Z',serviceM8Pricing:current}};
  const mapping={business_id:'A',connection_generation:id(2),object_type:'job',local_id:job.id,external_uuid:id(4601),
    snapshot:{profile:{pricing:old},pricing:current}};
  const db=database({servicem8_connections:[privateConnection()],jobs:[job],external_object_mappings:[mapping]});
  const {route}=setup(db);
  let res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.body.bookedSales,0);assert.equal(res.body.pricing.currentTotals,1);
  mapping.snapshot.pricing=serviceM8PricingSnapshot({uuid:id(4601)},[],{updatedAt:'2026-10-03T00:00:00Z'});
  res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.body.bookedSales,0);assert.equal(res.body.pricing.unknownTotals,1);
});

test('full import: undated historical imports never become leads or quotes on database insertion day', async () => {
  const jobs=['quoted','won','completed'].map((status,index)=>({id:id(4701+index),business_id:'A',status,
    created_at:'2026-10-15T00:00:00Z',details:{importedFrom:'servicem8',total:100}}));
  const original=structuredClone(jobs);
  const {route}=setup(database({jobs}));
  const res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.statusCode,200);
  assert.equal(res.body.leads,0);assert.equal(res.body.newLeads,0);
  assert.equal(res.body.quotes,0);assert.equal(res.body.bookedSales,0);
  assert.equal(res.body.unknownWinDates,2);
  assert.equal(res.body.dateCoverage.unknownLeadDates,3);
  assert.equal(res.body.dateCoverage.unknownQuoteDates,1);
  assert.match(res.body.dateCoverage.note,/without sent dates are excluded/);
  assert.deepEqual(jobs,original);
});

test('full import: original arrival and saved quote creation dates remain usable while ordinary leads retain insertion dates', async () => {
  const jobs=[
    {id:id(4801),business_id:'A',status:'quoted',created_at:'2026-10-15T00:00:00Z',details:{importedFrom:'servicem8',
      createdAt:'2026-09-01T00:00:00Z',quoteSentAt:'2026-10-05T00:00:00Z',total:100}},
    {id:id(4802),business_id:'A',quote_id:id(4812),status:'quoted',created_at:'2026-10-15T00:00:00Z',details:{importedFrom:'servicem8'}},
    {id:id(4803),business_id:'A',quote_id:id(4813),status:'quoted',created_at:'2026-10-15T00:00:00Z',details:{importedFrom:'servicem8'}},
    {id:id(4804),business_id:'A',status:'new',created_at:'2026-10-15T00:00:00Z',details:{}},
    {id:id(4805),business_id:'A',status:'new',created_at:'2026-10-15T00:00:00Z',details:{importedFrom:'servicem8',requestSubmittedAt:'2026-10-02T00:00:00Z'}},
  ];
  const quotes=[{id:id(4812),business_id:'A',created_at:'2026-09-02T00:00:00Z'},
    {id:id(4813),business_id:'A',created_at:'2026-10-03T00:00:00Z'}];
  const {route}=setup(database({jobs,quotes}));
  const res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
  assert.equal(res.statusCode,200);assert.equal(res.body.leads,3);assert.equal(res.body.newLeads,2);
  assert.equal(res.body.quotes,1,'only the real sent date counts; quote creation is not a sent date');
  assert.equal(res.body.dateCoverage.unknownLeadDates,0);
  assert.equal(res.body.dateCoverage.unknownQuoteDates,2);
});


test('metrics exclude database-trigger import win dates but retain independently dated approval',async()=>{
 const inserted='2026-10-15T00:00:00Z',stamp=Date.parse(inserted);
 const jobs=[{id:id(4991),business_id:'A',status:'completed',created_at:inserted,details:{importedFrom:'servicem8',wonAt:stamp+0.137,total:88000}},
 {id:id(4992),business_id:'A',status:'completed',created_at:inserted,details:{importedFrom:'servicem8',wonAt:stamp,acceptedAt:'2026-10-05T00:00:00Z',total:500}}];
 const {route}=setup(database({jobs}));const res=await route('GET','/api/sales/metrics',{businessId:'A',query:metricsRange});
 assert.equal(res.statusCode,200);assert.equal(res.body.bookedSales,500);assert.equal(res.body.unknownWinDates,1);
});

const followupSettingsPath = '/api/sales/followup-settings';
const followupSteps = () => [{id:'step_1',delayDays:2,subject:'Hi {customer_name}',body:'From {business_name}: {quote_link}\n<Thanks>'}];
function automaticFollowupFixture(options={}) {
 const sender=id(601),customerId=id(602),jobId=id(603),quoteId=id(604),anchor=Date.now()-3*86400000;
 const config={enabled:true,steps:followupSteps(),senderUserId:sender,enabledAt:new Date(anchor-86400000).toISOString()};
 const job={id:jobId,business_id:'A',customer_id:customerId,quote_id:quoteId,status:'quoted',details:{quoteSentAt:anchor}};
 const db=database({businesses:[{id:'A',name:'Wash & Co',pricing_config:{rates:{house:5},followups:config}}],
  users:[{id:sender,business_id:'A',role:'owner'}],customers:[{id:customerId,business_id:'A',name:'Jane Smith',email:'jane@example.test',followups_disabled:false}],
  jobs:[job],quotes:[{id:quoteId,business_id:'A',status:'sent',public_token:'public-token'}],
  integration_tasks:[],conversation_drafts:[],emails:[]});
 const sends=[],incoming=[],auth={accessToken:'test-token',account:{id:id(605),business_id:'A',user_id:sender,email_address:'owner@example.test',last_sync_at:new Date(anchor-86400000).toISOString()}};
 const provider={listMessageIds:async()=>incoming.map(m=>m.id),getMessage:async(_,key)=>incoming.find(m=>m.id===key),
  sendMessage:async(_,message)=>{sends.push(message);if(options.sendError)throw options.sendError;return {id:'sent-1',threadId:'thread-1'};}};
 const f=setup(db,undefined,{emailProvider:provider,getValidAccessToken:async()=>auth});
 async function schedule(){await f.worker.scheduleAutomaticFollowups();for(const [i,t] of db.tables.integration_tasks.entries())t.id||=id(610+i);await new Promise(r=>setImmediate(r));}
 async function deliver(){claimMock(db);await f.worker.tick();}
 return {...f,db,sends,incoming,auth,config,job,sender,customerId,quoteId,schedule,deliver,provider};
}
test('follow-up settings validate strict enablement/cadence/messages and preserve pricing with serialized CAS',async()=>{
 const f=automaticFollowupFixture(),req={businessId:'A',userId:id(601)};
 assert.deepEqual((await f.route('GET',followupSettingsPath,req)).body,{enabled:true,steps:followupSteps()});
 const before=structuredClone(f.db.tables.businesses[0].pricing_config);
 for(const body of [{enabled:'true',steps:followupSteps()},{enabled:true,steps:[]},
  {enabled:true,steps:[...followupSteps(),{...followupSteps()[0],id:'other'}]},
  {enabled:true,steps:[{...followupSteps()[0],subject:'Bad\r\nBcc: victim@example.test'}]},
  {enabled:true,steps:[{...followupSteps()[0],body:'{CUSTOMER_NAME}'}]},
  {enabled:true,steps:[{...followupSteps()[0],delayDays:0}]}]){
  assert.equal((await f.route('PUT',followupSettingsPath,{...req,body})).statusCode,400);
 }
 assert.deepEqual(f.db.tables.businesses[0].pricing_config,before);
 const result=await f.route('PUT',followupSettingsPath,{...req,body:{enabled:true,steps:followupSteps()}});
 assert.equal(result.statusCode,200);assert.deepEqual(f.db.tables.businesses[0].pricing_config.rates,{house:5});
 assert.equal(f.db.tables.businesses[0].pricing_config.followups.enabledAt,before.followups.enabledAt);
 assert.equal(result.body.senderUserId,undefined);assert.equal(result.body.enabledAt,undefined);
 f.db.tables.users[0].role='staff';
 assert.equal((await f.route('PUT',followupSettingsPath,{...req,body:{enabled:false,steps:[]}})).statusCode,403);
 assert.equal((await f.route('GET',followupSettingsPath,{businessId:'B'})).statusCode,404);
});
test('newly enabled follow-ups exclude historical quotes and re-enabling resets activation',async()=>{
 const f=automaticFollowupFixture(),req={businessId:'A',userId:f.sender};
 await f.route('PUT',followupSettingsPath,{...req,body:{enabled:false,steps:followupSteps()}});
 await f.route('PUT',followupSettingsPath,{...req,body:{enabled:true,steps:followupSteps()}});
 assert(Date.parse(f.db.tables.businesses[0].pricing_config.followups.enabledAt)>f.job.details.quoteSentAt);
 await f.schedule();assert.equal(f.db.tables.integration_tasks.length,0);assert.equal(f.sends.length,0);
});
test('automatic follow-ups dedupe concurrent scheduling and delivery, render safe HTML and correct public links',async()=>{
 const f=automaticFollowupFixture();await Promise.all([f.schedule(),f.schedule()]);
 assert.equal(f.db.tables.integration_tasks.length,1);
 await f.deliver();await f.deliver();
 assert.equal(f.sends.length,1);assert.equal(f.sends[0].to,'jane@example.test');
 assert.equal(f.sends[0].subject,'Hi Jane');assert.match(f.sends[0].bodyText,/quote\.html\?t=public-token/);
 assert.match(f.sends[0].bodyHtml,/Wash &amp; Co/);assert.match(f.sends[0].bodyHtml,/&lt;Thanks&gt;/);
 assert.equal(f.db.tables.conversation_drafts[0].status,'sent');assert.equal(f.db.tables.conversation_drafts[0].payload.opportunityId,f.job.id);assert.equal(f.db.tables.emails[0].direction,'sent');
 assert.equal(f.db.tables.integration_tasks[0].state,'succeeded');
});
test('queued follow-ups recheck opt-out, replies, terminal stages, quote acceptance and tenant ownership before sending',async()=>{
 for(const mutate of [
  f=>{f.db.tables.customers[0].followups_disabled=true;},f=>{f.job.details.clientResponded=true;},
  ...['won','scheduled','cancelled','completed','paid','lost','accepted'].map(status=>f=>{f.job.status=status;}),
  f=>{f.db.tables.quotes[0].status='accepted';},f=>{f.db.tables.quotes[0].status='declined';},
  f=>{f.config.enabled=false;},f=>{f.config.steps[0].body='';},f=>{f.db.tables.customers[0].business_id='B';},
  f=>{f.db.tables.users[0].role='staff';},f=>{f.job.details.quoteSentAt=null;},
  f=>{f.db.tables.emails.push({id:id(699),business_id:'A',customer_id:null,direction:'received',from_address:'Jane <jane@example.test>',sent_at:new Date().toISOString()});},
 ]){
  const f=automaticFollowupFixture();await f.schedule();mutate(f);await f.deliver();assert.equal(f.sends.length,0);
 }
});
test('mailbox sync catches unindexed inbound replies and fails closed when Gmail is unavailable',async()=>{
 const f=automaticFollowupFixture();await f.schedule();
 // No customer match is needed: the synced address itself stops the follow-up.
 f.incoming.push({id:'reply-1',from:'Jane <jane@example.test>',to:'owner@example.test',date:new Date().toISOString(),isSentByUs:false,subject:'Please call'});
 // The shared sync uses ilike to link customers. Keep this test unlinked.
 const original=f.db.from.bind(f.db);f.db.from=table=>{const q=original(table);q.ilike=()=>q.eq('id','no-match');return q;};
 await f.deliver();assert.equal(f.sends.length,0);assert.equal(f.db.tables.emails[0].direction,'received');
 const g=automaticFollowupFixture();await g.schedule();g.auth.account.business_id='B';await g.deliver();assert.equal(g.sends.length,0);
});
test('unknown delivery or post-send persistence failure cannot cause a retry to send twice',async()=>{
 for(const mode of ['unknown','save-failed','index-failed']){
  const f=automaticFollowupFixture(mode==='unknown'?{sendError:Error('timeout')}:{});await f.schedule();
  if(mode==='save-failed')f.db.fail=(table,op,value)=>table==='conversation_drafts'&&op==='update'&&value.status==='sent';
  if(mode==='index-failed')f.db.fail=(table,op)=>table==='emails'&&op==='upsert';
  await f.deliver();f.db.fail=null;await f.deliver();assert.equal(f.sends.length,1,mode);
  assert(['sending','unknown','sent'].includes(f.db.tables.conversation_drafts[0].status));
 }
});
test('definitive Gmail rejection retries through the same permanent guard',async()=>{
 const error=Object.assign(Error('rejected'),{code:'SEND_REJECTED'}),f=automaticFollowupFixture({sendError:error});
 await f.schedule();await f.deliver();assert.equal(f.db.tables.conversation_drafts[0].status,'draft');
 await f.deliver();assert.equal(f.sends.length,2);
});

test('simultaneous workers cannot both send a reclaimed automatic follow-up',async()=>{
 const f=automaticFollowupFixture();await f.schedule();
 const task=f.db.tables.integration_tasks[0];task.state='running';task.lease_token=id(650);task.attempts=1;
 let claims=0;
 // Model two workers holding the same logical task after overlapping claims.
 f.db.rpc=async()=>({data:claims++<2?[structuredClone(task)]:[]});
 const other=setup(f.db,undefined,{emailProvider:f.provider,getValidAccessToken:async()=>f.auth});
 await Promise.all([f.worker.tick(),other.worker.tick()]);
 assert.equal(f.sends.length,1);assert.equal(f.db.tables.conversation_drafts.length,1);
});
test('an opt-out arriving during send-guard acquisition prevents provider delivery',async()=>{
 const f=automaticFollowupFixture();await f.schedule();
 f.db.fail=(table,op,value)=>{
  if(table==='conversation_drafts'&&op==='update'&&value.status==='sending')f.db.tables.customers[0].followups_disabled=true;
  return false;
 };
 await f.deliver();assert.equal(f.sends.length,0);
});

const followupHistoryPath = '/api/sales/followup-history';
function historyFixture() {
 const f=automaticFollowupFixture();
 f.db.tables.email_accounts=[{...f.auth.account,provider:'gmail',access_token:'private-account-token'}];
 return f;
}
test('follow-up history is authenticated, tenant and role scoped, read-only and rejects invalid pagination',async()=>{
 const f=historyFixture(),req={businessId:'A',userId:f.sender};
 const protectedRoute=setup(f.db,undefined,{requireBusiness:(_req,res)=>res.status(401).json({error:'Authentication required'})});
 assert.equal((await protectedRoute.route('GET',followupHistoryPath,req)).statusCode,401);
 for(const role of ['staff','technician',null]){
  f.db.tables.users[0].role=role;
  assert.equal((await f.route('GET',followupHistoryPath,req)).statusCode,403);
 }
 f.db.tables.users[0].role='manager';
 assert.equal((await f.route('GET',followupHistoryPath,{...req,businessId:'B'})).statusCode,403);
 for(const query of [{limit:'0'},{limit:'101'},{offset:'-1'},{offset:'2junk'},{offset:'9007199254740992'},{repliesLimit:'0'},{repliesOffset:['1']}])
  assert.equal((await f.route('GET',followupHistoryPath,{...req,query})).statusCode,400);
 await f.schedule();
 f.db.tables.integration_tasks[0].state='pending';
 const before=structuredClone(f.db.tables);
 f.db.fail=(_table,op)=>{assert.equal(op,'select');return false;};
 const result=await f.route('GET',followupHistoryPath,req);
 assert.equal(result.statusCode,200);assert.equal(result.body.items.length,1);
 assert.deepEqual(f.db.tables,before);
 assert.equal(result.body.items[0].subject,'');assert.equal(result.body.items[0].sent_at,null);
 assert.equal(result.body.items[0].status,'pending');
});
test('follow-up history recovers deterministic legacy drafts, returns only safe fields and pages all tasks',async()=>{
 const f=historyFixture();await f.schedule();await f.deliver();
 const task=f.db.tables.integration_tasks[0],draft=f.db.tables.conversation_drafts[0];
 delete draft.payload.opportunityId; // Historical sending update discarded correlation.
 task.created_at='2026-01-01T00:00:00Z';task.last_error='private-provider-secret';task.lease_token='private-lease';
 f.db.tables.integration_tasks.push({...structuredClone(task),id:id(701),created_at:'2026-01-02T00:00:00Z',dedupe_key:task.dedupe_key+':other',payload:{...task.payload,stepId:'other'}},
  {...structuredClone(task),id:id(702),business_id:'B'},
  {id:id(703),business_id:'A',kind:'reminder',payload:{jobId:f.job.id},created_at:'2026-01-03T00:00:00Z'});
 const req={businessId:'A',userId:f.sender,query:{limit:'1',offset:'0'}};
 const first=(await f.route('GET',followupHistoryPath,req)).body;
 assert.equal(first.items.length,1);assert.equal(first.items[0].id,id(701));assert.equal(first.hasMore,true);assert.equal(first.nextOffset,1);
 const second=(await f.route('GET',followupHistoryPath,{...req,query:{limit:'1',offset:'1'}})).body;
 const item=second.items[0];assert.equal(item.id,task.id);assert.equal(item.jobId,f.job.id);assert.equal(item.customer_name,'Jane Smith');
 assert.equal(item.subject,'Hi Jane');assert.match(item.bodyText,/Wash & Co/);assert.equal(item.status,'sent');assert(item.sent_at);
 assert.equal(second.hasMore,false);assert.equal(second.nextOffset,null);
 assert.doesNotMatch(JSON.stringify(second),/private-|access_token|provider_message_id|lease_token|public_token|sent_message_id/);
 assert.equal((await f.route('GET',followupHistoryPath,{...req,query:{offset:'2'}})).body.items.length,0);
});
test('history paginates associated thread replies and excludes other quotes, accounts and businesses',async()=>{
 const f=historyFixture();await f.schedule();await f.deliver();
 const received=(n,extra={})=>({id:id(n),business_id:'A',account_id:f.auth.account.id,direction:'received',customer_id:null,
  from_address:'Jane <JANE@example.test>',subject:'Reply '+n,body_text:'Response '+n,thread_id:'thread-1',sent_at:new Date(Date.now()+n*1000).toISOString(),...extra});
 f.db.tables.emails.push(received(710),received(711),received(712),received(713,{thread_id:'another-quote'}),
  received(714,{business_id:'B'}),received(715,{account_id:id(999)}));
 const req={businessId:'A',userId:f.sender,query:{repliesLimit:'2'}};
 const first=(await f.route('GET',followupHistoryPath,req)).body.items[0];
 assert.deepEqual(first.replies.map(r=>r.id),[id(710),id(711)]);assert.equal(first.stoppedReason,'customer_replied');
 assert.equal(first.repliesHasMore,true);assert.equal(first.repliesNextOffset,2);
 const second=(await f.route('GET',followupHistoryPath,{...req,query:{repliesLimit:'2',repliesOffset:'2'}})).body.items[0];
 assert.deepEqual(second.replies.map(r=>r.id),[id(712)]);assert.equal(second.repliesHasMore,false);
 assert.equal(second.repliesNextOffset,null);
 // An unrelated thread still stops automation, but is not presented as a response.
 f.db.tables.emails=f.db.tables.emails.filter(m=>m.direction==='sent'||m.thread_id==='another-quote');
 const other=(await f.route('GET',followupHistoryPath,req)).body.items[0];
 assert.equal(other.stoppedReason,'customer_replied');assert.deepEqual(other.replies,[]);
});
test('history fallback associates only replies after send, and a pre-send unlinked reply stops queued automation',async()=>{
 const f=historyFixture();await f.schedule();await f.deliver();
 const sent=f.db.tables.emails[0];sent.thread_id=null;
 const anchor=f.job.details.quoteSentAt;
 f.db.tables.emails.push({id:id(720),business_id:'A',account_id:f.auth.account.id,direction:'received',customer_id:null,
  from_address:'jane@example.test',subject:'Before follow-up',sent_at:new Date(anchor+1000).toISOString()},
 {id:id(721),business_id:'A',account_id:f.auth.account.id,direction:'received',customer_id:f.customerId,
  from_address:'jane@example.test',subject:'After follow-up',sent_at:new Date(Date.parse(sent.sent_at)+1000).toISOString()});
 const req={businessId:'A',userId:f.sender};
 const item=(await f.route('GET',followupHistoryPath,req)).body.items[0];
 assert.deepEqual(item.replies.map(r=>r.id),[id(721)]);assert.equal(item.stoppedReason,'customer_replied');
 const g=historyFixture();await g.schedule();
 g.db.tables.emails.push({id:id(722),business_id:'A',account_id:g.auth.account.id,direction:'received',customer_id:null,
  from_address:'Jane <jane@example.test>',subject:'Please stop',sent_at:new Date().toISOString()});
 await g.deliver();assert.equal(g.sends.length,0);
 const stopped=(await g.route('GET',followupHistoryPath,{businessId:'A',userId:g.sender})).body.items[0];
 assert.equal(stopped.stoppedReason,'customer_replied');assert.equal(stopped.sent_at,null);assert.equal(stopped.bodyText,'');
 assert.equal(stopped.replies[0].id,id(722));
});
test('history reports safe stop reasons without disclosing raw integration errors',async()=>{
 for(const [reason,mutate] of [
  ['customer_opted_out',f=>{f.db.tables.customers[0].followups_disabled=true;}],
  ['customer_responded',f=>{f.job.details.clientResponded=true;}],
  ['job_closed',f=>{f.job.status='won';}],
  ['quote_closed',f=>{f.db.tables.quotes[0].status='accepted';}],
  ['followups_disabled',f=>{f.config.enabled=false;}],
  ['job_unavailable',f=>{f.db.tables.jobs=[];}],
 ]){
  const f=historyFixture();await f.schedule();mutate(f);
  const result=await f.route('GET',followupHistoryPath,{businessId:'A',userId:f.sender});
  assert.equal(result.body.items[0].stoppedReason,reason);
 }
 const f=historyFixture();f.db.fail=table=>table==='integration_tasks';
 const result=await f.route('GET',followupHistoryPath,{businessId:'A',userId:f.sender});
 assert.equal(result.statusCode,503);assert.doesNotMatch(JSON.stringify(result.body),/secret database detail/);
});

test('custom public service metadata is token scoped, read only, cost private and frozen after approval',async()=>{
 const token=id(8001),quoteId=id(8002),line={svc:'custom',pricingMode:'fixed',label:'Move furniture',qty:2,unit:'hour',unitPrice:20.01,fixedPrice:40.02,customCost:98765,estCost:98765,recommendedPrice:88888};
 const db=database({quotes:[{id:quoteId,business_id:'A',public_token:token,amount:40.02,status:'sent'}],jobs:[{id:id(8003),quote_id:quoteId,business_id:'A',details:{services:[line],costSnapshot:{secret:'PRIVATE'},estimatedCost:98765}},{id:id(1),quote_id:quoteId,business_id:'B',details:{services:[{label:'FOREIGN'}]}}]});
 const {route}=setup(db),path='/api/public/quotes/:token/services',get=t=>route('GET',path,{params:{token:t}});
 let res=await get(token);assert.equal(res.statusCode,200);assert.equal(res.body.services[0].label,'Move furniture');assert.equal(res.body.services[0].unit,'hour');assert.equal(res.body.services[0].fixedPrice,40.02);assert.doesNotMatch(JSON.stringify(res.body),/98765|88888|costSnapshot|customCost|estCost|PRIVATE|FOREIGN/);
 assert.equal((await get('invalid')).statusCode,404);assert.equal((await get(id(9999))).statusCode,404);
 db.tables.quotes[0].status='accepted';db.tables.quote_versions=[{id:id(8004),quote_id:quoteId,business_id:'A',created_at:'2026-11-10',snapshot:{accepted:true,details:{services:[structuredClone(line)]}}}];db.tables.jobs[0].details.services[0].label='Changed after approval';
 res=await get(token);assert.equal(res.body.services[0].label,'Move furniture');
 const history=await route('GET','/api/sales/quotes/:quoteId/history',{...owner,params:{quoteId}});assert.equal(history.body.versions[0].snapshot.details.services[0].unitPrice,20.01);assert.equal(history.body.versions[0].snapshot.details.services[0].fixedPrice,40.02);assert.doesNotMatch(JSON.stringify(history.body),/customCost|98765|estCost/);
});
