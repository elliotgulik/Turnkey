const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');

// SDK contract double, not a live imagery test. Exercises the real page/module,
// geographic click events, both supported marker families and DOM controls.
function mapsDouble(legacy,lookup){
 return `
 const instances=window.mapsTest={markers2d:[],maps:[]};
 class Map2D {
  constructor(el,options){Object.assign(this,options);this.listeners={};instances.map2d=this;}
  addListener(name,fn){this.listeners[name]=fn;}
  setCenter(p){this.center=p;} setZoom(z){this.zoom=z;} setTilt(t){this.tilt=t;} setHeading(h){this.heading=h;}
 }
 class Marker2D {
  constructor(options){Object.assign(this,options);this.listeners={};instances.markers2d.push(this);}
  addListener(name,fn){this.listeners[name]=fn;} setMap(m){this.map=m;} setOptions(o){Object.assign(this,o);}
 }
 class Overlay2D extends Marker2D {}
 class Map3D extends HTMLElement {
  constructor(options){super();Object.assign(this,options);instances.map3d=this;}
  stopCameraAnimation(){this.stopped=true;}
  flyCameraTo(options){this.lastFlight=options;Object.assign(this,options.endCamera);this.center={...this.center,altitude:45};}
 }
 class Marker3D extends HTMLElement {constructor(options){super();Object.assign(this,options);}}
 class Interactive extends HTMLElement {constructor(options){super();Object.assign(this,options);}}
 class Line3D extends HTMLElement {constructor(options){super();Object.assign(this,options);}}
 customElements.define('gmp-map-3d',Map3D);
 customElements.define('test-property-marker',Marker3D);
 customElements.define('test-corner-marker',Interactive);
 customElements.define('test-line',Line3D);
 window.google={maps:{Map:Map2D,Marker:Marker2D,Polygon:Overlay2D,Polyline:Overlay2D,SymbolPath:{CIRCLE:0},
 importLibrary:async(name)=>{
 if(name==='geocoding'){
   if('${lookup}'==='unavailable')throw Error('Library unavailable');
   return {Geocoder:class {geocode(request){instances.geocodeRequest=request;return new Promise((resolve,reject)=>{
     instances.completeLookup=()=>{
       if('${lookup}'==='denied')return reject(Error('REQUEST_DENIED'));
       resolve({results:'${lookup}'==='empty'?[]:[{formatted_address:'12 Test Road',partial_match:'${lookup}'==='partial',
         geometry:{location:{lat:()=>-36.81,lng:()=>174.71}}}]});
     };
   });}}};
 }
 return {Map3DElement:Map3D,${legacy?'Marker3DElement':'MarkerElement'}:Marker3D,
 ${legacy?'Marker3DInteractiveElement':'MarkerInteractiveElement'}:Interactive,
 Polyline3DElement:Line3D,AltitudeMode:{ABSOLUTE:'ABSOLUTE',CLAMP_TO_GROUND:'CLAMP_TO_GROUND'},MapMode:{SATELLITE:'SATELLITE'}};}}};
 window.__tkMeasureMapsReady();`;
}
for(const legacy of [false,true])for(const lookup of ['success','denied','empty','partial','unavailable','no-address'])test(`workspace preserves trace and resolves property anchor (${legacy?'3D':'DOM'} markers, ${lookup})`,async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='maps.googleapis.com')return route.fulfill({contentType:'application/javascript',body:mapsDouble(legacy,lookup)});
   const filename=url.pathname.slice(1);
   if(filename==='config.js')return route.fulfill({contentType:'application/javascript',body:'window.TURNKEY_CONFIG={mapsKey:"test-only"}'});
   if(!['measure.html','measure.js','measure.css','measurement-editor.js','geometry.js'].includes(filename))return route.abort();
   return route.fulfill({contentType:filename.endsWith('.html')?'text/html':filename.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(root,filename==='geometry.js'?'extension/geometry.js':filename))});
  });
  await page.goto('https://measurement.test/measure.html?requestId=test&lat=-36.8&lng=174.7'+(lookup==='no-address'?'':'&address=12%20Test%20Road'));
  await page.waitForFunction(()=>window.mapsTest?.map3d);
  await page.locator('[data-view="3d"]').click();
  const emit=async(type,props)=>page.evaluate(({type,props})=>{
   const map=mapsTest.map3d;const event=new Event(type,{bubbles:true,cancelable:true});Object.assign(event,props);map.dispatchEvent(event);
  },{type,props});
  await emit('gmp-steadychange',{isSteady:true});
  await page.waitForTimeout(600);
  const p={lat:-36.8001,lng:174.7001,altitude:72.25};
  await emit('gmp-click',{position:p});
  assert.equal(await page.locator('test-corner-marker').count(),1);
  assert.deepEqual(await page.locator('test-corner-marker').evaluate(m=>({position:m.position,mode:m.altitudeMode})),{position:p,mode:'ABSOLUTE'});
  assert.equal(await page.locator('[data-mode="ground"]').getAttribute('class'),'active');
  // Loading must not accept even valid geographic picks.
  await emit('gmp-steadychange',{isSteady:false});await emit('gmp-click',{position:p});
  assert.equal(await page.locator('test-corner-marker').count(),1);
  await emit('gmp-steadychange',{isSteady:true});
  await page.evaluate(()=>{mapsTest.map3d.heading=90;});
  await emit('gmp-click',{position:{...p,lng:174.7002}});
  assert.equal(await page.locator('test-corner-marker').count(),1);
  await page.waitForTimeout(600);
  await emit('gmp-click',{position:{...p,lng:174.7002}});
  assert.equal(await page.locator('test-corner-marker').count(),2);
  await emit('gmp-click',{position:{...p,lat:-36.8002,altitude:80}});
  assert.equal(await page.locator('test-corner-marker').count(),3);
  // Resolve after drawing: a late lookup must move only the anchor, not the
  // camera or canonical points (also asserted in the final Finish payload).
  const cameraBefore=await page.evaluate(()=>({...mapsTest.map3d.center}));
  if(!['unavailable','no-address'].includes(lookup)){
   await page.evaluate(()=>mapsTest.completeLookup());
   await page.waitForFunction(()=>!document.getElementById('tkm-property-address').textContent.includes('locating address'));
   assert.deepEqual(await page.evaluate(()=>mapsTest.geocodeRequest),{address:'12 Test Road'});
  }
  const anchor=lookup==='success'?{lat:-36.81,lng:174.71}:{lat:-36.8,lng:174.7};
  const label=await page.locator('#tkm-property-address').textContent();
  if(lookup==='success')assert.equal(label,'12 Test Road');
  else assert.match(label,/original Earth camera location/i);
  assert.deepEqual(await page.locator('test-property-marker').evaluate(m=>m.position),anchor);
  assert.deepEqual(await page.evaluate(()=>mapsTest.markers2d[0].position),anchor);
  assert.deepEqual(await page.evaluate(()=>({...mapsTest.map3d.center})),cameraBefore);
  assert.equal(await page.locator('#tkm-return-property').textContent(),lookup==='success'?'Return to property':'Return to original camera');
  await page.locator('#tkm-return-property').click();
  assert.deepEqual(await page.evaluate(()=>mapsTest.map3d.lastFlight.endCamera),{
   center:anchor,altitudeMode:'CLAMP_TO_GROUND',range:300,heading:0,tilt:60,roll:0});
  assert.equal(await page.locator('test-corner-marker').count(),3);
  await page.locator('#tkm-clear').click();
  assert.equal(await page.locator('test-corner-marker').count(),0);
  assert.equal(await page.locator('test-property-marker').count(),1);
  assert.equal(await page.locator('#tkm-property-address').textContent(),label);
  await page.locator('#tkm-undo').click();
  assert.equal(await page.locator('test-corner-marker').count(),3);
  await page.locator('[data-view="2d"]').click();
  await page.evaluate(()=>{mapsTest.map2d.center={lat:0,lng:0};});
  await page.locator('#tkm-return-property').click();
  assert.deepEqual(await page.evaluate(()=>mapsTest.map2d.center),anchor);
  assert.equal(await page.evaluate(label=>mapsTest.markers2d.filter(m=>m.title===label&&m.map).length,label),1);
  await page.evaluate(()=>window.addEventListener('message',e=>{if(e.data.type==='TURNKEY_MEASURE_FINISH')window.sentMeasurement=e.data;}));
  await page.locator('#tkm-finish').click();
  await page.waitForFunction(()=>window.sentMeasurement);
  assert.deepEqual(await page.evaluate(()=>({mode:sentMeasurement.mode,points:sentMeasurement.points})),{
   mode:'ground',points:[p,{...p,lng:174.7002},{...p,lat:-36.8002,altitude:80}]});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
