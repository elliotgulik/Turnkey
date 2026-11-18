const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..');
test('custom button launches directly, retains returned geocode across camera movement and saves it with fixed custom work',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fixture.test/**',route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(!pathname.startsWith('/extension/'))return route.fulfill({contentType:'text/html',body:'<!doctype html><body><main id="app"></main>'});
   const file=path.resolve(root,'.'+pathname);
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404});
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
  });
  await page.goto('https://fixture.test/search/12+Test+Road/@-36.8000,174.7000');
  await page.evaluate(async()=>{
   const listeners=[];window.launches=[];let serial=0;
   const customer={id:'C',name:'Test customer',address:'12 Test Road'},job={id:'J',details:{}};
   const stored={tk_config:{siteUrl:'https://fixture.test'},tk_session:{userId:'U'},tk_profile:{business_id:'B'},tk_business:{id:'B',name:'Test business'}};
   window.chrome={storage:{local:{get:async key=>({[key]:stored[key]})},onChanged:{addListener(){}}},runtime:{getURL:p=>'/extension/'+p,onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(msg,cb)=>{
    if(msg.type==='TK_GET_CUSTOMER_CONTEXT')return cb({ok:true,data:{businessId:'B',customer,address:customer.address,job}});
    if(msg.type==='TK_OPEN_WORKSPACE'){launches.push(msg.payload);return cb({ok:true,requestId:'r'+(++serial)});}
    if(msg.type==='TK_API'){
     const data=msg.action==='getProfile'?{business_id:'B'}:msg.action==='getBusiness'?stored.tk_business:msg.action==='getPricingLearningState'?{modelVersion:1,settings:{},observations:[]}:{};
     if(msg.action==='saveBoundQuote'){window.savedDetails=msg.args[1].details;return cb({ok:true,data:{quote:{id:'Q',business_id:'B',public_token:'public'},job:{id:'J',business_id:'B',quote_id:'Q'}}});}
     return cb({ok:true,data});
    }
   }}};
   window.complete=result=>new Promise(resolve=>listeners.forEach(fn=>fn({type:'TK_MEASURE_COMPLETE',requestId:'r1',result},{},resolve)));
   await (await import('/extension/content/panel/app.js')).init(document.querySelector('#app'));
  });
  await page.locator('[data-action="measure-custom-area"]').click();
  assert.deepEqual(await page.evaluate(()=>launches[0]),{category:'custom',categoryLabel:'Custom area',kind:'area',lat:-36.8,lng:174.7,address:'12 Test Road'});
  assert.equal(await page.locator('.tk-category-modal').count(),0);
  await page.evaluate(()=>complete({value:321,unit:'m²',groundArea:321,perimeter:80,points:[{lat:-36.81,lng:174.71},{lat:-36.81,lng:174.711},{lat:-36.811,lng:174.71}],propertyLocation:{lat:-36.81,lng:174.71,address:'12 Test Road'}}));
  await page.evaluate(()=>history.pushState({},'', '/search/Other/@-37.0000,175.0000'));
  await page.waitForTimeout(1600);
  await page.locator('[data-action="measure-custom-area"]').click();
  const next=await page.evaluate(()=>launches[1]);
  assert.equal(next.lat,-36.81);assert.equal(next.lng,174.71);assert.equal(next.propertyLat,-36.81);assert.equal(next.propertyLng,174.71);
  assert.equal(next.address,'12 Test Road');
  await page.locator('[data-action="instant-quote"]').click();
  await page.locator('[data-custom-field="unitPrice"]').fill('123.45');
  await page.locator('[data-create]').click();
  await page.waitForFunction(()=>window.savedDetails);
  const saved=await page.evaluate(()=>savedDetails);
  assert.deepEqual(saved.propertyLocation,{lat:-36.81,lng:174.71,address:'12 Test Road'});
  assert.equal(saved.services[0].svc,'custom');assert.equal(saved.services[0].qty,1);assert.equal(saved.services[0].fixedPrice,123.45);
  assert.equal(saved.areaPolys[0].size,321);assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
