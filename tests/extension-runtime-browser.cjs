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
class MapFixture { constructor(el) { this.el=el; el.innerHTML='<button id="fixture-point">Add mapped point</button>'; }
 addListener(name,fn) { if(name==='click') {let i=0; const p=[[-36.8,174.7],[-36.8,174.7001],[-36.8001,174.7001],[-36.8001,174.7]]; this.el.querySelector('button').onclick=()=>{const x=p[i++%4];fn({latLng:{lat:()=>x[0],lng:()=>x[1]}})};} }
}
class Overlay {setMap(){} }
window.google={maps:{Map:MapFixture,Marker:Overlay,Polygon:Overlay,Polyline:Overlay,SymbolPath:{CIRCLE:0},LatLng:class {constructor(lat,lng){this.lat=()=>lat;this.lng=()=>lng;}},importLibrary:async n=>{if(n==='geometry')return {spherical:{computeArea:()=>99,computeLength:()=>40,computeDistanceBetween:()=>20}};throw Error('3D intentionally unavailable in fixture');}}};
window.__tkMeasureMapsReady();`;
(async()=>{
 let context;
 try{
  const cached=path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const writes=[];
  await context.route('https://earth.google.com/**',r=>r.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; img-src 'self'; script-src 'self'"},body:'<!doctype html><title>Earth fixture</title><h1>Earth fixture</h1>'}));
  await context.route('https://maps.googleapis.com/maps/api/js**',r=>r.fulfill({contentType:'text/javascript',body:fixtureMap}));
  await context.route('https://turnkeycrm.net/**',r=>{
   const u=new URL(r.request().url());
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
    return r.fulfill({contentType:'application/json',body:JSON.stringify([{...body,id:body.id||'11111111-1111-4111-8111-111111111111',public_token:'fixture-public'}])});
   }
   return r.fulfill({contentType:'application/json',body:JSON.stringify(table==='users'?[{business_id:'fixture-business'}]:[])});
  });
  await worker.evaluate(async()=>chrome.storage.local.set({tk_config:{siteUrl:'https://turnkeycrm.net',supabaseUrl:'https://fixture.supabase.co',supabaseAnonKey:'fixture'},tk_session:{accessToken:'fixture',refreshToken:'fixture',userId:'fixture-user',expiresAt:Date.now()+3600000},tk_profile:{business_id:'fixture-business'},tk_business:{name:'Fixture business',pricing_config:{}}}));
  const earth=await context.newPage();
  await earth.goto('https://earth.google.com/web/search/Public+fixture/@-36.800000,174.700000,50a,500d,35y');
  await earth.locator('[data-action="measure-area"]').click();
  const workspaceEvent=context.waitForEvent('page');
  await earth.locator('[data-cat="deck"]').click();
  const workspace=await workspaceEvent;
  workspace.on('pageerror',e=>console.error('Workspace:',e.message));
  await workspace.waitForURL('**/measure.html?**');
  // Chrome-created tabs can start their first navigation before Playwright
  // attaches routing. Reload after attachment to serve the local fixture.
  await workspace.reload();
  await workspace.waitForLoadState();
  await workspace.locator('#fixture-point').waitFor({timeout:12000}).catch(async e=>{console.error(await workspace.locator('body').innerText());throw e;});
  await workspace.locator('#fixture-point').click({clickCount:1});
  await workspace.locator('#fixture-point').click();
  await workspace.locator('#fixture-point').click();
  await workspace.locator('#fixture-point').click();
  await workspace.locator('#tkm-finish').click();
  await earth.locator('.tk-meas-value').waitFor();
  assert.match(await earth.locator('.tk-meas-value').innerText(),/m²/);
  await earth.locator('[data-action="instant-quote"]').click();
  await earth.locator('[data-new="name"]').fill('Isolated test customer');
  await earth.locator('[data-create]').click();
  await earth.locator('[data-open]').waitFor();
  const job=writes.find(x=>x.table==='jobs');
  assert.ok(job,'A draft quote is persisted through the real MV3 API bridge');
  assert.equal(job.body.business_id,'fixture-business');
  const area=job.body.details.areaPolys[0];
  assert.equal(area.geoPts.length,4);
  assert.equal(area.points.length,4);
  assert.ok(area.size>90&&area.size<110,'Real geographic calculation, not the SDK fixture area');
  assert.equal(writes.filter(x=>x.table==='quotes').length,1);
  assert.equal(writes.find(x=>x.table==='quotes').body.status,'draft');
  console.log('Real MV3 runtime: restrictive Earth CSP → hosted map → extension → draft quote passed (all network writes mocked).');
 } finally {if(context)await context.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
