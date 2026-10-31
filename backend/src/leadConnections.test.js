import test from "node:test";
import assert from "node:assert/strict";
import { installLeadConnections } from "./leadConnections.js";
import { hashWixToken } from "./wixLeads.js";
function fakeDb(initial = []) {
  const db = {
    rows: structuredClone(initial),
    fail: null,
    beforeWrite: null,
    writes: [],
    from() {
      let op = "select",
        value,
        filters = [],
        single = false;
      const q = {
        select() {
          return q;
        },
        order() { return q; },
        limit() { return q; },
        eq(k, v) {
          filters.push((r) => r[k] === v);
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        update(v) {
          op = "update";
          value = v;
          return q;
        },
        insert(v) {
          op = "insert";
          value = v;
          return q;
        },
        delete() {
          op = "delete";
          return q;
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(async () => {
              if (db.fail === op)
                return {
                  error: { code: "XX000", message: "private database details" },
                };
              if (op !== "select") {
                if (db.beforeWrite) await db.beforeWrite(op, value);
                db.writes.push({ op, value });
              }
              let rows = db.rows.filter((r) => filters.every((f) => f(r)));
              if (op === "update" || op === "insert") {
                const candidate =
                  op === "insert" ? value : { ...rows[0], ...value };
                if (
                  db.rows.some(
                    (r) =>
                      (op === "insert" && r.id === candidate.id) ||
                      (r.provider === candidate.provider &&
                        r.external_id === candidate.external_id &&
                        (op === "insert" || !rows.includes(r))),
                  )
                )
                  return { error: { code: "23505" } };
                if (op === "insert") {
                  db.rows.push({ ...value });
                  rows = [value];
                } else rows.forEach((r) => Object.assign(r, value));
              }
              if (op === "delete")
                db.rows = db.rows.filter((r) => !rows.includes(r));
              return { data: single ? rows[0] || null : rows, error: null };
            })
            .then(resolve, reject);
        },
      };
      return q;
    },
  };
  return db;
}
function setup(db, options = {}) {
  const routes = new Map(),
    app = {
      get: (path, ...handlers) => routes.set("GET " + path, handlers),
      post: (path, ...handlers) => routes.set("POST " + path, handlers),
    };
  installLeadConnections(app, {
    db,
    requireBusiness: (req, res, next) => next(),
    encrypt: (t) => "encrypted-" + t,
    decrypt: () => "private-page-token",
    fetchEdge: async () => ({ ok: true, json: async () => ({ success: true }) }),
    generateToken: () => "new-test-token",
    inspectToken: async () => ({ type: 'SYSTEM_USER', expiresAt: 0 }),
    fetchPage: async (id) => ({
      ok: true,
      json: async () => ({ id, name: "Page" }),
    }),
    env: { PUBLIC_BACKEND_URL: "https://backend.example" },
    ...options,
  });
  return async (path, { businessId = "A", body = {} } = {}) => {
    const req = { businessId, body };
    const res = {
      statusCode: 200,
      status(n) {
        this.statusCode = n;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    await routes.get(path).at(-1)(req, res);
    return res;
  };
}
const wix = {
  id: "old-wix",
  business_id: "A",
  provider: "wix",
  external_id: hashWixToken("working-token"),
};
const meta = {
  id: "old-meta",
  business_id: "A",
  provider: "meta",
  external_id: "111",
  token_enc: "working-encrypted-token",
};
test("Meta rejects a foreign page with 409 without fetching or changing either business", async () => {
  const db = fakeDb([
    meta,
    { ...meta, id: "foreign", business_id: "B", external_id: "222" },
  ]);
  const before = structuredClone(db.rows);
  const route = setup(db, {
    fetchPage: async () =>
      assert.fail("foreign mapping must be rejected first"),
  });
  const res = await route("POST /api/connections/meta/connect", {
    body: { pageId: "222", retrievalToken: "valid-system-user-token" },
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(db.rows, before);
  assert.equal(db.writes.length, 0);
});
test("a racing Meta page claim returns 409 and preserves the prior connection", async () => {
  const db = fakeDb([meta]);
  db.beforeWrite = async () => {
    db.beforeWrite = null;
    db.rows.push({
      ...meta,
      id: "racer",
      business_id: "B",
      external_id: "222",
    });
  };
  const res = await setup(db)("POST /api/connections/meta/connect", {
    body: { pageId: "222", retrievalToken: "valid-system-user-token" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(db.rows.find((r) => r.id === meta.id).external_id, "111");
  assert.equal(db.rows.find((r) => r.id === "racer").business_id, "B");
});
test('Meta setup uses one System User token and derives the Page token server-side', async () => {
  const db = fakeDb();
  const calls = [];
  let encryptedPlaintext;
  const res = await setup(db, {
    encrypt: value => { encryptedPlaintext = value; return 'encrypted-envelope'; },
    fetchPage: async (id, options) => {
      calls.push({ id, edge: 'page', options });
      return { ok: true, json: async () => ({ id, name: 'Page', access_token: 'derived-page-token' }) };
    },
    fetchEdge: async (id, edge, options) => {
      calls.push({ id, edge, options });
      return { ok: true, json: async () => edge === 'leadgen_forms' ? { data: [] } : { success: true } };
    },
  })('POST /api/connections/meta/connect', {
    body: { pageId: '973487265846279', retrievalToken: 'system-user-token' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.find(x => x.edge === 'leadgen_forms').options.token, 'derived-page-token');
  assert.equal(calls.find(x => x.edge === 'subscribed_apps').options.token, 'derived-page-token');
  assert.equal(res.body.health, 'ready');
  assert.match(encryptedPlaintext, /system-user-token/);
  assert.match(encryptedPlaintext, /derived-page-token/);
  assert.doesNotMatch(JSON.stringify(res.body), /system-user-token|derived-page-token|encrypted-envelope/);
});
test("Meta connect accepts one System User token and stores the Page token returned by Meta", async () => {
  const db = fakeDb(), calls = [];
  let encryptedPlaintext;
  const res = await setup(db, {
    encrypt: value => { encryptedPlaintext = value; return "encrypted"; },
    fetchPage: async (id, options) => {
      calls.push({ id, options });
      return { ok: true, json: async () => ({ id, name: "Nova Exterior", access_token: "derived-page-token" }) };
    },
    fetchEdge: async (_id, edge, options) => {
      calls.push({ edge, options });
      return { ok: true, json: async () => edge === "leadgen_forms" ? { data: [] } : { success: true } };
    },
  })("POST /api/connections/meta/connect", {
    body: { pageId: "973487265846279", retrievalToken: "single-system-user-token" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].options.token, "single-system-user-token");
  assert.equal(calls.find((x) => x.edge === "leadgen_forms").options.token, "derived-page-token");
  assert.equal(calls.find((x) => x.edge === "subscribed_apps").options.token, "derived-page-token");
  assert.match(encryptedPlaintext, /single-system-user-token/);
  assert.match(encryptedPlaintext, /derived-page-token/);
  assert.doesNotMatch(JSON.stringify(res.body), /single-system-user-token|derived-page-token/);
});
test('Meta accepts a correctly-scoped user token and exchanges it before storing', async () => {
  const db = fakeDb(), checks = [], calls = [];
  const res = await setup(db, {
    inspectToken: async ({ token }) => {
      checks.push(token);
      return { type: 'USER', expiresAt: token === 'short-lived-user-token' ? 1900000000 : 0, scopes: ['leads_retrieval', 'pages_manage_metadata'] };
    },
    exchangeUserToken: async ({ token }) => {
      assert.equal(token, 'short-lived-user-token');
      return { accessToken: 'exchanged-user-token', expiresIn: 5184000 };
    },
    fetchPage: async (id, options) => {
      calls.push({ edge: 'page', options });
      return { ok: true, json: async () => ({ id, name: 'Nova Exterior', access_token: 'page-scoped-token' }) };
    },
    fetchEdge: async (_id, edge, options) => {
      calls.push({ edge, options });
      return { ok: true, json: async () => edge === 'leadgen_forms' ? { data: [] } : { success: true } };
    },
  })('POST /api/connections/meta/connect', {
    body: { pageId: '973487265846279', token: 'short-lived-user-token' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(checks, ['short-lived-user-token', 'exchanged-user-token']);
  assert.equal(calls.find(x => x.edge === 'page').options.token, 'exchanged-user-token');
  assert.equal(calls.find(x => x.edge === 'leadgen_forms').options.token, 'page-scoped-token');
  assert.equal(calls.find(x => x.edge === 'subscribed_apps').options.token, 'page-scoped-token');
  assert.equal(res.body.tokenType, 'USER');
  assert.equal(res.body.adsReportingAvailable, false);
  assert.doesNotMatch(JSON.stringify(res.body), /short-lived-user-token|exchanged-user-token|page-scoped-token/);
});
test("failed Wix regeneration preserves the working hash and never reveals a new URL", async () => {
  const db = fakeDb([wix]);
  db.fail = "update";
  const res = await setup(db)("POST /api/connections/wix/connect");
  assert.equal(res.statusCode, 503);
  assert.equal(db.rows[0].external_id, wix.external_id);
  assert.equal(res.body.webhookUrl, undefined);
  assert.equal(db.writes.length, 0);
});
test("Wix regeneration updates only its existing tenant row in one statement", async () => {
  const db = fakeDb([
    wix,
    { ...wix, id: "B-wix", business_id: "B", external_id: "B-hash" },
  ]);
  const res = await setup(db)("POST /api/connections/wix/connect");
  assert.equal(res.statusCode, 200);
  assert.equal(
    res.body.webhookUrl,
    "https://backend.example/api/leads/wix/new-test-token",
  );
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[0].external_id, hashWixToken("new-test-token"));
  assert.equal(db.rows[1].external_id, "B-hash");
  assert.deepEqual(
    db.writes.map((x) => x.op),
    ["update"],
  );
});
test("concurrent first Wix connects cannot create two active rows for a business", async () => {
  const db = fakeDb();
  let calls = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  db.beforeWrite = async () => {
    if (++calls === 2) release();
    await barrier;
  };
  let token = 0;
  const route = setup(db, { generateToken: () => `token-${++token}` });
  const results = await Promise.all([
    route("POST /api/connections/wix/connect"),
    route("POST /api/connections/wix/connect"),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(db.rows.length, 1);
  const successful = results.find((r) => r.statusCode === 200);
  assert.equal(
    db.rows[0].external_id,
    hashWixToken(successful.body.webhookUrl.split("/").at(-1)),
  );
});
test("concurrent Wix token regeneration returns one live URL and one conflict", async () => {
  const db = fakeDb([wix]);
  let calls = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  db.beforeWrite = async () => {
    if (++calls === 2) release();
    await barrier;
  };
  let token = 0;
  const route = setup(db, { generateToken: () => `rotated-${++token}` });
  const results = await Promise.all([
    route("POST /api/connections/wix/connect"),
    route("POST /api/connections/wix/connect"),
  ]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  const winner = results.find(r => r.statusCode === 200).body.webhookUrl.split("/").at(-1);
  assert.equal(db.rows[0].external_id, hashWixToken(winner));
});
test("status and disconnect errors surface safely for both providers", async () => {
  for (const provider of ["wix", "meta"])
    for (const action of ["status", "disconnect"]) {
      const db = fakeDb([wix, meta]);
      db.fail = action === "status" ? "select" : "delete";
      const res = await setup(db)(
        `${action === "status" ? "GET" : "POST"} /api/connections/${provider}/${action}`,
      );
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.ok, undefined);
      assert.equal(res.body.connected, undefined);
      assert.doesNotMatch(JSON.stringify(res.body), /private database/);
      assert.equal(db.rows.length, 2);
    }
});
test("disconnect is tenant-scoped and provider-scoped", async () => {
  const db = fakeDb([wix, meta, { ...wix, id: "B", business_id: "B" }]);
  assert.equal(
    (await setup(db)("POST /api/connections/wix/disconnect")).statusCode,
    200,
  );
  assert.deepEqual(
    db.rows.map((r) => r.id),
    ["old-meta", "B"],
  );
});
test("Wix parser rejects oversized JSON before the general 25mb parser", async () => {
  const { default: express } = await import("express");
  const { installWixBodyParser } = await import("./leadConnections.js");
  const { request } = await import("node:http");
  const app = express();
  installWixBodyParser(app);
  app.use(express.json({ limit: "25mb" }));
  let persisted = 0;
  app.post("/api/leads/wix/:token", (req, res) => {
    persisted++;
    res.json({ ok: true });
  });
  app.post("/other", (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) =>
    res.status(error.status || 500).json({ error: "Rejected" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const send = (path, body) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    const large = JSON.stringify({ name: "Jane", notes: "a".repeat(65536) });
    assert.equal(await send("/api/leads/wix/test", large), 413);
    assert.equal(persisted, 0);
    assert.equal(
      await send("/api/leads/wix/test", JSON.stringify({ name: "Jane" })),
      200,
    );
    assert.equal(persisted, 1);
    assert.equal(await send("/other", large), 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Meta repair uses only authenticated business mapping and never returns credentials', async () => {
  const db = fakeDb([meta, { ...meta, id: 'B', business_id: 'B', external_id: '222' }]);
  let observed;
  const route = setup(db, { fetchEdge: async (id, edge, opts) => {
    observed = { id, edge, opts }; return { ok: true, json: async () => ({ success: true }) };
  }});
  const res = await route('POST /api/connections/meta/repair', { body: { pageId: '222' } });
  assert.equal(res.body.health, 'ready'); assert.equal(observed.id, '111');
  assert.equal(observed.opts.method, 'POST'); assert.equal(observed.opts.body.subscribed_fields, 'leadgen');
  assert.doesNotMatch(JSON.stringify(res.body), /private-page-token|working-encrypted-token/);
  assert.equal(db.writes.length, 0);
});
test('expired Meta credential reports reconnect even when a connection row exists', async () => {
  const res = await setup(fakeDb([meta]), { fetchPage: async () => ({ ok: false, json: async () => ({ error: { code: 190, message: 'private details' } }) }) })('POST /api/connections/meta/check');
  assert.equal(res.body.health, 'reconnect'); assert.equal(res.body.connected, true);
  assert.doesNotMatch(JSON.stringify(res.body), /private details/);
});
test('another subscribed app cannot produce a healthy status for this app', async () => {
  const res = await setup(fakeDb([meta]), { env: { META_APP_ID: 'ours' }, fetchEdge: async () => ({ ok: true, json: async () => ({ data: [{ id: 'other', subscribed_fields: ['leadgen'] }] }) }) })('POST /api/connections/meta/check');
  assert.equal(res.body.health, 'subscription_missing'); assert.equal(res.body.subscribed, false);
});
test('a missing Meta mapping and unreadable credential cannot trigger external requests', async () => {
  const options = { fetchPage: async () => assert.fail('must not request Meta'), decrypt: () => { throw new Error('private key details'); } };
  assert.equal((await setup(fakeDb(), options)('POST /api/connections/meta/repair')).statusCode, 404);
  const res = await setup(fakeDb([meta]), options)('POST /api/connections/meta/check');
  assert.equal(res.statusCode, 503); assert.doesNotMatch(JSON.stringify(res.body), /private key details/);
});

test('Meta historical import ignores client tenant/Page IDs and stores only mapped business leads', async () => {
  const db = fakeDb([meta, {...meta,id:'other',business_id:'B',external_id:'222'}]);
  const saved=[];
  const calls=[];
  const route=setup(db,{decrypt:()=>JSON.stringify({version:1,retrievalToken:'system-user-token',pageToken:'derived-page-token'}),addLead:async p=>{saved.push(p);return {id:'saved'};},fetchEdge:async(id,edge,options)=>{calls.push({id,edge,options});return {ok:true,json:async()=>({data:edge==='leadgen_forms'?(assert.equal(id,'111'),[{id:'333'}]):[{id:'444',form_id:'333',created_time:'2026-09-01',field_data:[{name:'full_name',values:['Fixture']}]}]})}}});
  const res=await route('POST /api/connections/meta/import',{body:{businessId:'B',pageId:'222',formId:'999'}});
  assert.equal(res.statusCode,200);assert.equal(res.body.imported,1);assert.equal(saved[0].business_id,'A');assert.equal(saved[0].historicalImport,true);assert.equal(saved[0].external_id,'444');assert.equal(JSON.stringify(res.body).includes('private-page-token'),false);
  assert.ok(calls.every(call=>call.options.token==='derived-page-token'));
});
test('Meta import storage failure is retryable and never claims completion', async () => {
  const db=fakeDb([meta]);
  const route=setup(db,{addLead:async()=>{throw Error('secret db failure');},fetchEdge:async(id,edge)=>({ok:true,json:async()=>({data:edge==='leadgen_forms'?[{id:'333'}]:[{id:'444',field_data:[]}]})})});
  const res=await route('POST /api/connections/meta/import');assert.equal(res.statusCode,503);assert.equal(res.body.done,undefined);assert.doesNotMatch(res.body.error,/secret/);
});
