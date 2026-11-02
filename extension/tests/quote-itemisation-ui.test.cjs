// Focused browser fixture: no live CRM, Supabase, Maps, or full app suite.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..');

test('quote UI reuses outline quantities, requires manual panes and saves exactly the displayed item prices',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  try {
    const page=await browser.newPage({viewport:{width:1100,height:1000}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://fixture.test/**',route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><body class="tk-root"><main id="toolbar"></main><main id="quote"></main>'});
      const file=path.resolve(root,'.'+pathname);
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404});
      return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
    });
    await page.goto('https://fixture.test/');
    await page.addStyleTag({url:'https://fixture.test/extension/content/panel/panel.css'});
    await page.evaluate(async()=>{
      await import('/extension/vendor/pricing-engine.js');await import('/extension/vendor/cost-engine.js');await import('/extension/vendor/pricing-learning-engine.js');
      const {renderQuotePanel}=await import('/extension/content/panel/quote.js');
      const {mountToolbar}=await import('/extension/content/panel/toolbar.js');
      const customer={id:'C',name:'Jane <img src=x onerror="window.bad=true">',phone:'021 123',email:'jane@example.net',address:'42 <Road>',notes:'Gate & dog',source:'Wix'};
      const job={id:'J',details:{requestedServices:[{name:'House Wash',service_id:'housewash'},'Other <work>'],windowsRequested:true,jobNotes:'Back panes <script>window.bad=true</script>'}};
      const measurement={id:'outline',type:'area',service:'driveway',size:200,unit:'m²',categoryLabel:'Driveway',quantities:{area:200,perimeter:60},geoPts:[{lat:0,lng:0},{lat:0,lng:.001},{lat:.001,lng:.001}],points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]};
      const observations=Array.from({length:6},(_,i)=>({businessId:'B',quoteKey:'q'+i,jobId:'j'+i,svc:'driveway',unit:'m²',quantity:200,storeys:1,access:'standard',baselinePrice:800,chosenPrice:960,reason:'pricing_correction',context:{gstRegistered:true},measuredQuantity:200,verifiedQuantity:240,measurementReason:'site_measurement'}));
      const context={business:{id:'B'},TK_PRICE_LEARNING:window.TK_PRICE_LEARNING,learningState:{modelVersion:1,settings:{enabled:true,minSamples:5},observations},measurements:[measurement],address:customer.address,TK_PRICING:window.TK_PRICING,TK_COST:window.TK_COST,boundCustomer:customer,boundJob:job};
      window.paintQuote=extra=>renderQuotePanel(document.querySelector('#quote'),{...context,...extra},{onCancel:()=>{},onSearchCustomer:async()=>[],onCreateQuote:async payload=>{window.saved=payload;window.saveCount=(window.saveCount||0)+1}});
      window.paintQuote();
      const toolbar=mountToolbar(document.querySelector('#toolbar'),{onAction:()=>{},onAddressChange:()=>{}});
      toolbar.update({session:{},business:{name:'Business <bad>'},measurements:[],boundCustomer:customer,boundJob:job});
    });
    for(const host of ['#toolbar','#quote']) {
      const info=await page.locator(host+' .tk-client-context').innerText();
      for(const value of ['Jane <img','021 123','jane@example.net','42 <Road>','Gate & dog','Back panes <script>','House Wash','Other <work>','Window Cleaning'])assert.ok(info.includes(value),value);
      assert.equal(await page.locator(host+' .tk-client-context img, '+host+' .tk-client-context script').count(),0);
    }
    assert.equal(await page.locator('[data-create]').isDisabled(),true,'requested windows need a real manual count');
    assert.equal(await page.locator('[data-line-svc="0"] option[value="windows"]').count(),0);
    await page.locator('[data-extra-qty="0"]').fill('12');
    await page.locator('[data-extra-qty="0"]').dispatchEvent('change');
    assert.match(await page.locator('[data-service-price]').first().innerText(),/6 distinct comparable quotes/);
    assert.equal(await page.locator('[data-measure-hint]').count(),1);
    await page.locator('[data-measure-hint]').click();
    assert.ok(Number(await page.locator('[data-verified]').first().inputValue())>200);
    assert.match(await page.locator('[data-service-price]').first().innerText(),/200 m²/,'measurement hint does not auto-apply');
    await page.locator('[data-reuse="0"]').click();
    assert.equal(await page.locator('[data-line-svc="1"]').inputValue(),'housewash');
    assert.match(await page.locator('.tk-line-row').nth(1).innerText(),/60 m/);
    const standardPrice=Number(await page.locator('[data-price]').inputValue());
    await page.locator('[data-storeys="1"]').selectOption('3');
    assert.ok(Number(await page.locator('[data-price]').inputValue())>standardPrice,'house levels update recommended pricing');
    await page.locator('[data-access]').selectOption('hard');
    assert.match(await page.locator('[data-storeys="1"] option:checked').innerText(),/Three storey/);
    assert.equal(await page.locator('[data-create]').isDisabled(),false);
    await page.locator('[data-access]').selectOption('standard');
    await page.locator('[data-storeys="1"]').selectOption('1');
    const edit=page.locator('[data-line-price]').first();
    await edit.fill('123.45');await edit.dispatchEvent('change');
    await page.locator('[data-access]').selectOption('hard');
    assert.equal(await page.locator('[data-line-price]').first().inputValue(),'123.45');
    await page.locator('[data-margin]').fill('70');await page.locator('[data-margin]').dispatchEvent('change');
    assert.equal(await page.locator('[data-line-price]').first().inputValue(),'123.45');
    assert.match(await page.locator('[data-service-price]').first().innerText(),/below its target margin floor/);
    // Invalid line prices retain the editable field and can be corrected.
    await page.locator('[data-line-price]').first().fill('');await page.locator('[data-line-price]').first().dispatchEvent('change');
    assert.equal(await page.locator('[data-create]').isDisabled(),true);
    await page.locator('[data-line-price]').first().fill('123.45');await page.locator('[data-line-price]').first().dispatchEvent('change');
    await page.locator('[data-access]').selectOption('standard');
    // A direct measured-service edit is captured without a reason-selection step.
    await page.locator('[data-create]').click();
    assert.equal((await page.evaluate(()=>window.saved)).quoteLearning.lines[0].reason,'pricing_correction');
    // Draft measurements do nothing until Apply, which preserves original geometry.
    const quantityBefore=await page.locator('[data-service-price]').first().innerText();
    await page.locator('[data-verified]').first().fill('240');
    await page.locator('[data-measure-reason]').first().selectOption('site_measurement');
    assert.equal(await page.locator('[data-service-price]').first().innerText(),quantityBefore);
    await page.locator('[data-apply-quantity]').first().click();
    assert.match(await page.locator('[data-service-price]').first().innerText(),/240 m²/);
    assert.match(await page.locator('[data-service-price]').first().innerText(),/Original quantity: 200/);
    assert.equal(await page.locator('[data-line-price]').first().inputValue(),'123.45');
    await page.locator('[data-price]').fill('650.37');await page.locator('[data-price]').dispatchEvent('change');
    await page.locator('[data-distribute-total]').click();
    assert.match(await page.locator('[data-price-adjustment]').innerText(),/exact sum/);
    const displayed=await page.locator('[data-service-price]').evaluateAll(rows=>rows.map(row=>({svc:row.dataset.servicePrice,cents:Math.round(Number(row.querySelector('[data-line-price]').value)*100)})));
    assert.equal(displayed.reduce((sum,line)=>sum+line.cents,0),65037);
    await page.locator('[data-create]').click();
    const saved=await page.evaluate(()=>window.saved);
    assert.equal(saved.total,650.37);
    assert.equal(saved.quoteLearning.lines[0].measuredQuantity,200);
    assert.equal(saved.quoteLearning.lines[0].verifiedQuantity,240);
    assert.equal(saved.quoteLearning.lines[0].quantity,240);
    assert.equal(saved.quoteLearning.lines[0].reason,''); // Distribution explicitly clears price-training reasons.
    assert.equal(saved.quoteLearning.lines[0].measurementReason,'site_measurement');
    assert.equal(saved.quoteLearning.lines.reduce((sum,l)=>sum+Math.round(l.chosenPrice*100),0),65037);
    assert.equal(saved.assumptions.access,'standard');
    assert.deepEqual(saved.lines.map(line=>({svc:line.svc,cents:Math.round(line.fixedPrice*100)})),displayed);
    assert.deepEqual(saved.lines.map(line=>[line.svc,line.qty]),[['driveway',240],['housewash',60],['windows',12]]);
    assert.deepEqual(saved.areaPolys.map(area=>[area.service,area.size,area.unit,area.type]),[['driveway',200,'m²','area'],['housewash',60,'m','perimeter']]);
    assert.equal(saved.areaPolys[0].geoPts.length,saved.areaPolys[1].geoPts.length);
    if(process.env.TK_EXTENSION_UI_SCREENSHOT){
      await page.screenshot({path:process.env.TK_EXTENSION_UI_SCREENSHOT});
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:process.env.TK_EXTENSION_UI_SCREENSHOT.replace('.png','-mobile.png')});
      await page.setViewportSize({width:1100,height:1000});
    }
    await page.evaluate(()=>window.paintQuote({measurements:[],manualWindows:true,boundJob:null}));
    assert.equal(await page.locator('[data-extra-qty="0"]').inputValue(),'');
    assert.equal(await page.locator('[data-create]').isDisabled(),true);
    await page.locator('[data-extra-qty="0"]').fill('1.5');await page.locator('[data-extra-qty="0"]').dispatchEvent('change');
    assert.match(await page.locator('[role="alert"]:visible').innerText(),/whole-number manual pane count/);
    await page.locator('[data-extra-qty="0"]').fill('8');await page.locator('[data-extra-qty="0"]').dispatchEvent('change');
    assert.equal(await page.locator('[data-create]').isDisabled(),false);
    await page.locator('[data-create]').click();
    assert.equal((await page.evaluate(()=>window.saved)).areaPolys.length,0);
    const beforeSaves=await page.evaluate(()=>window.saveCount);
    const priceHandle=await page.locator('[data-line-price]').first().elementHandle();
    const createHandle=await page.locator('[data-create]').elementHandle();
    await page.locator('[data-line-price]').first().fill('203.47');
    assert.match(await page.locator('[data-final-total]').innerText(),/NZ\$203\.5/);
    await page.locator('[data-create]').click(); // actual blur + pointer click; no synthetic change
    assert.equal(await page.evaluate(()=>window.saveCount),beforeSaves+1,'a single click immediately after editing saves once');
    assert.equal((await page.evaluate(()=>window.saved)).lines[0].fixedPrice,203.47);
    assert.equal(await priceHandle.evaluate(el=>el.isConnected),true,'price input remains mounted');
    assert.equal(await createHandle.evaluate(el=>el.isConnected),true,'Create button remains mounted');
    assert.equal(await page.evaluate(()=>!!window.bad),false);
    await page.evaluate(async()=>{
      const {renderQuoteCreated}=await import('/extension/content/panel/quote.js');window.retries=0;
      renderQuoteCreated(document.querySelector('#quote'),{address:'Saved property',total:123.45,lines:[{svc:'driveway',qty:200,fixedPrice:123.45}],SERVICES:window.TK_PRICING.SERVICES,learningWarning:'Your quote is saved. Learning was not saved.'},{onRetryLearning:async()=>{if(++window.retries===1)throw Error('Temporary outage');},onDone:()=>{}});
    });
    await page.locator('[data-retry-learning]').click();assert.match(await page.locator('[data-learning-status]').innerText(),/quote is saved.*Temporary outage/);
    assert.match(await page.locator('.tk-created-total').innerText(),/NZ\$123\.5/);
    await page.locator('[data-retry-learning]').click();await page.locator('[data-retry-learning]').waitFor({state:'hidden'});assert.equal(await page.locator('[data-retry-learning]').isHidden(),true);
    assert.equal(await page.evaluate(()=>window.retries),2);assert.deepEqual(errors,[]);
  } finally {await browser.close()}
});
