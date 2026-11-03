/* Offline visual inventory. Synthetic fixtures only; no production requests. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const phase=process.argv[2]||'before',root=path.resolve(__dirname,'..'),out=path.join(root,'.design-shots',phase);
const fixed='2026-11-03T02:00:00Z';fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html',file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);});
const payload={staff:[{id:'servicem8:elliot',name:'Elliot Gulik',source:'servicem8'},{id:'servicem8:luca',name:'Luca Anderson',source:'servicem8'}],events:[],blocks:[],jobs:[],connections:[],logs:[],equipment:[],messages:[],drafts:[],stars:[],settings:{},goals:[],spend:[],tasks:[],items:[],accounts:[],hasMore:false,connected:false,done:true};
async function seed(page){await page.evaluate(()=>{
 const now=Date.now();currentBusinessId='design-fixture';currentUserId='fixture-owner';currentUserRole='owner';businessStateReady=true;
 backendUrl=()=>location.origin;window.TK_CURRENT_SESSION={user:{id:currentUserId},access_token:'fixture-only',expires_at:now/1000+3600};
 syncRecordToSupabase=async()=>{};scheduleSupabaseSync=()=>{};window.open=()=>null;
 currentBusinessProfile={name:'Nova Exterior',phone:'021 555 0100',email:'crew@example.test',home_address:'29a Selwyn Crescent, Forrest Hill',region:'Auckland'};
 docTemplate.businessName='Nova Exterior';docTemplate.phone='021 555 0100';docTemplate.email='crew@example.test';
 const names=['Aroha Thompson','Ben Wilson','Casey Williams','Drew Anderson','Harbour Property Group','Moana Taylor','River Brown','Sam Walker'];
 records=['new','contacted','quoted','won','scheduled','completed','paid','cancelled'].map((stage,i)=>newRecord({id:i+1,name:names[i],customerId:'c'+i,jobId:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),stage,source:i%2?'Wix':'Meta',email:'customer'+i+'@example.test',phone:'021 555 010'+i,address:(18+i)+' Kowhai Road, Takapuna, Auckland',suburb:'Takapuna',createdAt:now-i*3600000,requestSubmittedAt:now-i*3600000,total:stage==='new'?0:920+i*115,opportunityValue:980,services:stage==='new'?[]:[{svc:'housewash',qty:65,storeys:2},{svc:'driveway',qty:85}],requestedServices:['House Clean','Driveway Clean','Window Clean (Outside Only)'],formAnswers:[{label:'Select Services',answer:'House Clean, Driveway Clean, Window Clean (Outside Only)'},{label:'Urgency',answer:'As soon as possible'}],assignedSalespersonId:i%2?'servicem8:elliot':'servicem8:luca',salespersonName:i%2?'Elliot Gulik':'Luca Anderson',quoteSentAt:stage==='quoted'?now-86400000:null,wonAt:['won','scheduled','completed','paid'].includes(stage)?now-86400000:null,completedAt:['completed','paid'].includes(stage)?now-3600000:null,lostAt:stage==='cancelled'?now:null,scheduledDateISO:stage==='scheduled'?'2026-11-03':null,scheduledStartMin:540,scheduledDurationMin:120,notes:'Please call before arriving.',jobNotes:'Exterior house wash and driveway clean.',salesNotes:'Customer prefers a morning appointment.',nextFollowUpAt:stage==='quoted'?new Date(now-3600000).toISOString():null,estimatedCost:310,estimatedMarginPct:58}));
 records.forEach(r=>recordBusinesses.set(r,currentBusinessId));staff=[{id:currentUserId,name:'Elliot Gulik',role:'owner'}];pendingInvites=[];
 goals=[{id:1,label:'Monthly revenue',type:'revenue',target:15000,period:'month',perks:[]}];
 inboxMessages=[{id:'m1',customer_id:'c0',thread_id:'t1',direction:'sent',subject:'Your exterior cleaning quote',body_text:'Hi Aroha,\nThanks for your enquiry. Here is the quote for the house wash and driveway.',from_address:'Nova Exterior <crew@example.test>',to_addresses:'customer0@example.test',sent_at:new Date(now-3600000).toISOString(),snippet:'Here is your exterior cleaning quote.'}];
 window.TK_SUPABASE_CLIENT={from(){const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},maybeSingle:async()=>({data:null}),then(fn){return Promise.resolve({data:[]}).then(fn);}};return q;}};
 showApp();render();switchView('leads');
 });}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({headless:true});const inventory=[];
 try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:width===390?844:900},timezoneId:'Pacific/Auckland',serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(5000);await page.clock.setFixedTime(new Date(fixed));
  await page.addInitScript(()=>{window.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},onChanged:{addListener(){}}},runtime:{getURL:p=>p,onMessage:{addListener(){}}}};});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===base){if(process.env.DESIGN_EXTENSION_ONLY&&phase==='before'&&u.pathname==='/extension/content/panel/panel.css')return route.fulfill({contentType:'text/css',body:require('node:child_process').execFileSync('git',['show','fix/full-audit-2026-11:extension/content/panel/panel.css'],{cwd:root,encoding:'utf8'})});if(u.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={};'});if(u.pathname.startsWith('/api/')){if(u.pathname.includes('/metrics'))return route.fulfill({status:503,json:{error:'Offline fixture'}});return route.fulfill({json:payload});}return route.continue();}if(u.hostname==='fonts.googleapis.com'||u.hostname==='fonts.gstatic.com')return route.continue();if(u.href.includes('fullcalendar@6.1.15'))return route.continue();return route.fulfill({contentType:'text/javascript',body:''});});
  async function capture(name,action){let error=null;try{if(action)await action();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(75);}catch(e){error=e.message;}
   const state=await page.evaluate(()=>({text:(document.querySelector('.overlay.open:last-of-type')||document.querySelector('.view.active')||document.body).innerText,width:document.documentElement.scrollWidth,viewport:innerWidth,stages:typeof records==='undefined'?[]:records.map(r=>[r.id,r.stage]),nav:[...document.querySelectorAll('#bottom-nav button')].map(x=>x.textContent.trim())}));
   const file=`${name}-${width}.png`;await page.screenshot({path:path.join(out,file),fullPage:true,animations:'disabled'});inventory.push({name,width,file,...state,error});
  }
  if(!process.env.DESIGN_EXTENSION_ONLY){
  await page.goto(base);await page.waitForFunction(()=>window.TK_NOVA_LEAD_MANAGER&&window.TK_WORKSPACE);await seed(page);
  await capture('signin',()=>page.evaluate(()=>showAuth()));await page.evaluate(()=>showApp());
  const views=await page.locator('section.view[id]').evaluateAll(els=>els.map(x=>x.id.replace('view-','')));
  for(const view of views)await capture('view-'+view,()=>page.evaluate(v=>v==='detail'?openDetail(3):switchView(v),view));
  await capture('customer-profile',()=>page.evaluate(()=>openCustomerProfile(1)));await page.evaluate(()=>closeModal('customer-overlay'));
  await capture('quote-builder',()=>page.evaluate(()=>openQuoteModal(2)));await page.evaluate(()=>closeModal('quote-overlay'));
  await capture('settings',()=>page.evaluate(()=>openSettings()));await page.evaluate(()=>closeModal('settings-overlay'));
  await capture('connections',()=>page.evaluate(()=>openConnections()));await page.evaluate(()=>closeModal('conn-overlay'));
  await capture('more',()=>page.evaluate(()=>openMoreSheet()));await page.evaluate(()=>closeModal('more-overlay'));
  const overlays=await page.locator('.overlay[id]').evaluateAll(els=>els.map(x=>x.id).filter(id=>id!=='auth-overlay'));
  for(const id of overlays)await capture(id,()=>page.evaluate(id=>{document.querySelectorAll('.overlay.open').forEach(el=>el.classList.remove('open'));openModal(id);},id));
  await page.evaluate(()=>document.querySelectorAll('.overlay.open').forEach(el=>el.classList.remove('open')));
  for(const file of ['booking.html','quote.html','reset-password.html','measure.html','privacy.html','404.html','extension/popup/popup.html']){
   await page.goto(base+'/'+file);if(file==='quote.html')await page.evaluate(()=>{currentQuote={business:{name:'Nova Exterior',phone:'021 555 0100',email:'crew@example.test'},customer:{name:'Aroha Thompson',address:'18 Kowhai Road, Takapuna'},amount:1150,services:[{svc:'housewash',qty:65,price:700},{svc:'driveway',qty:85,price:450}],notes:'House wash and driveway clean.',status:'sent',createdAt:'2026-11-03T02:00:00Z'};renderQuote(currentQuote);});
   await capture(file.replaceAll('/','-').replace('.html',''));
  }
  }
  await page.goto(base+'/404.html');
  await page.evaluate(async base=>{
   document.body.innerHTML='';document.body.style.background='#dfe5e4';
   const host=document.createElement('div');document.body.appendChild(host);const shadow=host.attachShadow({mode:'open'});
   const css=document.createElement('style');css.textContent=await (await fetch(base+'/extension/content/panel/panel.css')).text();shadow.appendChild(css);
   const root=document.createElement('div');root.className='tk-root';shadow.appendChild(root);
   const {mountToolbar}=await import(base+'/extension/content/panel/toolbar.js');
   const measurements=[{id:'a',categoryLabel:'House',service:'housewash',size:65,unit:'m',type:'perimeter',quantities:{area:160,perimeter:65},storeys:2},{id:'b',categoryLabel:'Driveway',service:'driveway',size:85,unit:'m²',type:'area',quantities:{area:85,perimeter:42}}];
   const customer={id:'fixture',name:'Aroha Thompson',email:'aroha@example.test',phone:'021 555 0100',address:'18 Kowhai Road, Takapuna',requestedServices:['House wash','Driveway clean']};
   mountToolbar(root,{onAction(){},onAddressChange(){},onRemoveMeasurement(){}}).update({session:{userId:'fixture'},business:{name:'Nova Exterior'},address:customer.address,boundCustomer:customer,measurements});
   window.designExtension={root,measurements,customer};
  },base);
  await capture('extension-panel');
  await page.evaluate(async base=>{
   await import(base+'/extension/vendor/pricing-engine.js');await import(base+'/extension/vendor/cost-engine.js');
   const {renderQuotePanel}=await import(base+'/extension/content/panel/quote.js');const {root,measurements,customer}=window.designExtension;
   const layer=document.createElement('div');root.appendChild(layer);
   renderQuotePanel(layer,{TK_PRICING:window.TK_PRICING,TK_COST:window.TK_COST,measurements,boundCustomer:customer,address:customer.address,business:{id:'fixture'}},{onClose(){},onCreate(){}});
  },base);
  await capture('extension-instant-quote');
  await capture('extension-quote-costs',()=>page.evaluate(()=>{const body=window.designExtension.root.querySelector('.tk-modal-body');body.scrollTop=body.scrollHeight;}));
  fs.writeFileSync(path.join(out,`runtime-${width}.json`),JSON.stringify(errors,null,2));await context.close();console.log(phase+' screenshots '+width+' complete');
 }
 fs.writeFileSync(path.join(out,process.env.DESIGN_EXTENSION_ONLY?'extension-inventory.json':'inventory.json'),JSON.stringify(inventory,null,2));console.log(`${inventory.length} ${phase} screenshots saved`);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
