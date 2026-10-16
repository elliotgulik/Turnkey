const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('../conversations.js');
const { groupMessages, category } = globalThis.TK_CONVERSATIONS;
test('folders overlap correctly and equal provider thread IDs in different accounts stay separate', () => {
  const rows = [
    { id: '1', account_id: 'A', thread_id: 'same', direction: 'received', sent_at: '2026-01-01' },
    { id: '2', account_id: 'A', thread_id: 'same', direction: 'sent', sent_at: '2026-01-02' },
    { id: '3', account_id: 'B', thread_id: 'same', direction: 'sent', sent_at: '2026-01-03' },
    { id: '4', account_id: 'A', thread_id: null, direction: 'received', sent_at: '2026-01-04' }
  ];
  const groups = groupMessages(rows, ['same']);
  assert.equal(groups.length, 3); assert.equal(category(groups, 'inbox').length, 2); assert.equal(category(groups, 'sent').length, 2);
  assert.equal(category(groups, 'starred').length, 2); assert.equal(category(groups, 'all').length, 3);
  assert.equal(groups.find(g => g.key === 'A:same').last.id, '2');
});
test('migration enforces owner/business RLS and backend-only writes in real Postgres', async () => {
  const { PGlite } = await import('@electric-sql/pglite'); const db = new PGlite();
  const user = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function public.current_business_id() returns text language sql stable as $$select current_setting('request.business',true)$$;
      create table auth.users(id uuid primary key);create table public.email_accounts(id uuid primary key);
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      insert into auth.users values('${user}'),('${other}');insert into email_accounts values('${user}');`);
    const migration = fs.readFileSync('supabase/migrations/' + fs.readdirSync('supabase/migrations').find(f => f.endsWith('_conversations.sql')), 'utf8');
    await db.exec(migration); await db.exec(migration);
    await db.exec(`insert into conversation_drafts(id,business_id,user_id,payload) values('${user}','A','${user}','{"subject":"private"}'),('${other}','A','${other}','{}');
      insert into conversation_stars(business_id,user_id,account_id,thread_key) values('A','${user}','${user}','thread'),('B','${user}','${user}','foreign');
      set role authenticated;set request.jwt.claim.sub='${user}';set request.business='A';`);
    assert.equal((await db.query('select * from conversation_drafts')).rows.length, 1);
    assert.equal((await db.query('select * from conversation_stars')).rows.length, 1);
    await assert.rejects(db.query("update conversation_drafts set status='sent'"), /permission denied/);
    await assert.rejects(db.query("delete from conversation_stars"), /permission denied/);
    await db.exec("set request.business='B'"); assert.equal((await db.query('select * from conversation_drafts')).rows.length, 0);
    await db.exec('set role anon'); await assert.rejects(db.query('select * from conversation_drafts'), /permission denied/);
  } finally { await db.close(); }
});
