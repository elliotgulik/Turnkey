const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"),
  fs = require("node:fs");
let db;
const biz = "test-business-a",
  other = "test-business-b",
  cid = "11111111-1111-4111-8111-111111111111",
  qid = "22222222-2222-4222-8222-222222222222",
  jid = "33333333-3333-4333-8333-333333333333",
  uid = "44444444-4444-4444-8444-444444444444";
before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
  await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.users(id uuid primary key,business_id text,role text);
 create function public.current_business_id() returns text language sql security definer set search_path=public as $$select business_id from users where id=auth.uid()$$;
 create table public.customers(id uuid primary key default gen_random_uuid(),business_id text,name text,address text,suburb text,email text,phone text);
 create table public.businesses(id text primary key,name text,phone text,email text,logo_url text,accent_color text,primary_color text,font_style text,header_style text,quote_intro_message text,policies_config jsonb);
 create table public.quotes(id uuid primary key default gen_random_uuid(),business_id text,lead_id text,amount numeric,status text,public_token uuid default gen_random_uuid(),created_at timestamptz default now());
 create table public.jobs(id uuid primary key default gen_random_uuid(),business_id text,customer_id uuid,quote_id text,status text,details jsonb,created_at timestamptz default now());
 create table public.activity_log(id uuid primary key default gen_random_uuid(),business_id text,customer_id uuid,job_id uuid,type text,summary text,detail jsonb,created_at timestamptz default now());
 insert into users values('${uid}','${biz}','owner');
 insert into customers(id,business_id,name) values('${cid}','${biz}','Test customer');
 insert into quotes(id,business_id,lead_id,amount,status) values('${qid}','${biz}','${cid}',115,'sent');
 insert into jobs(id,business_id,customer_id,quote_id,status,details) values('${jid}','${biz}','${cid}','${qid}','quoted','{"total":115,"gstRegistered":true,"estimatedCost":45,"services":[{"svc":"driveway","qty":10,"priceSnapshot":115}],"salesHistory":[]}');
 `);
  await db.exec(
    fs.readFileSync("backend/supabase/schema-servicem8.sql", "utf8"),
  );
  await db.exec(
    fs.readFileSync(
      "supabase/migrations/20261015061746_sales_platform.sql",
      "utf8",
    ),
  );
});
after(async () => await db?.close());
test("migration is idempotent", async () => {
  await db.exec(
    fs.readFileSync(
      "supabase/migrations/20261015061746_sales_platform.sql",
      "utf8",
    ),
  );
});
test("public quote approval is idempotent and stamps the won date", async () => {
  const {
    rows: [q],
  } = await db.query(`select public_token from quotes where id=$1`, [qid]);
  await db.query(`select respond_to_public_quote($1,'accept')`, [
    q.public_token,
  ]);
  await db.query(`select respond_to_public_quote($1,'accept')`, [
    q.public_token,
  ]);
  const {
    rows: [j],
  } = await db.query(`select status,details from jobs where id=$1`, [jid]);
  assert.equal(j.status, "won");
  assert.ok(j.details.wonAt);
  const {
    rows: [r],
  } = await db.query(
    `select count(*)::int n from activity_log where type='quote_accepted'`,
  );
  assert.equal(r.n, 1);
});
test("accepted amounts and services cannot change", async () => {
  await assert.rejects(
    db.query(`update quotes set amount=999 where id=$1`, [qid]),
    /immutable/,
  );
  await assert.rejects(
    db.query(
      `update jobs set details=jsonb_set(details,'{total}','999') where id=$1`,
      [jid],
    ),
    /locked/,
  );
});
test("accepted quote has a frozen version", async () => {
  const { rows } = await db.query(
    `select snapshot from quote_versions where quote_id=$1`,
    [qid],
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].snapshot.amount), 115);
  assert.equal(rows[0].snapshot.details.services[0].svc, "driveway");
});
test("tenant RLS prevents cross-business goals reads and writes", async () => {
  await db.query(
    `insert into sales_goals(business_id,label,metric,target,starts_at,ends_at) values($1,'Other target','leads',20,now(),now()+interval '1 month')`,
    [other],
  );
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${uid}';`);
  try {
    const { rows } = await db.query("select * from sales_goals");
    assert.equal(rows.length, 0);
    await assert.rejects(
      db.query(
        `insert into sales_goals(business_id,label,metric,target,starts_at,ends_at) values($1,'bad','leads',1,now(),now()+interval '1 month')`,
        [other],
      ),
      /row-level security/,
    );
  } finally {
    await db.exec("reset role;");
  }
});
test("browser roles cannot read backend credentials or enqueue work", async () => {
  await db.exec("set role authenticated");
  try {
    await assert.rejects(
      db.query("select * from servicem8_connections"),
      /permission denied/,
    );
    await assert.rejects(
      db.query(
        `insert into integration_tasks(business_id,kind,dedupe_key,payload) values('x','handoff','bad','{}')`,
      ),
      /permission denied/,
    );
  } finally {
    await db.exec("reset role;");
  }
});
test("duplicate queue deliveries and claims are fenced", async () => {
  await db.query(
    `insert into integration_tasks(business_id,kind,dedupe_key,payload) values($1,'handoff','same','{}') on conflict do nothing`,
    [biz],
  );
  await db.query(
    `insert into integration_tasks(business_id,kind,dedupe_key,payload) values($1,'handoff','same','{}') on conflict do nothing`,
    [biz],
  );
  const first = await db.query("select * from claim_integration_task()"),
    second = await db.query("select * from claim_integration_task()");
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 0);
  assert.ok(first.rows[0].lease_token);
});
test("sales notes can change without changing accepted pricing", async () => {
  await db.query(
    `update jobs set details=details||'{"salesNotes":"Follow up about access"}' where id=$1`,
    [jid],
  );
  const {
    rows: [q],
  } = await db.query("select amount from quotes where id=$1", [qid]);
  assert.equal(Number(q.amount), 115);
});

