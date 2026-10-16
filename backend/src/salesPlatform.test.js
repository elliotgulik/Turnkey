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
  assert.deepEqual(db.tables.external_object_mappings[0].snapshot,{status:'Completed',completed:true,active:true,invoiceSent:true,paymentReceived:true,invoicedTotal:115,collectedTotal:115});
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
