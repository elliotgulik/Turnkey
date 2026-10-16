const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"),
  fs = require("node:fs");
let db;
const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = (extra = {}) => ({
  date: "2026-10-01",
  level: "ad",
  account_id: "123",
  currency: "NZD",
  timezone: "Pacific/Auckland",
  campaign_id: "1",
  adset_id: "2",
  ad_id: "3",
  spend: 20,
  ...extra,
});
const migration = fs
  .readdirSync("supabase/migrations")
  .find((n) => n.endsWith("_marketing_analytics.sql"));
before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create table public.jobs(id uuid primary key,business_id text);`,
  );
  await db.exec(fs.readFileSync("supabase/migrations/" + migration, "utf8"));
  await db.exec(
    `insert into public.marketing_ad_connections(business_id,account_id,account_name,currency,timezone,generation) values('a','123','A','NZD','Pacific/Auckland','${generation}'),('b','999','B','USD','UTC','${generation}');`,
  );
});
after(async () => db?.close());
async function publish({
  business = "a",
  revision = 0,
  rows = [row()],
  since = "2026-10-01",
  until = "2026-10-02",
  source = "meta",
  gen = generation,
  levels = ["ad"],
} = {}) {
  return db.query(
    "select public.marketing_publish($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
    [
      business,
      gen,
      revision,
      since,
      until,
      levels,
      JSON.stringify(rows),
      source,
    ],
  );
}
test("migration installs RLS, private service-only tables and invoker RPC", async () => {
  const { rows } = await db.query(
    "select relname,relrowsecurity from pg_class where relname in ('marketing_ad_connections','marketing_daily_snapshots','marketing_attribution_links')",
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.relrowsecurity));
  for (const role of ["anon", "authenticated"])
    for (const table of [
      "marketing_ad_connections",
      "marketing_daily_snapshots",
      "marketing_attribution_links",
    ]) {
      const r = await db.query(
        "select has_table_privilege($1,$2,$3) as allowed",
        [role, table, "SELECT,INSERT,UPDATE,DELETE"],
      );
      assert.equal(r.rows[0].allowed, false);
    }
  const f = await db.query(
    "select prosecdef,has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where proname='marketing_publish'",
  );
  assert.equal(f.rows[0].prosecdef, false);
  assert.equal(f.rows[0].allowed, false);
});
test("publisher creates complete empty-day coverage, and atomic replacement removes stale entities", async () => {
  await publish();
  let r = await db.query(
    "select date,rows,source from marketing_daily_snapshots where business_id='a' order by date",
  );
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].rows.length, 1);
  assert.equal(r.rows[1].rows.length, 0);
  await publish({
    revision: 1,
    rows: [row({ ad_id: "4", spend: 30 })],
    until: "2026-10-01",
    source: "csv",
  });
  r = await db.query(
    "select rows,source from marketing_daily_snapshots where business_id='a' and date='2026-10-01'",
  );
  assert.equal(r.rows[0].rows[0].ad_id, "4");
  assert.equal(r.rows[0].rows.length, 1);
  assert.equal(r.rows[0].source, "csv");
  const c = await db.query(
    "select revision,last_sync_at,last_import_at from marketing_ad_connections where business_id='a'",
  );
  assert.equal(Number(c.rows[0].revision), 2);
  assert.ok(c.rows[0].last_sync_at);
  assert.ok(c.rows[0].last_import_at);
});
test("stale revisions and connection generations preserve saved rows", async () => {
  await assert.rejects(publish({ revision: 1, rows: [] }), /revision changed/);
  await assert.rejects(
    publish({
      revision: 2,
      gen: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      rows: [],
    }),
    /revision changed/,
  );
  const r = await db.query(
    "select rows from marketing_daily_snapshots where business_id='a' and date='2026-10-01'",
  );
  assert.equal(r.rows[0].rows[0].ad_id, "4");
});
test("invalid, duplicate and cross-account batches roll back without touching another tenant", async () => {
  for (const rows of [
    [row({ account_id: "999" })],
    [row({ currency: "USD" })],
    [row({ date: "2026-10-03" })],
    [row(), row()],
    [row({ level: "campaign" })],
  ])
    await assert.rejects(publish({ revision: 2, rows }));
  const a = await db.query(
    "select revision from marketing_ad_connections where business_id='a'",
  );
  assert.equal(Number(a.rows[0].revision), 2);
  const b = await db.query(
    "select count(*) n from marketing_daily_snapshots where business_id='b'",
  );
  assert.equal(Number(b.rows[0].n), 0);
});
test("authenticated and anon cannot query credentials or call publisher directly", async () => {
  for (const role of ["authenticated", "anon"]) {
    await db.exec("set role " + role);
    try {
      await assert.rejects(
        db.query("select token_enc from public.marketing_ad_connections"),
        /permission denied/,
      );
      await assert.rejects(publish({ revision: 2 }), /permission denied/);
    } finally {
      await db.exec("reset role");
    }
  }
});
test("service role can execute publisher with explicit table grants", async () => {
  await db.exec("set role service_role");
  try {
    await publish({
      business: "b",
      revision: 0,
      rows: [row({ account_id: "999", currency: "USD", timezone: "UTC" })],
    });
    const r = await db.query(
      "select count(*) n from marketing_daily_snapshots where business_id='b'",
    );
    assert.equal(Number(r.rows[0].n), 2);
  } finally {
    await db.exec("reset role");
  }
});