test("accepted job cannot detach its quote to bypass commercial locks", async () => {
  for (const sql of [
    "quote_id=null",
    "quote_id=null,details=jsonb_set(details,'{total}','999')",
    "details=jsonb_set(details,'{services}','[]')",
    "business_id='another-business'",
  ]) {
    await assert.rejects(
      db.query(`update jobs set ${sql} where id=$1`, [jid]),
      /locked|belong/,
    );
  }
  await assert.rejects(
    db.query("update quotes set created_at=now() where id=$1", [qid]),
    /immutable/,
  );
});

test("linked customers and quotes cannot cross tenants or mismatch within a tenant", async () => {
  const {
    rows: [c],
  } = await db.query(
    `insert into customers(business_id,name) values($1,'Other customer') returning id`,
    [other],
  );
  const {
    rows: [q],
  } = await db.query(
    `insert into quotes(business_id,lead_id,amount,status) values($1,$2,10,'sent') returning id`,
    [other, c.id],
  );
  await assert.rejects(
    db.query(
      `insert into jobs(business_id,customer_id,quote_id,status) values($1,$2,$3,'new')`,
      [biz, cid, q.id],
    ),
    /Quote does not belong/,
  );
  await assert.rejects(
    db.query(
      `insert into jobs(business_id,customer_id,status) values($1,$2,'new')`,
      [biz, c.id],
    ),
    /Customer does not belong/,
  );
  await assert.rejects(
    db.query(
      `insert into quotes(business_id,lead_id,amount,status) values($1,$2,10,'sent')`,
      [biz, c.id],
    ),
    /Customer does not belong/,
  );
  await assert.rejects(
    db.query(
      `insert into jobs(business_id,customer_id,quote_id,status) values($1,$2,$3,'new')`,
      [biz, null, qid],
    ),
    /match/,
  );
  await assert.rejects(
    db.query(`update quotes set business_id=$1 where id=$2`, [biz, q.id]),
    /Customer does not belong/,
  );
});

