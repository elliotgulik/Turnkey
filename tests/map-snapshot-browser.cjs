/* Real SVG/image/canvas rendering; Google Maps requests are local test doubles. */
const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main></main>'}));await page.goto('https://snapshot.test/');
  await page.addScriptTag({path:path.resolve('pricing-engine.js')});await page.addScriptTag({path:path.resolve('map-snapshot.js')});
  const result=await page.evaluate(async()=>{
   const areas=[{service:'driveway',size:65.25,notes:'PRIVATE_NOTES',estimatedCost:999,geoPts:[{lat:-36.8,lng:174.7},{lat:-36.8001,lng:174.7002},{lat:-36.8002,lng:174.7}]},{service:'fence',size:12,geoPts:[{lat:-36.8,lng:174.7},{lat:-36.8002,lng:174.7}]}];
   const M=TK_MAP_SNAPSHOT;
   const offline=await M.buildSnapshot(areas,'',{scale:1});
   async function pixels(snapshot){const image=new Image();image.src=snapshot.dataUrl;await image.decode();const c=document.createElement('canvas');c.width=snapshot.width;c.height=snapshot.height;c.getContext('2d').drawImage(image,0,0);return c;}
   const canvas=await pixels(offline),ctx=canvas.getContext('2d');
   let colored=0,darkLegend=0;const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
   for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(y<400&&Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>30)colored++;if(y>=400&&data[i]<190&&data[i+1]<190&&data[i+2]<190)darkLegend++;}
   const fake=document.createElement('canvas');fake.width=640;fake.height=400;const g=fake.getContext('2d');g.fillStyle='#def1df';g.fillRect(0,0,640,400);g.fillStyle='#ff00ff';g.fillRect(0,390,30,10);
   const blob=await new Promise(resolve=>fake.toBlob(resolve,'image/png'));
   let requested;
   const aerial=await M.buildSnapshot(areas,'fixture-only-key',{scale:1,fetchImpl:async url=>{requested=url;return {ok:true,blob:async()=>blob};}});
   const aerialCanvas=await pixels(aerial),attribution=[...aerialCanvas.getContext('2d').getImageData(5,395,1,1).data];
   const failed=await M.buildSnapshot(areas,'fixture-only-key',{scale:1,fetchImpl:async()=>({ok:false})});
   const started=Date.now();const timedOut=await M.buildSnapshot(areas,'fixture-only-key',{scale:1,timeoutMs:100,fetchImpl:async(url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('Aborted'))))});
   const pixelSketch=await M.buildSnapshot([{service:'driveway',size:10,points:[{x:10,y:10},{x:50,y:10},{x:30,y:50}]}],'fixture-only-key',{scale:1,fetchImpl:async()=>{throw Error('Unanchored pixels must not request a georeferenced map');}});
   return {offline:{...offline,dataUrl:offline.dataUrl.slice(0,22)},colored,darkLegend,aerial:{hasImagery:aerial.hasImagery,areaCount:aerial.areaCount},requested,attribution,failed:failed.hasImagery,timedOut:timedOut.hasImagery,elapsed:Date.now()-started,pixelSketch:pixelSketch.hasImagery,svg:M.buildSvg(areas)};
  });
  assert.match(result.offline.dataUrl,/^data:image\/png;base64,/);assert.equal(result.offline.hasImagery,false);assert.equal(result.offline.areaCount,2);assert.ok(result.offline.height>400);
  assert.ok(result.colored>100,'Fallback polygon/line pixels must render: '+result.colored);assert.ok(result.darkLegend>100,'Measurement legend must render');
  assert.match(result.svg,/65.25 m²/);assert.match(result.svg,/12 m/);assert.doesNotMatch(result.svg,/PRIVATE_NOTES|estimatedCost|999/);
  const url=new URL(result.requested);assert.equal(url.searchParams.getAll('path').length,2);assert.equal(url.searchParams.getAll('markers').length,2);
  assert.equal(result.aerial.hasImagery,true);assert.deepEqual(result.attribution,[255,0,255,255]);assert.equal(result.failed,false);assert.equal(result.timedOut,false);assert.ok(result.elapsed<3000);assert.equal(result.pixelSketch,false);
  console.log('Map snapshot browser passed: real measured PNG fallback, polygon/line rendering, legend, mocked aerial request, preserved attribution, error/timeout fallback, and unanchored sketch safety.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
