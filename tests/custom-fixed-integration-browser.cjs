// Real root/public pages and local modules, with only external API boundaries mocked.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=process.cwd(),browser=await chromium.launch({headless:true});
 const line={svc:'custom',pricingMode:'fixed',label:'Furniture <move>',qty:2,unit:'hour',unitPrice:20.01,fixedPrice:40.02,customCost:null,manual:true,lineKey:'custom-A'};
 const quote={quoteId:'Q',status:'sent',amount:40.02,services:[{svc:'custom',qty:2,fixedPrice:40.02}],business:{name:'Fixture Business'},customer:{name:'Customer'},areaPolys:[]};
 try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const fixture=fs.readFileSync('tests/quote-workspace-browser.cjs','utf8');
  await page.addInitScript(fixture.slice(fixture.indexOf('function externalFixtures()'),fixture.indexOf('function mapsSDKFixture()'))+'externalFixtures();');
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={backendUrl:"https://fixture.test",supabaseUrl:"https://supabase.test",supabaseAnonKey:"fixture"};'});
   if(url.pathname==='/rest/v1/rpc/get_public_quote')return route.fulfill({json:quote});
   if(url.pathname==='/api/public/quotes/T/services')return route.fulfill({json:{quoteId:'Q',status:'sent',amount:40.02,services:[line]}});
   if(url.host==='fixture.test'&&!url.pathname.startsWith('/api/')){
    const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(file.startsWith(root+path.sep)&&fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'application/octet-stream',body:fs.readFileSync(file)});
   }
   return route.fulfill({contentType:'application/json',body:'{}'});
  });
  await page.goto('https://fixture.test/');await page.waitForFunction(()=>window.TK_PRICE_LEARNING_UI&&window.TK_QUOTE_WORKSPACE);
  await page.evaluate(line=>{
   currentBusinessId='fixture-business';currentUserRole='owner';TK_SALES_PLATFORM.request=async()=>({settings:{enabled:true},observations:[]});
   records=[newRecord({id:701,name:'Custom quote',address:'10 Test Road',stage:'quoting',services:[line],total:40.02,areaPolys:[]})];showApp();businessStateReady=true;recordBusinesses.set(records[0],currentBusinessId);openQuoteModal(701);
  },line);
  await page.locator('#qw-next').click();
  assert.equal(await page.locator('[aria-label="Custom unit"]').inputValue(),'hour');
  assert.equal(await page.locator('[aria-label="Custom quantity"]').inputValue(),'2');
  assert.equal(await page.evaluate(()=>quoteTotal()),40.02);
  await page.locator('[aria-label="Custom unit price"]').fill('21.03');assert.equal(await page.evaluate(()=>quoteTotal()),42.06);
  await page.locator('#qw-next').click();assert.match(await page.locator('#estimate-zone').innerText(),/margin: Unknown/);
  assert.equal(await page.evaluate(()=>TK_PRICE_LEARNING_UI.capture(records[0])),null);
  await page.locator('#qw-next').click();assert.match(await page.locator('#qw-preview').innerText(),/Furniture <move>.*2 hour/);assert.match(await page.locator('#qw-preview').innerText(),/42\.06/);
  await page.locator('#qw-next').click();
  let saved=await page.evaluate(()=>structuredClone(records[0]));assert.equal(saved.total,42.06);assert.equal(saved.estimatedCost,null);assert.equal(saved.estimatedMarginPct,null);assert.equal(saved.services[0].priceSnapshot,42.06);assert.deepEqual(saved.areaPolys,[]);
  const documentHtml=await page.evaluate(()=>renderDocHTML('quote',records[0]));assert.match(documentHtml,/2 hour/);assert.match(documentHtml,/42\.06/);
  await page.evaluate(()=>{closeDocPreview();openQuoteModal(701);});await page.locator('#qw-next').click();
  await page.locator('[aria-label="Custom delivery cost"]').fill('10');await page.locator('#qw-next').click();assert.doesNotMatch(await page.locator('#estimate-zone').innerText(),/Unknown/);
  await page.locator('#qw-next').click();await page.locator('#qw-next').click();saved=await page.evaluate(()=>structuredClone(records[0]));assert.equal(saved.total,42.06);assert.equal(saved.estimatedCost,10);assert.equal(saved.costSnapshot.costComplete,true);
  await page.goto('https://fixture.test/quote.html?t=T');await page.locator('#approve-btn').waitFor();
  assert.match(await page.locator('#card').innerText(),/Furniture <move>/);assert.match(await page.locator('#card').innerText(),/2 hour/);assert.match(await page.locator('#card').innerText(),/40\.02/);assert.equal(await page.locator('#card move').count(),0);assert.doesNotMatch(await page.locator('#card').innerText(),/customCost|Estimated cost|m²/);
  assert.deepEqual(errors,[]);console.log(`PASS custom CRM/public quote at ${width}px`);await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