test("version history is append-only and frozen after approval", async () => {
  await assert.rejects(
    db.query(`update quote_versions set snapshot='{}' where quote_id=$1`, [
      qid,
    ]),
    /append-only/,
  );
  await assert.rejects(
    db.query("delete from quote_versions where quote_id=$1", [qid]),
    /append-only/,
  );
  await assert.rejects(
    db.query(
      `insert into quote_versions(business_id,quote_id,fingerprint,snapshot) values($1,$2,'forged','{}')`,
      [biz, qid],
    ),
    /frozen/,
  );
  await assert.rejects(
    db.query(
      `insert into quote_versions(business_id,quote_id,fingerprint,snapshot) values($1,$2,'foreign','{}')`,
      [other, qid],
    ),
    /belong/,
  );
});

test("server timestamps reject spoofing on insertion and remain stable", async () => {
  const {
    rows: [j],
  } = await db.query(
    `insert into jobs(business_id,customer_id,status,details) values($1,$2,'new','{"wonAt":1,"approvedAt":1,"firstResponseAt":1,"qualifiedAt":1}') returning id,details`,
    [biz, cid],
  );
  assert.deepEqual(j.details, {});
  const {
    rows: [qualified],
  } = await db.query(
    `update jobs set status='qualified',details='{"firstResponseAt":1,"qualifiedAt":1}' where id=$1 returning details`,
    [j.id],
  );
  assert.ok(qualified.details.firstResponseAt > Date.now() - 60000);
  assert.ok(qualified.details.qualifiedAt > Date.now() - 60000);
  const {
    rows: [again],
  } = await db.query(
    `update jobs set details='{"firstResponseAt":2,"qualifiedAt":2,"approvedAt":2,"wonAt":2}' where id=$1 returning details`,
    [j.id],
  );
  assert.deepEqual(again.details, qualified.details);
});

test("public response preserves branding, freezes identities, and filters secrets", async () => {
  await db.query(
    `insert into businesses(id,name,phone,email,logo_url,accent_color,primary_color,font_style,header_style,quote_intro_message,policies_config) values($1,'Original brand','123','public@example.test','logo','#abc','#def','serif','simple','Welcome','{"terms":"Public terms"}')`,
    [biz],
  );
  const {
    rows: [q],
  } = await db.query(
    `insert into quotes(business_id,lead_id,amount,status) values($1,$2,230,'sent') returning id,public_token`,
    [biz, cid],
  );
  await db.query(
    `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,'quoted',$4)`,
    [
      biz,
      cid,
      q.id,
      JSON.stringify({
        notes: "Customer note",
        estimatedCost: 999,
        access_token: "secret",
        services: [
          {
            svc: "driveway",
            qty: 2,
            priceSnapshot: 230,
            estCost: 77,
            recommendedPrice: 88,
            credentials: "secret",
          },
        ],
      }),
    ],
  );
  await db.query(`select respond_to_public_quote($1,'accept')`, [
    q.public_token,
  ]);
  await db.query(
    `update businesses set name='Changed',logo_url='changed' where id=$1`,
    [biz],
  );
  await db.query(`update customers set name='Changed' where id=$1`, [cid]);
  await db.exec("set role anon");
  try {
    const {
      rows: [r],
    } = await db.query("select get_public_quote($1) value", [q.public_token]);
    assert.equal(r.value.business.name, "Original brand");
    assert.equal(r.value.business.logoUrl, "logo");
    assert.equal(r.value.business.primaryColor, "#def");
    assert.equal(r.value.business.quoteIntroMessage, "Welcome");
    assert.equal(r.value.customer.name, "Test customer");
    assert.equal(r.value.notes, "Customer note");
    assert.equal(r.value.services[0].fixedPrice, 230);
    assert.doesNotMatch(
      JSON.stringify(r.value),
      /estimatedCost|estCost|recommendedPrice|credentials|access_token|secret/,
    );
  } finally {
    await db.exec("reset role");
  }
});

test("every new table has RLS and backend tables deny both browser roles", async () => {
  const tenant = [
    "sales_settings",
    "sales_goals",
    "sales_spend",
    "sales_events",
    "quote_versions",
  ];
  const internal = [
    "servicem8_connections",
    "integration_tasks",
    "external_object_mappings",
    "integration_oauth_states",
    "servicem8_handoffs",
    "servicem8_object_map",
    "servicem8_webhook_events",
  ];
  const { rows } = await db.query(
    `select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[])`,
    [[...tenant, ...internal]],
  );
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.relrowsecurity));
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      for (const table of internal)
        await assert.rejects(
          db.query(`select * from ${table}`),
          /permission denied/,
        );
      await assert.rejects(
        db.query("select * from claim_integration_task()"),
        /permission denied/,
      );
      if (role === "authenticated")
        for (const table of tenant) {
          const { rows } = await db.query(
            `select * from ${table} where business_id=$1`,
            [other],
          );
          assert.equal(rows.length, 0);
        }
    } finally {
      await db.exec("reset role");
    }
  }
});

