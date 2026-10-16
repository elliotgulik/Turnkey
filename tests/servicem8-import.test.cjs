const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const I=require('../servicem8-import.js');
const fixture=n=>fs.readFileSync(`tests/fixtures/servicem8/${n}.csv`,'utf8');
function mounted(){
  const html=fs.readFileSync('index.html','utf8');
  const start=html.indexOf('function rowsToObjects('),end=html.indexOf('// End-to-end:',start);
  const processEnd=html.indexOf('\n}',html.indexOf('function sm8Process(',end))+2;
  const c={window:null,TextDecoder,Uint8Array,importWizard:{files:{}},sm8RenderUpload:()=>'<button disabled onclick="sm8Validate()">Continue</button>'};c.window=c;
  vm.createContext(c);vm.runInContext(html.slice(start,processEnd),c);
  vm.runInContext(fs.readFileSync('servicem8-import.js','utf8'),c);
  return c;
}
test('realistic aliases, quoted multiline data, BOM UTF-8 and UTF-16',()=>{
  const text=fixture('clients');
  for(const input of ['\uFEFF'+text,Buffer.from('\uFEFF'+text),Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')])]){
    const f=I.parse(input);assert.equal(I.detect(f.headers),'clients');
    assert.match(I.objects(f)[0]['Company Address'],/\nPonsonby/);
  }
  const le=Buffer.from(text,'utf16le'),be=Buffer.alloc(le.length);for(let n=0;n<le.length;n+=2){be[n]=le[n+1];be[n+1]=le[n];}
  assert.equal(I.parse(Buffer.concat([Buffer.from([254,255]),be])).rows.length,1);
});
test('mounted wizard emits the exact five-argument RPC contract, preserving currency and links',()=>{
  const c=mounted();
  const result=c.sm8Process(I.parse(fixture('clients')),I.parse(fixture('jobs')));
  assert.equal(result.customers[0].name,'Smith & Sons');
  assert.equal(result.jobs[0].total,1234.50);assert.equal(result.jobs[0].status,'paid');
  assert.equal(result.jobs[0].ref,'00123');assert.equal(result.invoices[0].payment_date,'2026-10-15');
  assert.equal(result.jobs[1].status,'scheduled');assert.equal(result.customers.length,2);
  assert.deepEqual(Object.keys(I.payload(result)),['p_source','p_customers','p_jobs','p_quotes','p_invoices']);
  assert.equal(c.sm8Process(null,I.parse(fixture('jobs'))).customers.length,2);
  c.importWizard.files.jobs={};assert.doesNotMatch(c.sm8RenderUpload(),/disabled/);
});
test('item catalogue review and CSV round trip preserve leading zeros and quotes',()=>{
  const f=I.parse(fixture('items'));assert.equal(I.detect(f.headers),'items');
  assert.equal(I.items(f)[0].price,2.5);
  const rows=[{'Item Number':'001','Item Name':'Wash "wide", area','Price':2.5}];
  const parsed=I.parse(I.csv(rows));assert.equal(I.items(parsed)[0].item_number,'001');
  assert.equal(I.items(parsed)[0].name,rows[0]['Item Name']);
});
test('invalid files and calendar/currency values fail before an RPC',()=>{
  for(const text of ['Name,Email\na,b,c','Name\n"broken'])assert.throws(()=>I.parse(text));
  assert.throws(()=>I.parse(new Uint8Array([80,75,3,4])),/Excel/);
  assert.throws(()=>I.money('1.234,50'));
  assert.throws(()=>I.money('oops'));assert.throws(()=>I.date('2026-02-30'));
  assert.equal(I.date('0000-00-00 00:00:00'),null);
  assert.equal(I.mapping(['Custom Name'],{Name:'Custom Name'}).Name,'Custom Name');
  assert.throws(()=>I.mapping(['Name'],{Name:'Missing'}));
});
test('actual ServiceM8 SQL RPC accepts the normalized payload and deduplicates jobs/invoices',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
  try {
    await db.exec(`create role authenticated;create role anon;create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create function current_business_id() returns text language sql as $$select 'A'::text$$;
      create function current_business_role() returns text language sql as $$select 'owner'::text$$;
      create table customers(id uuid primary key default gen_random_uuid(),business_id text,name text,email text,phone text,address text,suburb text,notes text,source text);
      create table jobs(id uuid primary key default gen_random_uuid(),business_id text,customer_id uuid,status text,scheduled_date date,details jsonb,quote_id text);
      create table quotes(id uuid primary key default gen_random_uuid(),business_id text,lead_id text,amount numeric,status text);
      create table invoices(id uuid primary key default gen_random_uuid(),business_id text,job_id text,amount numeric,paid boolean,payment_status text,payment_date date,payment_method text,due_date date);`);
    await db.exec(fs.readFileSync('backend/supabase/schema-import-wizard.sql','utf8'));
    await db.exec(fs.readFileSync('backend/supabase/schema-import-servicem8.sql','utf8'));
    await assert.rejects(db.query("select run_import('servicem8')"),/ambiguous/);
    await db.exec(fs.readFileSync('supabase/migrations/20261015212330_fix_servicem8_import_rpc.sql','utf8'));
    const c=mounted(),result=c.sm8Process(I.parse(fixture('clients')),I.parse(fixture('jobs'))),p=I.payload(result);
    const args=[p.p_source,...['p_customers','p_jobs','p_quotes','p_invoices'].map(k=>JSON.stringify(p[k]))];
    await db.exec(fs.readFileSync('supabase/migrations/20261015212330_fix_servicem8_import_rpc.sql','utf8')); // rerun is safe
    const sql='select run_import($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb) as result';
    const first=(await db.query(sql,args)).rows[0].result;
    assert.equal(first.errors.length,0);assert.equal(first.counts.jobs.inserted,2);
    assert.equal(first.counts.invoices.inserted,1);
    const second=(await db.query(sql,args)).rows[0].result;
    assert.equal(second.counts.customers.duplicates,2);assert.equal(second.counts.jobs.duplicates,2);assert.equal(second.counts.invoices.duplicates,1);
    const invoice=(await db.query('select amount,paid from invoices')).rows[0];
    assert.equal(Number(invoice.amount),1234.5);assert.equal(invoice.paid,true);
    const access=(await db.query("select has_function_privilege('anon','public.run_import(text,jsonb,jsonb,jsonb,jsonb)','execute') as anon, has_function_privilege('authenticated','public.run_import(text,jsonb,jsonb,jsonb,jsonb)','execute') as member")).rows[0];
    assert.equal(access.anon,false);assert.equal(access.member,true);
    await db.exec("create or replace function current_business_role() returns text language sql as $$select null::text$$");
    await assert.rejects(db.query(sql,args),/only an owner or manager/);
  } finally {await db.close();}
});
const nativeHeaders=require('./fixtures/servicem8/native-headers.cjs');
const syntheticNative=(headers,values)=>'\uFEFF'+[headers,headers.map(h=>values[h]??'')].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
test('exact native client/job headers preserve unnamed columns and job-only contact aliases',()=>{
  const clients=I.parse(syntheticNative(nativeHeaders.clients,{'Name':'Synthetic Customer','Company Address':'12 Test Lane','Email Address':'synthetic@example.test'}));
  assert.equal(clients.columns.filter(c=>!c.name).length,3);
  assert.equal(new Set(clients.headers).size,23);assert.equal(I.detect(clients.headers),'clients');
  assert.equal(I.objects(clients)[0].Name,'Synthetic Customer');
  const jobs=I.parse(syntheticNative(nativeHeaders.jobs,{'Job Number':'0007','Job Status':'Completed','Company':'Synthetic Customer','Job Email Address':'job@example.test','Job Contact Mobile Number':'0210000000','Job Address':'12 Test Lane','Total Invoice Amount':'$1,234.50','Payment Received':'Yes'}));
  assert.equal(jobs.headers.length,36);assert.equal(I.detect(jobs.headers),'jobs');
  const c=mounted(),result=c.sm8Process(null,jobs);
  assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].total,1234.50);
  assert.equal(result.customers[0].email,'job@example.test');assert.equal(result.customers[0].phone,'0210000000');
  assert.equal(result.customers[0].address,'12 Test Lane');
  const both=c.sm8Process(clients,jobs);assert.equal(both.customers[0].email,'synthetic@example.test');
  assert.equal(both.customers[0].phone,'0210000000');
  jobs.rows[0][jobs.headers.indexOf('Job Telephone Number')]='090000000';
  assert.equal(c.sm8Process(null,jobs).customers[0].phone,'090000000');
  jobs.rows[0][jobs.headers.indexOf('Job Email Address')]='';
  jobs.rows[0][jobs.headers.indexOf('Billing Email Address')]='billing@example.test';
  jobs.rows[0][jobs.headers.indexOf('Job Telephone Number')]='';
  jobs.rows[0][jobs.headers.indexOf('Job Contact Mobile Number')]='';
  jobs.rows[0][jobs.headers.indexOf('Billing Contact Mobile Number')]='0220000000';
  const billing=c.sm8Process(null,jobs).customers[0];assert.equal(billing.email,'billing@example.test');assert.equal(billing.phone,'0220000000');
});
test('duplicates coalesce only matching/empty values and conflicting values require explicit mapping',()=>{
  const f=I.parse('Name,Name,Email Address,,,\n,Example,one@example.test,unlabelled value,,');
  assert.equal(I.objects(f)[0].Name,'Example');
  assert.equal(f.rows[0][3],'unlabelled value');
  assert.equal(f.columns[3].name,'');
  const conflicting=I.parse('Name,NAME,Email\nAlpha,Beta,x@example.test');
  assert.throws(()=>I.objects(conflicting),/Conflicting duplicate header/);
  conflicting.mapping={Name:conflicting.headers[1]};
  assert.equal(I.objects(conflicting)[0].Name,'Beta');
  const extra=I.parse('Name,Email,\nExample,x@example.test,,,');
  assert.equal(extra.rows[0].length,3);
  assert.equal(I.parse('Name,Email,\nExample,x@example.test').rows[0].length,3);
  assert.throws(()=>I.parse('Name,Email,\nExample'),/missing a named field/);
  assert.throws(()=>I.parse('Name,Email,\nExample,x@example.test,,unexpected'),/beyond its headers/);
});
function exportDb(tables,requests=[]){
  return {from(table){let businessId;
    const q={select(){return q},eq(k,v){assert.equal(k,'business_id');businessId=v;return q},order(k){assert.equal(k,'id');return q},async range(start,end){requests.push({table,businessId,start,end});return {data:tables[table].filter(r=>r.business_id===businessId).slice(start,end+1),error:null}}};return q;
  }};
}
test('user export prepares tenant-scoped paginated clients and full job archive with honest labels',async()=>{
  const requests=[];
  const customers=Array.from({length:1001},(_,i)=>({id:String(i),business_id:'A',name:'Synthetic '+i,email:'sample@example.test',phone:'0210000000',address:'12 Test Lane',details:{billingAddress:'PO Box 1'}}));
  const job={id:'job-1',business_id:'A',customer_id:'0',status:'won',quote_id:'quote-1',scheduled_date:'2026-10-15',details:{total:115,services:[{svc:'wash',qty:1}],notes:'Synthetic only'},custom_archive_field:'preserved'};
  const db=exportDb({customers:[...customers,{id:'foreign',business_id:'B',name:'Other business'}],jobs:[job,{id:'foreign-job',business_id:'B'}]},requests);
  const clients=await I.prepareExport('clients',{db,businessId:'A'});
  assert.equal(clients.count,1001);assert.equal(clients.filename,'turnkey-servicem8-clients.csv');
  const parsed=I.parse(clients.text);assert.equal(I.detect(parsed.headers),'clients');assert.equal(I.objects(parsed)[0]['Telephone Number'],'0210000000');
  assert.equal(requests.length,2);assert.equal(requests[1].start,1000);
  assert.ok(requests.every(q=>q.businessId==='A'));
  const jobs=await I.prepareExport('jobs',{db,businessId:'A'});assert.equal(jobs.count,1);assert.match(jobs.filename,/archive/);
  const archive=I.objects(I.parse(jobs.text))[0];assert.deepEqual(JSON.parse(archive['Record JSON']),job);
  assert.equal(JSON.parse(archive['Details JSON']).services[0].svc,'wash');
  const upload=mounted().sm8RenderUpload();assert.match(upload,/openExport/);assert.match(upload,/not a ServiceM8 job import file/);
  await assert.rejects(I.prepareExport('clients',{db,businessId:null}),/Sign in/);
  await assert.rejects(I.prepareExport('clients',{db,businessId:'A',isCurrent:()=>false}),/business changed/);
  await assert.rejects(I.prepareExport('other',{db,businessId:'A'}),/Choose clients or jobs/);
});
test('export aborts on query failure, mismatched tenant or a business switch during pagination',async()=>{
  const query=data=>({from(){const q={select(){return q},eq(){return q},order(){return q},async range(){return data}};return q;}});
  await assert.rejects(I.prepareExport('clients',{db:query({data:null,error:{message:'private server error'}}),businessId:'A'}),e=>/Could not read your customers/.test(e.message)&&!e.message.includes('private server error'));
  await assert.rejects(I.prepareExport('clients',{db:query({data:[{business_id:'B'}]}),businessId:'A'}),/outside your business/);
  let checks=0;
  const many=Array.from({length:1000},(_,i)=>({id:String(i),business_id:'A',name:'Synthetic'}));
  await assert.rejects(I.prepareExport('clients',{db:exportDb({customers:many}),businessId:'A',isCurrent:()=>++checks<2}),/business changed/);
});
test('additive webhook health migration upgrades old tables and preserves existing subscription timestamps',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
  try {
    await db.exec("create table servicem8_connections(business_id text primary key); insert into servicem8_connections values ('synthetic-business')");
    const sql=fs.readFileSync('supabase/migrations/20261016054350_ensure_servicem8_webhook_health.sql','utf8');
    await db.exec(sql);
    assert.equal((await db.query('select webhook_subscribed_at from servicem8_connections')).rows[0].webhook_subscribed_at,null);
    await db.exec("update servicem8_connections set webhook_subscribed_at='2026-10-15T00:00:00Z'");
    await db.exec(sql);
    assert.equal(new Date((await db.query('select webhook_subscribed_at from servicem8_connections')).rows[0].webhook_subscribed_at).toISOString(),'2026-10-15T00:00:00.000Z');
  } finally {await db.close();}
});
