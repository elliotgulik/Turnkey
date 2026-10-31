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
      await import('/extension/vendor/pricing-engine.js');await import('/extension/vendor/cost-engine.js');
      const {renderQuotePanel}=await import('/extension/content/panel/quote.js');
      const {mountToolbar}=await import('/extension/content/panel/toolbar.js');
      const customer={id:'C',name:'Jane <img src=x onerror="window.bad=true">',phone:'021 123',email:'jane@example.net',address:'42 <Road>',notes:'Gate & dog',source:'Wix'};
      const job={id:'J',details:{requestedServices:[{name:'House Wash',service_id:'housewash'},'Other <work>'],windowsRequested:true,jobNotes:'Back panes <script>window.bad=true</script>'}};
      const measurement={id:'outline',type:'area',service:'driveway',size:200,unit:'m²',categoryLabel:'Driveway',quantities:{area:200,perimeter:60},geoPts:[{lat:0,lng:0},{lat:0,lng:.001},{lat:.001,lng:.001}],points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]};
      const context={measurements:[measurement],address:customer.address,TK_PRICING:window.TK_PRICING,TK_COST:window.TK_COST,boundCustomer:customer,boundJob:job};
      window.paintQuote=extra=>renderQuotePanel(document.querySelector('#quote'),{...context,...extra},{onCancel:()=>{},onSearchCustomer:async()=>[],onCreateQuote:async payload=>{window.saved=payload}});
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
    await page.locator('[data-price]').fill('650.37');await page.locator('[data-price]').dispatchEvent('change');
    assert.match(await page.locator('[data-price-adjustment]').innerText(),/Manual total adjustment/);
    const displayed=await page.locator('[data-service-price]').evaluateAll(rows=>rows.map(row=>({svc:row.dataset.servicePrice,cents:Math.round(Number(row.querySelector('strong').textContent.replace(/[$,]/g,''))*100)})));
    assert.equal(displayed.reduce((sum,line)=>sum+line.cents,0),65037);
    await page.locator('[data-create]').click();
    const saved=await page.evaluate(()=>window.saved);
    assert.equal(saved.total,650.37);
    assert.equal(saved.assumptions.access,'standard');
    assert.deepEqual(saved.lines.map(line=>({svc:line.svc,cents:Math.round(line.fixedPrice*100)})),displayed);
    assert.deepEqual(saved.lines.map(line=>[line.svc,line.qty]),[['driveway',200],['housewash',60],['windows',12]]);
    assert.deepEqual(saved.areaPolys.map(area=>[area.service,area.size,area.unit,area.type]),[['driveway',200,'m²','area'],['housewash',60,'m','perimeter']]);
    assert.equal(saved.areaPolys[0].geoPts.length,saved.areaPolys[1].geoPts.length);
    if(process.env.TK_EXTENSION_UI_SCREENSHOT)await page.screenshot({path:process.env.TK_EXTENSION_UI_SCREENSHOT});
    await page.evaluate(()=>window.paintQuote({measurements:[],manualWindows:true,boundJob:null}));
    assert.equal(await page.locator('[data-extra-qty="0"]').inputValue(),'');
    assert.equal(await page.locator('[data-create]').isDisabled(),true);
    await page.locator('[data-extra-qty="0"]').fill('1.5');await page.locator('[data-extra-qty="0"]').dispatchEvent('change');
    assert.match(await page.locator('[role="alert"]').innerText(),/whole-number manual pane count/);
    await page.locator('[data-extra-qty="0"]').fill('8');await page.locator('[data-extra-qty="0"]').dispatchEvent('change');
    assert.equal(await page.locator('[data-create]').isDisabled(),false);
    await page.locator('[data-create]').click();
    assert.equal((await page.evaluate(()=>window.saved)).areaPolys.length,0);
    assert.equal(await page.evaluate(()=>!!window.bad),false);assert.deepEqual(errors,[]);
  } finally {await browser.close()}
});
