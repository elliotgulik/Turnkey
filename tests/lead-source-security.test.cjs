const { test } = require("node:test");
const assert = require("node:assert/strict"),
  fs = require("node:fs");
test("lead source migration is idempotent and backend-only with concurrent uniqueness", async () => {
  const { PGlite } = await import("@electric-sql/pglite"),
    db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create table lead_sources(id uuid primary key default gen_random_uuid(),business_id text not null,provider text not null,external_id text not null,unique(provider,external_id));
  grant all on lead_sources to anon,authenticated;
  insert into lead_sources(business_id,provider,external_id) values('business-a','wix','hashed-token');`);
    const sql = fs.readFileSync(
      "supabase/migrations/20261015071000_secure_lead_sources.sql",
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    for (const role of ["anon", "authenticated"]) {
      await db.exec("set role " + role);
      await assert.rejects(
        db.query("select * from lead_sources"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("delete from lead_sources"),
        /permission denied/,
      );
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.equal(
      (await db.query("select count(*)::int n from lead_sources")).rows[0].n,
      1,
    );
    await assert.rejects(
      db.query(
        "insert into lead_sources(business_id,provider,external_id) values('business-a','wix','different-hash')",
      ),
      /unique/,
    );
  } finally {
    await db.close();
  }
});
