/* Byte-for-byte assembled index and local modules. All remote SDK, Supabase
 * and backend traffic is intercepted; any email send fails this test. */
const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chromium.executablePath()) ? {} : {executablePath:path.join(require('node:os').homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')}) });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    const drafts = new Map(), loaded = new Set(), errors = [], escapes = []; let sends = 0;
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.assembledFixture = { user: null, opens: [], writes: [], historyRows: [], historyScopes: [], historyAccountScopes: [] };
      window.open = (...args) => { assembledFixture.opens.push(args); return null; };
      window.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session: assembledFixture.user ? { user: { id: assembledFixture.user }, access_token: 'fixture-token' } : null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
        from(table) {
          let value, columns = '', filters = {};
          const q = { select(c) { columns = c; return q; }, eq(k,v) { filters[k]=v;return q; }, neq(){return q;},is(){return q;},order(){return q;},limit(){return q;},
            insert(v){value=v;assembledFixture.writes.push({table,value:v});return q;},update(v){value=v;assembledFixture.writes.push({table,value:v});return q;},upsert(v){value=v;return q;},
            async single(){return {data:table==='quotes'?{id:filters.id||'33333333-3333-4333-8333-333333333333',amount:200,status:'sent',public_token:'quote-token'}:{id:filters.id||'44444444-4444-4444-8444-444444444444'},error:null};},
            async maybeSingle(){if(table==='email_accounts'){assembledFixture.historyAccountScopes.push(filters);return {data:{id:'a'},error:null};}return {data:value?{...value,public_token:'quote-token'}:null,error:null};},
            then(resolve,reject){if(table==='emails')assembledFixture.historyScopes.push(filters);return Promise.resolve({data:table==='emails'?assembledFixture.historyRows.filter(m=>m.business_id===filters.business_id&&m.account_id===filters.account_id):[],error:null}).then(resolve,reject);} };return q;
        }
      }) };
      class PDF { constructor(){this.lines=[];} setFillColor(){} rect(){} roundedRect(){} setFont(){} setFontSize(){} setTextColor(){} setDrawColor(){} setLineWidth(){} line(){} addPage(){} addImage(){} text(v){this.lines.push(v);} splitTextToSize(v){return [v];} output(kind){if(kind!=='datauristring')throw Error('Unexpected download');return 'data:application/pdf;base64,'+btoa(unescape(encodeURIComponent('%PDF-1.7\n'+JSON.stringify(this.lines))));} }
      window.jspdf={jsPDF:PDF};
    });
    await page.route('**/*', async route => {
      const u = new URL(route.request().url()), method = route.request().method();
      if (u.protocol === 'mailto:' || u.hostname === 'mail.google.com') { escapes.push(u.href); return route.abort(); }
      if (u.origin === 'https://assembled.test') {
        const name = u.pathname === '/' ? 'index.html' : u.pathname.slice(1), file = path.resolve(name);
        if (name === 'config.js') return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={supabaseUrl:"https://fixture.invalid",supabaseAnonKey:"fixture-key",backendUrl:"https://backend.test"};'});
        if (!file.startsWith(process.cwd()+path.sep) || !fs.existsSync(file)) return route.fulfill({status:404,body:''});
        loaded.add(name);return route.fulfill({path:file,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
      }
      if (u.origin === 'https://backend.test') {
        const body = route.request().postDataJSON?.() || {}, pathname=u.pathname;
        if (/\/api\/email\/send$|\/api\/conversations\/send$/.test(pathname)) {sends++;return route.fulfill({status:500,json:{error:'Sending disabled in assembled test'}});}
        if (pathname.endsWith('/messages')) return route.fulfill({json:{account:{email_address:'owner@example.com'},messages:await page.evaluate(()=>assembledFixture.historyRows.filter(m=>m.business_id==='fixture-business'&&m.account_id==='a')),stars:[],hasMore:false}});
        if (pathname.endsWith('/quote-attachments')) return route.fulfill({json:{attachments:[]}});
        if (pathname.endsWith('/drafts')) return route.fulfill({json:{drafts:[...drafts.values()]}});
        if (pathname.includes('/drafts/')) {const id=pathname.split('/').pop();if(method==='DELETE'){drafts.delete(id);return route.fulfill({json:{ok:true}});} const draft={id,status:'draft',payload:body};drafts.set(id,draft);return route.fulfill({json:{draft}});}
        return route.fulfill({json:{ok:true,leads:[],connected:false}});
      }
      return route.fulfill({contentType:'text/javascript',body:''});
    });
    await page.goto('https://assembled.test/');
    await page.waitForFunction(() => window.TK_CONVERSATIONS_BRIDGE && window.TK_QUOTE_WORKSPACE && window.TK_SALES_PLATFORM);
    for (const file of ['conversations.js','conversations-bridge.js','conversations.css','sales-platform.js','quote-workspace.js']) assert.ok(loaded.has(file),'Assembled index missing '+file);
    await page.evaluate(() => {
      currentBusinessId='fixture-business'; currentUserId='11111111-1111-4111-8111-111111111111';businessStateReady=true;assembledFixture.user=currentUserId;
      records=[newRecord({id:701,name:'Assembled customer',email:'customer@example.com',address:'1 Test Road',stage:'quoted',total:200,services:[{svc:'driveway',qty:20,customRate:10,fixedPrice:200}],customerId:'22222222-2222-4222-8222-222222222222',jobId:'44444444-4444-4444-8444-444444444444',quoteId:'33333333-3333-4333-8333-333333333333',quotePublicToken:'quote-token'})];
      showApp();switchView('inbox');
    });
    await page.locator('#view-inbox h2').filter({hasText:'Conversations'}).waitFor();
    await page.evaluate(() => {
      assembledFixture.historyRows = [
        {id:'m1',business_id:currentBusinessId,account_id:'a',thread_id:'selected',customer_id:records[0].customerId,direction:'received',from_address:'old-address@example.test',to_addresses:'owner@example.com',subject:'Selected customer',body_text:'Customer question',sent_at:'2026-11-01'},
        {id:'m2',business_id:currentBusinessId,account_id:'a',thread_id:'selected',direction:'sent',from_address:'owner@example.com',to_addresses:'alias@example.test',subject:'Selected reply',body_text:'Thread reply',sent_at:'2026-11-02'},
        {id:'m3',business_id:currentBusinessId,account_id:'a',thread_id:'email-only',direction:'sent',from_address:'owner@example.com',to_addresses:'Customer <customer@example.com>',subject:'Email matched',body_text:'Exact address match',sent_at:'2026-11-03'},
        {id:'other',business_id:currentBusinessId,account_id:'other-user',thread_id:'selected',customer_id:records[0].customerId,body_text:'OTHER_USER'},
        {id:'foreign',business_id:'foreign-business',account_id:'a',thread_id:'selected',customer_id:records[0].customerId,body_text:'FOREIGN_BUSINESS'},
        {id:'unrelated',business_id:currentBusinessId,account_id:'a',thread_id:'unrelated',from_address:'notcustomer@example.com',body_text:'UNRELATED_CUSTOMER'}
      ];
      return TK_CONVERSATIONS_BRIDGE.openCustomerHistory(701);
    });
    const history = page.locator('#cp-conversations');
    await history.getByText(/Recent synced conversations/).waitFor();
    assert.equal(await history.locator('details').count(),3);
    assert.doesNotMatch(await history.textContent(),/OTHER_USER|FOREIGN_BUSINESS|UNRELATED_CUSTOMER/);
    assert.deepEqual(await page.evaluate(()=>assembledFixture.historyAccountScopes.at(-1)),{business_id:'fixture-business',user_id:'11111111-1111-4111-8111-111111111111',provider:'gmail'});
    await history.locator('details').filter({hasText:'Customer question'}).locator('summary').click();
    await history.locator('details').filter({hasText:'Customer question'}).getByRole('button',{name:'Open in Conversations'}).click();
    await page.locator('.cv-thread-heading').getByText('Selected reply').waitFor();
    assert.equal(await page.locator('.cv-message').count(),2);
    // Existing compose path receives the selected record, never sends.
    await page.evaluate(()=>TK_CONVERSATIONS_BRIDGE.openCustomerHistory(701));
    await history.getByRole('button',{name:'Compose email',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.cv-composer [name=to]')?.value==='customer@example.com');
    await page.getByRole('button',{name:'Save & close',exact:true}).click();
    // Real Nova lead panel is loaded after the bridge; exercise its UI.
    await page.evaluate(()=>{records[0].stage='new';switchView('leads');render();});
    await page.locator('[data-nlm="detail"][data-id="701"]').first().click();
    const leadHistory = page.locator('.nlm-record-panel [data-customer-conversations]');
    await leadHistory.locator('summary').click();
    await leadHistory.getByText(/Recent synced conversations/).waitFor();
    assert.equal(await leadHistory.locator('details').count(),3);
    assert.doesNotMatch(await leadHistory.textContent(),/OTHER_USER|FOREIGN_BUSINESS|UNRELATED_CUSTOMER/);
    await page.evaluate(()=>TK_CONVERSATIONS_BRIDGE.reset());
    assert.doesNotMatch(await leadHistory.textContent(),/Customer question|Thread reply/);
    assert.equal(sends,0);assert.deepEqual(escapes,[]);assert.deepEqual(errors,[]);
    console.log('Customer Conversations passed: assembled profile tab, selected customer + exact email/thread history, mailbox ownership, existing inbox thread and compose, Nova lead panel, reset; all traffic intercepted, no sends.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
