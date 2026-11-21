import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {DEFAULT_WELCOME,validateWelcome,normalizeSmsPhone,welcomeEligibility,welcomeContent,smsReady,sendWelcomeSms,installLeadWelcome} from './leadWelcome.js';
const settings=()=>({...DEFAULT_WELCOME,sources:['wix','meta','booking']});
const env={TWILIO_BUSINESS_ID:'b',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'private-fixture',TWILIO_MESSAGING_SERVICE_SID:'MG'+'b'.repeat(32),TWILIO_OPT_OUT_READY:'true',SUPABASE_SERVICE_ROLE_KEY:'fixture-signing-secret'};

test('welcome defaults are off and validation requires a safe link, template and sources',()=>{
 assert.equal(DEFAULT_WELCOME.enabled,false);
 assert.equal(validateWelcome(settings()).trustUrl,'https://www.instagram.com/novaexterior/');
 for(const patch of [{trustUrl:'http://example.test'},{trustUrl:'https://user:secret@example.test'},{body:'Hi without link'},{body:'{unknown} {trust_link}'},{subject:'Hi\r\nBcc: x'},{sources:['unknown']}])assert.throws(()=>validateWelcome({...settings(),...patch}));
 assert.equal(welcomeContent(settings(),{name:'Mike Simpson'},'Nova Exterior').body,'Hi Mike, thanks for contacting Nova Exterior! While we review your enquiry, see our work and how we care for your property: https://www.instagram.com/novaexterior/');
});
test('NZ SMS numbers normalize; missing, landline and foreign numbers are excluded',()=>{
 for(const input of ['021 605 354','+64 21 605 354','006421605354'])assert.equal(normalizeSmsPhone(input),'+6421605354');
 for(const input of ['',null,'099999999','+15551234567','abc','02112'])assert.equal(normalizeSmsPhone(input),null);
});
test('eligibility excludes history, opted-out recipients and terms-only consent',()=>{
 const now=Date.now(),created=new Date(now).toISOString(),lead={customer:{name:'Mike'},submittedAt:now};
 assert.match(welcomeEligibility(lead,settings(),created,now),/consent/);
 assert.equal(welcomeEligibility({...lead,smsConsent:true},settings(),created,now),null);
 assert.equal(welcomeEligibility({...lead,formAnswers:[{label:'SMS consent',answer:'Checked'}]},settings(),created,now),null);
 assert.match(welcomeEligibility({...lead,formAnswers:[{label:'I agree to terms and conditions',answer:'Checked'}]},settings(),created,now),/consent/);
 assert.match(welcomeEligibility({...lead,historicalImport:true,smsConsent:true},settings(),created,now),/Historical/);
 assert.match(welcomeEligibility({...lead,submittedAt:now-7200000,smsConsent:true},settings(),created,now),/Historical/);
 assert.match(welcomeEligibility({...lead,customer:{followups_disabled:true}},settings(),created,now),/opted out/);
 assert.equal(welcomeEligibility(lead,{...settings(),consentMode:'enquiries'},created,now),null);
});
test('SMS uses scoped server credentials, a trusted provider URL and STOP text',async()=>{
 assert.equal(smsReady(env,'other'),false);
 assert.equal(smsReady({...env,TWILIO_OPT_OUT_READY:'false'},'b'),false);
 let calls=0;
 const send=async(url,options)=>{calls++;assert.match(url,/^https:\/\/api.twilio.com\/2010-04-01\/Accounts\/AC[a]+\/Messages.json$/);assert.equal(options.body.get('To'),'+6421605354');assert.match(options.body.get('Body'),/Reply STOP/);return {ok:true,json:async()=>({sid:'SM-fixture'})};};
 assert.equal((await sendWelcomeSms(env,'b','+6421605354','Welcome',send)).id,'SM-fixture');
 await assert.rejects(sendWelcomeSms(env,'other','+6421605354','Hi',send),/not configured/);assert.equal(calls,1);
 await assert.rejects(sendWelcomeSms(env,'b','+6421605354','Hi',async()=>({ok:false,json:async()=>({code:21610})})),error=>error.definitelyRejected&&/opted out/.test(error.message));
});