test("expired leases rotate fencing tokens and retries honor due time and attempt limit", async () => {
  const {
    rows: [old],
  } = await db.query(`select * from integration_tasks where dedupe_key='same'`);
  await db.query(
    `update integration_tasks set lease_until=now()-interval '1 minute' where id=$1`,
    [old.id],
  );
  const {
    rows: [fresh],
  } = await db.query("select * from claim_integration_task()");
  assert.equal(fresh.id, old.id);
  assert.notEqual(fresh.lease_token, old.lease_token);
  assert.equal(fresh.attempts, 2);
  const stale = await db.query(
    `update integration_tasks set state='succeeded' where id=$1 and lease_token=$2 returning id`,
    [old.id, old.lease_token],
  );
  assert.equal(stale.rows.length, 0);
  await db.query(
    `update integration_tasks set state='failed',next_attempt_at=now()+interval '1 hour' where id=$1 and lease_token=$2`,
    [fresh.id, fresh.lease_token],
  );
  assert.equal(
    (await db.query("select * from claim_integration_task()")).rows.length,
    0,
  );
  await db.query(
    `update integration_tasks set next_attempt_at=now()-interval '1 minute',attempts=12 where id=$1`,
    [old.id],
  );
  assert.equal(
    (await db.query("select * from claim_integration_task()")).rows.length,
    0,
  );
  await db.query(`update integration_tasks set attempts=11 where id=$1`, [
    old.id,
  ]);
  const last = await db.query("select * from claim_integration_task()");
  assert.equal(last.rows[0].attempts, 12);
});

test("approval stamps advanced jobs without downgrading and cannot be reversed", async () => {
  const {
    rows: [q],
  } = await db.query(
    `insert into quotes(business_id,lead_id,amount,status) values($1,$2,100,'sent') returning id,public_token`,
    [biz, cid],
  );
  const {
    rows: [j],
  } = await db.query(
    `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,'scheduled','{}') returning id`,
    [biz, cid, q.id],
  );
  await db.query(`select respond_to_public_quote($1,'accept')`, [
    q.public_token,
  ]);
  const {
    rows: [approved],
  } = await db.query("select status,details from jobs where id=$1", [j.id]);
  assert.equal(approved.status, "scheduled");
  assert.ok(approved.details.approvedAt > Date.now() - 60000);
  await db.query(`select respond_to_public_quote($1,'decline')`, [
    q.public_token,
  ]);
  assert.equal(
    (await db.query("select status from quotes where id=$1", [q.id])).rows[0]
      .status,
    "accepted",
  );
  await assert.rejects(
    db.query(`select respond_to_public_quote($1,null)`, [q.public_token]),
    /invalid action/,
  );
});

test("tenant CRUD checks reject reassignment across all editable sales tables", async () => {
  await db.query(`insert into sales_settings(business_id) values($1),($2)`, [
    biz,
    other,
  ]);
  await db.query(
    `insert into sales_spend(business_id,source,amount,spent_at) values($1,'Search',10,current_date),($2,'Search',20,current_date)`,
    [biz, other],
  );
  await db.query(
    `insert into sales_goals(business_id,label,metric,target,starts_at,ends_at) values($1,'Own','leads',1,now(),now()+interval '1 day')`,
    [biz],
  );
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${uid}'`);
  try {
    for (const table of ["sales_settings", "sales_spend", "sales_goals"]) {
      assert.ok(
        (await db.query(`select * from ${table}`)).rows.every(
          (r) => r.business_id === biz,
        ),
      );
      await assert.rejects(
        db.query(`update ${table} set business_id=$1 where business_id=$2`, [
          other,
          biz,
        ]),
        /row-level security/,
      );
      assert.equal(
        (
          await db.query(
            `delete from ${table} where business_id=$1 returning *`,
            [other],
          )
        ).rows.length,
        0,
      );
    }
    for (const table of ["sales_events", "quote_versions"])
      await assert.rejects(
        db.query(`delete from ${table}`),
        /permission denied/,
      );
  } finally {
    await db.exec("reset role");
  }
});

