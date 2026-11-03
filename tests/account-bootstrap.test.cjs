const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function harness(response){
 const calls=[];
 const chain=new Proxy({}, {get:(_,key)=>key==='then'?response.promise.then.bind(response.promise):(...args)=>{calls.push([key,...args]);return chain;}});
 const c=vm.createContext({currentBusinessId:'company-A',currentUserId:'owner-A',businessSessionVersion:1,currentUserRole:'owner',staff:[],pendingInvites:[],emailAccount:null,currentBusinessProfile:null,console,sb:{from:table=>{calls.push(['from',table]);return chain;}},applyPricingConfig:()=>{c.applied=true;},applyWorkflowConfig:()=>{c.applied=true;}});
 vm.runInContext(section('function captureAccountScope(){','function clearAccountConnections(){'),c);
 return{c,calls};
}
test('late staff results cannot populate a different company or issue its invite request',async()=>{
 const d=deferred(),{c,calls}=harness(d);
 vm.runInContext(section('async function loadStaffAndInvites(){','async function openTeam()'),c);
 const pending=c.loadStaffAndInvites();c.currentBusinessId='company-B';c.currentUserId='staff-B';c.businessSessionVersion++;
 d.resolve({data:[{id:'owner-A'}]});await pending;
 assert.equal(c.staff.length,0);assert.equal(calls.filter(x=>x[0]==='from').length,1);
});
test('late company settings cannot alter pricing after an account switch',async()=>{
 const d=deferred(),{c}=harness(d);
 vm.runInContext(section('async function loadBusinessProfile(){','// Quote/invoice PDFs'),c);
 const pending=c.loadBusinessProfile();c.currentUserId='staff-A';c.businessSessionVersion++;
 d.resolve({data:{id:'company-A',pricing_config:{rate:123}}});await pending;
 assert.equal(c.currentBusinessProfile,null);assert.equal(c.applied,undefined);
});
test('staff sign-in never attempts to provision a missing owner company',async()=>{
 const d=deferred(),{c,calls}=harness(d);c.currentUserRole='technician';
 vm.runInContext(section('async function loadBusinessProfile(){','// Quote/invoice PDFs'),c);
 const pending=c.loadBusinessProfile();d.resolve({data:null});await pending;
 assert.equal(calls.some(x=>x[0]==='upsert'),false);
});
test('Gmail lookup scopes both company and user, and ignores a previous user response',async()=>{
 const d=deferred(),{c,calls}=harness(d);
 vm.runInContext(section('async function loadEmailAccountStatus(){','// A fetch()'),c);
 const pending=c.loadEmailAccountStatus();c.currentUserId='other-user';c.businessSessionVersion++;
 d.resolve({data:{business_id:'company-A',user_id:'owner-A',email_address:'private@example.test'}});await pending;
 assert.equal(c.emailAccount,null);
 assert.ok(calls.some(x=>x[0]==='eq'&&x[1]==='business_id'&&x[2]==='company-A'));
 assert.ok(calls.some(x=>x[0]==='eq'&&x[1]==='user_id'&&x[2]==='owner-A'));
});
test('a current Gmail result remains available to its owner',async()=>{
 const d=deferred(),{c}=harness(d);
 vm.runInContext(section('async function loadEmailAccountStatus(){','// A fetch()'),c);
 const pending=c.loadEmailAccountStatus();d.resolve({data:{business_id:'company-A',user_id:'owner-A',email_address:'mine@example.test'}});await pending;
 assert.equal(c.emailAccount.email_address,'mine@example.test');
});
function bootHarness(){
 const d=deferred();let listener;const starts=[];
 const c=vm.createContext({sb:{auth:{getSession:()=>d.promise,onAuthStateChange:fn=>{listener=fn;}}},appSessionGate:{start:session=>{starts.push(session.user.id);return Promise.resolve();},reset(){},isPending:()=>false},authRecoveryActive:false,businessStateReady:false,businessSessionVersion:1,window:{TK_MFA:{reset(){}}},showPasswordRecovery(){},showAuth(){},setAuthMsg(){},businessStoreKey:()=>'',STORE_KEY:'test',localStorage:{removeItem(){}},clearAccountConnections(){},clearTimeout(){},supabaseSyncTimer:null,goals:[],goalSeq:1,seq:1,followSeq:1,unsubscribeRealtime(){},stopLastSeenHeartbeat(){},records:[],currentBusinessId:null,currentUserId:null,currentUserRole:'owner',staff:[],pendingInvites:[],render(){},renderAll(){}});
 vm.runInContext(section('let authEventRevision=0;','// Install as an app'),c);
 return {c,d,starts,event:(event,session)=>listener(event,session)};
}
test('a startup snapshot cannot resurrect a signed-out account',async()=>{
 const h=bootHarness();h.event('SIGNED_OUT',null);h.d.resolve({data:{session:{user:{id:'old-user'}}}});
 await new Promise(r=>setImmediate(r));assert.equal(h.starts.length,0);
});
test('a newer signed-in account wins over the startup snapshot',async()=>{
 const h=bootHarness();h.event('SIGNED_IN',{user:{id:'new-user'}});h.d.resolve({data:{session:{user:{id:'old-user'}}}});
 await new Promise(r=>setImmediate(r));assert.deepEqual(h.starts,['new-user']);
});
test('signing out of recovery allows the next account to sign in normally',async()=>{
 const h=bootHarness();h.event('PASSWORD_RECOVERY',{user:{id:'reset-user'}});h.event('SIGNED_OUT',null);h.event('SIGNED_IN',{user:{id:'next-user'}});
 assert.equal(h.c.authRecoveryActive,false);assert.deepEqual(h.starts,['next-user']);h.d.resolve({data:{session:null}});
});
test('late template lookup cannot seed templates into the next company',async()=>{
 const d=deferred(),{c,calls}=harness(d);c.emailTemplates={};c.EMAIL_TEMPLATE_DEFAULTS={quote:{},invoice:{}};
 vm.runInContext(section('async function loadEmailTemplates(){','// {{customer_name}}'),c);
 const pending=c.loadEmailTemplates();c.currentBusinessId='company-B';c.businessSessionVersion++;
 d.resolve({data:[]});await pending;
 assert.equal(calls.some(x=>x[0]==='upsert'),false);assert.equal(Object.keys(c.emailTemplates).length,0);
});
test('a null initial auth event reveals sign-in even before the startup lookup settles',async()=>{
 const h=bootHarness();let shown=0;h.c.showAuth=()=>shown++;
 h.event('INITIAL_SESSION',null);h.d.resolve({data:{session:null}});await new Promise(r=>setImmediate(r));
 assert.equal(shown,1);assert.equal(h.starts.length,0);
});