test('migration is repeatable, isolates configuration and queues each new lead only once',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table public.businesses(id text primary key);create table public.leads(id uuid primary key default gen_random_uuid(),business_id text,payload jsonb not null,source text,created_at timestamptz default now());
 insert into businesses values('b'),('other');`);
 const sql=fs.readFileSync(new URL('../../supabase/migrations/20261120223607_lead_welcome_messages.sql',import.meta.url),'utf8');
 await db.exec(sql);await db.exec(sql);
 await db.query('insert into lead_welcome_settings(business_id,settings) values($1,$2)',['b',{...settings(),enabled:true}]);
 await db.query("insert into leads(business_id,source,payload) values('b','wix',$1),('b','meta',$2),('other','wix',$1),('b','Turnkey quote widget',$1)",[{customer:{name:'Mike'}},{historicalImport:true,customer:{name:'Old lead'}}]);
 assert.equal((await db.query('select count(*)::int as n from lead_welcome_messages')).rows[0].n,2);
 const [first,second]=await Promise.all([db.query('select * from claim_lead_welcomes()'),db.query('select * from claim_lead_welcomes()')]);
 assert.equal(first.rows.length+second.rows.length,2);assert.equal((await db.query('select * from claim_lead_welcomes()')).rows.length,0);
 assert.equal((await db.query("select has_table_privilege('authenticated','lead_welcome_settings','select') as allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_function_privilege('authenticated','claim_lead_welcomes()','execute') as allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});

function memoryDb({enabled=true,consent=true}={}){
 const data={lead_welcome_settings:[{business_id:'b',settings:{...settings(),enabled,consentMode:consent?'enquiries':'explicit',senderUserId:'owner'}}],
 leads:[{id:'lead',business_id:'b',created_at:new Date().toISOString(),payload:{source:'wix',customer:{name:'Mike',phone:'021605354'}}}],lead_welcome_suppressions:[],customers:[],businesses:[{id:'b',name:'Nova Exterior'}],email_accounts:[],users:[],
 lead_welcome_messages:[{id:'message',business_id:'b',lead_id:'lead',status:'queued',settings:{...settings(),consentMode:'enquiries',enabled:true},channel:'sms',created_at:new Date().toISOString()}]};
 return {data,from(table){let filters=[],patch,one=false,limit=Infinity;
  const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},lt(k,v){filters.push(r=>r[k]<v);return q;},ilike(k,v){return q.eq(k,v);},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},limit(n){limit=n;return q;},order(){return q;},maybeSingle(){one=true;return q;},update(v){patch=v;return q;},upsert(v){data[table].push(v);return q;},then(resolve){let rows=data[table].filter(r=>filters.every(f=>f(r))).slice(0,limit);if(patch)rows.forEach(r=>Object.assign(r,patch));return Promise.resolve({data:one?rows[0]||null:rows,error:null}).then(resolve);}};return q;},
 rpc(){const rows=data.lead_welcome_messages.filter(r=>r.status==='queued');rows.forEach(r=>r.status='sending');return Promise.resolve({data:rows,error:null});}};
}
function service(db,sendSms){const routes=[];return {...installLeadWelcome({get(...args){routes.push(args);},put(...args){routes.push(args);},post(...args){routes.push(args);}},{db,requireBusiness:(_q,_s,next)=>next(),getValidAccessToken:async()=>null,env,sendSms}),routes};}
test('worker sends once after a durable claim, and duplicate ticks do not resend',async()=>{
 const db=memoryDb();let count=0;const worker=service(db,async()=>{count++;return {id:'SM-one'};});
 await Promise.all([worker.tick(),worker.tick()]);await worker.tick();
 assert.equal(count,1);assert.equal(db.data.lead_welcome_messages[0].status,'accepted');
});
test('disabled company and opted-out customers are excluded at send time',async()=>{
 for(const kind of ['disabled','optout']){
 const db=memoryDb({enabled:kind!=='disabled'});if(kind==='optout')db.data.customers.push({id:'c',business_id:'b',phone:'021605354',followups_disabled:true});
 const worker=service(db,async()=>{throw Error('must not send');});await worker.tick();assert.equal(db.data.lead_welcome_messages[0].status,'skipped');
 }
});
test('ambiguous provider failure is held for review, never automatically retried',async()=>{
 const db=memoryDb();let calls=0;const worker=service(db,async()=>{calls++;throw Error('timeout');});
 await worker.tick();await worker.tick();assert.equal(calls,1);assert.equal(db.data.lead_welcome_messages[0].status,'unknown');
});
test('staff cannot read or change company welcome settings',()=>{
 const worker=service(memoryDb(),async()=>({id:'x'}));
 for(const route of worker.routes.filter(r=>r[0]==='/api/leads/welcome-settings')){
 let status;route[2]({businessRole:'technician'},{status(n){status=n;return this;},json(){}},()=>{throw Error('must not allow');});assert.equal(status,403);
 }
});

test('welcome email uses the saving manager Gmail and records provider acceptance',async()=>{
 const db=memoryDb();const row=db.data.lead_welcome_messages[0];row.channel='email';row.settings={...row.settings,channel:'email',senderUserId:'owner'};
 db.data.lead_welcome_settings[0].settings.channel='email';
 db.data.leads[0].payload.customer.email='mike@example.test';
 db.data.users.push({id:'owner',business_id:'b',role:'manager'});
 let sent;
 const worker=installLeadWelcome({get(){},put(){},post(){}},{db,requireBusiness(){},env,getValidAccessToken:async(b,u,p)=>{
 assert.equal(b,'b');assert.equal(u,'owner');assert.equal(p,'gmail');return {accessToken:'private-fixture',account:{email_address:'team@example.test'}};
 },sendEmail:async(_token,message)=>{sent=message;return {id:'gmail-one'};}});
 await worker.tick();assert.equal(row.status,'accepted');assert.equal(sent.to,'mike@example.test');assert.match(sent.bodyText,/https:\/\/www.instagram.com\/novaexterior\//);assert.match(sent.bodyHtml,/welcome-unsubscribe\?id=message/);assert.doesNotMatch(sent.bodyHtml,/private-fixture|fixture-signing-secret/);
});

test('saving welcome settings binds them to the authenticated company, not request fields',async()=>{
 const db=memoryDb(),worker=service(db,async()=>({id:'unused'}));
 // Both GET and PUT have four middleware entries; choose the final settings route.
 const save=worker.routes.filter(r=>r[0]==='/api/leads/welcome-settings').at(-1).at(-1);
 let body,status;
 await save({businessId:'b',userId:'owner',body:{...settings(),enabled:false,business_id:'foreign',senderUserId:'foreign'}},{json(v){body=v;return this;},status(n){status=n;return this;}});
 assert.equal(status,undefined);assert.ok(body.settings);
 const stored=db.data.lead_welcome_settings.at(-1);
 assert.equal(stored.business_id,'b');assert.equal(stored.settings.senderUserId,'owner');
 assert.equal(body.settings.senderUserId,undefined);
});

test('provider setup is required before activation and never triggers a test send',async()=>{
 const db=memoryDb();let sends=0;const worker=service(db,async()=>{sends++;});
 const save=worker.routes.filter(r=>r[0]==='/api/leads/welcome-settings').at(-1).at(-1);
 let status;
 await save({businessId:'other',userId:'owner',body:{...settings(),enabled:true}},{json(){return this;},status(n){status=n;return this;}});
 assert.equal(status,400);assert.equal(sends,0);
});