test("draft versions retain the customer and branding from their creation", async () => {
  const {
    rows: [q],
  } = await db.query(
    `insert into quotes(business_id,lead_id,amount,status) values($1,$2,50,'sent') returning id`,
    [biz, cid],
  );
  await db.query(
    `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,'quoted','{"total":50}')`,
    [biz, cid, q.id],
  );
  const {
    rows: [before],
  } = await db.query("select snapshot from quote_versions where quote_id=$1", [
    q.id,
  ]);
  assert.equal(before.snapshot.customer.name, "Changed");
  assert.equal(before.snapshot.business.name, "Changed");
  await db.query(`update customers set name='Later customer' where id=$1`, [
    cid,
  ]);
  await db.query(`update businesses set name='Later business' where id=$1`, [
    biz,
  ]);
  assert.deepEqual(
    (
      await db.query("select snapshot from quote_versions where quote_id=$1", [
        q.id,
      ])
    ).rows[0].snapshot,
    before.snapshot,
  );
});

test("legacy won jobs without a won date never acquire today on maintenance or progression", async () => {
  for (const status of ["won", "scheduled", "completed", "paid"]) {
    // Model a pre-migration row without running the new timestamp trigger.
    let legacy;
    await db.exec("alter table jobs disable trigger sales_job_prepare");
    try {
      ({
        rows: [legacy],
      } = await db.query(
        `insert into jobs(business_id,customer_id,status,details) values($1,$2,$3,'{}') returning id`,
        [biz, cid, status],
      ));
    } finally {
      await db.exec("alter table jobs enable trigger sales_job_prepare");
    }
    const {
      rows: [updated],
    } = await db.query(
      `update jobs set details=details||'{"salesNotes":"Access confirmed","wonAt":1}' where id=$1 returning details`,
      [legacy.id],
    );
    assert.equal(
      updated.details.wonAt,
      undefined,
      `${status}: maintenance must not invent wonAt`,
    );
    const {
      rows: [progressed],
    } = await db.query(
      `update jobs set status='paid' where id=$1 returning details`,
      [legacy.id],
    );
    assert.equal(
      progressed.details.wonAt,
      undefined,
      `${status}: progression inside won stages must not invent wonAt`,
    );
    assert.equal(
      progressed.details.firstResponseAt,
      undefined,
      `${status}: progression must not invent a first response`,
    );
  }
});

test("actual transition into won stages stamps once and preserves the date thereafter", async () => {
  const {
    rows: [j],
  } = await db.query(
    `insert into jobs(business_id,customer_id,status,details) values($1,$2,'quoted','{}') returning id`,
    [biz, cid],
  );
  const {
    rows: [won],
  } = await db.query(
    `update jobs set status='won',details=details||'{"wonAt":1}' where id=$1 returning details`,
    [j.id],
  );
  assert.ok(won.details.wonAt > Date.now() - 60000);
  const {
    rows: [paid],
  } = await db.query(
    `update jobs set status='paid',details=details||'{"wonAt":2}' where id=$1 returning details`,
    [j.id],
  );
  assert.equal(paid.details.wonAt, won.details.wonAt);
});

