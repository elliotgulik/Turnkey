// Hosted workspace integration with fake SDK, animation and scene readiness.
// All requests intercepted; no real Maps key, extension session or live writes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const root=process.env.TK_CAMERA_TEST_ROOT||path.resolve(__dirname,'..');
const fixture=`
class Map2D {addListener(){} }
class Overlay2D {constructor(options){Object.assign(this,options);}setMap(){}addListener(){}}
class Map3D extends HTMLElement {
 constructor(options){super();Object.assign(this,options);window.map3d=this;}
 connectedCallback(){this.steady(true);}
 steady(value){const e=new Event('gmp-steadychange');e.isSteady=value;this.dispatchEvent(e);}
 stopCameraAnimation(){window.stopped=(window.stopped||0)+1;clearInterval(window.animation);}
}
class Line extends HTMLElement {constructor(options){super();Object.assign(this,options);}}
customElements.define('fake-map3d',Map3D);customElements.define('fake-line',Line);
window.google={maps:{Map:Map2D,Marker:Overlay2D,Polygon:Overlay2D,Polyline:Overlay2D,SymbolPath:{CIRCLE:0},importLibrary:async()=>({Map3DElement:Map3D,Polyline3DElement:Line,AltitudeMode:{ABSOLUTE:'absolute',CLAMP_TO_GROUND:'ground'}})}};
window.pick=(p={lat:-36.8,lng:174.7,altitude:25.125})=>{const e=new Event('gmp-click');e.position=p;map3d.dispatchEvent(e);};
window.tick=(property)=>map3d.dispatchEvent(new Event('gmp-'+property+'change'));
window.__tkMeasureMapsReady();`;
test('initial 3D mount, moving camera, render ticks, multiple angles and surface retry',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{
  const u=new URL(r.request().url());
  if(u.host==='maps.googleapis.com')return r.fulfill({contentType:'text/javascript',body:fixture});
  if(u.pathname==='/config.js')return r.fulfill({contentType:'text/javascript',body:"window.TURNKEY_CONFIG={mapsKey:'fake'}"});
  const file=path.join(root,u.pathname==='/geometry.js'?'extension/geometry.js':u.pathname.slice(1));
  return r.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
 });
 await page.clock.install();
 await page.goto('https://camera.test/measure.html?requestId=camera-fixture&lat=-36.8&lng=174.7');
 await page.getByRole('button',{name:'3D inspect',exact:true}).click();
 await page.evaluate(()=>pick());assert.equal(await page.locator('#tkm-corner option').count(),0);
 await page.clock.runFor(600);await page.evaluate(()=>pick());
 assert.equal(await page.locator('#tkm-corner option').count(),1,'initial synchronous mount readiness must not be lost');
 assert.equal(await page.locator('#tkm-steady-hint').isVisible(),false);
 // Fake real animation, interleaving clicks and a misleading steady=true.
 await page.evaluate(()=>{window.animation=setInterval(()=>{map3d.heading+=2;map3d.tilt-=0.2;tick('heading');map3d.steady(true);},50);});
 await page.clock.runFor(1000);await page.evaluate(()=>pick());
 assert.equal(await page.locator('#tkm-corner option').count(),1);
 await page.getByRole('button',{name:'Retry view',exact:true}).click();
 assert.equal(await page.evaluate(()=>stopped),1);
 await page.clock.runFor(600);await page.evaluate(()=>pick({lat:-36.8001,lng:174.7,altitude:27.25}));
 assert.equal(await page.locator('#tkm-corner option').count(),2,'orbit must settle and recover');
 // Continuous frame notifications with tiny bounded jitter must not rearm motion.
 await page.evaluate(()=>{window.base=map3d.heading;window.frame=0;window.animation=setInterval(()=>{map3d.heading=base+(++frame%2?0.002:-0.002);tick('heading');map3d.steady(true);},16);});
 await page.clock.runFor(1200);await page.evaluate(()=>pick({lat:-36.8001,lng:174.7001,altitude:29.5}));
 assert.equal(await page.locator('#tkm-corner option').count(),3);
 await page.evaluate(()=>clearInterval(animation));
 await page.getByRole('button',{name:'3D surface',exact:true}).click();
 assert.deepEqual(await page.locator('fake-line').evaluate(el=>el.path.map(p=>p.altitude)),[25.125,27.25,29.5,25.125]);
 // Multiangle controls update actual pose; no synthetic height or screen projection.
 await page.getByRole('button',{name:'East',exact:true}).click();
 await page.locator('#tkm-camera-tilt').selectOption('45');
 await page.evaluate(()=>pick());assert.equal(await page.locator('#tkm-corner option').count(),3);
 await page.clock.runFor(600);await page.evaluate(()=>pick({lat:-36.8,lng:174.7001,altitude:30}));
 assert.equal(await page.locator('#tkm-corner option').count(),4);
 await page.evaluate(()=>map3d.steady(false));await page.clock.runFor(10000);await page.evaluate(()=>pick());
 assert.match(await page.locator('#tkm-steady-hint').innerText(),/imagery is still loading/);
 await page.getByRole('button',{name:'Retry view',exact:true}).click();await page.clock.runFor(600);await page.evaluate(()=>pick());
 assert.equal(await page.locator('#tkm-corner option').count(),4,'retry cannot bypass explicit surface loading');
 await page.evaluate(()=>{map3d.steady(true);pick(null);});
 assert.match(await page.locator('#tkm-steady-hint').innerText(),/No accurate 3D surface/);
 await page.evaluate(()=>pick({lat:-36.8,lng:174.7002}));assert.equal(await page.locator('#tkm-corner option').count(),4);
 await page.evaluate(()=>pick({lat:-36.8,lng:174.7002,altitude:31}));
 assert.equal(await page.locator('#tkm-corner option').count(),5);
 assert.equal(await page.locator('#tkm-steady-hint').isVisible(),false);
 await page.getByRole('button',{name:'2D top-down',exact:true}).click();assert.equal(await page.locator('#tkm-steady-hint').isVisible(),false);
 await page.getByRole('button',{name:'3D inspect',exact:true}).click();await page.clock.runFor(600);await page.evaluate(()=>pick());
 assert.equal(await page.locator('#tkm-corner option').count(),6);
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
