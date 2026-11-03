const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../sales-platform.js'), 'utf8');
const helpers = source.slice(source.indexOf('  let followupEditorSerial ='), source.indexOf('  function openStageSettings()'));
const step = (overrides = {}) => ({id:'first',delayDays:2,subject:'Your quote from {business_name}',body:'Hi {customer_name}\n{quote_link}',...overrides});
function fixture(extra = {}) {
  const context = vm.createContext({currentBusinessId:'business-a',currentUserRole:'owner',peopleScope:()=>context.currentBusinessId+':owner:1',...extra});
  vm.runInContext(helpers,context);
  return context;
}

test('new sequences start disabled and blank, and drafts require a valid increasing cadence', () => {
  const c=fixture();
  assert.equal(c.validateFollowupDraft({enabled:false,steps:[]}).enabled,false);
  assert.throws(()=>c.validateFollowupDraft({enabled:true,steps:[]}),/at least one step/);
  const valid=c.validateFollowupDraft({enabled:true,steps:[step(),step({id:'second',delayDays:5})]});
  assert.deepEqual(Array.from(valid.steps,s=>s.delayDays),[2,5]);
  for(const delayDays of [0,-1,1.5,366,NaN,Infinity])assert.throws(()=>c.validateFollowupDraft({enabled:true,steps:[step({delayDays})]}),/whole day/);
  for(const delayDays of [1,2])assert.throws(()=>c.validateFollowupDraft({enabled:true,steps:[step(),step({id:'second',delayDays})]}),/later than/);
  assert.throws(()=>c.validateFollowupDraft({enabled:true,steps:[step(),step({delayDays:4})]}),/identifier/);
  assert.throws(()=>c.validateFollowupDraft({enabled:false,steps:Array.from({length:7},(_,i)=>step({id:'s'+i,delayDays:i+1}))}),/six/);
});

test('message validation preserves distinct subjects, multiline bodies and supported placeholders', () => {
  const c=fixture();
  const valid=c.validateFollowupDraft({enabled:true,steps:[step({subject:'  First message  '}),step({id:'second',delayDays:7,subject:'Any questions?',body:'Hello {{customer_name}},\n\nPlease reply.\n{business_name}'})]});
  assert.equal(valid.steps[0].subject,'First message');assert.equal(valid.steps[1].subject,'Any questions?');
  assert.match(valid.steps[1].body,/\n\nPlease reply/);
  for(const subject of ['', ' ', 'x'.repeat(201), 'Hello\r\nBcc: unwanted@example.test'])assert.throws(()=>c.validateFollowupDraft({enabled:true,steps:[step({subject})]}),/subject/);
  for(const body of ['', ' ', 'x'.repeat(10001)])assert.throws(()=>c.validateFollowupDraft({enabled:true,steps:[step({body})]}),/message/);
  assert.throws(()=>c.validateFollowupDraft({enabled:true,steps:[step({body:'Hi {unsupported}'})]}),/unsupported placeholder/);
});

function saveFixture(request) {
  const editor={disabled:false},alerts={textContent:'old error'},notices=[];
  let closes=0;
  const form={dataset:{scope:'business-a:owner:1'},isConnected:true,elements:{namedItem:()=>({checked:true})},
    querySelectorAll:()=>[{dataset:{followupStep:'first'},querySelector:selector=>({value:selector.includes('delayDays')?'2':selector.includes('subject')?'Checking your quote':'Please reply if you have questions.'})}],
    querySelector:()=>editor};
  const c=fixture({document:{getElementById:()=>({querySelector:()=>alerts,close(){closes++;}})},api:request,toast:message=>notices.push(message)});
  return {c,form,editor,notices,closes:()=>closes};
}
test('explicit save sends only the per-business settings contract; duplicate submits cannot send twice',async()=>{
  const calls=[];let release;
  const f=saveFixture((path,opts)=>{calls.push({path,opts});return new Promise(resolve=>release=resolve);});
  const saving=f.c.saveFollowupSettings(f.form);
  assert.equal(f.editor.disabled,true);
  await f.c.saveFollowupSettings(f.form);assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/sales/followup-settings');assert.equal(calls[0].opts.method,'PUT');
  const data=JSON.parse(calls[0].opts.body);assert.deepEqual(Object.keys(data),['enabled','steps']);assert.equal(data.enabled,true);assert.equal(data.steps[0].body,'Please reply if you have questions.');
  release({enabled:true,steps:data.steps});await saving;
  assert.equal(f.closes(),1);assert.equal(f.notices.length,1);
});
test('failed save preserves the editor and permits retry; stale sessions cannot save or display success',async()=>{
  const f=saveFixture(async()=>{throw Error('Could not save');});
  await assert.rejects(f.c.saveFollowupSettings(f.form),/Could not save/);
  assert.equal(f.editor.disabled,false);assert.equal(f.closes(),0);assert.equal(f.notices.length,0);
  f.c.currentBusinessId='business-b';
  await assert.rejects(f.c.saveFollowupSettings(f.form),/session changed/);
  let release;const pending=saveFixture(()=>new Promise(resolve=>release=resolve));
  const saving=pending.c.saveFollowupSettings(pending.form);pending.c.currentBusinessId='business-b';release({});await saving;
  assert.equal(pending.closes(),0);assert.equal(pending.notices.length,0);
});
test('staff cannot save business follow-up settings',async()=>{
  let requests=0;const f=saveFixture(async()=>{requests++;});f.c.currentUserRole='staff';
  await assert.rejects(f.c.saveFollowupSettings(f.form),/owner or manager/);assert.equal(requests,0);
});
test('a business change during authentication cannot send an old settings save to the next business',async()=>{
  let release,requests=0;
  const c=vm.createContext({currentUserId:'owner',currentBusinessId:'business-a',businessSessionVersion:1,
    backendUrl:()=> 'https://backend.example.test',window:{TK_CURRENT_SESSION:null},
    sb:{auth:{getSession:()=>new Promise(resolve=>release=resolve)}},setTimeout,clearTimeout,AbortController,
    fetch:async()=>{requests++;return {ok:true,json:async()=>({})};}});
  vm.runInContext(source.slice(source.indexOf('  async function api('),source.indexOf('  async function syncServiceM8Dispatch(')),c);
  const saving=c.api('/api/sales/followup-settings',{method:'PUT',body:'{"enabled":true,"steps":[]}'});
  await new Promise(resolve=>setImmediate(resolve));c.currentBusinessId='business-b';c.businessSessionVersion++;
  release({data:{session:{user:{id:'owner'},access_token:'fixture-token',expires_at:Date.now()/1000+3600}}});
  await assert.rejects(saving,/business session changed/);assert.equal(requests,0);
});
test('dashboard and analytics disclose excluded historical sales without assuming a revenue amount',()=>{
  const start=source.indexOf('  function notice(report)'),end=source.indexOf('  renderDashboard =',start);
  const c=vm.createContext({metrics:null,migrationError:'',esc:String});vm.runInContext(source.slice(start,end),c);
  assert.match(c.notice({unknownWinDates:12}),/12 historical jobs have no verified sale date and are excluded from dated booked sales/);
  assert.match(c.notice({unknownWinDates:1}),/1 historical job has no verified sale date and is excluded/);
  assert.equal(c.notice({unknownWinDates:0}),'');
  assert.match(source.slice(source.indexOf('  renderDashboard ='),source.indexOf('  renderSales =')),/notice\(r\)/);
  assert.match(source.slice(source.indexOf('  renderSales ='),source.indexOf('  renderSales =')+600),/notice\(r\)/);
});
