/* Byte-for-byte assembled index and local modules. All remote SDK, Supabase
 * and backend traffic is intercepted; any email send fails this test. */
const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    const drafts = new Map(), loaded = new Set(), errors = [], escapes = []; let sends = 0;
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.assembledFixture = { user: null, opens: [], writes: [] };
      window.open = (...args) => { assembledFixture.opens.push(args); return null; };
      window.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session: assembledFixture.user ? { user: { id: assembledFixture.user }, access_token: 'fixture-token' } : null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
        from(table) {
          let value, columns = '', filters = {};
          const q = { select(c) { columns = c; return q; }, eq(k,v) { filters[k]=v;return q; }, neq(){return q;},is(){return q;},order(){return q;},limit(){return q;},
            insert(v){value=v;assembledFixture.writes.push({table,value:v});return q;},update(v){value=v;assembledFixture.writes.push({table,value:v});return q;},upsert(v){value=v;return q;},
            async single(){return {data:table==='quotes'?{id:filters.id||'33333333-3333-4333-8333-333333333333',amount:200,status:'sent',public_token:'quote-token'}:{id:filters.id||'44444444-4444-4444-8444-444444444444'},error:null};},
            async maybeSingle(){return {data:value?{...value,public_token:'quote-token'}:null,error:null};},
            then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject);} };return q;
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
        if (pathname.endsWith('/messages')) return route.fulfill({json:{account:{email_address:'owner@example.com'},messages:[],stars:[],hasMore:false}});
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
    await page.evaluate(() => generateAndSendDoc('quote',records[0]));
    await page.locator('.cv-files li').waitFor();
    assert.ok([...drafts.values()].some(d=>d.payload.attachments[0]?.contentBase64));
    await page.getByRole('button',{name:'Save & close',exact:true}).click();
    await page.getByRole('button',{name:/^Drafts/}).click();
    await page.locator('[data-cv-action=draft]').first().click();
    assert.equal(await page.locator('.cv-files li').count(),1);
    // Real legacy contact UI creates mailto anchors. Assert both dynamically
    // rendered and newly inserted mail/Gmail links lose external destinations.
    await page.evaluate(() => {
      const host=document.createElement('div');host.id='mail-entry-test';host.innerHTML='<a href="mailto:contact@example.com?subject=Follow%20up&body=Hello" target="_blank">Contact email</a><a href="https://mail.google.com/mail/?view=cm&to=gmail@example.com&su=Inside" target="_blank">Gmail link</a>';document.body.append(host);
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#mail-entry-test a')].every(a=>a.getAttribute('href')==='#'));
    await page.locator('#mail-entry-test a').first().click();
    await page.waitForFunction(() => document.querySelector('.cv-composer [name=to]')?.value==='contact@example.com');
    assert.equal(await page.locator('.cv-composer [name=subject]').inputValue(),'Follow up');
    await page.locator('#mail-entry-test a').nth(1).click({button:'middle'});
    await page.waitForFunction(() => document.querySelector('.cv-composer [name=to]')?.value==='gmail@example.com');
    assert.equal(await page.locator('a[href^="mailto:"], a[href*="mail.google.com"]').count(),0);
    assert.equal(await page.evaluate(() => assembledFixture.opens.length),0);assert.equal(sends,0);assert.deepEqual(escapes,[]);assert.equal(context.pages().length,1);
    assert.deepEqual(errors,[]);
    console.log('Assembled Conversations passed: real index/module order, real quote PDF helper/save path, PDF draft restore, captured mailto/Gmail links, no external mail navigation or email sends.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
