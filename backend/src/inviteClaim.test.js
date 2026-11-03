import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = fs.readFileSync(new URL('../../supabase/migrations/20261103013028_confirmed_invites.sql', import.meta.url), 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function setup(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema turnkey_private;
    create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz);
    create table public.users(id uuid primary key references auth.users(id), business_id text, email text,
      role text check (role in ('owner','manager','technician')));
    create table public.businesses(id text primary key, name text);
    create table public.invites(id uuid primary key default gen_random_uuid(), business_id text not null,
      email text not null, role text not null check (role in ('owner','manager','technician')),
      invited_by uuid references auth.users(id), created_at timestamptz not null default now(), accepted_at timestamptz);
    create table public.customers(id uuid primary key default gen_random_uuid(), business_id text);
    create table public.jobs(id uuid primary key default gen_random_uuid(), business_id text);
    create table public.quotes(id uuid primary key default gen_random_uuid(), business_id text);
    insert into public.businesses values ('team', 'Team'), ('second-team', 'Second team');
  `)
  // Load the actual preceding function before replacing it, as production does.
  const prior = fs.readFileSync(new URL('../../supabase/migrations/20260727120000_fix_invite_matching_and_activity.sql', import.meta.url), 'utf8')
  await db.exec(prior.slice(prior.indexOf('create or replace function'), prior.indexOf('-- ===== last_seen_at')))
  await db.exec(`alter function public.handle_new_user() set schema turnkey_private;
    create trigger on_auth_user_created after insert on auth.users
    for each row execute function turnkey_private.handle_new_user();`)
  await db.exec(migration)
  return db
}
const rows = async (db, sql, params = []) => (await db.query(sql, params)).rows
const invite = (db, email = ' staff@example.com ', role = 'technician', business = 'team', date = '2026-01-01') =>
  db.query('insert into public.invites(email,role,business_id,created_at) values ($1,$2,$3,$4)', [email, role, business, date])
const signup = (db, n = 1, confirmed = false, email = 'Staff@example.com') =>
  db.query('insert into auth.users values ($1,$2,$3)', [id(n), email, confirmed ? '2026-02-01' : null])
const confirm = (db, n = 1) => db.query('update auth.users set email_confirmed_at = now() where id=$1', [id(n)])

test('confirmed signup accepts only the oldest normalized invite and its real role', async t => {
  const db = await setup(t)
  await invite(db, 'STAFF@example.com', 'manager')
  await invite(db, 'staff@example.com', 'owner', 'second-team', '2026-01-02')
  await signup(db, 1, true)
  assert.deepEqual(await rows(db, 'select business_id,role from public.users'), [{ business_id: 'team', role: 'manager' }])
  assert.equal((await rows(db, 'select count(*)::int n from public.invites where accepted_at is not null'))[0].n, 1)
  assert.equal((await rows(db, 'select * from public.businesses where id=$1', [id(1)])).length, 0)
})

test('unconfirmed signup defers acceptance, confirmation claims exactly once and removes empty provisional business', async t => {
  const db = await setup(t)
  await invite(db)
  await signup(db)
  assert.deepEqual(await rows(db, 'select business_id,role from public.users'), [{ business_id: id(1), role: 'owner' }])
  assert.equal((await rows(db, 'select accepted_at from public.invites'))[0].accepted_at, null)
  await confirm(db)
  const accepted = (await rows(db, 'select accepted_at from public.invites'))[0].accepted_at
  await invite(db, 'staff@example.com', 'owner', 'second-team', '2026-01-02')
  // PGlite serializes concurrent requests on its single connection. This
  // exercises queued retries, not independent PostgreSQL sessions/lock waits.
  await Promise.all([confirm(db), confirm(db)])
  await db.query('update auth.users set email_confirmed_at=null where id=$1', [id(1)])
  await confirm(db)
  assert.deepEqual(await rows(db, 'select business_id,role from public.users'), [{ business_id: 'team', role: 'technician' }])
  assert.deepEqual((await rows(db, 'select accepted_at from public.invites order by created_at')).map(r => r.accepted_at), [accepted, null])
  assert.equal((await rows(db, 'select * from public.businesses where id=$1', [id(1)])).length, 0)
})

for (const table of ['customers', 'jobs', 'quotes', 'users']) {
  test(`confirmation preserves provisional business with ${table}`, async t => {
    const db = await setup(t)
    await signup(db)
    if (table === 'users') {
      await signup(db, 2, false, 'other@example.com')
      await db.query('update public.users set business_id=$1 where id=$2', [id(1), id(2)])
    } else {
      await db.query(`insert into public.${table}(business_id) values ($1)`, [id(1)])
    }
    await invite(db)
    await confirm(db)
    assert.equal((await rows(db, 'select * from public.businesses where id=$1', [id(1)])).length, 1)
    assert.equal((await rows(db, 'select business_id from public.users where id=$1', [id(1)]))[0].business_id, 'team')
    assert.equal((await rows(db, `select count(*)::int n from public.${table} where business_id=$1`, [id(1)]))[0].n, 1)
  })
}

test('no invite preserves owner provisioning on signup and confirmation', async t => {
  const db = await setup(t)
  await signup(db)
  await confirm(db)
  await signup(db, 2, true, 'confirmed@example.com')
  assert.deepEqual(await rows(db, 'select business_id,role from public.users order by id'), [1, 2].map(n => ({ business_id: id(n), role: 'owner' })))
})

test('queued competing signups cannot consume one invite twice', async t => {
  const db = await setup(t)
  await invite(db)
  await Promise.all([signup(db, 1, true, 'Staff@example.com'), signup(db, 2, true, 'staff@example.com')])
  assert.equal((await rows(db, "select count(*)::int n from public.users where business_id='team'"))[0].n, 1)
  assert.equal((await rows(db, 'select count(*)::int n from public.invites where accepted_at is not null'))[0].n, 1)
})

test('migration is repeatable, has one confirmation trigger, and blocks untrusted execution', async t => {
  const db = await setup(t)
  await db.exec(migration)
  assert.equal((await rows(db, "select count(*)::int n from pg_trigger where tgname='on_auth_user_email_confirmed'"))[0].n, 1)
  const functions = await rows(db, `select p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('anon',p.oid,'execute') anon,
    has_function_privilege('authenticated',p.oid,'execute') authenticated
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='turnkey_private'`)
  assert.equal(functions.length, 2)
  for (const f of functions) {
    assert.equal(f.prosecdef, true)
    assert.deepEqual(f.proconfig, ['search_path=pg_catalog, public'])
    assert.equal(f.anon, false)
    assert.equal(f.authenticated, false)
  }
  await assert.rejects(invite(db, 'bad@example.com', 'admin'), /check constraint/)
})
