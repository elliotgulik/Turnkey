/* One assembled desktop/mobile pass: controls, search, pricing, session continuity. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
(async()=>{
 const server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,filename=path.resolve('.'+(name==='/'?'/index.html':name));
  if(!filename.startsWith(process.cwd()+path.sep)){res.writeHead(404);res.end();return;}
  fs.readFile(filename,(error,data)=>{if(error){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.html')?'text/html':'application/octet-stream');res.end(data);});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,cached=path.join(require('node:os').homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 const browser=await chromium.launch({headless:true,...(!fs.existsSync(chromium.executablePath())?{executablePath:cached}:{})});
 try{
  for(const width of [1440,390]){
   const page=await browser.newPage({viewport:{width,height:960},timezoneId:'Pacific/Auckland'}),errors=[];
   page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{
    const url=route.request().url();
    if(url===base+'/config.js?v=20261017a')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={};'});
    if(url.startsWith(base))return route.continue();
    return route.fulfill({contentType:'text/javascript',body:''});
   });
   await page.goto(base);await page.waitForFunction(()=>!!window.TK_WORKSPACE&&!!window.TK_UI);
   await page.evaluate(()=>{
    currentBusinessId='ux-a';currentUserId='ux-owner';currentUserRole='owner';businessStateReady=true;currentBusinessProfile={name:'Coastal Exterior Care'};
    records=[newRecord({id:1,name:'Alice Sample',email:'alice@example.test',address:'1 Sample Street',stage:'new',opportunityValue:300}),newRecord({id:2,name:'Ben Example',email:'ben@example.test',address:'2 Example Street',stage:'quoted',quoteSentAt:Date.now(),total:620}),newRecord({id:3,name:'Casey Demo',email:'casey@example.test',address:'3 Demo Street',stage:'won',total:1150})];
    records.forEach(r=>recordBusinesses.set(r,currentBusinessId));staff=[];showApp();render();switchView('leads');TK_WORKSPACE.refresh();
   });
   assert.equal(await page.locator('.sidebar-nav [data-view=calendar] svg').count(),1);
   await page.getByRole('button',{name:'Search your workspace',exact:true}).click();
   await page.getByRole('searchbox',{name:'Search customers and pages'}).fill('alice');
   await page.getByRole('option',{name:/Alice Sample/}).click();
   assert.match(await page.locator('#view-detail').innerText(),/Alice Sample/);
   // Same-user notifications must not call the clearing/reinitialization wrappers.
   await page.evaluate(()=>{openLeadModal();document.getElementById('l-name').value='Unsaved enquiry';window.repeatInitCalls=0;const old=handleAuthedSession;handleAuthedSession=(...args)=>{repeatInitCalls++;return old(...args);};});
   await page.evaluate(()=>appSessionGate.start({user:{id:'ux-owner'},access_token:'renewed'}));
   assert.equal(await page.evaluate(()=>repeatInitCalls),0);assert.equal(await page.locator('#l-name').inputValue(),'Unsaved enquiry');
   assert.equal(await page.locator('#auth-overlay').isVisible(),false);await page.evaluate(()=>closeModal('lead-overlay'));
   await page.evaluate(()=>openSettings());
   await page.locator('.sx-nav [data-sx-category="business"]').click();
   await page.locator('#biz-name-input').fill('Unsaved business edit');
   await page.locator('.sx-nav [data-sx-category="connections"]').click();
   await page.locator('.sx-nav [data-sx-category="business"]').click();
   assert.equal(await page.locator('#biz-name-input').inputValue(),'Unsaved business edit');
   fs.mkdirSync('.artifacts',{recursive:true});await page.screenshot({path:'.artifacts/workspace-settings-'+width+'.png',fullPage:true,animations:'disabled'});
   await page.evaluate(()=>closeModal('settings-overlay'));
   // Real searchable picker inside a native dialog, without breaking FormData or change handlers.
   await page.evaluate(()=>{const d=document.createElement('dialog');d.id='ux-test-dialog';d.innerHTML='<form id="ux-test-form"><label>Assigned person<select name="person" required aria-label="Assigned person"><option value="">Choose</option><option value="alice">Alice Smith</option><option value="bob" disabled>Bob Disabled</option><option value="casey">Casey Cooper</option></select></label><button type="button" id="ux-after-select">Continue</button></form>';document.body.append(d);d.showModal();window.changed=0;d.querySelector('select').addEventListener('change',()=>changed++);});
   await page.getByRole('combobox',{name:'Assigned person: Choose',exact:true}).click();
   await page.getByRole('combobox',{name:'Search assigned person',exact:true}).fill('casey');
   await page.getByRole('option',{name:'Casey Cooper'}).click();
   assert.equal(await page.evaluate(()=>new FormData(document.getElementById('ux-test-form')).get('person')),'casey');assert.equal(await page.evaluate(()=>changed),1);
   await page.getByRole('combobox',{name:'Assigned person: Casey Cooper',exact:true}).press('ArrowDown');
   await page.getByRole('combobox',{name:'Search assigned person',exact:true}).press('Home');
   await page.getByRole('combobox',{name:'Search assigned person',exact:true}).press('ArrowDown');
   await page.getByRole('combobox',{name:'Search assigned person',exact:true}).press('Enter');
   assert.equal(await page.evaluate(()=>new FormData(document.getElementById('ux-test-form')).get('person')),'alice');
   await page.getByRole('combobox',{name:'Assigned person: Alice Smith',exact:true}).click();
   await page.getByRole('combobox',{name:'Search assigned person',exact:true}).press('Tab');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'ux-after-select');
   await page.evaluate(()=>{document.getElementById('ux-test-dialog').close();document.getElementById('ux-test-dialog').remove();switchView('pricing');});
   await page.getByRole('tab',{name:'Service setup',exact:true}).click();
   const service=page.locator('.ux-service-cost').first();await service.locator('summary').click();
   assert.ok(await service.locator('input[type=checkbox]').count()>=3);
   await page.getByRole('tab',{name:'Chemical prices',exact:true}).click();
   assert.equal(await page.locator('.ux-service-cost').first().isVisible(),false);
   await page.evaluate(()=>switchView('leads'));
   fs.mkdirSync('.artifacts',{recursive:true});await page.screenshot({path:'.artifacts/workspace-ux-'+width+'.png',fullPage:true,animations:'disabled'});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No page overflow at '+width);
   // Clear dialog results and prevent old-business actions after an account switch.
   await page.getByRole('button',{name:'Search your workspace',exact:true}).click();await page.getByRole('searchbox',{name:'Search customers and pages'}).fill('Alice');
   await page.evaluate(()=>{currentBusinessId='ux-b';businessSessionVersion++;showAuth();});
   assert.equal(await page.locator('#workspace-command').evaluate(el=>el.open),false);assert.equal(await page.locator('#workspace-command').textContent().then(t=>t.includes('Alice Sample')),false);
   assert.deepEqual(errors,[],'Runtime errors at '+width);await page.close();console.log('PASS workspace UX '+width+'px');
  }
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
