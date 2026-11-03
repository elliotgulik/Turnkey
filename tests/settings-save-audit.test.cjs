const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function setup(write){const calls=[],messages=[],values={'biz-name-input':'Company','biz-phone-input':'021','biz-email-input':'a@example.test','biz-region-input':'New region','biz-home-address-input':'New address','cp-notes':'New notes','notif-email':'alerts@example.test'};
 const q=new Proxy({}, {get:(_,key)=>key==='then'?(resolve,reject)=>Promise.resolve().then(write).then(resolve,reject):(...args)=>{calls.push([key,...args]);return q;}});
 const c=vm.createContext({sb:{from:table=>{calls.push(['from',table]);return q;}},currentBusinessId:'A',currentUserId:'owner',businessSessionVersion:1,currentBusinessProfile:{id:'A',region:'Old region',home_address:'Old address',region_lat:1,region_lng:2,home_lat:3,home_lng:4},document:{getElementById:id=>({value:values[id]||'',checked:true})},console,toast:m=>messages.push(m),openSettings(){},geocodeRegion:async()=>null,preloadLogoDataUrl:async()=>{},customerProfileCtx:{customerId:'customer-A'},records:[{customerId:'customer-A',notes:'Original'}],saveState(){c.saved=true},logActivity(){c.logged=true},notificationPrefs:{original:true},NOTIFICATION_EVENTS:[{key:'quote_accepted'},{key:'payment_received'}],EMAIL_TEMPLATE_DEFAULTS:{}});
 vm.runInContext(section('function captureAccountScope(){','function clearAccountConnections(){'),c);
 return{c,calls,messages};
}
test('failed preference writes do not claim success or alter saved preferences',async()=>{
 const f=setup(()=>({error:Error('database offline')}));vm.runInContext(section('async function saveNotificationPrefs(){','/* ===== Push notifications'),f.c);await f.c.saveNotificationPrefs();
 assert.equal(f.c.notificationPrefs.original,true);assert.equal(f.messages.some(m=>m==='Notification preferences saved'),false);assert.match(f.messages.at(-1),/Could not save/);
 const payload=f.calls.find(x=>x[0]==='upsert')[1];assert.equal(payload.length,2);assert.ok(payload.every(x=>x.business_id==='A'));
});
test('changed address and region clear stale coordinates when geocoding has no result',async()=>{
 const f=setup(()=>({data:{id:'A'}}));vm.runInContext(section('async function saveBusinessProfile(){',"const LOGO_BUCKET="),f.c);await f.c.saveBusinessProfile();
 const payload=f.calls.find(x=>x[0]==='upsert')[1];for(const key of ['region_lat','region_lng','home_lat','home_lng'])assert.equal(payload[key],null);
});
test('company switch during geocoding prevents the profile write',async()=>{
 const f=setup(()=>({data:{id:'A'}})),d=deferred();f.c.geocodeRegion=()=>d.promise;vm.runInContext(section('async function saveBusinessProfile(){',"const LOGO_BUCKET="),f.c);
 const pending=f.c.saveBusinessProfile();f.c.currentBusinessId='B';f.c.businessSessionVersion++;d.resolve({lat:1,lng:2});await pending;assert.equal(f.calls.some(x=>x[0]==='upsert'),false);
});
test('logo uploaded under an old account is never attached to the next company',async()=>{
 const f=setup(()=>({data:{id:'B'}})),d=deferred();f.c.sb.storage={from:()=>({upload:()=>d.promise,getPublicUrl:()=>({data:{publicUrl:'https://example.test/logo'}})})};
 vm.runInContext(section("const LOGO_BUCKET=",'/* =====================================================================\n   IMPORT WIZARD'),f.c);
 const pending=f.c.uploadBusinessLogo({type:'image/png',name:'logo.png'});f.c.currentBusinessId='B';f.c.businessSessionVersion++;d.resolve({});await pending;
 assert.equal(f.calls.some(x=>x[0]==='upsert'),false);assert.equal(f.c.currentBusinessProfile.id,'A');
});
test('notes reject an unconfirmed save and restore the button after a rejected request',async()=>{
 for(const write of [()=>({data:null}),()=>Promise.reject(Error('offline'))]){
 const f=setup(write);vm.runInContext(section('async function saveCustomerNotes(btn){','async function iwLoadCustomerPhotos()'),f.c);const button={disabled:false,textContent:'Save notes'};await f.c.saveCustomerNotes(button);
 assert.equal(button.disabled,false);assert.equal(f.c.records[0].notes,'Original');assert.equal(f.c.saved,undefined);assert.match(f.messages.at(-1),/Could not save/);
 assert.ok(f.calls.some(x=>x[0]==='eq'&&x[1]==='business_id'&&x[2]==='A'));
 }
});
test('confirmed notes save is shared locally only after durable customer update',async()=>{
 const f=setup(()=>({data:{id:'customer-A'}}));vm.runInContext(section('async function saveCustomerNotes(btn){','async function iwLoadCustomerPhotos()'),f.c);await f.c.saveCustomerNotes({disabled:false});assert.equal(f.c.records[0].notes,'New notes');assert.equal(f.c.saved,true);assert.equal(f.c.logged,true);
});
