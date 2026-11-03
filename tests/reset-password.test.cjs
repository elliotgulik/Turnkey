const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const tick=()=>new Promise(setImmediate);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const session=id=>({user:{id,email:id+'@example.test'}});
function fixture({startup,update,userCheck,remembered}={}){
 const elements=new Map(),storage=new Map();let callback,current=null,reads=0,updates=0;
 if(remembered)storage.set('turnkey-password-recovery',JSON.stringify({userId:remembered,at:Date.now()}));
 function element(id){if(!elements.has(id))elements.set(id,{hidden:id==='reset-change'||id==='reset-success',value:'',textContent:'',listeners:{},classList:{toggle(){}},setAttribute(){},focus(){},reportValidity:()=>true,reset(){},addEventListener(event,fn){this.listeners[event]=fn;}});return elements.get(id);}
 const auth={
  onAuthStateChange(fn){callback=fn;},
  getSession:async()=>{if(++reads===1&&startup)return startup;return {data:{session:current}};},
  getUser:async()=>userCheck?userCheck:{data:{user:current?.user}},
  updateUser:async()=>{updates++;return update?update:{error:null};},
  resetPasswordForEmail:async()=>({error:null})
 };
 const ctx=vm.createContext({URLSearchParams,Date,document:{getElementById:element},location:{hash:'',search:'',pathname:'/reset-password.html',origin:'https://turnkey.test'},history:{replaceState(){}},sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},window:{TURNKEY_CONFIG:{supabaseUrl:'https://fixture.test',supabaseAnonKey:'fixture'},supabase:{createClient:()=>({auth})}}});
 vm.runInContext(fs.readFileSync('reset-password.js','utf8'),ctx);
 return {element,auth,updates:()=>updates,emit(event,s){current=s;assert.equal(callback(event,s),undefined,'auth callbacks must stay synchronous');},submit(){element('reset-password').value=element('reset-confirm').value='fixture-password';return element('reset-change').listeners.submit({preventDefault(){}});}};
}
test('a startup snapshot cannot switch a recovery event to a different account',async()=>{
 const gate=deferred(),f=fixture({startup:gate.promise});f.emit('PASSWORD_RECOVERY',session('staff'));gate.resolve({data:{session:session('owner')}});await tick();
 assert.match(f.element('reset-description').textContent,/staff@example.test/);assert.equal(f.element('reset-change').hidden,false);
});
test('startup success or error cannot undo a later sign-out or recovery event',async()=>{
 for(const error of [false,true]){
  const gate=deferred(),f=fixture({startup:gate.promise,remembered:'staff'});
  f.emit('SIGNED_OUT',null);if(error)gate.reject(Error('Old network error'));else gate.resolve({data:{session:session('staff')}});await tick();
  assert.equal(f.element('reset-change').hidden,true);assert.match(f.element('reset-status').textContent,/session changed/);
 }
 const gate=deferred(),f=fixture({startup:gate.promise});f.emit('PASSWORD_RECOVERY',session('staff'));gate.reject(Error('Old network error'));await tick();
 assert.equal(f.element('reset-change').hidden,false);assert.equal(f.element('reset-status').textContent,'');
});
test('account changes during server identity validation block password update',async()=>{
 const gate=deferred(),f=fixture({userCheck:gate.promise});await tick();f.emit('PASSWORD_RECOVERY',session('staff'));
 const save=f.submit();await tick();f.emit('SIGNED_IN',session('owner'));gate.resolve({data:{user:session('staff').user}});await save;
 assert.equal(f.updates(),0);assert.equal(f.element('reset-change').hidden,true);
});
test('late password-save success or failure cannot overwrite a newer recovery screen',async()=>{
 for(const error of [null,{message:'Old password request failed'}]){
  const gate=deferred(),f=fixture({update:gate.promise});await tick();f.emit('PASSWORD_RECOVERY',session('staff'));
  const save=f.submit();await tick();assert.equal(f.updates(),1);f.emit('PASSWORD_RECOVERY',session('other-staff'));
  gate.resolve({error});await save;assert.equal(f.element('reset-success').hidden,true);assert.equal(f.element('reset-change').hidden,false);
  assert.match(f.element('reset-description').textContent,/other-staff@example.test/);assert.equal(f.element('reset-status').textContent,'');
 }
});
test('an ordinary session cannot reset its password without a recovery event or matching marker',async()=>{
 const f=fixture();await tick();f.emit('SIGNED_IN',session('staff'));await f.submit();assert.equal(f.updates(),0);
});
test('valid recovery saves once and session expiry returns to requesting a link',async()=>{
 const f=fixture();await tick();f.emit('PASSWORD_RECOVERY',session('staff'));await f.submit();assert.equal(f.updates(),1);assert.equal(f.element('reset-success').hidden,false);
 const expired=fixture();await tick();expired.emit('PASSWORD_RECOVERY',session('staff'));expired.auth.getSession=async()=>({data:{session:null}});await expired.submit();
 assert.equal(expired.updates(),0);assert.equal(expired.element('reset-change').hidden,true);assert.match(expired.element('reset-status').textContent,/expired/);
});
