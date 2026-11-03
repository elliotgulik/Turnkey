const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function fixture({verified=true,level='aal1',fail=false}={}){
 const input={value:'123456',focus(){}},form={},cancel={},submit={},message={},normal={style:{}};
 const card={remove(){this.removed=true;},querySelector:sel=>({'form':form,'[data-cancel]':cancel,'[type=submit]':submit,'[role=alert]':message}[sel])};
 const calls=[];let signedOut=0;let failure=fail;
 const ctx=vm.createContext({window:{},showAuth(){},currentUserRole:'owner',document:{getElementById:id=>id==='auth-card-normal'?normal:id==='auth-mfa-code'?input:null,createElement:()=>card,querySelector:()=>({append(){}})},sb:{auth:{mfa:{listFactors:async()=>({data:{totp:verified?[{id:'factor',status:'verified'}]:[]}}),getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:level}}),challengeAndVerify:async args=>{calls.push(args);return {error:failure?{message:'Incorrect code'}:null};}},getSession:async()=>({data:{session:{user:{id:'owner'}}}}),signOut:async()=>{signedOut++;}}}});
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
