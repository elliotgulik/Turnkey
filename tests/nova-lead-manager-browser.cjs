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
      await leads.locator('.nlm-name').first().click();
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
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS production Nova Leads Manager at ${width}px`);
    }
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
