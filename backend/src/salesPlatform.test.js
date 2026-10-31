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
        one = false, orders = [], maxRows = Infinity, bounds;
      const q = {
        select() {
          return q;
        },
        eq(k, v) {
          filters.push((r) => k === "snapshot->>accepted" ? String(r.snapshot?.accepted) === v
            : k === "lease_until" && r[k] && v ? Date.parse(r[k]) === Date.parse(v) : r[k] === v);
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
  const {worker}=setup(db,async url=>response(url.includes('jobpayment')?[{amount:'40'},{amount:'75'}]:{status:'Completed',active:1,invoice_sent:1,payment_received:1,total_invoice_amount:'115'}));
  await worker.refreshRemote('A',id(3));
  assert.equal(JSON.stringify([db.tables.jobs,db.tables.quotes]),before);
  assert.deepEqual(db.tables.external_object_mappings[0].snapshot,{status:'Completed',booking:null,schedulePermissionMissing:false,completed:true,active:true,invoiceSent:true,paymentReceived:true,invoicedTotal:115,collectedTotal:115});
});
test('ServiceM8 scheduled activity syncs booking and status to its linked TurnKey job', async () => {
  const db=database({
    servicem8_connections:[{business_id:'A',generation:id(2),auth_mode:'api_key',api_key_enc:encryptToken('test')}],
    external_object_mappings:[{business_id:'A',connection_generation:id(2),object_type:'job',external_uuid:id(3),local_id:id(4)}]
  });
  let localSync;
  db.rpc=async(name,args)=>{assert.equal(name,'sync_servicem8_job_state');localSync=args;return {data:null,error:null};};
  const {worker}=setup(db,async url=>{
    if(url.includes('/jobactivity.json?'))return response([{uuid:id(6),activity_was_scheduled:'1',active:'1',start_date:'2026-11-02 09:00:00',end_date:'2026-11-02 10:30:00'}]);
    if(url.includes('/jobpayment.json?'))return response([]);
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
  const {worker}=setup(db,async url=>url.includes('/jobactivity.json?')?response({},403):url.includes('/jobpayment.json?')?response([]):response({status:'Work Order',active:1}));
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
  assert.equal(res.body.webhookSubscribed,true);assert.equal(res.body.retryAvailable,true);assert.equal(res.body.failed,1);assert.equal(res.body.exhausted,1);
  db.tables.servicem8_connections[0].last_error='Connected, but webhook registration failed. Reconnect or use manual refresh.';
  res=await route('GET','/api/sales/servicem8/status',owner);
  assert.equal(res.body.reconnectRequired,false,'webhook warning is not a credential failure');
  db.tables.servicem8_connections[0].api_key_enc='invalid-ciphertext';
  res=await route('GET','/api/sales/servicem8/status',owner);
  assert.equal(res.body.credentialsReady,false);assert.equal(res.body.reconnectRequired,true);assert.equal(res.body.retryAvailable,false);
  assert.doesNotMatch(JSON.stringify(res.body),/synthetic-private-key|invalid-ciphertext|_enc/);
});
test('dispatch sync imports all active ServiceM8 bookings and staff without depending on calendar date view', async () => {
  const db = database({ users: ownerRows, servicem8_connections: [privateConnection()] });
  const saved=[];
  db.rpc = async (name, args) => { assert.equal(name, 'sync_servicem8_dispatch_event'); saved.push(args); return { data: null, error: null }; };
  const activity = { uuid: id(30), job_uuid: id(31), staff_uuid: id(32),
    activity_was_scheduled: '1', active: '1', start_date: '2026-11-04 09:00:00', end_date: '2026-11-04 10:30:00' };
  const { route } = setup(db, async (url) => url.endsWith('/vendor.json')
    ? response({ timezone_name: 'Pacific/Auckland' })
    : url.includes('/jobactivity.json')
    ? response([activity])
    : url.includes('/job/' + id(31) + '.json')
      ? response({ uuid: id(31), company_uuid: id(33), company_name: 'Nova Exterior', job_description: 'House wash', job_address: '29 Selwyn Cres', status: 'Work Order', active: 1 })
      : url.includes('/company/' + id(33) + '.json')
        ? response({ uuid: id(33), name: 'Nova Exterior' })
        : url.includes('/companycontact.json')
          ? response([{ active: '1', is_primary_contact: '1', first: 'Alex', last: 'Smith', email: 'alex@example.test', mobile: '021 555 0100' }])
          : url.includes('/jobmaterial.json')
            ? response([{ name: 'House wash', quantity: '1' }, { name: 'Window clean', quantity: '8' }])
            : url.includes('/staff/' + id(32) + '.json')
              ? response({ first: 'Jordan', last: 'Lee' })
      : response({}));
  const result = await route('POST', '/api/job-calendar/servicem8/sync', { ...owner, body: {} });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.synced, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].p_business_id, 'A');
  assert.equal(saved[0].p_external_id, id(30));
  assert.equal(saved[0].p_event.start_time, '2026-11-03T20:00:00.000Z', 'ServiceM8 local Auckland times are converted to the correct instant');
  assert.match(saved[0].p_event.title, /Alex Smith.*House wash/);
  assert.match(saved[0].p_event.notes, /29 Selwyn Cres/);
  assert.deepEqual(saved[0].p_event.details, {
    personName: 'Alex Smith', jobUuid: id(31), companyName: 'Nova Exterior', email: 'alex@example.test', phone: '021 555 0100',
    address: '29 Selwyn Cres', services: ['House wash', 'Window clean'],
    lineItems: [{ name: 'House wash', quantity: '1' }, { name: 'Window clean', quantity: '8' }],
    assignedStaff: ['Jordan Lee'], staffAssigned: true, status: 'Work Order',
  });
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
      : url.endsWith('/job/' + id(42) + '.json') ? response({ uuid:id(42), company_name: 'Nova Exterior', job_description: 'House wash' })
        : url.includes('/jobmaterial.json') || url.includes('/companycontact.json') ? response([])
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
    if(url.includes('/jobactivity.json?')||url.includes('/jobpayment.json?'))return response([]);
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
    assert.equal(res.body.webhookSubscribed,!failSubscription);
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
  const {worker}=setup(db,async url=>response(url.includes('jobpayment')?[]:{status:'Work Order'}),{oauthProvider:{refreshAccessToken:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600})}});
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
    customers:[snapshot.customer],businesses:[snapshot.business]});
  const objects=new Map(), calls=[], pdfs=[];
  const fetchImpl=async(url,opts)=>{
    const path=url.slice(SM.API.length); calls.push({path,method:opts.method});
    if(path==='/taxrate.json')return response([{uuid:id(104),active:1,amount:15}]);
    if(path.startsWith('/jobpayment.json?'))return response([]);
    if(opts.method==='POST'){
      if(opts.body instanceof FormData){
        pdfs.push(await opts.body.get('file').text());
        const key='/attachment/'+opts.body.get('uuid')+'.json';
        assert.ok(!objects.has(key)); objects.set(key,{active:1}); return response({});
      }
      const body=JSON.parse(opts.body);
      if(/^\/job\/.+\.json$/.test(path)){
        assert.ok(objects.has(path));Object.assign(objects.get(path),body);return response({});
      }
      const key=path.replace('.json','/'+body.uuid+'.json');
      assert.ok(!objects.has(key),'must never duplicate remote records');objects.set(key,{...body,active:1});return response({});
    }
    return objects.has(path)?response(objects.get(path)):response({},404);
  };
  return {db,jobId,quoteId,version,snapshot,objects,calls,pdfs,...setup(db,fetchImpl)};
}
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
  const f=quoteHandoffFixture(),before=JSON.stringify([f.db.tables.jobs,f.db.tables.quotes]);
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
  assert.equal(JSON.stringify([f.db.tables.jobs,f.db.tables.quotes]),before);
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
  const before=JSON.stringify([f.db.tables.quotes,f.db.tables.jobs,f.db.tables.quote_versions]);
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
  assert.equal(JSON.stringify([f.db.tables.quotes,f.db.tables.jobs,f.db.tables.quote_versions]),before);
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
    price:s=>{s.details.services[0].priceSnapshot=230;},
    amount:s=>{s.amount=230;},
    gst:s=>{s.details.gstRegistered=false;},
    terms:s=>{s.details.publicTerms='Changed scope and terms';},
    geometry:s=>{s.details.areaPolys[0].points[0].x=5;},
    geoGeometry:s=>{s.details.areaPolys[0].geoPts[0].lat=-37.0001;},
    contact:s=>{s.customer.email='changed@example.test';},
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
