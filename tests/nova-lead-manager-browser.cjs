/* Production index with Nova loaded: status scopes on desktop and mobile. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.setHeader('Content-Type', { '.js':'text/javascript', '.css':'text/css', '.html':'text/html' }[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    });
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const cached = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    browser = await chromium.launch({ headless:true, ...(fs.existsSync(chromium.executablePath()) ? {} : { executablePath:cached }) });
    for (const width of [1440,390,360]) {
      const context = await browser.newContext({ viewport:{width,height:980}, serviceWorkers:'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [], loaded = new Set();
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.ok() && r.url().startsWith(base)) loaded.add(new URL(r.url()).pathname); });
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(base) && new URL(url).pathname !== '/config.js') return route.continue();
        return route.fulfill({ contentType:'text/javascript', body:url.startsWith(base) ? 'window.TURNKEY_CONFIG={};' : '' });
      });
      await page.route('**/api/job-calendar/staff',route=>route.fulfill({json:{staff:[{id:'servicem8:elliot',name:'Elliot Gulik',source:'servicem8',readOnly:true},{id:'servicem8:luca',name:'Luca Anderson',source:'servicem8',readOnly:true}]}}));
      await page.goto(base);
      await page.waitForFunction(() => window.TK_NOVA_LEAD_MANAGER && window.TK_SALES_PLATFORM);
      await page.evaluate(() => {
        const now = Date.now();
        backendUrl=()=>location.origin;currentBusinessId='test-business';currentUserId='test-owner';currentUserRole='owner';
        window.TK_CURRENT_SESSION={user:{id:currentUserId},access_token:'fake-test-token',expires_at:Math.floor(Date.now()/1000)+3600};
        syncRecordToSupabase=async(r)=>{window.lastAssigned=r.assignedSalespersonId;};

        records = ['new','scheduled','won','completed','paid','cancelled','lost'].map((stage,i) => newRecord({
          id:i+1, stage, name:`Customer ${i+1}`, source:'ServiceM8', total:100,
          createdAt:now, address:'18 Kowhai Road, Auckland', wonAt:now,
          nextFollowUpAt:new Date(now-86400000).toISOString(),
        }));
        showApp(); render(); switchView('leads');
      });
      assert(loaded.has('/nova-lead-manager.js'));
      assert(loaded.has('/nova-lead-manager.css'));
      const leads = page.locator('#view-leads');
      const ids = () => leads.locator('[data-nlm-record]').evaluateAll(els => els.map(el => Number(el.dataset.nlmRecord)));
      const scope = key => leads.locator(`[data-nlm-scope="${key}"]`);
      assert.match(await leads.locator('h2').innerText(), /^Lead Manager\s+1$/);
      assert.deepEqual(await ids(), [1]);
      assert.equal(await leads.locator('.nlm-new:visible').count(),1);
      await leads.locator('.nlm-name').first().click();
      assert.equal(await leads.locator('.nlm-new:visible').count(),0);
      assert.equal(await page.evaluate(()=>TK_NOVA_LEAD_MANAGER.pendingLeads().length),0);
      await page.waitForFunction(()=>!document.querySelector('#view-leads [data-sale-assignee="1"]').disabled);
      const assignee=leads.locator('[data-sale-assignee="1"]');
      assert.match(await assignee.innerText(),/Elliot Gulik/);
      await assignee.selectOption('servicem8:luca');
      await page.waitForFunction(()=>records[0].salespersonName==='Luca Anderson'&&window.lastAssigned==='servicem8:luca');
      assert.equal(await page.evaluate(()=>records[0].stage),'new');
      await page.evaluate(()=>{records[0].nextFollowUpAt=new Date(Date.now()-3600000).toISOString();});
      await leads.locator('.nlm-close').click();
      await leads.locator('.nlm-tools summary').click();
      await leads.locator('[data-sale-action="followups"]').click();
      assert.match(await page.locator('#sales-dialog').innerText(),/Customer 1/);
      await page.locator('#sales-dialog [data-sale-action="followup-tomorrow"]').click();
      await page.waitForFunction(()=>Date.parse(records[0].nextFollowUpAt)>Date.now());
      await page.locator('#sales-dialog [data-sale-action="followup-scope"][data-id="all"]').click();
      await page.locator('#sales-dialog [data-sale-action="followup-done"]').click();
      await page.waitForFunction(()=>records[0].nextFollowUpAt===null);
      assert.equal(await page.evaluate(()=>records[0].stage),'new');
      await page.locator('#sales-dialog [data-sale-action="dialog-close"]').click();
      await page.evaluate(()=>{
        records[0].customerId=records[1].customerId='shared-customer';
        window.TK_SUPABASE_CLIENT={from(table){if(table!=='customers')throw Error('Unexpected preference table');let values;return {update(v){values=v;return this;},eq(){return this;},select(){return this;},single:async()=>({data:{id:'shared-customer',...values},error:null})};}};
      });
      await leads.locator('.nlm-name').first().click();
      await leads.locator('[data-customer-followups="1"]').check();
      await page.waitForFunction(()=>records[0].followupsDisabled===true&&records[1].followupsDisabled===true);
      assert.equal(await page.evaluate(()=>TK_SALES_PLATFORM.followupRows('all').some(r=>r.id===1)),false);
      await leads.locator('[data-customer-followups="1"]').uncheck();
      await page.waitForFunction(()=>records[0].followupsDisabled===false&&records[1].followupsDisabled===false);
      await leads.locator('.nlm-close').click();



      await leads.locator('.nlm-name').first().click();
      await leads.getByRole('button',{name:'Mark as unread',exact:true}).click();
      assert.equal(await leads.locator('.nlm-new:visible').count(),1);
      await leads.locator('.nlm-close').click();
      assert.equal(await page.locator('#cnt-leads').innerText(),'1');
      await page.locator(width>760?'#lead-alert-button':'#view-leads [data-nlm="notifications"]').click();
      assert.match(await page.locator('#lead-alert-list').innerText(),/Customer 1/);
      await page.locator('#lead-alert-list [data-nlm="alert"]').click();
      assert.notEqual(await page.locator('#cnt-leads').getAttribute('hidden'),null);
      assert.equal(await leads.locator('.nlm-detail').count(),1);
      await leads.locator('.nlm-close').click();
      await page.locator('#view-leads [data-nlm="notifications"]').click();
      assert.match(await page.locator('#lead-alert-list .read').innerText(),/Read/);
      await page.locator('#lead-alert-overlay .x').click();
      assert.equal(await page.evaluate(()=>records[0].stage),'new');
      for(const key of ['open','all'])assert.equal(await scope(key).locator('span').innerText(),'1');
      await scope('all').click();assert.deepEqual(await ids(),[1]);
      await page.evaluate(()=>{records[0].stage='contacted';render();});
      assert.deepEqual(await ids(),[]);
      await page.evaluate(()=>{switchView('pipeline');});
      assert.equal(await page.locator('#view-pipeline .sale-card[data-record="1"]').count(),1);
      await page.evaluate(()=>{records[0].stage='new';render();switchView('leads');});
      assert.deepEqual(await ids(),[1]);
      await page.evaluate(() => switchView('pipeline'));
      assert.equal(await page.locator('#view-pipeline h2').innerText(), 'Sales pipeline');
      assert.equal(await page.locator('#view-pipeline #pipeline-new').count(),0);
      assert.equal(await page.locator('#view-pipeline #pipeline-completed').count(),0);
      assert.equal(await page.locator('#view-pipeline #pipeline-lost').count(),0);
      await page.locator('.sale-past-jobs summary').click();
      await page.locator('.sale-past-menu [data-id="completed"]').click();
      assert.equal(await page.locator('#pipeline-completed .sale-card').count(),2);
      await page.locator('#view-pipeline [data-sale-action="pipeline-scope"][data-id="all"]').click();
      assert.equal(await page.locator('#pipeline-completed').count(),0);
      assert.equal(await page.locator('#view-pipeline .sale-card[data-record="1"]').count(),0);
      await page.evaluate(() => switchView('sales'));
      assert.equal(await page.locator('#view-sales h2').innerText(), 'Analytics');
      await page.evaluate(() => {
        records[1].notes='list_cleaning_services_below_(house,_roof,_windows): House windows and garage outside, 2 levels';
        records[1].serviceM8Pricing={items:[{name:'ServiceM8 house wash',quantity:1,unitPrice:300,lineTotal:300},{name:'Windows',quantity:2,unitPrice:50,lineTotal:100}],total:460,currency:'NZD',taxLabel:'As reported by ServiceM8',lineTaxLabel:'Line prices exclude tax'};
        render();switchView('pipeline');
      });
      const linkedCard=page.locator('#view-pipeline .sale-card[data-record="2"]');
      assert.match(await linkedCard.innerText(),/House windows and garage outside, 2 levels/);
      assert.equal(await linkedCard.locator('details.tk-sm8-pricing').getAttribute('open'),null);
      await linkedCard.locator('.tk-sm8-pricing summary').click();
      assert.match(await linkedCard.innerText(),/ServiceM8 house wash/);
      assert.match(await linkedCard.innerText(),/\$460\.0/);
      assert.match(await linkedCard.innerText(),/\$100\.0/);
      assert.equal(await page.evaluate(() => records[1].total),100);
      // Unknown currency creates long price labels; names must keep usable width.
      await page.evaluate(() => {
        records[1].serviceM8Pricing.currency=null;
        records[1].serviceM8Pricing.items[0].name='Window cleaning on exterior only';
        render();switchView('pipeline');
      });
      const pipelineCard=page.locator('#view-pipeline .sale-card[data-record="2"]');
      await pipelineCard.locator('.tk-sm8-pricing summary').click();
      const sizing=await pipelineCard.locator('.tk-sm8-pricing li>div').first().evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,overflow:el.scrollWidth>el.clientWidth+1}));

      assert(sizing.width>=120,`Service name collapsed to ${sizing.width}px at viewport ${width}`);
      assert(sizing.height<180,`Service name stacked vertically (${sizing.height}px)`);
      assert.equal(sizing.overflow,false);
      const priceBox=await pipelineCard.locator('.tk-sm8-pricing').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
      assert(priceBox.scroll<=priceBox.width+1,'Pricing must fit inside the card');
      // Urgency uses Wix timing answers, configured zones and known geography only.
      const grades=await page.evaluate(()=>{
        const m=TK_NOVA_LEAD_MANAGER;
        const base={source:'Wix',urgency:'As soon as possible',services:['House wash']};
        const results=[
          m.grade({...base,address:'Takapuna, Auckland'}).grade,
          m.grade({...base,address:'Manurewa, South Auckland'}).grade,
          m.grade({...base,address:'Manurewa, South Auckland',services:['House wash','Windows']}).grade,
          m.grade({...base,address:'Unconfirmed Road, Auckland',suburb:'Unconfirmed'}).grade,
          m.grade({...base,address:'Northshore, Auckland'}).grade,
          m.grade({...base,address:'Central Auckland'}).grade,
          m.grade({...base,urgency:'',notes:'Preferred timing: ASAP',address:'Takapuna, Auckland'}).grade,
          m.grade({...base,address:'NotTakapuna, Manurewa'}).grade,
        ];
        m.setConfig({suburbs:['Manurewa'],postcodes:[]});
        results.push(m.grade({...base,address:'Manurewa, South Auckland'}).grade);
        m.setConfig({suburbs:['Takapuna'],postcodes:[]});
        return results;
      });
      assert.deepEqual(grades,['A','C','A','A','A','A','A','C','A']);
      // Existing read markers survive beyond 72 hours; NEW does not expire.
      await page.evaluate(()=>{
        switchView('leads');TK_NOVA_LEAD_MANAGER.reset();
        records=[newRecord({id:51,stage:'new',name:'Old unread',createdAt:Date.now()-4*86400000}),
          newRecord({id:52,stage:'new',name:'Fresh read',createdAt:Date.now()-1000})];
        const oldRead={};oldRead['52:'+records[1].createdAt]=Date.now()-4*86400000;
        localStorage.setItem('turnkey-lead-alerts-read:test-business:test-owner',JSON.stringify(oldRead));
        render();
      });
      await scope('all').click();
      assert.equal(await leads.locator('[data-nlm-record="51"] .nlm-new:visible').count(),1);
      assert.equal(await leads.locator('[data-nlm-record="52"] .nlm-new:visible').count(),0);
      assert.equal(await page.evaluate(()=>TK_NOVA_LEAD_MANAGER.pendingLeads().length),0);
      await leads.locator('[data-nlm-record="51"] .nlm-name').click();
      await leads.locator('.nlm-close').click();
      await page.evaluate(()=>{render();});
      assert.equal(await leads.locator('.nlm-new:visible').count(),0);
      await leads.locator('[data-nlm-record="51"] .nlm-name').click();
      await leads.getByRole('button',{name:'Mark as unread',exact:true}).click();
      assert.equal(await page.evaluate(()=>TK_NOVA_LEAD_MANAGER.pendingLeads().length),0);
      await leads.locator('.nlm-close').click();
      await page.evaluate(()=>{
        currentUserId='another-user';render();
      });
      assert.equal(await leads.locator('.nlm-new:visible').count(),2);
      await page.evaluate(()=>{currentUserId='test-owner';currentBusinessId='another-business';render();});
      assert.equal(await leads.locator('.nlm-new:visible').count(),2);
      await page.evaluate(()=>{currentBusinessId='test-business';render();});
      assert.equal(await leads.locator('.nlm-new:visible').count(),1);
      // Every row interaction, including a direct quote action, acknowledges the lead.
      await page.evaluate(()=>{TK_EARTH_QUOTES.open=()=>{};records[0].address='Takapuna';});
      await leads.locator('[data-nlm-record="51"] [data-nlm="earth"]').click();
      assert.equal(await leads.locator('.nlm-new:visible').count(),0);
      if(width<760){
        const nav=page.locator('#bottom-nav');
        assert.deepEqual(await nav.locator('button').evaluateAll(els=>els.map(el=>el.getAttribute('aria-label'))),['Leads','Pipeline','Calendar','Inbox','More']);
        assert.equal(await nav.getAttribute('aria-label'),'Main navigation');
        for(const view of ['pipeline','calendar','inbox','leads']){
          await nav.locator(`[data-view="${view}"]`).click();
          assert.equal(await page.locator('#view-'+view).evaluate(el=>el.classList.contains('active')),true);
          assert.equal(await nav.locator(`[data-view="${view}"]`).getAttribute('aria-current'),'page');
        }
        for(const button of await nav.locator('button').all()){
          const box=await button.boundingBox();assert(box.width>=44&&box.height>=44);
          assert.equal(await button.locator('svg').count(),1);
        }
        await nav.getByRole('button',{name:'More',exact:true}).click();
        assert.match(await page.locator('#more-body').innerText(),/Analytics/);
        await page.locator('#more-overlay .x').click();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      }
      // Arrival expiry is independent of persistent NEW and read markers.
      await page.evaluate(()=>{
        records[0].createdAt=Date.now()-1000;TK_NOVA_LEAD_MANAGER.setRead(records[0],false);
        render();
      });
      assert.equal(await page.evaluate(()=>TK_NOVA_LEAD_MANAGER.pendingLeads().length),1);
      assert.equal(await page.evaluate(()=>TK_NOVA_LEAD_MANAGER.pendingLeads(Date.now()+3*86400000).length),0);
      assert.equal(await leads.locator('[data-nlm-record="51"] .nlm-new:visible').count(),1);
      const savedRecords=await page.evaluate(()=>records);
      await page.screenshot({path:path.join(os.tmpdir(),`turnkey-nova-${width}.png`),fullPage:true});
      await page.reload();
      await page.waitForFunction(()=>window.TK_NOVA_LEAD_MANAGER);
      await page.evaluate(saved=>{
        currentBusinessId='test-business';currentUserId='test-owner';currentUserRole='owner';records=saved;
        showApp();render();switchView('leads');
      },savedRecords);
      await scope('all').click();
      assert.equal(await leads.locator('[data-nlm-record="51"] .nlm-new:visible').count(),1);
      assert.equal(await leads.locator('[data-nlm-record="52"] .nlm-new:visible').count(),0);
      // End-to-end intake -> saved record -> drawer, full detail and profile.
      await page.evaluate(()=>{
        ensureRecordSynced=async()=>{};logActivity=()=>{};sendLifecycleEmail=()=>{};notifyOwner=()=>{};
        ingestQuoteRequest({source:'wix',external_id:'wix-form-fixture',historicalImport:true,submittedAt:Date.now(),customer:{name:'Wix Form Fixture',email:'fixture@example.test',address:'7 Fixture Road, Grey Lynn, Auckland 1021, New Zealand',notes:'Please wash the house and inspect the roof.'},requestedServices:['House Clean','Roof Treatment'],formAnswers:[{label:'Select Services',answer:'House Clean, Roof Treatment'},{label:'Select an Address',answer:'7 Fixture Road, Grey Lynn, Auckland 1021, New Zealand'},{label:'Message',answer:'Please wash the house and inspect the roof.'},{label:'Cleaning Frequency',answer:'Every 4 Months'},{label:'I agree to the',answer:'Checked'}]});
        const r=records.find(r=>r.externalId==='wix-form-fixture');r.customerId='fixture-customer';
        window.wixFixtureId=r.id;
        if(r.formAnswers.length!==5)throw Error('Form answers dropped at intake');
        if(getRequestedServices(r).map(x=>x.name).join(',')!=='House Clean,Roof Treatment')throw Error('Selected services replaced by prose');
        switchView('leads');
      });
      await leads.getByRole('button',{name:'Wix Form Fixture',exact:true}).click();
      assert.match(await leads.locator('.nlm-detail').innerText(),/Every 4 Months/);
      assert.match(await leads.locator('.nlm-detail').innerText(),/Checked/);
      await leads.locator('.nlm-close').click();
      await page.evaluate(()=>openDetail(window.wixFixtureId));
      assert.match(await page.locator('#view-detail .tk-form-submission').innerText(),/Grey Lynn/);
      assert.match(await page.locator('#view-detail .tk-form-submission').innerText(),/Every 4 Months/);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS production Nova Leads Manager at ${width}px`);
    }
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
