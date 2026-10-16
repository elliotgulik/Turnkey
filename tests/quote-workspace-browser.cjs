/* Run: node tests/quote-workspace-browser.cjs
 * Serves the unmodified index and its real local modules. Only external SDK/API
 * boundaries are fixtures; no app function, engine, map renderer, or sb binding
 * is replaced. No real credentials, remote writes, or email delivery are used.
 */
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
function externalFixtures() {
  window.qwFixture = {saves:[], routes:[], imports:[], routeMode:'ok', selections:0};
  window.supabase = {createClient:() => ({
    auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    from(table) {
      let payload;
      const chain = {
        select(){return chain;},eq(){return chain;},is(){return chain;},order(){return chain;},limit(){return chain;},
        upsert(value){
          if(table !== 'businesses')throw Error('Unexpected database write: '+table);
          payload=value;window.qwFixture.saves.push({...value});return chain;
        },
        insert(){throw Error('Unexpected insert: '+table);},update(){throw Error('Unexpected update: '+table);},
        maybeSingle:async()=>({data:payload ? {...payload} : null,error:null}),
        then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject);}
      };return chain;
    }
  })};
}
function mapsSDKFixture() {
  class FixturePlaces extends HTMLElement {
    connectedCallback(){
      if(this.firstChild)return;
      this.innerHTML='<input aria-label="Places search text" placeholder="Search address"><button type="button">Choose address result</button>';
      this.querySelector('button').onclick=()=>{
        const event=new Event('gmp-select');
        const address=this.querySelector('input').value || '29A Selwyn Crescent, Forrest Hill, Auckland 0620, New Zealand';
        event.placePrediction={toPlace:()=>({formattedAddress:address,location:{lat:()=>-36.77,lng:()=>174.74},fetchFields:async()=>{window.qwFixture.selections++;}})};
        this.dispatchEvent(event);
      };
    }
  }
  customElements.define('fixture-places',FixturePlaces);
  class DistanceMatrixService {
    async getDistanceMatrix(request){
      window.qwFixture.routes.push(request);
      const mode=window.qwFixture.routeMode;
      if(mode==='denied')throw Error('REQUEST_DENIED');
      if(mode==='pending')return new Promise(resolve=>window.qwFixture.pendingRoutes.push(resolve));
      return {rows:[{elements:[mode==='zero'?{status:'ZERO_RESULTS'}:mode==='malformed'?{status:'OK',distance:{value:NaN}}:{status:'OK',distance:{value:12500},duration:{value:900}}]}]};
    }
  }
  window.google={maps:{importLibrary:async name=>{
    window.qwFixture.imports.push(name);
    if(name==='places')return {PlaceAutocompleteElement:FixturePlaces};
    if(name==='routes')return {DistanceMatrixService};
    throw Error('Unexpected Google library: '+name);
  }}};
  const callback=new URL(document.currentScript.src).searchParams.get('callback');
  if(callback)window[callback]();
}
(async()=>{
  const root=process.cwd();
  const server=http.createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html', file=path.resolve(root,name);
    if(!file.startsWith(root+path.sep)||!['.html','.js','.css','.png','.ico','.webmanifest'].includes(path.extname(file))){res.writeHead(404);return res.end();}
    fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(data);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const cached=path.join(require('node:os').homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached})});
    for(const width of [1440,390]) {
      const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'}), page=await context.newPage();
      const errors=[],restRouting=[],loaded=new Set();
      page.on('pageerror',error=>errors.push(error.message));
      page.on('response',response=>{if(response.url().startsWith(base)&&response.status()===200)loaded.add(new URL(response.url()).pathname);});
      await page.addInitScript(externalFixtures);
      await page.route('**/*',route=>{
        const url=route.request().url();
        if(/\/distancematrix\/json/.test(url)){restRouting.push(url);return route.abort();}
        if(url===base+'/config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={supabaseUrl:"https://fixture.invalid",supabaseAnonKey:"fixture-not-a-key",mapsKey:"fixture-not-a-key"};'});
        if(url.startsWith(base))return route.continue(); // Includes the byte-for-byte real index.
        if(url.startsWith('https://maps.googleapis.com/maps/api/js?'))return route.fulfill({contentType:'text/javascript',body:'('+mapsSDKFixture.toString()+')();'});
        if(url.includes('/staticmap?')||url.includes('tile.openstreetmap.org'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64')});
        if(url.includes('nominatim.openstreetmap.org'))return route.fulfill({contentType:'application/json',body:decodeURIComponent(url).includes('Unresolvable')?'[]':'[{"lat":"-36.8","lon":"174.75"}]'});
        if(url.includes('/geocode/json'))return route.fulfill({contentType:'application/json',body:'{"status":"ZERO_RESULTS","results":[]}'});
        return route.fulfill({contentType:'text/javascript',body:''});
      });
      await page.goto(base);
      await page.waitForFunction(()=>window.TK_QUOTE_WORKSPACE&&window.TK_SALES_PLATFORM&&window.TK_PIPELINE);
      // Assert integration comes from the actual document, not test-injected scripts.
      for(const file of ['sales-metrics.js','pipeline-model.js','sales-platform.js','quote-workspace.js','pricing-engine.js','cost-engine.js'])assert(loaded.has('/'+file),'Missing assembled module '+file);
      assert(loaded.has('/quote-workspace.css'),'Workspace CSS must be integrated in index');
      await page.evaluate(()=>{
        records=[newRecord({id:701,name:'Quote test',address:'Original street',suburb:'Auckland',stage:'quoting',services:[]}),newRecord({id:702,name:'Locked',stage:'won',services:[{svc:'driveway',qty:25}]})];
        currentBusinessProfile={name:'Test',region:'Auckland',home_address:'Depot, Auckland',home_lat:-36.79,home_lng:174.73};
        currentUserRole='owner';currentBusinessId='fixture-business';
        showApp();render();renderAll();switchView('pipeline');
      });
      // Enter through the real sales shell action and choose an actual widget result.
      await page.locator('[data-sale-action="quote"][data-id="701"]').first().click();
      const property=page.locator('#qw-step-0 .qw-places');await property.waitFor();
      await property.getByRole('textbox').fill('10 Test Road, Auckland, New Zealand');
      await property.getByRole('button').click();
      await page.waitForFunction(()=>document.getElementById('qw-address').value==='10 Test Road, Auckland, New Zealand');
      await page.locator('#qw-next').click();
      await page.waitForFunction(()=>qe?.lat===-36.77&&quoteTravelInfo?.source==='google');
      assert.deepEqual(await page.evaluate(()=>records.find(r=>r.id===701).mapCenter),{lat:-36.77,lng:174.74,zoom:19});
      const routeRequest=await page.evaluate(()=>window.qwFixture.routes.at(-1));
      assert.deepEqual(routeRequest.origins,[{lat:-36.79,lng:174.73}]);assert.deepEqual(routeRequest.destinations,[{lat:-36.77,lng:174.74}]);assert.equal(routeRequest.travelMode,'DRIVING');
      assert.deepEqual(await page.evaluate(()=>quoteTravelInfo),{km:25,mins:30,source:'google'});
      await page.locator('#qw-next').click();assert.match(await page.locator('#qw-message').innerText(),/quantity/);
      // Draw using the real map pointer handlers, then verify map → service sync.
      await page.locator('#qe-svc-pick button').first().click();
      const stage=page.locator('#qe-stage');await stage.scrollIntoViewIfNeeded();
      for(const position of [{x:50,y:60},{x:130,y:60},{x:130,y:140},{x:50,y:140},{x:50,y:60}])await stage.click({position});
      assert.equal(await page.evaluate(()=>qe.areas.length),1);
      assert.equal(await page.evaluate(()=>draftLines[0].qty===qe.areas[0].size),true);
      assert.equal(await page.evaluate(()=>qe.areas[0].geoPts.every(p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng))),true);
      // Real line input and pricing updates; no replacement of draft/math/render functions.
      await page.locator('#svc-builder input[type="number"]').first().fill('50');
      assert.equal(await page.locator('#quote-overlay .modal-body').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Map/services must fit the mobile viewport');
      const total=await page.evaluate(()=>quoteTotal());
      await page.locator('#qw-next').click();
      assert.equal(await page.locator('#qw-step-2').isVisible(),true);
      assert.equal(await page.locator('#quote-overlay .modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      assert.match(await page.locator('#qw-travel-status').innerText(),/one-way route/);
      const estimate=await page.evaluate(()=>TK_COST.costBreakdown(draftLines,quoteTravelInfo));
      assert.equal(estimate.travelKm,25);assert.equal(estimate.travelMins,30);
      assert.equal(estimate.fuelCost,await page.evaluate(()=>25*COST_INPUTS.fuelPerKm));
      // Provider denial, zero-results and malformed responses use an explicitly labelled estimate.
      for(const mode of ['denied','zero','malformed']){
        await page.evaluate(async mode=>{window.qwFixture.routeMode=mode;await loadQuoteTravelInfo(records.find(r=>r.id===701));},mode);
        const info=await page.evaluate(()=>quoteTravelInfo);assert.equal(info.source,'estimate');assert(info.km>0);
        assert.match(await page.locator('#qw-travel-status').innerText(),/straight-line/);
      }
      // Two actual SDK requests resolve out of order; newest travel must win.
      await page.evaluate(()=>{
        window.qwFixture.routeMode='pending';window.qwFixture.pendingRoutes=[];
        window.firstTravel=loadQuoteTravelInfo(records.find(r=>r.id===701));
        window.secondTravel=loadQuoteTravelInfo(records.find(r=>r.id===701));
      });
      await page.waitForFunction(()=>window.qwFixture.pendingRoutes.length===2);
      const stale=await page.evaluate(async()=>{
        const response=metres=>({rows:[{elements:[{status:'OK',distance:{value:metres},duration:{value:600}}]}]});
        window.qwFixture.pendingRoutes[1](response(11000));await window.secondTravel;
        window.qwFixture.pendingRoutes[0](response(99000));await window.firstTravel;
        window.qwFixture.routeMode='denied';return quoteTravelInfo.km;
      });assert.equal(stale,22);
      // Missing coordinates + failed manual lookup safely yields the configured default.
      assert.equal(await page.evaluate(async()=>{const before=currentBusinessProfile;currentBusinessProfile={home_address:'Unresolvable',home_lat:null,home_lng:null};const result=await calcTravelDistance('Unresolvable');currentBusinessProfile=before;return result;}),null);
      await page.evaluate(async()=>{window.qwFixture.routeMode='ok';await loadQuoteTravelInfo(records.find(r=>r.id===701));});
      await page.locator('#qw-next').click();
      assert.equal(await page.evaluate(()=>quoteTotal()),total);
      assert.doesNotMatch(await page.locator('#qw-preview').innerText(),/Wages|Chemicals|Estimated Profit/);
      await page.locator('#qw-next').click(); // Real confirmQuoteSend and sales-platform snapshots.
      assert.equal(await page.locator('#doc-preview-overlay').evaluate(el=>el.classList.contains('open')),true);
      const snapshot=await page.evaluate(()=>{const r=records.find(r=>r.id===701);return {total:r.total,travelKm:r.travelKm,travelMins:r.travelMins,source:r.travelSource,price:r.services[0].priceSnapshot};});
      assert.equal(snapshot.total,total);assert.equal(snapshot.travelKm,25);assert.equal(snapshot.travelMins,30);assert.equal(snapshot.source,'google');assert(snapshot.price>0);
      await page.evaluate(()=>{closeDocPreview();openQuoteModal(702);});
      assert.equal(await page.locator('#quote-overlay').evaluate(el=>el.classList.contains('open')),false);
      // Existing measurements cannot be moved to another Places-selected property.
      await page.evaluate(()=>{openQuoteModal(701);});
      await property.getByRole('textbox').fill('A different property, Auckland');await property.getByRole('button').click();
      await page.waitForFunction(()=>document.getElementById('qw-address').value==='A different property, Auckland');
      await page.locator('#qw-next').click();assert.match(await page.locator('#qw-message').innerText(),/has measurements/);
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===701).address),'10 Test Road, Auckland, New Zealand');
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===701).areaPolys.length),1);
      await page.evaluate(()=>{closeModal('quote-overlay');openSettings();});
      const depot=page.locator('#settings-overlay .qw-places');await depot.waitFor();
      await depot.getByRole('button').click();
      await page.waitForFunction(()=>document.getElementById('biz-home-address-input').value.startsWith('29A'));
      await page.getByRole('button',{name:'Save business profile',exact:true}).click();
      await page.waitForFunction(()=>window.qwFixture.saves.length===1);
      const saved=await page.evaluate(()=>window.qwFixture.saves[0]);assert.equal(saved.home_lat,-36.77);assert.equal(saved.home_lng,174.74);assert.match(saved.home_address,/29A/);
      await page.locator('#biz-home-address-input').fill('Unresolvable new address');
      await page.getByRole('button',{name:'Save business profile',exact:true}).click();
      await page.waitForFunction(()=>window.qwFixture.saves.length===2);
      assert.equal(await page.evaluate(()=>window.qwFixture.saves.at(-1).home_lat),null);assert.equal(await page.evaluate(()=>window.qwFixture.saves.at(-1).home_lng),null);
      await page.evaluate(async()=>{currentUserRole='technician';await saveBusinessProfile();});assert.equal(await page.evaluate(()=>window.qwFixture.saves.length),2);
      assert.deepEqual(restRouting,[],'No direct browser Distance Matrix REST calls');assert.deepEqual(errors,[]);
      await context.close();console.log(`Assembled quote workspace browser checks passed (${width}px)`);
    }
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
