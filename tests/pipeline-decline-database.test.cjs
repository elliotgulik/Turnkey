const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('quote declines cancel only matching open jobs, once, retaining other tenants and confirmed work',async()=>{
 const {PGlite}=await import('@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table quotes(id text primary key,business_id text,status text);
    create table jobs(id text primary key,business_id text,quote_id text,status text,details jsonb);
    insert into quotes values('q','a','sent');
    insert into jobs values('open','a','q','quoted','{"total":500}'),('other','b','q','quoted','{}'),('won','a','q','won','{}');`);
  const sql=fs.readFileSync('supabase/migrations/20261018102804_pipeline_quote_decline.sql','utf8');
  await db.exec(sql);await db.exec(sql);
  await db.exec("update quotes set status='declined' where id='q';update quotes set status='declined' where id='q';");
  const {rows}=await db.query('select * from jobs order by id');
  const open=rows.find(r=>r.id==='open');assert.equal(open.status,'cancelled');assert.equal(open.details.total,500);assert.equal(open.details.salesHistory.length,1);assert.ok(open.details.lostAt>0);
  assert.equal(rows.find(r=>r.id==='other').status,'quoted');assert.equal(rows.find(r=>r.id==='won').status,'won');
 }finally{await db.close();}
});
