/* Production UI, fixture-only data. No emails, live completions or external API writes. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),os=require('node:os');
const root=path.resolve(__dirname,'..'),review='https://g.page/r/CbDFAxFaaWMUEBM/review';
const jobId='00000000-0000-4000-8000-000000000111';
(async()=>{
 const cached=path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached})});
 try{for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Pacific/Auckland',serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(7000);
  const state={drafts:{},completed:[],logs:[],calls:[],failSave:false,failComplete:false},errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('postJobFixtureRequest',async(p,options={},user='employee')=>{
   state.calls.push({p,options,user});p=p.replace(/^\/api\/job-work/,'');const body=options.body?JSON.parse(options.body):{};
   const settings={enabled:true,reviewUrl:review,logoUrl:'https://fixture.test/fixture-logo.svg',businessName:'Nova Exterior'};
   if(p.endsWith('/post-job/settings'))return {settings,role:'technician',employee:{id:user,name:'Field Employee',aliases:[user]}};
   if(p.endsWith('/post-job/complete')){
    if(state.failComplete)throw Error('Database unavailable');
    const existing=state.completed.find(x=>x.employeeId===user);if(existing)return {checklist:existing,job:{status:'completed',details:{jobStatus:'completed'}}};
    const row={responses:body.responses,jobId,employeeId:user,employeeName:'Field Employee',completedAt:new Date().toISOString()};state.completed.push(row);state.drafts[user]=row;return {checklist:row,job:{id:jobId,status:'completed',details:{jobStatus:'completed',postJobCompletedAt:row.completedAt}}};
   }
   if(p.endsWith('/post-job')){
    if(options.method==='PUT'){if(state.failSave)throw Error('Offline');state.drafts[user]={responses:body.responses,employeeId:user,jobId,updatedAt:new Date().toISOString()};return {checklist:state.drafts[user]};}
    return {settings,checklist:state.drafts[user]||null,history:state.completed.filter(x=>x.employeeId===user)};
   }
   if(p==='/staff')return {role:'technician',staff:[{id:user,name:'Field Employee',email:'field@example.test'}]};
   if(p==='/equipment')return {equipment:[]};
   if(p.startsWith('/logs')){
    if(options.method==='POST'){state.logs.push({id:'log-1',user_id:body.userId,job_id:body.jobId,minutes:90,start_at:body.startAt,end_at:body.endAt});return {logId:'log-1',ok:true};}
    return {logs:state.logs.filter(x=>x.user_id===user),usage:[]};
   }
   if(p.includes('/photos'))return {photos:[]};
   return {};
  });
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());if(url.origin==='https://fixture.test'){
    if(url.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={};'});
    if(url.pathname==='/fixture-logo.svg')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="65"><text x="10" y="42" fill="#0f7d6b" font-family="sans-serif" font-size="28">Nova Exterior</text></svg>'});
    const file=path.join(root,url.pathname==='/'?'index.html':url.pathname.slice(1));
    if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
   }
   return route.fulfill({contentType:'text/javascript',body:''});
  });
  const setup=async()=>{await page.waitForFunction(()=>window.TK_POST_JOB&&window.TK_JOB_WORK);await page.evaluate(({jobId})=>{
   currentBusinessId='fixture-business';currentUserId='employee';currentUserRole='technician';businessSessionVersion=1;businessStateReady=true;
   window.checklistFixture={biz:currentBusinessId,user:currentUserId,version:1,role:'technician'};
   records=[newRecord({id:11,jobId,name:'Customer Example',address:'10 Example Road, Auckland',stage:'scheduled',jobStatus:'in_progress',assignedStaffId:currentUserId,startedAt:Date.now()-5400000})];
   const run=(p,o)=>window.postJobFixtureRequest(p,o,window.checklistFixture.user);
   TK_POST_JOB.configure({context:()=>window.checklistFixture,records:()=>records,request:run,notify:m=>window.lastChecklistNotify=m});
   TK_JOB_WORK.configure({getBusinessId:()=>window.checklistFixture.biz,getUserId:()=>window.checklistFixture.user,getVersion:()=>window.checklistFixture.version,getRecords:()=>records,request:run,notify:m=>window.lastHoursNotify=m});
   const original=qrcode;window.qrcode=Object.assign(function(...args){const qr=original(...args),add=qr.addData;qr.addData=function(value){window.encodedReviewUrl=value;return add.apply(this,arguments);};return qr;},original);
   showApp();openDetail(11);
  },{jobId});};
  await page.goto('https://fixture.test/');await setup();await page.evaluate(()=>completeJob(11));
  const dialog=page.locator('.pj-dialog');await page.waitForFunction(()=>TK_POST_JOB.getActive()?.loaded);
  await dialog.getByRole('button',{name:'Complete Job',exact:true}).click();assert.equal(state.completed.length,0);assert.equal(await dialog.locator('.pj-missing').count(),5);
  await dialog.getByRole('radio',{name:'Yes',exact:true}).check();await dialog.locator('[name="qualityCheck"]').check();
  for(const name of ['injectorFlushed','fuelSwitchOff','objectsReturned'])await dialog.locator(`[name="${name}"]`).check();
  assert.match(await dialog.locator('[data-pj-progress]').innerText(),/3\/4/);
  await dialog.locator('[name="askedUpcomingWork"]').check();await dialog.locator('[name="upcomingWorkNotes"]').fill('Deck wash next month');
  await dialog.locator('[name="askedFrequency"]').check();await dialog.locator('[name="frequencyAnswer"]').fill('Every six months');
  await dialog.getByRole('button',{name:'Show Review QR Code',exact:true}).click();
  const qr=page.locator('.pj-review');assert.equal(await qr.isVisible(),true);assert.equal(await page.evaluate(()=>encodedReviewUrl),review);
  const bounds=await qr.boundingBox();assert.equal(Math.round(bounds.width),width);assert.equal(Math.round(bounds.height),900);assert.ok((await qr.locator('svg').last().boundingBox()).width>=250);
  await page.screenshot({path:`/private/tmp/post-job-qr-${width}.png`});
  const scrollBefore=await dialog.locator('.pj-body').evaluate(el=>el.scrollTop);
  await qr.getByRole('button',{name:'Close review QR code'}).click();assert.equal(await dialog.locator('[name="reviewScanned"]').isChecked(),false);assert.equal(await dialog.locator('.pj-body').evaluate(el=>el.scrollTop),scrollBefore);
  await dialog.getByRole('button',{name:'Save and close checklist'}).click();
  await page.reload();await setup();await page.evaluate(()=>completeJob(11));await page.waitForFunction(()=>TK_POST_JOB.getActive()?.loaded);
  assert.equal(await dialog.locator('[name="objectsReturned"]').isChecked(),true);assert.equal(await dialog.locator('[name="frequencyAnswer"]').inputValue(),'Every six months');
  await dialog.getByRole('button',{name:'Log work hours',exact:true}).click();const hours=page.locator('[data-tkj-form="log-hours"]');await hours.waitFor();
  await hours.locator('[name="startTime"]').fill('09:00');await hours.locator('[name="endTime"]').fill('10:30');await hours.getByRole('button',{name:'Save hours',exact:true}).click();
  await dialog.waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('[data-pj-hours-summary]').textContent.includes('1h 30m'));
  assert.equal(state.logs.length,1);assert.equal(state.logs[0].user_id,'employee');
  await dialog.locator('[name="propertyLap"]').check();
  await page.screenshot({path:`/private/tmp/post-job-checklist-${width}.png`});
  const checkbox=await dialog.locator('[name="propertyLap"]').boundingBox();assert.equal(Math.round(checkbox.width),24);assert.equal(Math.round(checkbox.height),24);assert.ok((await dialog.getByRole('button',{name:'Complete Job',exact:true}).boundingBox()).height>=48);
  const overflow=await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false);
  state.failComplete=true;await dialog.getByRole('button',{name:'Complete Job',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-pj-message]').textContent.includes('Database unavailable'));assert.equal(state.completed.length,0);assert.equal(await page.evaluate(()=>records[0].stage),'scheduled');
  state.failComplete=false;await dialog.getByRole('button',{name:'Complete Job',exact:true}).click();await page.waitForFunction(()=>!!TK_POST_JOB.getActive()?.completed);
  assert.equal(state.completed.length,1);assert.equal(state.completed[0].responses.reviewScanned,false);assert.equal(state.completed[0].responses.upcomingWorkNotes,'Deck wash next month');
  assert.equal(await dialog.locator('[name="propertyLap"]').isDisabled(),true);assert.equal(await dialog.getByRole('button',{name:'Complete Job',exact:true}).isVisible(),false);
  await dialog.getByRole('button',{name:'Close completed checklist'}).click();
  await page.evaluate(()=>{window.checklistFixture.user='second-worker';window.checklistFixture.version=2;TK_POST_JOB.open(11);});await page.waitForFunction(()=>TK_POST_JOB.getActive()?.loaded);
  assert.equal(await dialog.locator('[name="objectsReturned"]').isChecked(),false);
  await dialog.getByRole('radio',{name:'No',exact:true}).check();assert.equal(await dialog.locator('[data-pj-handover]').isVisible(),false);
  for(const name of ['injectorFlushed','fuelSwitchOff','objectsReturned','propertyLap'])await dialog.locator(`[name="${name}"]`).check();
  await dialog.getByRole('button',{name:'Complete Job',exact:true}).click();await page.waitForFunction(()=>!!TK_POST_JOB.getActive()?.completed);
  assert.equal(state.completed[1].responses.customerHome,false);assert.equal(state.completed[1].responses.qualityCheck,false);
  await page.evaluate(()=>{window.checklistFixture.biz='other-company';window.checklistFixture.version=3;});await page.waitForFunction(()=>!document.querySelector('.pj-dialog'));
  assert.deepEqual(errors,[]);console.log(`PASS post-job handover, QR, reload, hours, completion and account scope at ${width}px`);await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
