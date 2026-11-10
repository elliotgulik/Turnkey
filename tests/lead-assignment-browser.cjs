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
    for (const width of [1440,390]) {
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
      await page.route('**/api/job-calendar/staff',route=>route.fulfill({status:503,json:{error:'Temporary backend outage'}}));
      await page.goto(base);
      await page.waitForFunction(() => window.TK_NOVA_LEAD_MANAGER && window.TK_SALES_PLATFORM);
      await page.evaluate(() => {
        const now = Date.now();
        backendUrl=()=>location.origin;currentBusinessId='test-business';currentUserId='luca';currentUserRole='owner';
        window.TK_CURRENT_SESSION={user:{id:currentUserId,user_metadata:{full_name:'Luca Anderson'}},access_token:'fake-test-token',expires_at:Math.floor(Date.now()/1000)+3600};
        syncRecordToSupabase=async(r)=>{window.lastAssigned=r.assignedSalespersonId;};

        records = ['new','scheduled','won','completed','paid','cancelled','lost'].map((stage,i) => newRecord({
          id:i+1, stage, name:`Customer ${i+1}`, source:'ServiceM8', total:100,
          createdAt:now, address:'18 Kowhai Road, Auckland', wonAt:now, assignedSalespersonId:i===0?'luca':null,
          nextFollowUpAt:new Date(now-86400000).toISOString(),
        }));
        staff=[{id:'luca',business_id:currentBusinessId,name:'Luca Anderson',email:'luca@example.test',role:'owner'},{id:'elliot',business_id:currentBusinessId,name:'Elliot Gulik',role:'owner'}];showApp(); render(); switchView('leads');
      });
      const leads=page.locator('#view-leads');
      assert.match(await leads.locator('h2').innerText(),/Luca’s Leads Dashboard/);
      await leads.locator('.nlm-name').first().click();
      if(width>=1100)await leads.locator('[data-nlm="detail"]').filter({hasText:'Manage lead'}).click();
      const dropdown=leads.locator('[data-sale-assignee="1"]');
      assert.equal(await dropdown.isEnabled(),true);
      assert.match(await dropdown.innerText(),/Luca Anderson/);
      assert.match(await dropdown.innerText(),/Elliot Gulik/);
      await leads.getByRole('combobox',{name:/^Salesperson for Customer 1:/}).click();
      await page.getByRole('option',{name:'Elliot Gulik',exact:true}).click();
      await page.waitForFunction(()=>window.lastAssigned==='elliot');
      assert.equal(await page.evaluate(()=>records[0].salespersonName),'Elliot Gulik');
      await leads.locator('.nlm-close').click();
      await leads.locator('[data-nlm-owner=""]').click();
      assert.equal(await leads.locator('.nlm-new:visible').count(),0);
      assert.deepEqual(errors,[]);
      console.log(`Luca owner assignment works with remote staff unavailable at ${width}px`);
      await context.close();
    }
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
