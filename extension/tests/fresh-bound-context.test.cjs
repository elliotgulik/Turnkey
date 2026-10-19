const test=require('node:test'), assert=require('node:assert/strict');
let count=0;
async function fixture() {
  const storage={tk_config:{supabaseUrl:'https://db.example',supabaseAnonKey:'anon'},tk_session:{accessToken:'token',refreshToken:'refresh',userId:'user',expiresAt:Date.now()+3600000}};
  const listeners=[],tabs=[],reads=[],storageListeners=[];
  let readHook=null;
  let business='B';
  const customer={id:'C',business_id:'B',name:'Original',address:'42 Road',notes:'Gate',phone:'021',email:'a@example.net'};
  const job={id:'J',business_id:'B',customer_id:'C',quote_id:null,status:'new',details:{jobNotes:'Rear wall',requestedServices:[{name:'House Wash',service_id:'housewash'}]}};
  global.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)}},storage:{onChanged:{addListener:fn=>storageListeners.push(fn)},local:{get:async k=>({[k]:storage[k]})},session:{get:async k=>({[k]:storage[k]}),set:async data=>Object.assign(storage,data)}},tabs:{create:async options=>{const tab={id:tabs.length+10,...options};tabs.push(tab);return tab},update:async()=>{},remove:async()=>{},onRemoved:{addListener:()=>{}}}};
  global.fetch=async url=>{
    const u=new URL(url); reads.push(u);
    const table=u.pathname.split('/').pop();
    const body=table==='users'?[{business_id:business}]:table==='customers'?[customer]:table==='jobs'?[job]:[];
    const text=JSON.stringify(body);
    if(table==='customers'&&readHook){const hook=readHook;readHook=null;await hook()}
    return {ok:true,status:200,text:async()=>text};
  };
  const module=await import('../background/customer-handoff.js?fresh='+ ++count);
  module.registerCustomerHandoff();
  const dispatch=(message,sender)=>new Promise(resolve=>{for(const listener of listeners)listener(message,sender,resolve)});
  const launch=payload=>dispatch({type:'TK_CUSTOMER_LAUNCH',businessId:'B',customerId:'C',recordId:7,jobId:'J',...payload},{url:'https://turnkeycrm.net/index.html',tab:{id:1}});
  const context=tabId=>dispatch({type:'TK_GET_CUSTOMER_CONTEXT'},{url:'https://earth.google.com/web/',tab:{id:tabId}});
  return {customer,job,reads,tabs,launch,context,setBusiness:value=>{business=value},setReadHook:fn=>{readHook=fn},emitChange:changes=>storageListeners.forEach(fn=>fn(changes,'local'))};
}

test('bound context refreshes customer and exact job requests, remains tab-scoped and rejects an account switch',async()=>{
  const f=await fixture();
  const launch=await f.launch(); assert.equal(launch.ok,true,launch.error);
  f.customer.name='Fresh'; f.customer.notes='New gate code'; f.job.details.windowsRequested=true;
  const result=await f.context(launch.data.tabId);
  assert.equal(result.data.customer.name,'Fresh'); assert.equal(result.data.customer.notes,'New gate code');
  assert.equal(result.data.job.details.windowsRequested,true); assert.equal(result.data.jobId,'J');
  for(const u of f.reads.filter(u=>/customers|jobs/.test(u.pathname))) assert.equal(u.searchParams.get('business_id'),'eq.B');
  for(const u of f.reads.filter(u=>/jobs/.test(u.pathname))) {assert.equal(u.searchParams.get('id'),'eq.J');assert.equal(u.searchParams.get('customer_id'),'eq.C')}
  assert.equal((await f.context(999)).data,null);
  f.setBusiness('OTHER'); assert.equal((await f.context(launch.data.tabId)).data,null);
});

test('a wrong-customer or foreign job cannot launch, and a reassigned job cannot supply context',async()=>{
  const f=await fixture(); f.job.customer_id='ANOTHER';
  assert.equal((await f.launch()).ok,false); assert.equal(f.tabs.length,0);
  f.job.customer_id='C'; const launch=await f.launch(); assert.equal(launch.ok,true);
  f.job.business_id='FOREIGN'; const result=await f.context(launch.data.tabId);
  assert.equal(result.ok,false); assert.equal(result.data,undefined);
});


test('switching away and back during an async context read discards the stale tenant result',async()=>{
  const f=await fixture(); const launch=await f.launch(); assert.equal(launch.ok,true);
  f.setReadHook(async()=>{
    f.setBusiness('OTHER');
    f.emitChange({tk_profile:{oldValue:{business_id:'B'},newValue:{business_id:'OTHER'}}});
    await Promise.resolve();
    f.setBusiness('B');
    f.emitChange({tk_profile:{oldValue:{business_id:'OTHER'},newValue:{business_id:'B'}}});
  });
  const result=await f.context(launch.data.tabId);
  assert.equal(result.ok,true);assert.equal(result.data,null);
});

test('switching deployment during an async context read also discards the result',async()=>{
  const f=await fixture();const launch=await f.launch();
  f.setReadHook(async()=>f.emitChange({tk_config:{oldValue:{siteUrl:'https://one.example'},newValue:{siteUrl:'https://two.example'}}}));
  assert.equal((await f.context(launch.data.tabId)).data,null);
});
