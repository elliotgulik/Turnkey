/* Real Conversations UI/bridge and the repo's actual buildDocPDF function.
 * Only Supabase/HTTP and the jsPDF SDK boundary are test doubles. No emails. */
const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      if (route.request().url() === 'https://conversations.test/') return route.fulfill({ contentType: 'text/html', body: '<main id="view-inbox" class="view active"></main><span id="cnt-inbox"></span>' });
      return route.abort();
    });
    await page.goto('https://conversations.test/');
    await page.addScriptTag({ path: path.resolve('pricing-engine.js') });
    await page.addScriptTag({ path: path.resolve('format-utils.js') });
    await page.addStyleTag({ path: path.resolve('conversations.css') });
    await page.addScriptTag({ content: `
      let currentBusinessId='A', currentUserId='11111111-1111-4111-8111-111111111111', businessStateReady=true;
      let sb={auth:{getSession:async()=>({data:{session:{user:{id:currentUserId},access_token:'fake-token'}}})}};
      let records=[{id:1,business_id:'A',name:'Alice',email:'alice@example.com',phone:'021123',address:'1 Test Street',suburb:'Test',total:200,stage:'new',services:[{svc:'driveway',qty:20,customRate:10,internalCost:77}],estimatedCost:99,margin:0.3,salesNotes:'PRIVATE_SALES_NOTES'},
        {id:2,business_id:'A',name:'Bob',email:'bob@example.com',address:'2 Test Street',total:300,stage:'quoted',services:[{svc:'driveway',qty:30,customRate:10}]},
        {id:3,business_id:'B',name:'FOREIGN_CUSTOMER',total:400,services:[{svc:'driveway',qty:40}]}];
      let docTemplate={business:'Fixture Wash',phone:'021456',email:'owner@example.com',accent:'#138a72',quoteTerms:'Customer quote terms',invoiceTerms:'Payment due in 7 days',footer:'Thank you'};
      let cachedLogoDataUrl=null, SERVICES=TK_PRICING.SERVICES, ROOF_TYPES=TK_PRICING.ROOF_TYPES, STOREY_TYPES=TK_PRICING.STOREY_TYPES,FENCE_SIDES=TK_PRICING.FENCE_SIDES;
      let docPreview={recordId:1}, sendDocCtx={mode:'quote',recordId:1}, inboxThreads=[],inboxOpenThread=null;
      window.bridgeFixture={drafts:new Map(),calls:[],pdfInputs:[],notices:[],opens:0,downloads:0,sends:0,activities:[],syncs:[],sendMode:'reject'};
      function backendUrl(){return 'https://backend.test'}
      function docBizName(){return docTemplate.business}
      function money(n){return '$'+Number(n).toFixed(2)}
      function toast(t){bridgeFixture.notices.push(t)}
      function switchView(v){if(v!=='inbox')throw Error('Unexpected view');renderInbox()}
      function showAuth(){} function handleAuthedSession(){} function openConnections(){}
      function closeModal(){} function closeDocPreview(){} function render(){} function renderAll(){}
      function defaultFollows(){return [{dayOffset:0,state:'pending'}]}
      function todayISO(){return '2026-10-16'} function addDaysISO(){return '2026-10-23'}
      function logActivity(...args){bridgeFixture.activities.push(args)}
      async function syncRecordToSupabase(r){bridgeFixture.syncs.push(r.id); if(bridgeFixture.pauseSync)await new Promise(resolve=>bridgeFixture.resumeSync=resolve);r.quotePublicToken='quote-token-'+r.id;}
      async function ensureRecordSynced(r){return syncRecordToSupabase(r)}
      async function preloadMapSnapshot(r){r._mapSnapshotDataUrl=null}
      function triggerPush(){throw Error('Unexpected notification')}
      function downloadBlob(){bridgeFixture.downloads++;throw Error('Unexpected download')}
      window.open=()=>{bridgeFixture.opens++;throw Error('Unexpected popup')};
      window.TK_SALES_PLATFORM={reset(){bridgeFixture.salesReset=true}};
      window.TK_QUOTE_WORKSPACE={};
      class FixturePDF {
        constructor(){this.lines=[]}
        setFillColor(){} rect(){} roundedRect(){} setFont(){} setFontSize(){} setTextColor(){} setDrawColor(){} setLineWidth(){} line(){} addPage(){} addImage(){}
        text(value){this.lines.push(value)} splitTextToSize(value){return [value]}
        output(kind){const data='%PDF-1.7\\n'+JSON.stringify(this.lines);if(kind!=='datauristring')throw Error('Expected base64 output contract');return 'data:application/pdf;base64,'+btoa(data)}
      }
      window.jspdf={jsPDF:FixturePDF};
      window.fetch=async(url,options={})=>{
        const body=options.body?JSON.parse(options.body):{};bridgeFixture.calls.push({url,method:options.method,body});
        if(options.headers.Authorization!=='Bearer fake-token')throw Error('Missing bearer token');
        const result=(data,ok=true)=>({ok,json:async()=>data});
        if(url.endsWith('/messages'))return result({account:{email_address:'owner@example.com'},stars:[],hasMore:false,messages:[{id:'22222222-2222-4222-8222-222222222222',account_id:'acct',thread_id:'thread-1',direction:'received',from_address:'Alice <alice@example.com>',to_addresses:'owner@example.com',subject:'Question',body_text:'Can you send a quote?',sent_at:'2026-10-15'}]});
        if(url.endsWith('/quote-attachments'))return bridgeFixture.uploadFailure ? result({error:'Uploaded attachment store unavailable'},false) : result({attachments:[]});
        if(url.endsWith('/drafts'))return result({drafts:[...bridgeFixture.drafts.values()].filter(d=>d.status!=='sent')});
        if(url.includes('/drafts/')){
          const id=url.split('/').pop();
          if(options.method==='DELETE'){bridgeFixture.drafts.delete(id);return result({ok:true})}
          const draft={id,status:'draft',payload:body};bridgeFixture.drafts.set(id,draft);return result({draft});
        }
        if(url.endsWith('/send')){
          bridgeFixture.sends++;
          if(bridgeFixture.sendMode==='reject')return result({error:'Gmail rejected the message (403)'},false);
          bridgeFixture.drafts.get(body.draftId).status='sent';return result({ok:true,id:'confirmed-'+bridgeFixture.sends});
        }
        throw Error('Unexpected request '+url);
      };
    ` });
    const source = fs.readFileSync('index.html', 'utf8');
    const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    await page.addScriptTag({ content: extract('function hexToRgb(hex){', '\nfunction buildDocPDF(') + '\n' + extract('function buildDocPDF(mode,r,outputType){', '\nfunction buildDocEmailBody(') + '\n' + extract('function docNumber(mode,r){', '// Shared by both quote and invoice') + '\n' + extract('function lineVariantNote(s){', '// Green/grey/orange/red') });
    await page.addScriptTag({ content: `
      const realBuildDocPDF=buildDocPDF;
      buildDocPDF=function(mode,record,output){bridgeFixture.pdfInputs.push({mode,record:structuredClone(record),output});if(bridgeFixture.pdfFails)throw Error('PDF generation failed');return realBuildDocPDF(mode,record,output)};
    ` });
    await page.addScriptTag({ path: path.resolve('pipeline-model.js') });
    await page.addScriptTag({ path: path.resolve('conversations.js') });
    await page.addScriptTag({ path: path.resolve('conversations-bridge.js') });
    await page.getByRole('heading', { name: 'Conversations', exact: true }).waitFor();
    await page.evaluate(() => openGmailCompose({ to: 'client@example.com', subject: 'Hello', body: 'Stay inside TurnKey' }));
    assert.equal(await page.locator('[name=bodyText]').inputValue(), 'Stay inside TurnKey');
    await page.evaluate(() => generateAndSendDoc('quote', records[0]));
    assert.equal(await page.locator('.cv-files li').count(), 1, JSON.stringify(await page.evaluate(() => bridgeFixture.notices)));
    assert.match(await page.locator('.cv-files').textContent(), /Quote-Q-1001.pdf/);
    let state = await page.evaluate(() => ({
      stage: records[0].stage, quoteSentAt: records[0].quoteSentAt,
      last: [...bridgeFixture.drafts.values()].at(-1), pdf: bridgeFixture.pdfInputs.at(-1), sends: bridgeFixture.sends,
    }));
    assert.equal(state.stage, 'new'); assert.equal(state.quoteSentAt, undefined); assert.equal(state.sends, 0);
    assert.deepEqual(state.last.payload.document, { mode: 'quote', recordId: '1' });
    assert.equal(state.pdf.output, 'base64'); assert.equal(state.pdf.record.estimatedCost, undefined); assert.equal(state.pdf.record.services[0].internalCost, undefined);
    const pdf = Buffer.from(state.last.payload.attachments[0].contentBase64, 'base64').toString();
    assert.match(pdf, /%PDF-1.7/); assert.match(pdf, /Driveway/); assert.match(pdf, /\$200.00/); assert.doesNotMatch(pdf, /PRIVATE_SALES_NOTES|estimatedCost|internalCost|margin/);
    await page.evaluate(() => { bridgeFixture.uploadFailure = true; });
    await page.getByRole('button', { name: 'Saved quote PDF', exact: true }).click();
    assert.equal(await page.locator('[data-cv-action=opportunity-quote]').count(), 2);
    assert.equal(await page.getByText('FOREIGN_CUSTOMER', { exact: false }).count(), 0);
    await page.locator('[data-cv-action=opportunity-quote][data-id="2"]').click();
    await page.locator('.cv-files li').nth(1).waitFor();
    state = await page.evaluate(() => [...bridgeFixture.drafts.values()].at(-1));
    assert.equal(state.payload.attachments.length, 2); assert.ok(state.payload.attachments.every(f => f.contentBase64 && !f.savedAttachmentId));
    await page.getByRole('button', { name: 'Save & close', exact: true }).click();
    await page.getByRole('button', { name: /^Drafts/ }).click();
    await page.locator('[data-cv-action=draft]').filter({ hasText: 'Your quote from' }).click();
    assert.equal(await page.locator('.cv-files li').count(), 2);
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await page.getByText('Gmail rejected the message (403)', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => records[0].quoteSentAt), undefined);
    assert.equal(await page.locator('.cv-files li').count(), 2);
    await page.evaluate(() => { bridgeFixture.sendMode = 'success'; });
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await page.getByText('Email sent.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => records[0].stage), 'quoted');
    assert.ok(await page.evaluate(() => records[0].quoteSentAt));
    assert.equal(await page.evaluate(() => bridgeFixture.activities.length), 1);
    // Invoice entry points only prepare; they never mark invoices as sent.
    await page.evaluate(() => openSendDocModal('invoice', records[1]));
    assert.match(await page.locator('.cv-files').textContent(), /Invoice-INV-1002.pdf/);
    assert.equal(await page.evaluate(() => records[1].invoiceSent), undefined);
    await page.evaluate(() => { docPreview.recordId = 2; return sendInvoiceDoc(); });
    assert.equal(await page.evaluate(() => records[1].invoiceSent), undefined);
    await page.evaluate(() => sendQuoteDoc());
    assert.equal(await page.evaluate(() => records[1].quoteSentAt), undefined);
    await page.evaluate(() => {
      sendDocCtx = { mode: 'quote', recordId: 2 };
      for (const [id, value] of [['sd-to', 'edited@example.com'], ['sd-subject', 'Edited quote subject'], ['sd-body', 'Edited quote message']]) { const input = document.createElement('input'); input.id = id; input.value = value; document.body.append(input); }
      return confirmSendDocEmail();
    });
    assert.equal(await page.locator('[name=subject]').inputValue(), 'Edited quote subject');
    assert.equal(await page.locator('[name=bodyText]').inputValue(), 'Edited quote message');
    assert.match(await page.locator('.cv-files').textContent(), /Quote-Q-1002.pdf/);
    assert.equal(await page.evaluate(() => bridgeFixture.sends), 2);
    const countBefore = await page.evaluate(() => bridgeFixture.drafts.size);
    await page.evaluate(() => { bridgeFixture.pdfFails = true; return generateAndSendDoc('quote', records[1]); });
    assert.equal(await page.evaluate(() => bridgeFixture.drafts.size), countBefore);
    assert.match(await page.evaluate(() => bridgeFixture.notices.at(-1)), /PDF generation failed/);
    await page.evaluate(() => { bridgeFixture.pdfFails = false; return openComposeModal({ to: 'alice@example.com', subject: 'Follow up', body: 'Checking in' }); });
    assert.equal(await page.locator('[name=bodyText]').inputValue(), 'Checking in');
    await page.getByRole('button', { name: /^Inbox/ }).click();
    await page.locator('[data-cv-action=thread]').click();
    await page.evaluate(() => sendReply());
    assert.equal(await page.locator('[name=subject]').inputValue(), 'Re: Question');
    state = await page.evaluate(() => [...bridgeFixture.drafts.values()].at(-1));
    assert.equal(state.payload.replyToId, '22222222-2222-4222-8222-222222222222');
    // Real successful send callback advances contacted -> quote sent; drafts never do.
    await page.evaluate(()=>{records[1].stage='new';return openComposeModal({to:'bob@example.com',subject:'Your enquiry',body:'Checking the scope',opportunityId:'2'});});
    assert.equal(await page.evaluate(()=>records[1].stage),'new');
    await page.getByRole('button',{name:'Send email',exact:true}).click();
    await page.waitForFunction(()=>records[1].stage==='contacted');
    await page.evaluate(()=>generateAndSendDoc('quote',records[1]));
    assert.equal(await page.evaluate(()=>records[1].stage),'contacted');
    await page.getByRole('button',{name:'Send email',exact:true}).click();
    await page.waitForFunction(()=>records[1].stage==='quoted');
    // In-flight PDF work must not create a draft in the next business.
    const beforeSwitch = await page.evaluate(() => bridgeFixture.drafts.size);
    await page.evaluate(() => { bridgeFixture.pauseSync = true; bridgeFixture.preparing = generateAndSendDoc('quote', records[0]); });
    await page.waitForFunction(() => !!bridgeFixture.resumeSync);
    await page.evaluate(async () => { currentBusinessId = 'B'; TK_SALES_PLATFORM.reset(); bridgeFixture.resumeSync(); await bridgeFixture.preparing; });
    assert.equal(await page.evaluate(() => bridgeFixture.drafts.size), beforeSwitch);
    assert.equal(await page.locator('#view-inbox').textContent(), '');
    assert.equal(await page.evaluate(() => bridgeFixture.opens), 0);
    assert.equal(await page.evaluate(() => bridgeFixture.downloads), 0);
    assert.equal(await page.evaluate(() => bridgeFixture.sends), 4);
    assert.equal(browser.contexts()[0].pages().length, 1);
    console.log('Conversations bridge browser passed: actual PDF helper/base64 contract, public fields, opportunity picker without uploads, persisted PDF drafts, no popups/downloads, quote/invoice entry points, send rejection/success, reply, tenant-switch fencing.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
