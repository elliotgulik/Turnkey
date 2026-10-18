// Real MV3 runtime smoke test in an isolated Chromium profile. Network,
// identity and Maps are fixtures; this never writes to the live CRM.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tk-extension-test-'));
const extension=path.join(root,'extension');
const fixtureMap=`
class MapFixture { constructor(el) { this.el=el; window.__map=this; el.innerHTML='<button id="fixture-point">Add mapped point</button>'; }
 addListener(name,fn) { this.clickHandler=fn; if(name==='click') {let i=0; const p=[[-36.8,174.7],[-36.8,174.7001],[-36.8001,174.7001],[-36.8001,174.7]]; this.el.querySelector('button').onclick=()=>{const x=p[i++%4];fn({latLng:{lat:()=>x[0],lng:()=>x[1]}})};} }
}
class Overlay {constructor(options){this.options=options;this.listeners={};(window.__overlays ||= []).push(this);}setMap(map){this.removed=map===null;} addListener(name,fn){this.listeners[name]=fn;}}
const altitudeModes={ABSOLUTE:'absolute',CLAMP_TO_GROUND:'clamp-to-ground'};
class Map3DFixture extends HTMLElement {constructor(options){super();Object.assign(this,options);window.__map3d=this;} connectedCallback(){queueMicrotask(()=>{const e=new Event('gmp-steadychange');e.isSteady=true;this.dispatchEvent(e);});} }
class MarkerFixture extends HTMLElement {constructor(options){super();if(!Object.values(altitudeModes).includes(options.altitudeMode))throw Error('Invalid altitude mode');Object.assign(this,options);} }
class LineFixture extends HTMLElement {constructor(options){super();if(!Object.values(altitudeModes).includes(options.altitudeMode))throw Error('Invalid altitude mode');Object.assign(this,options);} }
customElements.define('fixture-map3d',Map3DFixture);customElements.define('fixture-marker',MarkerFixture);customElements.define('fixture-line',LineFixture);
window.google={maps:{Map:MapFixture,Marker:Overlay,Polygon:Overlay,Polyline:Overlay,SymbolPath:{CIRCLE:0},LatLng:class {constructor(lat,lng){this.lat=()=>lat;this.lng=()=>lng;}},importLibrary:async n=>{if(n==='geometry')return {spherical:{computeArea:()=>99,computeLength:()=>40,computeDistanceBetween:()=>20}};if(n==='maps3d')return {Map3DElement:Map3DFixture,MarkerInteractiveElement:MarkerFixture,Polyline3DElement:LineFixture,AltitudeMode:altitudeModes};throw Error('Unknown fixture library');}}};
window.__tkMeasureMapsReady();`;
(async()=>{
 let context;
 try{
  const cached=path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const writes=[],handoffs=[];
  await context.route('https://turnkeycrm.net/api/**',r=>{
    if(r.request().url().includes('/servicem8/handoff')){handoffs.push(r.request().postDataJSON());return r.fulfill({status:handoffs.length===1?503:202,contentType:'application/json',body:JSON.stringify(handoffs.length===1?{error:'Temporary connection issue'}:{queued:true})});}
    return r.fulfill({contentType:'application/json',body:JSON.stringify({state:'transferred',message:'Transferred to ServiceM8',openUrl:'https://go.servicem8.com/OpenJob/22222222-2222-4222-8222-222222222222'})});
  });
  await context.route('https://earth.google.com/**',r=>r.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; img-src 'self'; script-src 'self'"},body:'<!doctype html><title>Earth fixture</title><h1>Earth fixture</h1>'}));
  await context.route('https://maps.googleapis.com/maps/api/js**',r=>r.fulfill({contentType:'text/javascript',body:fixtureMap}));
  await context.route('https://turnkeycrm.net/**',r=>{
   const u=new URL(r.request().url());
   if(u.pathname.startsWith('/api/'))return r.fallback();
   if(u.pathname==='/config.js')return r.fulfill({contentType:'text/javascript',body:"window.TURNKEY_CONFIG={mapsKey:'fixture'};"});
   const name=u.pathname==='/geometry.js'?'extension/geometry.js':u.pathname.slice(1);
   const file=path.resolve(root,name);
   if(!file.startsWith(root+'/')||!fs.existsSync(file))return r.fulfill({status:404,body:'Not found'});
   return r.fulfill({contentType:name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
  });
  await context.route('https://fixture.supabase.co/**',r=>{
   const req=r.request(),table=new URL(req.url()).pathname.split('/').pop();
   if(req.method()==='POST'){
    const body=req.postDataJSON();writes.push({table,body});
    if(table==='activity_log')return r.fulfill({status:201,body:''});
    return r.fulfill({contentType:'application/json',body:JSON.stringify([{...body,id:body.id||'11111111-1111-4111-8111-111111111111',public_token:'fixture-public'}])});
   }
   return r.fulfill({contentType:'application/json',body:JSON.stringify(table==='users'?[{business_id:'fixture-business'}]:table==='businesses'?[{id:'fixture-business',name:'Fixture business',pricing_config:{}}]:[])});
  });
  await worker.evaluate(async()=>chrome.storage.local.set({tk_config:{siteUrl:'https://turnkeycrm.net',backendUrl:'https://turnkeycrm.net',supabaseUrl:'https://fixture.supabase.co',supabaseAnonKey:'fixture'},tk_session:{accessToken:'fixture',refreshToken:'fixture',userId:'fixture-user',expiresAt:Date.now()+3600000},tk_profile:{business_id:'fixture-business'},tk_business:{name:'Fixture business',pricing_config:{}}}));
  const earth=await context.newPage();
  await earth.goto('https://earth.google.com/web/search/Public+fixture/@-36.800000,174.700000,50a,500d,35y');
  await earth.locator('[data-action="measure-area"]').click();
  const workspaceEvent=context.waitForEvent('page');
  await earth.locator('[data-cat="deck"]').click();
  const workspace=await workspaceEvent;
  await workspace.waitForURL('**/measure.html?**');
  // Chrome-created tabs can start their first navigation before Playwright
  // attaches routing. Reload after attachment to serve the local fixture.
  await workspace.waitForLoadState();
  const errors=[];workspace.on('pageerror',e=>errors.push(e.message));
  await workspace.reload();
  await workspace.waitForLoadState();
  await workspace.locator('#fixture-point').waitFor({timeout:12000}).catch(async e=>{console.error(await workspace.locator('body').innerText());throw e;});
  await workspace.locator('#fixture-point').click({clickCount:1});
  await workspace.locator('#fixture-point').click();
  await workspace.locator('#fixture-point').click();
  await workspace.locator('#fixture-point').click();
  await workspace.getByRole('button',{name:'Insert point',exact:true}).click();
  await workspace.locator('#tkm-edge').selectOption('0');
  await workspace.evaluate(()=>window.__map.clickHandler({latLng:{lat:()=>-36.79999,lng:()=>174.70005}}));
  assert.equal(await workspace.locator('#tkm-corner option').count(),5);
  await workspace.evaluate(()=>{const corner=window.__overlays.findLast(x=>!x.removed&&x.options.label?.text==='2');corner.listeners.dragend({latLng:{lat:()=>-36.79998,lng:()=>174.70005}});});
  await workspace.getByRole('button',{name:'Delete corner',exact:true}).click();
  assert.equal(await workspace.locator('#tkm-corner option').count(),4);
  await workspace.getByRole('button',{name:'Undo',exact:true}).click();
  assert.equal(await workspace.locator('#tkm-corner option').count(),5);
  await workspace.getByRole('button',{name:'3D inspect',exact:true}).click();
  assert.equal(await workspace.locator('fixture-line').evaluate(el=>el.altitudeMode),'clamp-to-ground');
  assert.ok(await workspace.locator('fixture-line').evaluate(el=>el.path.every(p=>p.altitude===undefined)));
  const corners=[[-36.8,174.7],[-36.79998,174.70005],[-36.8,174.7001],[-36.8001,174.7001],[-36.8001,174.7]];
  for(let i=0;i<corners.length;i++){
    await workspace.locator('#tkm-corner').selectOption({value:String(i)});
    assert.equal(await workspace.locator('#tkm-corner').inputValue(),String(i),'selected corner before 3D move');
    await workspace.evaluate(([lat,lng])=>{const e=new Event('gmp-click');e.position={lat,lng,altitude:20};window.__map3d.dispatchEvent(e);},corners[i]);
  }
  await workspace.getByRole('button',{name:'3D surface',exact:true}).click();
  assert.equal(await workspace.locator('fixture-line').evaluate(el=>el.altitudeMode),'absolute',JSON.stringify({readout:await workspace.locator('#tkm-readout').innerText(),path:await workspace.locator('fixture-line').evaluate(el=>el.path)}));
  assert.equal(await workspace.locator('fixture-line').evaluate(el=>el.extruded),false);
  await workspace.getByRole('button',{name:'Insert point',exact:true}).click();
  await workspace.locator('#tkm-edge').selectOption('1');
  await workspace.evaluate(()=>{const e=new Event('gmp-click');e.position={lat:-36.79999,lng:174.70008,altitude:21};window.__map3d.dispatchEvent(e);});
  assert.equal(await workspace.locator('#tkm-corner option').count(),6);
  assert.equal(await workspace.locator('fixture-line').evaluate(el=>el.path[2].altitude),21);
  await workspace.getByRole('button',{name:'Undo',exact:true}).click();
  assert.equal(await workspace.locator('#tkm-corner option').count(),5);
  await workspace.getByRole('button',{name:'2D top-down',exact:true}).click();
  await workspace.locator('#tkm-finish').click();
  await earth.locator('.tk-meas-value').waitFor();
  assert.match(await earth.locator('.tk-meas-value').innerText(),/m²/);
  await earth.locator('[data-action="instant-quote"]').click();
  await earth.locator('[data-new="name"]').fill('Isolated test customer');
  await earth.locator('[data-price]').fill('650');
  await earth.locator('[data-price]').press('Tab');
  assert.ok(await earth.locator('[data-recommended]').innerText());
  assert.match(await earth.locator('.tk-price-block').innerText(),/Materials \/ chemicals/);
  await earth.locator('[data-create]').click();
  await earth.locator('[data-open]').waitFor();
  const job=writes.find(x=>x.table==='jobs');
  assert.ok(job,'A draft quote is persisted through the real MV3 API bridge');
  assert.equal(job.body.business_id,'fixture-business');
  assert.equal(job.body.details.total,650);
  assert.ok(job.body.details.estimatedCost>0);
  assert.ok(job.body.details.costSnapshot.wageCost>0);
  assert.equal(Math.round(job.body.details.services.reduce((sum,l)=>sum+l.fixedPrice,0)),650);
  const area=job.body.details.areaPolys[0];
  assert.equal(area.geoPts.length,5);
  assert.equal(area.points.length,5);
  assert.ok(area.size>90&&area.size<130,'Real geographic calculation, not the SDK fixture area');
  assert.equal(writes.filter(x=>x.table==='quotes').length,1);
  assert.equal(writes.find(x=>x.table==='quotes').body.status,'draft');
  await earth.locator('[data-servicem8]').click();
  await earth.getByText('Retry ServiceM8 transfer',{exact:true}).waitFor();
  assert.match(await earth.locator('[data-transfer-status]').innerText(),/quote remains saved/);
  await earth.locator('[data-servicem8]').click();
  await earth.locator('[data-check-transfer]').waitFor();
  assert.deepEqual(handoffs,[{jobId:job.body.id,mode:'quote'},{jobId:job.body.id,mode:'quote'}]);
  await earth.locator('[data-check-transfer]').click();
  await earth.locator('[data-open-servicem8]').waitFor();
  assert.equal(await earth.locator('[data-open-servicem8]').getAttribute('href'),'https://go.servicem8.com/OpenJob/22222222-2222-4222-8222-222222222222');
  assert.equal(writes.filter(x=>x.table==='quotes').length,1,'transfer retry must not create another quote');
  assert.deepEqual(errors,[]);
  console.log('Real MV3 runtime: restrictive Earth CSP → hosted map → extension → draft quote passed (all network writes mocked).');
 } finally {if(context)await context.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
