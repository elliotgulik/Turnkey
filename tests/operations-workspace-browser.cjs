/* Offline desktop/mobile workflow tests. Fixtures only; no external requests.
 * Run: node tests/operations-workspace-browser.cjs
 * Uses the actual CRM payment/status/lifecycle implementations where possible.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const crm = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const extract = name => {
  const start = crm.indexOf('function '+name+'(');
  assert.ok(start >= 0,name+' exists');
  return crm.slice(start,crm.indexOf('\n}',start)+2);
};
(async()=>{
  const browser = await playwright.chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1360,height:900},timezoneId:'Pacific/Auckland'});
    const errors = []; page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.abort());
    await page.setContent('<main id="operations"></main><section id="view-detail"></section><div id="payment-overlay"><p id="pay-modal-sub"></p><div id="pay-summary"></div><input id="pay-amount"><input id="pay-date"><select id="pay-method"><option>Cash</option><option>Bank transfer</option></select><input id="pay-notes"><div id="pay-history"></div><button id="confirm-payment" onclick="confirmRecordPayment()">Save payment</button></div><div id="pause-overlay"></div><div id="schedule-overlay"></div><div id="doc-preview-overlay"></div>');
    await page.addStyleTag({path:path.join(__dirname,'../operations-workspace.css')});
    await page.evaluate(()=>{
      window.fixture = {context:{businessId:'a',userId:'owner',version:1,role:'owner',ready:true},staff:[{id:'tech',name:'Crew One'}],calls:[],closed:0, terms:'Bank transfer. Due within 7 days. Account 00-0000.',records:[
        {id:1,jobId:'j1',businessId:'a',customerId:'c1',name:'Alice',address:'1 Test Street',stage:'won',total:400},
        {id:2,jobId:'j2',businessId:'a',customerId:'c2',name:'Bob',stage:'scheduled',total:600,assignedStaffId:'tech',assignedStaffIds:['tech'],scheduledDateISO:'2026-10-19',scheduledStartMin:510},
        {id:3,jobId:'j3',businessId:'a',customerId:'c3',name:'Partial',stage:'completed',total:400,invoiceId:'inv3',paymentStatus:'sent',payments:[{amount:150}],dueDate:'2026-10-01'},
        {id:4,jobId:'j4',businessId:'a',name:'Overdue',stage:'completed',total:500,invoiceId:'inv4',paymentStatus:'sent',dueDate:'2026-10-01'},
        {id:5,jobId:'j5',businessId:'a',name:'Paid',stage:'paid',total:200,invoiceId:'inv5',paymentStatus:'paid',payments:[{amount:200}]},
        {id:6,jobId:'j6',businessId:'a',name:'Sent',stage:'completed',total:300,invoiceId:'inv6',paymentStatus:'sent',dueDate:'2026-11-01'},
        {id:7,jobId:'j7',businessId:'a',name:'Lead only',stage:'new',total:0},
        {id:8,jobId:'j8',businessId:'a',name:'Lost quote',stage:'cancelled',lostAt:100},
        {id:9,jobId:'j9',businessId:'a',name:'Cancelled job',stage:'cancelled',wonAt:100,total:100},
        {id:10,jobId:'j10',businessId:'b',name:'SECRET OTHER BUSINESS',stage:'scheduled',invoiceId:'other',total:1},
        {id:11,jobId:'j11',businessId:'a',name:'Draft',stage:'completed',invoiceId:'draft',paymentStatus:'draft',total:100},
        {id:12,jobId:'j12',businessId:'a',name:'No invoice row',stage:'completed',total:120},
        {id:13,jobId:'j13',businessId:'a',name:'<img src=x onerror="window.xss=true">',stage:'won',total:50}
      ]};
      fixture.records.push({...fixture.records[0],id:99});
      window.records = fixture.records;
      window.todayISO = ()=>'2026-10-18';
      window.render = ()=>{};window.renderAll = ()=>{};window.logStatusChange = (r,s)=>fixture.calls.push(['status',r.id,s]);
      window.openDetail = id=>fixture.calls.push(['openDetail',id]);
      window.triggerPush = ()=>{};window.toast = ()=>{};window.logActivity = ()=>{};
      window.openModal = id=>document.getElementById(id)?.classList.add('open');
      window.staff = fixture.staff; window.currentUserId='owner';
      window.openSchedule = id=>{fixture.calls.push(['openSchedule',id]);openModal('schedule-overlay');};
      window.pendingPauseId = null;
      window.previewInvoice = id=>{fixture.calls.push(['previewInvoice',id]);openModal('doc-preview-overlay');};
      window.openPaymentModal = id=>{fixture.calls.push(['openPaymentModal',id]);openModal('payment-overlay');};
      window.openNewJobModal = id=>fixture.calls.push(['openNewJobModal',id]);
      window.workflowConfig={requirePhotos:false,requireSignoff:false};window.emailAccount=null;
      window.confirm = ()=>false;
      window.money=n=>'$'+n;window.isoToLabel=d=>d;window.renderCustomerProfile=()=>{};window.docPreview={mode:'quote',recordId:null};
      window.pendingPaymentJobId=null;window.closeModal=id=>document.getElementById(id)?.classList.remove('open');
    });
    // Run the CRM's actual lifecycle functions, with side effects stubbed above.
    await page.addScriptTag({content:crm.match(/function paymentsTotal\(r\)\{[^\n]+/)[0]+'\n'+crm.match(/function paymentBalance\(r\)\{[^\n]+/)[0]+'\n'+['invoiceDisplayStatus','startJob','pauseJob','resumeJob','completeJob','openPaymentModal','confirmRecordPayment','recordPayment'].map(extract).join('\n')});
    await page.addScriptTag({path:path.join(__dirname,'../operations-workspace.js')});
    await page.evaluate(()=>{
      window.workspace = TK_OPERATIONS.install({host:'#operations',watchInterval:40,getContext:()=>fixture.context,getRecords:()=>fixture.records,getStaff:()=>fixture.staff,getInvoiceTerms:()=>fixture.terms,recordBusiness:r=>r.businessId,
        actions:{calendar:()=>fixture.calls.push(['calendar'])},closeFlows:()=>{fixture.closed++;document.querySelectorAll('.open').forEach(el=>el.classList.remove('open'));}
      });
    });
    const count = async n=>assert.equal(await page.locator('#operations tbody tr').count(),n);
    await count(10); // won/operational + real cancelled; duplicate excluded
    assert.equal(await page.locator('#operations img').count(),0);
    assert.equal(await page.locator('#operations').innerText().then(t=>t.includes('SECRET')),false);
    assert.equal(await page.locator('[data-row="2"] [data-action="startJob"]').count(),1);
    assert.match(await page.locator('[data-row="2"]').innerText(),/Crew One/);
    assert.match(await page.locator('[data-row="2"]').innerText(),/08:30/);
    await page.selectOption('[data-control="customer"]','c1');
    await page.click('[data-action="openNewJobModal"]');
    assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1)),['openNewJobModal','c1']);
    await page.click('[data-row="1"] [data-action="openSchedule"]');
    assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1)),['openSchedule',1]);
    await page.fill('[data-control="search"]','bob'); await count(1);
    await page.selectOption('[data-control="layout"]','board');
    assert.equal(await page.locator('.tko-board article').count(),1);
    await page.click('[data-row="2"] [data-action="startJob"]');
    assert.equal(await page.evaluate(()=>fixture.records[1].jobStatus),'in_progress');
    await page.click('[data-action="pauseJob"]');
    assert.equal(await page.evaluate(()=>pendingPauseId),2); // existing reason dialog, no fabricated pause
    await page.evaluate(()=>{fixture.records[1].jobStatus='paused';workspace.refresh();});
    await page.click('[data-action="resumeJob"]');
    assert.equal(await page.evaluate(()=>fixture.records[1].jobStatus),'in_progress');
    await page.click('[data-action="completeJob"]'); // confirmation cancelled
    assert.equal(await page.evaluate(()=>fixture.records[1].stage),'scheduled');
    await page.evaluate(()=>{fixture.records[1].skipChecklist=true;window.confirm=()=>true;window.fmtDur=n=>n+' min';});
    await page.click('[data-action="completeJob"]');
    assert.equal(await page.evaluate(()=>fixture.records[1].stage),'completed');
    assert.equal(await page.evaluate(()=>fixture.records[1].total),600);
    await page.click('[data-view="invoices"]'); await count(5);
    await page.selectOption('[data-control="filter"]','partial');await count(1);
    assert.match(await page.locator('[data-row="3"]').innerText(),/Balance: \$250/);
    await page.click('[data-row="3"] [data-action="openPaymentModal"]');
    await page.fill('#pay-amount','25');await page.selectOption('#pay-method','Bank transfer');await page.fill('#pay-notes','Deposit verified');
    await page.click('#confirm-payment');
    assert.equal(await page.evaluate(()=>fixture.records[2].payments.at(-1).amount),25);
    assert.equal(await page.evaluate(()=>fixture.records[2].total),400);
    await page.getByText('Balance: $225',{exact:true}).waitFor();
    await page.click('[data-row="3"] [data-action="openPaymentModal"]');
    assert.equal(await page.locator('#payment-overlay').evaluate(el=>el.classList.contains('open')),true);
    await page.click('[data-row="3"] [data-action="previewInvoice"]');
    assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1)),['previewInvoice',3]);
    for (const [filter,n] of [['sent',1],['unpaid',4],['overdue',1],['paid',1],['draft',1]]) {
      await page.selectOption('[data-control="filter"]',filter);await count(n);
    }
    assert.equal(await page.locator('[data-action="openPaymentModal"]').count(),1); // draft ledger supported
    if(process.env.TURNKEY_OPERATIONS_SCREENSHOTS) await page.locator('#operations').screenshot({path:path.join(process.env.TURNKEY_OPERATIONS_SCREENSHOTS,'operations-desktop.png')});
    await page.click('summary'); assert.match(await page.locator('.tko-terms').innerText(),/00-0000/);
    await page.selectOption('[data-control="filter"]','paid');
    assert.equal(await page.locator('[data-action="openPaymentModal"]').count(),0);
    // Mobile controls, readable cards, no document-wide overflow.
    await page.setViewportSize({width:390,height:844});
    await page.click('[data-view="jobs"]');
    await page.selectOption('[data-control="layout"]','table');
    await page.fill('[data-control="search"]','Alice');await count(1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    if(process.env.TURNKEY_OPERATIONS_SCREENSHOTS) await page.locator('#operations').screenshot({path:path.join(process.env.TURNKEY_OPERATIONS_SCREENSHOTS,'operations-mobile.png')});
    await page.click('[data-row="1"] [data-action="openDetail"]');
    assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1)),['openDetail',1]);
    // Role change resets UI/flows. Only the assigned technician job remains.
    await page.evaluate(()=>{fixture.context.role='technician';fixture.context.userId='tech';workspace.refresh();});
    await count(1);
    assert.equal(await page.locator('[data-view="invoices"]').count(),0);
    assert.equal(await page.locator('[data-action="openSchedule"]').count(),0);
    assert.equal(await page.locator('[data-action="openNewJobModal"]').count(),0);
    assert.ok(await page.evaluate(()=>fixture.closed)>0);
    // Reused local id across businesses must never dispatch a stale click.
    await page.evaluate(()=>{fixture.context={businessId:'a',userId:'owner',version:2,role:'owner',ready:true};workspace.refresh();});
    const callsBefore = await page.evaluate(()=>fixture.calls.length);
    await page.evaluate(()=>{
      const stale=document.querySelector('[data-row="1"] [data-action="openDetail"]');
      fixture.context={businessId:'b',userId:'owner-b',version:3,role:'owner',ready:true};
      fixture.records=[{id:1,jobId:'b1',businessId:'b',name:'Business B',stage:'won',total:5}];
      stale.click();
    });
    assert.equal(await page.evaluate(()=>fixture.calls.length),callsBefore);
    assert.match(await page.locator('#operations').innerText(),/Business B/);
    assert.doesNotMatch(await page.locator('#operations').innerText(),/Alice|Partial/);
    // Session watchdog clears an opened native flow on logout without parent refresh.
    await page.click('[data-row="1"] [data-action="openSchedule"]');
    await page.evaluate(()=>{fixture.context.ready=false;fixture.context.userId=null;fixture.context.businessId=null;});
    await page.getByText('Sign in and load your business').waitFor();
    assert.equal(await page.locator('.open').count(),0);
    // Unavailable machinery never yields buttons that do nothing.
    await page.evaluate(()=>{
      workspace.destroy();
      fixture.context={businessId:'b',userId:'owner-b',version:4,role:'manager',ready:true};
      workspace=TK_OPERATIONS.install({host:'#operations',getContext:()=>fixture.context,getRecords:()=>fixture.records,recordBusiness:r=>r.businessId,actions:{openSchedule:null,openDetail:()=>{throw Error('Existing flow failed');},startJob:null,openNewJobModal:null,calendar:null}});
    });
    assert.equal(await page.locator('[data-action="openSchedule"]').count(),0);
    await page.click('[data-action="openDetail"]');
    assert.match(await page.locator('[role="status"]').innerText(),/Existing flow failed/);
    await page.evaluate(()=>workspace.destroy());
    assert.equal(await page.locator('#operations').innerText(),'');
    // Default adapter reads the CRM's lexical globals, not window properties.
    await page.addScriptTag({content:`
      let currentBusinessId='b', currentUserRole='owner', businessStateReady=true, businessSessionVersion=8;
      let recordBusinesses=new WeakMap(fixture.records.map(r=>[r,'b']));
      let docTemplate={invoiceTerms:'Existing native terms'};
    `});
    await page.evaluate(()=>{
      currentUserId='native-owner';window.records=fixture.records;
      workspace=TK_OPERATIONS.install({host:'#operations',watchInterval:40});
    });
    await count(1);
    await page.click('[data-action="openSchedule"]');
    await page.evaluate(()=>{
      pendingPaymentJobId=1;pendingPauseId=1;docPreview={mode:'invoice',recordId:1};
      document.getElementById('pay-summary').textContent='PRIVATE PAYMENT';
      document.getElementById('view-detail').textContent='PRIVATE RECORD';
      businessSessionVersion++;currentBusinessId=null;businessStateReady=false;currentUserId=null;
    });
    await page.getByText('Sign in and load your business').waitFor();
    assert.equal(await page.locator('.open').count(),0);
    assert.equal(await page.locator('#pay-summary').innerText(),'');
    assert.equal(await page.locator('#view-detail').innerText(),'');
    assert.deepEqual(await page.evaluate(()=>[pendingPaymentJobId,pendingPauseId,docPreview.recordId]),[null,null,null]);
    await page.evaluate(()=>workspace.destroy());
    assert.deepEqual(errors,[]);
    console.log('Operations desktop/mobile, lifecycle, invoice ledger, roles, tenant switch and logout passed');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