test("legacy accepted quotes cannot create approval or response dates on harmless edits", async () => {
  for (const status of [
    "won",
    "scheduled",
    "completed",
    "paid",
    "qualified",
    "quoted",
  ]) {
    let q, j;
    await db.exec(
      "alter table quotes disable trigger sales_quote_guard;alter table jobs disable trigger sales_job_prepare",
    );
    try {
      ({
        rows: [q],
      } = await db.query(
        `insert into quotes(business_id,lead_id,amount,status) values($1,$2,100,'sent') returning id,public_token`,
        [biz, cid],
      ));
      // Older accepted snapshots have no trusted approval-date marker either.
      await db.query(
        `insert into quote_versions(business_id,quote_id,fingerprint,snapshot) values($1,$2,'legacy','{"accepted":true,"details":{}}')`,
        [biz, q.id],
      );
      await db.query(`update quotes set status='accepted' where id=$1`, [q.id]);
      ({
        rows: [j],
      } = await db.query(
        `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,$4,'{}') returning id`,
        [biz, cid, q.id, status],
      ));
    } finally {
      await db.exec(
        "alter table quotes enable trigger sales_quote_guard;alter table jobs enable trigger sales_job_prepare",
      );
    }
    await db.query(`select respond_to_public_quote($1,'accept')`, [
      q.public_token,
    ]);
    const {
      rows: [updated],
    } = await db.query(
      `update jobs set details=details||'{"salesNotes":"Legacy maintenance","approvedAt":1,"firstResponseAt":1,"qualifiedAt":1}' where id=$1 returning details`,
      [j.id],
    );
    for (const key of ["wonAt", "approvedAt", "firstResponseAt", "qualifiedAt"])
      assert.equal(
        updated.details[key],
        undefined,
        `${status}: must preserve unknown ${key}`,
      );
  }
});

test("fresh acceptance has a trusted approval date that survives later edits", async () => {
  const {
    rows: [q],
  } = await db.query(
    `insert into quotes(business_id,lead_id,amount,status) values($1,$2,100,'sent') returning id,public_token`,
    [biz, cid],
  );
  const {
    rows: [j],
  } = await db.query(
    `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,'quoted','{}') returning id`,
    [biz, cid, q.id],
  );
  await db.query(`select respond_to_public_quote($1,'accept')`, [
    q.public_token,
  ]);
  const {
    rows: [v],
  } = await db.query(
    `select snapshot from quote_versions where quote_id=$1 and snapshot->>'accepted'='true'`,
    [q.id],
  );
  const {
    rows: [approved],
  } = await db.query("select details from jobs where id=$1", [j.id]);
  assert.ok(v.snapshot.approvedAt > Date.now() - 60000);
  assert.equal(approved.details.approvedAt, v.snapshot.approvedAt);
  const {
    rows: [edited],
  } = await db.query(
    `update jobs set details=details||'{"approvedAt":1,"firstResponseAt":1}' where id=$1 returning details`,
    [j.id],
  );
  assert.equal(edited.details.approvedAt, approved.details.approvedAt);
  assert.equal(
    edited.details.firstResponseAt,
    approved.details.firstResponseAt,
  );
});

test("job triggers fail fast on quote contention and the public getter takes no row locks", async () => {
  for (const name of ["sales_job_prepare", "sales_job_audit"]) {
    const {
      rows: [r],
    } = await db.query(`select prosrc from pg_proc where oid=$1::regproc`, [
      name,
    ]);
    assert.match(r.prosrc, /for update nowait/i);
  }
  const {
    rows: [r],
  } = await db.query(
    `select prosrc from pg_proc where oid='get_public_quote'::regproc`,
  );
  assert.doesNotMatch(r.prosrc, /for update/i);
});

