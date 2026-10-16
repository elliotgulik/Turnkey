// Synthetic browser smoke test: no network, customer fixtures, or live database.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const cached=path.join(require('node:os').homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached})});
 try {
  const page=await browser.newPage({acceptDownloads:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html><body><main id="wizard"></main></body></html>');
  await page.addScriptTag({content:`
    let currentBusinessId='A';
    const syntheticTables={customers:[{id:'c-1',business_id:'A',name:'Synthetic Example',email:'example@example.test',phone:'0210000000',address:'12 Test Lane'}],jobs:[{id:'j-1',business_id:'A',customer_id:'c-1',status:'won',details:{total:115,notes:'Synthetic job'}}]};
    const sb={from(table){let business;const q={select(){return q},eq(k,v){business=v;return q},order(){return q},async range(start,end){return {data:syntheticTables[table].filter(r=>r.business_id===business).slice(start,end+1),error:null}}};return q;}};
    const importWizard={files:{jobs:{}}};
    function sm8Process(){return {customers:[],jobs:[]};}
    function sm8RenderUpload(){return '<button disabled onclick="sm8Validate()">Continue</button>';}
  `});
  await page.addScriptTag({content:fs.readFileSync('servicem8-import.js','utf8')});
  await page.evaluate(()=>document.getElementById('wizard').innerHTML=sm8RenderUpload());
  await page.getByRole('button',{name:'Export clients CSV / Export jobs CSV…'}).click();
  assert.equal(await page.locator('dialog').count(),1);
  assert.match(await page.locator('dialog').innerText(),/not a native ServiceM8 jobs import file/);
  await page.evaluate(()=>TK_SERVICEM8_IMPORT.openExport());
  assert.equal(await page.locator('dialog').count(),1);
  for(const kind of ['clients','jobs']) {
    const pending=page.waitForEvent('download');
    await page.getByRole('button',{name:kind==='clients'?'Export clients CSV':'Export jobs CSV',exact:true}).click();
    const download=await pending;
    assert.equal(download.suggestedFilename(),kind==='clients'?'turnkey-servicem8-clients.csv':'turnkey-jobs-archive.csv');
    const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
    const text=Buffer.concat(chunks).toString('utf8');
    assert.match(text,/Synthetic Example/);
    assert.match(text,kind==='clients'?/Email Address/:/Record JSON/);
  }
  await page.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.locator('dialog').count(),0);
  await page.evaluate(()=>{currentBusinessId=null;TK_SERVICEM8_IMPORT.openExport();});
  await page.getByRole('button',{name:'Export clients CSV',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Sign in to your TurnKey business before exporting.'}).waitFor();
  await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').count(),0);
  await page.evaluate(()=>{currentBusinessId='A';TK_SERVICEM8_IMPORT.openExport();currentBusinessId='B';});
  await page.getByRole('button',{name:'Export jobs CSV',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Your business changed.'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('ServiceM8 export browser smoke passed: both downloads, labels, close/Escape, auth and account-switch guards.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
