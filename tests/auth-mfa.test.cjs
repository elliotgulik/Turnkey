const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function fixture({verified=true,level='aal1',fail=false,listGate,levelGate,verifyGate}={}){
 const input={value:'123456',focus(){}},form={},cancel={},submit={},message={},normal={style:{}};
 const card={remove(){this.removed=true;},querySelector:sel=>({'form':form,'[data-cancel]':cancel,'[type=submit]':submit,'[role=alert]':message}[sel])};
 const calls=[];let signedOut=0;let failure=fail;
 const ctx=vm.createContext({window:{},showAuth(){},currentUserRole:'owner',document:{getElementById:id=>id==='auth-card-normal'?normal:id==='auth-mfa-code'?input:id===card.id&&!card.removed?card:null,createElement:()=>card,querySelector:()=>({append(){}})},sb:{auth:{mfa:{listFactors:async()=>{if(listGate)await listGate;return {data:{totp:verified?[{id:'factor',status:'verified'}]:[]}};},getAuthenticatorAssuranceLevel:async()=>{if(levelGate)await levelGate;return {data:{currentLevel:level}};},challengeAndVerify:async args=>{calls.push(args);if(verifyGate)await verifyGate;return {error:failure?{message:'Incorrect code'}:null};}},getSession:async()=>({data:{session:{user:{id:'owner'}}}}),signOut:async()=>{signedOut++;}}}});
 vm.runInContext(fs.readFileSync('auth-mfa.js','utf8'),ctx);
 return {ctx,input,form,cancel,submit,message,card,calls,setFailure(v){failure=v;},signedOut:()=>signedOut};
}
test('technicians, users without a verified factor and AAL2 sessions require no extra challenge',async()=>{
 for(const [options,role] of [[{},'technician'],[{verified:false},'owner'],[{level:'aal2'},'manager']]){const f=fixture(options);assert.equal(await f.ctx.window.TK_MFA.requireFor({user:{id:'owner'}},role),true);assert.equal(f.calls.length,0);}
});
test('verified owner cannot continue until valid six-digit TOTP succeeds; incorrect codes can retry',async()=>{
 const f=fixture({fail:true});let admitted=false;
 const wait=f.ctx.window.TK_MFA.requireFor({user:{id:'owner'}},'owner').then(value=>{admitted=value;return value;});await new Promise(setImmediate);
 assert.equal(admitted,false);f.input.value='bad';await f.form.onsubmit({preventDefault(){}});assert.equal(f.calls.length,0);
 f.input.value='123456';await f.form.onsubmit({preventDefault(){}});assert.equal(admitted,false);assert.match(f.message.textContent,/Incorrect/);assert.equal(f.submit.disabled,false);
 f.setFailure(false);await f.form.onsubmit({preventDefault(){}});assert.equal(await wait,true);assert.equal(f.card.removed,true);assert.equal(f.ctx.window.TK_CURRENT_SESSION.user.id,'owner');
});
test('cancel and sign-out resolve a pending challenge without admitting the user',async()=>{
 const f=fixture();const wait=f.ctx.window.TK_MFA.requireFor({user:{id:'owner'}},'manager');await new Promise(setImmediate);await f.cancel.onclick();assert.equal(await wait,false);assert.equal(f.signedOut(),1);
});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('reset during factor lookup or assurance lookup cannot resurrect an MFA card',async()=>{
 for(const stage of ['listGate','levelGate']){
  const gate=deferred(),f=fixture({[stage]:gate.promise});
  const wait=f.ctx.window.TK_MFA.requireFor({user:{id:'owner'}},'owner');await new Promise(setImmediate);
  f.ctx.window.TK_MFA.reset();gate.resolve();assert.equal(await wait,false);assert.equal(f.form.onsubmit,undefined);
 }
});
test('switching to a technician resolves an earlier owner challenge',async()=>{
 const f=fixture();const first=f.ctx.window.TK_MFA.requireFor({user:{id:'owner'}},'owner');await new Promise(setImmediate);
 assert.equal(await f.ctx.window.TK_MFA.requireFor({user:{id:'staff'}},'technician'),true);
 assert.equal(await first,false);assert.equal(f.card.removed,true);
});
test('a late verification after sign-out cannot restore the global session',async()=>{
 const gate=deferred(),f=fixture({verifyGate:gate.promise});
 const wait=f.ctx.window.TK_MFA.requireFor({user:{id:'owner'}},'owner');await new Promise(setImmediate);
 const submit=f.form.onsubmit({preventDefault(){}});await new Promise(setImmediate);
 f.ctx.window.TK_MFA.reset();f.ctx.window.TK_CURRENT_SESSION=null;gate.resolve();await submit;
 assert.equal(await wait,false);assert.equal(f.ctx.window.TK_CURRENT_SESSION,null);
});
test('an expired or switched session cannot issue an MFA verification',async()=>{
 for(const session of [null,{user:{id:'staff'}}]){
  const f=fixture();f.ctx.sb.auth.getSession=async()=>({data:{session}});
  const wait=f.ctx.window.TK_MFA.requireFor({user:{id:'owner'}},'owner');await new Promise(setImmediate);
  await f.form.onsubmit({preventDefault(){}});assert.equal(f.calls.length,0);assert.match(f.message.textContent,/session changed/);
  f.ctx.window.TK_MFA.reset();assert.equal(await wait,false);
 }
});
function settingsFixture({enrollGate,verifyGate}={}){
 const panels=[],removed=[],verified=[],input={value:'123456'};
 function node(){return {children:new Map(),listeners:{},querySelector(selector){if(!this.children.has(selector))this.children.set(selector,node());return this.children.get(selector);},addEventListener(event,fn){this.listeners[event]=fn;},showModal(){},close(){this.listeners.close();},remove(){this.removed=true;},replaceChildren(){}};}
 const ctx=vm.createContext({window:{TK_CURRENT_SESSION:{user:{id:'owner'}}},currentUserRole:'owner',document:{body:{append(){}},getElementById:id=>id==='mfa-enroll-code'?input:null,createElement(){const panel=node();panels.push(panel);return panel;}},sb:{auth:{
  getSession:async()=>({data:{session:{user:{id:'owner'}}}}),
  mfa:{listFactors:async()=>({data:{totp:[]}}),enroll:async()=>{if(enrollGate)await enrollGate;return {data:{id:'new-factor',totp:{qr_code:'data:image/svg+xml,fixture'}}};},unenroll:async({factorId})=>{removed.push(factorId);return {};},challengeAndVerify:async({factorId})=>{verified.push(factorId);if(verifyGate)await verifyGate;return {};}}
 }}});
 vm.runInContext(fs.readFileSync('auth-mfa.js','utf8'),ctx);
 return {ctx,panels,removed,verified,async open(){await ctx.window.TK_MFA.settings();return panels.at(-1);},async enroll(panel){const button=panel.querySelector('[data-content]').querySelector('[data-enroll]');await button.onclick({target:button});}};
}
test('closing an unverified enrollment removes its factor so setup can be retried',async()=>{
 const f=settingsFixture(),panel=await f.open();await f.enroll(panel);panel.close();await new Promise(setImmediate);assert.deepEqual(f.removed,['new-factor']);
});
test('enrollment completing after close is cleaned up without reopening the dialog',async()=>{
 const gate=deferred(),f=settingsFixture({enrollGate:gate.promise}),panel=await f.open();
 const enrolling=f.enroll(panel);panel.close();gate.resolve();await enrolling;assert.deepEqual(f.removed,['new-factor']);assert.equal(panel.removed,true);
});
test('closing during verification never removes a potentially verified authenticator',async()=>{
 const gate=deferred(),f=settingsFixture({verifyGate:gate.promise}),panel=await f.open();await f.enroll(panel);
 const form=panel.querySelector('[data-content]').querySelector('form');
 const checking=form.onsubmit({preventDefault(){},target:form});await new Promise(setImmediate);assert.deepEqual(f.verified,['new-factor']);
 panel.close();gate.resolve();await checking;assert.deepEqual(f.removed,[]);
});
test('a delayed close event from an old settings panel cannot remove the replacement panel',async()=>{
 const f=settingsFixture(),old=await f.open(),current=await f.open();old.listeners.close();assert.equal(current.removed,undefined);
 await f.enroll(current);assert.equal(current.querySelector('[data-content]').querySelector('[data-qr]').src,'data:image/svg+xml,fixture');
});
