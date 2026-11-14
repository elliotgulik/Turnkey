const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),os=require('node:os');
const root=path.resolve(__dirname,'..'),jobId='00000000-0000-4000-8000-000000000111',uid='00000000-0000-4000-8000-000000000112';
(async()=>{
 const cached=path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached})});
 try{for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Pacific/Auckland',serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(8000);const calls=[],errors=[];let completed=null;
  page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('employeeFixtureRequest',async(p,o={},scope)=>{
   calls.push({p,o,scope});assert.ok(p.startsWith('/api/job-work/'));const payload=o.body?JSON.parse(o.body):{},url=new URL(p,'https://fixture.test');
   if(url.pathname.endsWith('/portal')){const date=url.searchParams.get('date');return {employee:{id:uid,name:'Luca Anderson',aliases:[uid,'servicem8:worker']},business:{id:'test-business',name:'Nova Exterior'},jobs:[{id:jobId,status:'scheduled',scheduled_date:date,customer:{name:'Customer Example',email:'customer@example.test',phone:'0211234567',address:'10 Example Road'},details:{calendarStartAt:date+'T09:00:00+13:00',calendarEndAt:date+'T11:00:00+13:00',workerInstructions:'Use the side gate. Keep pets inside.',salesNotes:'SECRET_SALES_NOTES',costSnapshot:{private:true}},services:[{name:'House wash',price:999999}],crew:['Luca Anderson','Elliot Gulik'],amount:999999,quoteId:'SECRET_QUOTE'}]};}
   if(url.pathname.endsWith('/post-job/settings'))return {settings:{enabled:true,reviewUrl:'https://g.page/r/CbDFAxFaaWMUEBM/review',businessName:'Nova Exterior',logoUrl:''},role:'technician',employee:{id:uid,name:'Luca Anderson',aliases:[uid,'servicem8:worker']}};
   if(url.pathname.endsWith('/post-job/complete')){completed={jobId,employeeId:uid,employeeName:'Luca Anderson',completedAt:new Date().toISOString(),responses:payload.responses};return {checklist:completed,statusManagedByServiceM8:true,job:{id:jobId,status:'scheduled',details:{postJobCompletedAt:completed.completedAt}}};}
   if(url.pathname.endsWith('/post-job'))return {checklist:completed||(o.method==='PUT'?{responses:payload.responses}:null),history:completed?[completed]:[],settings:{enabled:true,reviewUrl:'https://g.page/r/CbDFAxFaaWMUEBM/review',businessName:'Nova Exterior'}};
   if(url.pathname.endsWith('/staff'))return {role:'technician',staff:[{id:uid,name:'Luca Anderson',email:'employee@example.test'}]};
   if(url.pathname.endsWith('/equipment'))return {equipment:[]};
   if(url.pathname.endsWith('/logs'))return {logs:[],usage:[]};
   if(url.pathname.endsWith('/jobs'))return {jobs:[{id:jobId,name:'Customer Example',address:'10 Example Road',services:['House wash']}]};
   if(url.pathname.endsWith('/photos'))return {photos:[]};throw Error('Unexpected portal request '+p);
  });
  await page.addInitScript(({uid})=>{
   window.fixtureSession=null;window.fixtureProfile={id:uid,business_id:'test-business',role:'technician'};window.fixtureProfileQueries=[];window.fixtureAuthHandlers=[];
   window.fixtureClient={auth:{getSession:async()=>({data:{session:window.fixtureSession}}),onAuthStateChange:fn=>{window.fixtureAuthHandlers.push(fn);return {data:{subscription:{unsubscribe(){}}}};},signInWithPassword:async()=>{window.fixtureSession={user:{id:uid,email:'employee@example.test'},access_token:'fixture-token'};return {data:{session:window.fixtureSession}};},signOut:async()=>{window.fixtureSession=null;window.fixtureAuthHandlers.forEach(fn=>fn('SIGNED_OUT',null));return {error:null};},mfa:{listFactors:async()=>({data:{totp:[]}})}},from(table){window.fixtureProfileQueries.push(table);if(table!=='users')throw Error('Forbidden employee direct table '+table);return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:window.fixtureProfile,error:null})};}};
   window.supabase={createClient:()=>window.fixtureClient};
  },{uid});
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.origin==='https://fixture.test'){
    if(u.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={supabaseUrl:"https://fixture.supabase.test",supabaseAnonKey:"fixture-public-key",backendUrl:"https://fixture.test"};'});
    const file=path.join(root,u.pathname.slice(1)||'employee.html');if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
   }return route.fulfill({contentType:'text/javascript',body:''});
  });
  await page.goto('https://fixture.test/employee.html');await page.waitForFunction(()=>!!window.TK_EMPLOYEE_PORTAL);
  await page.evaluate(()=>TK_EMPLOYEE_PORTAL.configure({client:fixtureClient,request:(p,o,c)=>window.employeeFixtureRequest(p,o,c)}));
  await page.locator('#employee-email').fill('employee@example.test');await page.locator('#employee-password').fill('fixture-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForFunction(()=>TK_EMPLOYEE_PORTAL.getState().records.length===1);
  assert.equal(await page.locator('#employee-full-crm').isVisible(),false);assert.match(await page.locator('#employee-greeting').innerText(),/Luca Anderson/);
  const text=await page.locator('body').innerText();for(const value of ['SECRET_SALES_NOTES','999999','SECRET_QUOTE','Profitability','Connections','Analytics'])assert.ok(!text.includes(value),value);
  assert.equal(await page.evaluate(()=>typeof window.TK_PRICING),'undefined');assert.equal(await page.evaluate(()=>typeof window.TK_COST),'undefined');assert.equal(await page.evaluate(()=>typeof window.TK_SALES_PLATFORM),'undefined');
  await page.screenshot({path:`/private/tmp/employee-portal-${width}.png`});
  await page.getByRole('button',{name:'My schedule',exact:true}).click();await page.locator('#employee-week').waitFor();assert.equal(await page.locator('#employee-week button').count(),7);
  const before=await page.locator('#employee-date').inputValue();await page.getByRole('button',{name:'Next day',exact:true}).click();await page.waitForFunction(old=>document.querySelector('#employee-date').value!==old,before);
  await page.getByRole('button',{name:'Open job',exact:true}).click();assert.match(await page.locator('#view-detail').innerText(),/Use the side gate/);await page.locator('#tkj-card').waitFor();await page.locator('#post-job-card').waitFor();
  await page.locator('[data-complete]').click();await page.waitForFunction(()=>TK_POST_JOB.getActive()?.loaded);
  const dialog=page.locator('.pj-dialog');await dialog.getByRole('radio',{name:'No',exact:true}).check();for(const name of ['injectorFlushed','fuelSwitchOff','objectsReturned','propertyLap'])await dialog.locator(`[name="${name}"]`).check();
  await dialog.getByRole('button',{name:'Complete Job',exact:true}).click();await page.waitForFunction(()=>!!TK_POST_JOB.getActive()?.completed);assert.equal(completed.employeeId,uid);assert.equal(completed.responses.customerHome,false);
  await dialog.getByRole('button',{name:'Close completed checklist'}).click();await page.getByRole('button',{name:'My hours',exact:true}).click();
  await page.waitForFunction(()=>!!document.querySelector('#view-worklog [name="jobId"] option[value="00000000-0000-4000-8000-000000000111"]'));assert.match(await page.locator('#view-worklog h1').innerText(),/My work hours/);
  await page.screenshot({path:`/private/tmp/employee-hours-${width}.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await page.evaluate(()=>[...new Set(fixtureProfileQueries)]),['users']);
  assert.ok(calls.every(x=>x.p.startsWith('/api/job-work/')));
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.waitForFunction(()=>!TK_EMPLOYEE_PORTAL.getState().ready);assert.equal(await page.locator('#employee-app').isVisible(),false);assert.equal(await page.evaluate(()=>TK_EMPLOYEE_PORTAL.getState().records.length),0);
  assert.deepEqual(errors,[]);console.log(`PASS employee sign-in, own jobs, schedule, checklist, hours, privacy and sign-out at ${width}px`);await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
