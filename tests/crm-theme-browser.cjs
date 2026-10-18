/* Run from the checkout: node tests/crm-theme-browser.cjs
 * Real, byte-for-byte index + modules; the parent-added theme link is simulated
 * with addStyleTag after module startup. No app code is replaced. All external
 * traffic is intercepted, writes are forbidden. Empty account = no fake stats.
 * Screenshots default to /tmp/turnkey-crm-theme (override CRM_THEME_SHOTS).
 */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),shots=process.env.CRM_THEME_SHOTS||'/tmp/turnkey-crm-theme';
(async()=>{
  fs.mkdirSync(shots,{recursive:true});
  const cached=path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached})});
  try {
    for(const width of [1440,390]){
      const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage(),errors=[],loaded=new Set(),writes=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{
        window.supabase={createClient:()=>({
          auth:{getSession:async()=>({data:{session:window.themeSignedIn?{user:{id:'theme-user'},access_token:'fixture-token'}:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
          from(table){const q={select(){return q},eq(){return q},neq(){return q},is(){return q},order(){return q},limit(){return q},
            insert(){throw Error('Forbidden insert: '+table)},update(){throw Error('Forbidden update: '+table)},upsert(){throw Error('Forbidden upsert: '+table)},
            single:async()=>({data:null,error:null}),maybeSingle:async()=>({data:null,error:null}),then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject)}};return q;}
        })};
      });
      await page.route('**/*',async route=>{
        const req=route.request(),u=new URL(req.url());
        if(req.method()!=='GET'){writes.push(req.url());return route.abort()}
        if(u.origin==='https://theme.test'){
          const name=u.pathname==='/'?'index.html':u.pathname.slice(1),file=path.resolve(root,name);
          if(name==='config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={supabaseUrl:"https://fixture.invalid",supabaseAnonKey:"fixture-not-a-key",backendUrl:"https://backend.test"};'});
          if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
          loaded.add(name);return route.fulfill({path:file,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream'});
        }
        if(u.origin==='https://backend.test'){
          if(u.pathname.endsWith('/messages'))return route.fulfill({json:{messages:[],stars:[],hasMore:false,account:null}});
          if(u.pathname.endsWith('/drafts'))return route.fulfill({json:{drafts:[]}});
          if(u.pathname.endsWith('/range'))return route.fulfill({json:{jobs:[],staff:[],events:[],blocks:[],google:{connected:false},canManage:true}});
          return route.fulfill({status:503,json:{error:'Browser validation: backend unavailable'}});
        }
        return route.fulfill({contentType:'text/javascript',body:''});
      });
      await page.goto('https://theme.test/');
      await page.waitForFunction(()=>window.TK_SALES_PLATFORM&&window.TK_QUOTE_WORKSPACE&&window.TK_CONVERSATIONS_BRIDGE);
      await page.evaluate(()=>{records=[];currentBusinessId='theme-fixture';currentUserRole='owner';currentBusinessProfile={name:'Theme validation'};showApp();render();renderAll();switchView('dashboard');currentUserId='theme-user';businessStateReady=true;window.themeSignedIn=true});
      const iconsBefore=await page.locator('nav .nav-ico svg, nav .bn-ico svg').count();
      assert(iconsBefore>0,'Actual navigation SVGs must exist');
      await page.addStyleTag({url:'https://theme.test/crm-theme.css'});
      for(const name of ['sales-platform.js','quote-workspace.js','conversations.js','crm-theme.css'])assert(loaded.has(name),'Missing assembled asset '+name);
      async function fits(label){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' document overflow');}
      async function shot(name){await page.screenshot({path:path.join(shots,`${width}-${name}.png`),fullPage:!name.startsWith('quote-')&&name!=='settings'&&name!=='connections',animations:'disabled'});}
      for(const view of ['dashboard','pipeline','leads','sales','inbox','calendar','pricing']){
        await page.evaluate(v=>switchView(v),view);
        await page.locator('#view-'+view).waitFor({state:'visible'});
        if(view==='inbox')await page.locator('.cv-layout').waitFor();
        if(view==='calendar')await page.locator('.tkjc-agenda').waitFor();
        await fits(view);await shot(view);
        assert.equal(await page.locator('.view.active').count(),1,'Only selected view is visible');
      }
      // Real native sidebar collapse must preserve every icon.
      if(width>720){
        await page.locator('[data-sale-action=collapse]').click();
        assert.equal(await page.locator('nav .nav-ico svg, nav .bn-ico svg').count(),iconsBefore);
        const icon=page.locator('#tabs .nav-ico svg').first();assert(await icon.isVisible());assert((await icon.boundingBox()).width>=16);
        await page.locator('[data-sale-action=collapse]').click();
      } else {
        assert(!(await page.locator('#tabs').isVisible()));assert(await page.locator('#bottom-nav').isVisible());
      }
      await page.evaluate(()=>openSettings());
      await page.locator('#settings-overlay.open').waitFor();await fits('settings');await shot('settings');
      await page.evaluate(()=>closeModal('settings-overlay'));
      assert(!(await page.locator('#settings-overlay').isVisible()),'Closed overlay stays hidden');
      await page.evaluate(()=>openConnections());
      await page.locator('#conn-overlay.open').waitFor();await fits('connections');await shot('connections');
      await page.evaluate(()=>closeModal('conn-overlay'));
      // Explicitly labelled fixture, no monetary values. Real quote workspace.
      await page.evaluate(()=>{window.themeSignedIn=false;currentUserId=null;businessStateReady=false;TURNKEY_CONFIG.backendUrl='';records=[newRecord({id:701,name:'Browser validation fixture',stage:'quoting',services:[]})];openQuoteModal(701)});
      await page.locator('#qw-step-0').waitFor({state:'visible'});await fits('quote');await shot('quote-property');
      assert(!(await page.locator('#qw-step-1').isVisible()),'Inactive quote steps stay hidden');
      await page.locator('#qw-address').fill('Browser validation property');
      await page.locator('#qw-next').click();
      await page.locator('#qw-step-1').waitFor({state:'visible'});
      assert(await page.locator('#quote-overlay .modal-body').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Map/services fit modal');
      await fits('quote map');await shot('quote-map');
      // The parent is adding this class; exercise the contract on the real CTA
      // without changing its handler or label. The SVG remains parent-owned.
      await page.evaluate(()=>{closeModal('quote-overlay');render();switchView('pipeline');document.querySelector('[data-sale-action=quote][data-id="701"]').classList.add('quote-launch-btn')});
      const launch=page.locator('.quote-launch-btn').first();await page.keyboard.press('Tab');await launch.focus();
      const focus=await launch.evaluate(el=>getComputedStyle(el).outlineStyle);assert.equal(focus,'solid');
      if(width===390)assert(await launch.evaluate(el=>Math.abs(el.getBoundingClientRect().width-(el.parentElement.clientWidth-parseFloat(getComputedStyle(el.parentElement).paddingLeft)-parseFloat(getComputedStyle(el.parentElement).paddingRight)))<2),'Launch CTA fills its mobile container');
      await shot('quote-launch');
      await page.evaluate(()=>{closeModal('quote-overlay');switchView('dashboard')});
      assert.equal(await page.locator('nav .nav-ico svg, nav .bn-ico svg').count(),iconsBefore,'Theme preserves tab icons');
      assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
      console.log(`${width}px: assembled views, overflow, icons/collapse, hidden states, dialogs, real quote CTA/focus passed`);
      await context.close();
    }
    console.log('Screenshots: '+shots);
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
