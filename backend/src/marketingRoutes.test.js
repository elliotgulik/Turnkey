import test from "node:test";
import assert from "node:assert/strict";
import {
  installMarketingRoutes,
  dateRange,
  normalizeRow,
  metaRow,
  derive,
  parseCSV,
  exportCSV,
  reportingKey,
  seal,
  unseal,
  graphPages,
  paged,
  attribution,
  CSV_COLUMNS,
} from "./marketingRoutes.js";
const row = (extra = {}) =>
  normalizeRow({
    date: "2026-10-01",
    level: "ad",
    account_id: "123",
    currency: "NZD",
    timezone: "Pacific/Auckland",
    campaign_id: "1",
    campaign_name: "Campaign",
    adset_id: "2",
    adset_name: "Set",
    ad_id: "3",
    ad_name: "Ad",
    spend: "20",
    impressions: "1000",
    reach: "500",
    clicks: "40",
    link_clicks: "30",
    leads: "4",
    ...extra,
  });
const key = "ab".repeat(32),
  jobId = "11111111-1111-4111-8111-111111111111";
test("strict inclusive dates and daily metrics; unknown values stay unknown", () => {
  assert.throws(() => dateRange("2026-02-30", "2026-03-01"));
  assert.throws(() => dateRange("2025-01-01", "2026-10-01"));
  assert.throws(() => dateRange("2026-10-02", "2026-10-01"));
  assert.throws(() => row({ spend: -1 }));
  assert.throws(() => row({ impressions: "1.5" }));
  assert.throws(() => row({ spend: "Infinity" }));
  assert.throws(() => row({ date_stop: "2026-10-02" }));
  assert.throws(() => row({ timezone: "bad/zone" }));
  assert.equal(row({ leads: "" }).leads, null);
});
test("weighted metrics, zero denominators and nonadditive reach", () => {
  const r = row();
  assert.deepEqual(derive([r]), {
    spend: 20,
    impressions: 1000,
    reach: 500,
    clicks: 40,
    link_clicks: 30,
    leads: 4,
    ctr: 4,
    cpc: 0.5,
    cpm: 20,
    frequency: 2,
    cpl: 5,
  });
  const totals = derive([r, row({ spend: 80, impressions: 1000, clicks: 10 })]);
  assert.equal(totals.ctr, 2.5);
  assert.equal(totals.cpc, 2);
  assert.equal(totals.reach, null);
  assert.equal(totals.frequency, null);
  assert.equal(derive([row({ clicks: 0, leads: 0 })]).cpc, null);
  assert.equal(derive([r, row({ leads: null })]).cpl, null);
  assert.equal(derive([]).spend, null);
});
test("Meta aggregate lead does not double count action subtypes or assume missing means zero", () => {
  const raw = {
    ...row(),
    date_start: "2026-10-01",
    account_currency: "NZD",
    inline_link_clicks: "30",
    actions: [
      { action_type: "lead", value: "4" },
      { action_type: "onsite_conversion.lead_grouped", value: "4" },
    ],
  };
  assert.equal(
    metaRow(raw, {
      level: "ad",
      account_id: "123",
      currency: "NZD",
      timezone: "Pacific/Auckland",
    }).leads,
    4,
  );
  assert.equal(
    metaRow(
      { ...raw, actions: [] },
      {
        level: "ad",
        account_id: "123",
        currency: "NZD",
        timezone: "Pacific/Auckland",
      },
    ).leads,
    null,
  );
  assert.throws(() =>
    metaRow(
      { ...raw, account_id: "999" },
      {
        level: "ad",
        account_id: "123",
        currency: "NZD",
        timezone: "Pacific/Auckland",
      },
    ),
  );
});
test("CSV quoted newlines/commas, BOM, unknowns and spreadsheet formula protection", () => {
  const r = row({ ad_name: 'A, "quoted"\nname', leads: null });
  assert.deepEqual(parseCSV("\uFEFF" + exportCSV([r])), [r]);
  assert.match(
    exportCSV([row({ ad_name: '=HYPERLINK("bad")' })]),
    /'=HYPERLINK/,
  );
  assert.throws(() => parseCSV(exportCSV([r, r])), /Duplicate/);
  assert.throws(
    () => parseCSV(CSV_COLUMNS.join(",") + '\n"unfinished'),
    /Unclosed/,
  );
  assert.throws(() => parseCSV("date,date\n1,2"), /headers/);
  assert.throws(() => parseCSV("x".repeat(4 * 1024 * 1024 + 1)), /4 MB/);
});
test("encryption is authenticated and bound to business + account", () => {
  const v = seal("sensitive-reporting-token", "business-a", "123", key);
  assert.ok(!v.includes("sensitive"));
  assert.equal(
    unseal(v, "business-a", "123", key),
    "sensitive-reporting-token",
  );
  assert.throws(() => unseal(v, "business-b", "123", key));
  assert.throws(() => unseal(v, "business-a", "999", key));
  assert.throws(() => unseal(v, "business-a", "123", "cd".repeat(32)));
  assert.throws(() => seal("x", "a", "123", "short"));
});
test("Meta follows only validated cursors on fixed official origin; no tokens in URLs", async () => {
  const calls = [];
  const rows = await graphPages(
    "act_123/insights",
    { level: "ad" },
    {
      token: "secret",
      env: {},
      fetchImpl: async (url, options) => {
        calls.push([String(url), options]);
        return {
          ok: true,
          json: async () =>
            calls.length === 1
              ? {
                  data: [{ id: 1 }],
                  paging: {
                    next: "https://evil.test/?access_token=secret",
                    cursors: { after: "NEXT" },
                  },
                }
              : { data: [{ id: 2 }] },
        };
      },
    },
  );
  assert.equal(rows.length, 2);
  assert.ok(
    calls.every(
      ([u]) =>
        u.startsWith("https://graph.facebook.com/v26.0/") &&
        !u.includes("secret"),
    ),
  );
  assert.match(calls[1][0], /after=NEXT/);
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].method, "GET");
});
test("pagination loops, bad pages, provider errors and rate limits fail closed", async () => {
  const opts = { token: "secret", env: {} };
  await assert.rejects(
    graphPages(
      "act_123/insights",
      {},
      {
        ...opts,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            data: [],
            paging: { next: "x", cursors: { after: "same" } },
          }),
        }),
      },
    ),
    /pagination/,
  );
  await assert.rejects(
    graphPages(
      "act_123/insights",
      {},
      {
        ...opts,
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          json: async () => ({ error: { message: "secret" } }),
        }),
      },
    ),
    (e) => e.status === 429 && !e.message.includes("secret"),
  );
  await assert.rejects(
    graphPages(
      "act_123/insights",
      {},
      {
        ...opts,
        fetchImpl: async () => {
          throw Error("secret");
        },
      },
    ),
    /unavailable/,
  );
  await assert.rejects(
    graphPages(
      "act_123/insights",
      {},
      {
        ...opts,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ surprise: true }),
        }),
      },
    ),
    /Invalid/,
  );
});
test("CRM cohort uses account timezone; unknown remains unknown; cancelled is not won", () => {
  const jobs = [
    { id: "one", created_at: "2026-09-30T12:30:00Z", status: "won" },
    { id: "two", created_at: "2026-10-01T00:00:00Z", status: "cancelled" },
    {
      id: "three",
      created_at: "2026-10-01T00:00:00Z",
      status: "won",
      details: { requestSubmittedAt: "invalid legacy date", createdAt: 1e20 },
    },
  ];
  const r = attribution(
    jobs,
    [
      { job_id: "one", ad_id: "3" },
      { job_id: "two", ad_id: "3" },
    ],
    "2026-10-01",
    "2026-10-01",
    "Pacific/Auckland",
  );
  assert.equal(r.cohortLeads, 3);
  assert.equal(r.unknownLeads, 1);
  assert.equal(r.byAd[0].won, 1);
});
test('Meta-supplied ad IDs automatically connect CRM leads to won opportunities without guessing', () => {
  const r = attribution([
    { id: 'meta-lead', created_at: '2026-10-01T00:00:00Z', status: 'won', details: { metaAdId: '77', total: 1250 } },
    { id: 'unattributed', created_at: '2026-10-01T00:00:00Z', status: 'won', details: { total: 800, source: 'Meta' } },
  ], [], '2026-10-01', '2026-10-01', 'Pacific/Auckland');
  assert.equal(r.linkedLeads, 1);
  assert.equal(r.unknownLeads, 1);
  assert.equal(r.byAd[0].adId, '77');
  assert.equal(r.byAd[0].metaLeadMatches, 1);
  assert.equal(r.byAd[0].wonQuotedValue, 1250);
  assert.match(r.basis, /not collected cash/);
});
function database(tables = {}) {
  const calls = [],
    rpc = [];
  return {
    tables,
    calls,
    rpcCalls: rpc,
    rpc: async (name, args) => {
      rpc.push([name, args]);
      return { data: null };
    },
    from(table) {
      let filters = [],
        op = "select",
        value,
        single = false,
        start = 0,
        end = Infinity;
      const q = {
        select() {
          return q;
        },
        eq(k, v) {
          filters.push((r) => r[k] === v);
          calls.push([table, k, v]);
          return q;
        },
        gte(k, v) {
          filters.push((r) => r[k] >= v);
          return q;
        },
        lte(k, v) {
          filters.push((r) => r[k] <= v);
          return q;
        },
        order() {
          return q;
        },
        range(a, b) {
          start = a;
          end = b;
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
        upsert(v) {
          op = "upsert";
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
              let rs = (tables[table] || []).filter((r) =>
                filters.every((f) => f(r)),
              );
              if (op === "insert" || op === "upsert") {
                (tables[table] ||= []).push(value);
                rs = [value];
              }
              if (op === "update") rs.forEach((r) => Object.assign(r, value));
              if (op === "delete")
                tables[table] = (tables[table] || []).filter(
                  (r) => !rs.includes(r),
                );
              rs = rs.slice(start, end + 1);
              return { data: single ? rs[0] || null : rs };
            })
            .then(resolve, reject);
        },
      };
      return q;
    },
  };
}
function harness({
  role = "owner",
  tables = {},
  fetchImpl = async () => {
    throw Error("Unexpected network");
  },
  getMetaRetrievalToken = async () => null,
  authenticated = true,
} = {}) {
  const db = database({
      users: [{ id: "user-a", business_id: "business-a", role }],
      ...tables,
    }),
    routes = {};
  const app = {};
  for (const m of ["get", "post", "delete"])
    app[m] = (p, ...handlers) => {
      routes[m + " " + p] = handlers;
    };
  installMarketingRoutes(app, {
    db,
    env: { MARKETING_TOKEN_KEY: key },
    fetchImpl,
    getMetaRetrievalToken,
    requireBusiness: (req, res, next) => {
      if (!authenticated)
        return res.status(401).json({ error: "Unauthenticated" });
      req.businessId = "business-a";
      req.userId = "user-a";
      next();
    },
  });
  return {
    db,
    async call(method, path, body = {}, query = {}) {
      const req = { body, query, params: {} },
        res = {
          code: 200,
          status(c) {
            this.code = c;
            return this;
          },
          set() {
            return this;
          },
          type() {
            return this;
          },
          json(v) {
            this.body = v;
            return this;
          },
          send(v) {
            this.body = v;
            return this;
          },
        };
      const hs = routes[method + " " + path];
      assert.ok(hs, "registered " + method + " " + path);
      async function invoke(i) {
        let next = false;
        await hs[i](req, res, () => {
          next = true;
        });
        if (next && i + 1 < hs.length) await invoke(i + 1);
      }
      await invoke(0);
      return res;
    },
  };
}
const connection = () => ({
  business_id: "business-a",
  account_id: "123",
  currency: "NZD",
  timezone: "Pacific/Auckland",
  generation: "generation",
  revision: 0,
  account_name: "Account",
  token_enc: seal("secret-token-with-length", "business-a", "123", key),
});
test("every route rejects staff and unauthenticated users; tenant identity comes from auth", async () => {
  for (const [m, p] of [
    ["get", "/connection"],
    ["post", "/connection"],
    ["delete", "/connection"],
    ["post", "/sync"],
    ["post", "/import"],
    ["get", "/report"],
    ["get", "/export"],
    ["get", "/template"],
    ["post", "/attribution"],
    ["delete", "/attribution/:jobId"],
  ]) {
    const h = harness({ role: "tech" });
    assert.equal(
      (await h.call(m, "/api/marketing" + p, { businessId: "business-b" }))
        .code,
      403,
    );
    assert.equal(h.db.rpcCalls.length, 0);
    assert.equal(
      (await harness({ authenticated: false }).call(m, "/api/marketing" + p))
        .code,
      401,
    );
  }
});
test("status never exposes ciphertext; disconnect touches only reporting account", async () => {
  const h = harness({ tables: { marketing_ad_connections: [connection()] } });
  const r = await h.call("get", "/api/marketing/connection");
  assert.equal(r.body.connected, true);
  assert.ok(!JSON.stringify(r.body).includes("token_enc"));
  await h.call("delete", "/api/marketing/connection");
  assert.equal(h.db.tables.marketing_ad_connections[0].token_enc, null);
  assert.ok(h.db.calls.every(([table]) => table !== "lead_sources"));
});
test("sync publishes only after all levels succeed, with fixed attribution settings", async () => {
  const urls = [];
  const h = harness({
    tables: { marketing_ad_connections: [connection()] },
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return { ok: true, json: async () => ({ data: [] }) };
    },
  });
  const r = await h.call("post", "/api/marketing/sync", {
    since: "2026-10-01",
    until: "2026-10-02",
  });
  assert.equal(r.code, 200);
  assert.equal(urls.length, 3);
  assert.equal(h.db.rpcCalls.length, 1);
  assert.deepEqual(h.db.rpcCalls[0][1].p_levels, ["campaign", "adset", "ad"]);
  assert.equal(h.db.rpcCalls[0][1].p_business, "business-a");
  assert.equal(urls[0].searchParams.get("time_increment"), "1");
  assert.equal(urls[0].searchParams.get("action_report_time"), "impression");
  assert.deepEqual(
    JSON.parse(urls[0].searchParams.get("action_attribution_windows")),
    ["7d_click", "1d_view"],
  );
  let n = 0;
  const bad = harness({
    tables: { marketing_ad_connections: [connection()] },
    fetchImpl: async () => ({
      ok: ++n === 1,
      status: 500,
      json: async () =>
        n === 1 ? { data: [] } : { error: { message: "secret" } },
    }),
  });
  assert.equal(
    (
      await bad.call("post", "/api/marketing/sync", {
        since: "2026-10-01",
        until: "2026-10-02",
      })
    ).code,
    502,
  );
  assert.equal(bad.db.rpcCalls.length, 0);
});
test("CSV scope validation prevents cross-account imports and replacement is atomic RPC", async () => {
  const h = harness({ tables: { marketing_ad_connections: [connection()] } }),
    body = {
      csv: exportCSV([row()]),
      since: "2026-10-01",
      until: "2026-10-01",
      level: "ad",
      businessId: "business-b",
    };
  assert.equal((await h.call("post", "/api/marketing/import", body)).code, 200);
  assert.equal(h.db.rpcCalls[0][1].p_business, "business-a");
  assert.equal(
    (
      await h.call("post", "/api/marketing/import", {
        ...body,
        csv: exportCSV([row({ account_id: "999" })]),
      })
    ).code,
    400,
  );
  assert.equal(h.db.rpcCalls.length, 1);
});
test("report exposes incomplete coverage and paginates without truncating totals", async () => {
  const h = harness({
    tables: {
      marketing_ad_connections: [connection()],
      marketing_daily_snapshots: [
        {
          id: "s",
          business_id: "business-a",
          account_id: "123",
          level: "ad",
          date: "2026-10-01",
          rows: [row(), row({ ad_id: "4" })],
          source: "csv",
          updated_at: "2026-10-01T00:00:00Z",
        },
      ],
      jobs: [],
    },
  });
  let r = await h.call(
    "get",
    "/api/marketing/report",
    {},
    { since: "2026-10-01", until: "2026-10-02", level: "ad", limit: "1" },
  );
  assert.equal(r.code, 200);
  assert.equal(r.body.totals, null);
  assert.equal(r.body.entities.length, 1);
  assert.equal(r.body.total, 2);
  r = await h.call(
    "get",
    "/api/marketing/report",
    {},
    {
      since: "2026-10-01",
      until: "2026-10-01",
      level: "ad",
      limit: "1",
      page: "1",
    },
  );
  assert.equal(r.body.totals.spend, 40);
  assert.equal(r.body.entities[0].id, "4");
  assert.equal(r.body.totals.reach, null);
  assert.equal(
    (
      await h.call(
        "get",
        "/api/marketing/report",
        {},
        { since: "2026-10-01", until: "2026-10-01", page: "-1" },
      )
    ).code,
    400,
  );
});
test("database pagination reads past 1,000 with business filter on every page", async () => {
  const db = database({
    jobs: Array.from({ length: 1205 }, (_, i) => ({
      id: String(i),
      business_id: i < 1200 ? "a" : "b",
    })),
  });
  const rows = await paged(db, "jobs", "a");
  assert.equal(rows.length, 1200);
  assert.equal(db.calls.filter((c) => c[1] === "business_id").length, 3);
});
test("cannot attach another business job", async () => {
  const h = harness({
    tables: {
      marketing_ad_connections: [connection()],
      jobs: [{ id: jobId, business_id: "business-b" }],
    },
  });
  const r = await h.call("post", "/api/marketing/attribution", {
    jobId,
    adId: "3",
    evidence: "An explicit ad ID captured on form submission",
  });
  assert.equal(r.code, 404);
  assert.equal(h.db.tables.marketing_attribution_links, undefined);
});
test("connection checks ads_read before saving and refuses an account switch", async () => {
  const missing = harness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ permission: "ads_management", status: "granted" }],
      }),
    }),
  });
  assert.equal(
    (
      await missing.call("post", "/api/marketing/connection", {
        accountId: "123",
        token: "token-with-enough-characters",
      })
    ).code,
    403,
  );
  assert.equal(missing.db.tables.marketing_ad_connections, undefined);
  const h = harness({ tables: { marketing_ad_connections: [connection()] } });
  assert.equal(
    (
      await h.call("post", "/api/marketing/connection", {
        accountId: "999",
        currency: "NZD",
        timezone: "Pacific/Auckland",
      })
    ).code,
    409,
  );
});