test("accepted profitability snapshots are frozen while contact notes and followups remain editable", async () => {
  const {
    rows: [q],
  } = await db.query(
    `insert into quotes(business_id,lead_id,amount,status) values($1,$2,230,'sent') returning id,public_token`,
    [biz, cid],
  );
  const original = {
    total: 230,
    estimatedCost: 80,
    estimatedMarginPct: 60,
    gstRegistered: true,
    targetMargin: 55,
    services: [{ svc: "driveway", qty: 2, priceSnapshot: 230 }],
  };
  const {
    rows: [j],
  } = await db.query(
    `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,'quoted',$4) returning id`,
    [biz, cid, q.id, JSON.stringify(original)],
  );
  await db.query(`select respond_to_public_quote($1,'accept')`, [
    q.public_token,
  ]);
  for (const key of [
    "estimatedCost",
    "estimatedMarginPct",
    "gstRegistered",
    "targetMargin",
  ]) {
    for (const value of [999, null]) {
      await assert.rejects(
        db.query(
          `update jobs set details=jsonb_set(details,array[$2]::text[],$3::jsonb) where id=$1`,
          [j.id, key, JSON.stringify(value)],
        ),
        /locked/,
        `${key} cannot change or become null`,
      );
    }
    await assert.rejects(
      db.query(`update jobs set details=details-$2::text where id=$1`, [
        j.id,
        key,
      ]),
      /locked/,
      `${key} cannot be removed`,
    );
  }
  // Missing historical snapshots cannot be filled by a stale client either.
  await assert.rejects(
    db.query(
      `update jobs set details=details||'{"targetMargin":55}' where id=$1`,
      [jid],
    ),
    /locked/,
  );
  const editable = {
    contactName: "Updated contact",
    contactPhone: "021000000",
    salesNotes: "Gate code confirmed",
    nextFollowUpAt: 1900000000000,
    salesHistory: [{ note: "Called customer" }],
  };
  const {
    rows: [updated],
  } = await db.query(
    `update jobs set details=details||$2::jsonb where id=$1 returning details`,
    [j.id, JSON.stringify(editable)],
  );
  for (const [key, value] of Object.entries(original))
    assert.deepEqual(updated.details[key], value);
  for (const [key, value] of Object.entries(editable))
    assert.deepEqual(updated.details[key], value);
});

test("acceptance auto-handoff queues each job once including advanced operational stages", async () => {
  await db.query(
    `insert into servicem8_connections(business_id,auth_mode,auto_handoff) values($1,'api_key',true) on conflict(business_id) do update set auto_handoff=true`,
    [biz],
  );
  try {
    for (const status of ["quoted", "won", "scheduled", "completed", "paid"]) {
      const {
        rows: [q],
      } = await db.query(
        `insert into quotes(business_id,lead_id,amount,status) values($1,$2,100,'sent') returning id,public_token`,
        [biz, cid],
      );
      const {
        rows: [j],
      } = await db.query(
        `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,$4,'{}') returning id`,
        [biz, cid, q.id, status],
      );
      const tasks = () =>
        db.query(
          `select * from integration_tasks where business_id=$1 and kind='handoff' and dedupe_key=$2`,
          [biz, j.id],
        );
      const before = await tasks();
      assert.equal(before.rows.length, status === "won" ? 1 : 0);
      await db.query(`select respond_to_public_quote($1,'accept')`, [
        q.public_token,
      ]);
      const first = await tasks();
      assert.equal(
        first.rows.length,
        1,
        `${status}: acceptance must queue handoff`,
      );
      assert.deepEqual(first.rows[0].payload, { jobId: j.id });
      await db.query(`select respond_to_public_quote($1,'accept')`, [
        q.public_token,
      ]);
      await db.query(`update quotes set status='accepted' where id=$1`, [q.id]);
      await db.query(
        `update jobs set details=details||'{"salesNotes":"Access confirmed"}' where id=$1`,
        [j.id],
      );
      const repeated = await tasks();
      assert.equal(repeated.rows.length, 1);
      assert.equal(repeated.rows[0].id, first.rows[0].id);
      assert.equal(
        (await db.query("select status from jobs where id=$1", [j.id])).rows[0]
          .status,
        status === "quoted" ? "won" : status,
      );
    }
  } finally {
    await db.query(
      "update servicem8_connections set auto_handoff=false where business_id=$1",
      [biz],
    );
  }
});

test("advanced quote acceptance honors disabled auto-handoff", async () => {
  const {
    rows: [q],
  } = await db.query(
    `insert into quotes(business_id,lead_id,amount,status) values($1,$2,100,'sent') returning id,public_token`,
    [biz, cid],
  );
  const {
    rows: [j],
  } = await db.query(
    `insert into jobs(business_id,customer_id,quote_id,status,details) values($1,$2,$3,'completed','{}') returning id`,
    [biz, cid, q.id],
  );
  await db.query(`select respond_to_public_quote($1,'accept')`, [
    q.public_token,
  ]);
  assert.equal(
    (
      await db.query(
        `select id from integration_tasks where business_id=$1 and kind='handoff' and dedupe_key=$2`,
        [biz, j.id],
      )
    ).rows.length,
    0,
  );
});