test("reject duplicate entity-day even when parent IDs differ; forbid child IDs in parent rows", () => {
  assert.throws(
    () => parseCSV(exportCSV([row(), row({ campaign_id: "8" })])),
    /Duplicate/,
  );
  assert.throws(() => row({ level: "campaign" }), /child entity/);
  assert.throws(() => row({ level: "adset" }), /child entity/);
});
test("overall sync deadline prevents a request from starting", async () => {
  let called = false;
  await assert.rejects(
    graphPages(
      "act_123/insights",
      {},
      {
        token: "secret",
        deadline: Date.now() - 1,
        fetchImpl: async () => {
          called = true;
        },
      },
    ),
    (e) => e.status === 504,
  );
  assert.equal(called, false);
});
test("successful connection stores ciphertext and returns only safe account fields", async () => {
  let n = 0;
  const h = harness({
    fetchImpl: async () => ({
      ok: true,
      json: async () =>
        ++n === 1
          ? { data: [{ permission: "ads_read", status: "granted" }] }
          : {
              id: "act_123",
              account_id: "123",
              name: "Account",
              currency: "NZD",
              timezone_name: "Pacific/Auckland",
            },
    }),
  });
  const token = "reporting-token-must-not-be-returned";
  const r = await h.call("post", "/api/marketing/connection", {
    accountId: "123",
    token,
  });
  assert.equal(r.code, 200);
  const c = h.db.tables.marketing_ad_connections[0];
  assert.equal(unseal(c.token_enc, "business-a", "123", key), token);
  assert.ok(!JSON.stringify(r.body).includes(token));
  assert.equal(r.body.token_enc, undefined);
  assert.equal(r.body.connected, true);
});
test("reporting can reuse the authenticated business's saved Meta retrieval token", async () => {
  let n = 0, seenToken;
  const h = harness({
    getMetaRetrievalToken: async (businessId) => {
      assert.equal(businessId, "business-a");
      return "saved-system-user-token-with-ads-read";
    },
    fetchImpl: async (_url, options = {}) => {
      seenToken = options.headers?.Authorization?.replace("Bearer ", "");
      return {
        ok: true,
        json: async () => ++n === 1
          ? { data: [{ permission: "ads_read", status: "granted" }] }
          : { id: "act_123", account_id: "123", name: "Account", currency: "NZD", timezone_name: "Pacific/Auckland" },
      };
    },
  });
  const r = await h.call("post", "/api/marketing/connection", {
    accountId: "123", useConnectedLeadToken: true,
  });
  assert.equal(r.code, 200);
  assert.equal(seenToken, "saved-system-user-token-with-ads-read");
  assert.equal(unseal(h.db.tables.marketing_ad_connections[0].token_enc, "business-a", "123", key), seenToken);
  assert.ok(!JSON.stringify(r.body).includes(seenToken));
});
test("a saved Meta token with one accessible ad account connects without asking for its ID", async () => {
  const calls = [];
  let n = 0;
  const h = harness({
    getMetaRetrievalToken: async () => "saved-system-user-token-with-ads-read",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), token: options.headers?.Authorization?.replace("Bearer ", "") });
      const index = n++;
      return { ok: true, json: async () => index === 0
        ? { data: [{ permission: "ads_read", status: "granted" }] }
        : index === 1
          ? { data: [{ account_id: "123", name: "Nova Ads", currency: "NZD", timezone_name: "Pacific/Auckland" }] }
          : { data: [{ id: "act_123", account_id: "123", name: "Nova Ads", currency: "NZD", timezone_name: "Pacific/Auckland" }] } };
    },
  });
  const r = await h.call("post", "/api/marketing/connection", { useConnectedLeadToken: true });
  assert.equal(r.code, 200);
  assert.equal(r.body.accountId, "123");
  assert.equal(r.body.name, "Nova Ads");
  assert.ok(calls.some((x) => x.url.includes("me/adaccounts")));
  assert.ok(calls.every((x) => x.token === "saved-system-user-token-with-ads-read"));
});
test("saved Meta token with multiple ad accounts returns safe choices without storing a connection", async () => {
  let n = 0;
  const h = harness({
    getMetaRetrievalToken: async () => "saved-system-user-token-with-ads-read",
    fetchImpl: async () => ({ ok: true, json: async () => ++n === 1
      ? { data: [{ permission: "ads_read", status: "granted" }] }
      : { data: [
          { account_id: "123", name: "Nova Ads", currency: "NZD", timezone_name: "Pacific/Auckland" },
          { account_id: "456", name: "Other Ads", currency: "AUD", timezone_name: "Australia/Sydney" },
        ] } }),
  });
  const r = await h.call("post", "/api/marketing/connection", { useConnectedLeadToken: true });
  assert.equal(r.code, 200);
  assert.equal(r.body.requiresSelection, true);
  assert.deepEqual(r.body.accounts.map((a) => a.accountId), ["123", "456"]);
  assert.equal(h.db.tables.marketing_ad_connections, undefined);
  assert.ok(!JSON.stringify(r.body).includes("saved-system-user-token"));
});
test("permission lookup failure exposes no database details and performs no reporting writes", async () => {
  const h = harness();
  h.db.from = () => {
    throw Error("secret internal database password");
  };
  const r = await h.call("get", "/api/marketing/connection");
  assert.equal(r.code, 503);
  assert.ok(!JSON.stringify(r.body).includes("secret"));
  assert.equal(h.db.rpcCalls.length, 0);
});

test("reporting fallback derives an isolated stable key and honours explicit keys",()=>{
 const env={EMAIL_TOKEN_KEY:"a-private-server-secret"},key=reportingKey(env);
 assert.equal(key.length,64);assert.equal(key,reportingKey(env));
 assert.notEqual(key,reportingKey({EMAIL_TOKEN_KEY:"another-secret"}));
 assert.equal(unseal(seal("reporting-token","biz","account",key),"biz","account",key),"reporting-token");
 assert.equal(reportingKey({MARKETING_TOKEN_KEY:"a".repeat(64)}),"a".repeat(64));
 assert.throws(()=>reportingKey({...env,MARKETING_TOKEN_KEY:"invalid"}),/64 hex/);
 assert.throws(()=>reportingKey({}),/encryption key/);
});
