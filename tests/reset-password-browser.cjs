const { chromium }=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true});
 async function setup({session=false,failRequest=false,failUpdate=false,hash='',url='/reset-password.html'}={}){
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(({session,failRequest,failUpdate})=>{
   window.testCalls={send:[],update:[]};
   window.supabase={createClient(){return {auth:{
    onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};},
    getSession:async()=>({data:{session:session?{user:{id:'fixture'}}:null},error:null}),
    resetPasswordForEmail:async(email,options)=>{window.testCalls.send.push({email,options});if(failRequest)throw Error('Network unavailable');return {error:null};},
    updateUser:async value=>{window.testCalls.update.push(value);return {error:failUpdate?{message:'Password must differ from the old password'}:null};}
   }}}};
  },{session,failRequest,failUpdate});
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'text/javascript',body:''});
   if(u.hostname!=='turnkey.test')return route.abort();
   if(u.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={supabaseUrl:"https://fixture.supabase.co",supabaseAnonKey:"fixture-public"};'});
   const file=path.join(root,u.pathname==='/'?'index.html':u.pathname.slice(1));
   if(!fs.existsSync(file))return route.abort();
   return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)});
  });
  const page=await context.newPage();await page.goto('https://turnkey.test'+url+hash);
  return {context,page};
 }
 try{
  let {context,page}=await setup();
  await page.getByLabel('Email address').fill('owner@example.test');await page.getByRole('button',{name:'Send reset link',exact:true}).click();
  await page.getByRole('status').filter({hasText:'If an account exists'}).waitFor();
  assert.equal(await page.evaluate(()=>testCalls.send[0].options.redirectTo),'https://turnkey.test/');
  assert.equal(await page.evaluate(()=>testCalls.update.length),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await context.close();

  ({context,page}=await setup({session:true,hash:'#type=recovery&access_token=fixture'}));
  await page.getByRole('heading',{name:'Choose a new password'}).waitFor();
  assert.equal(new URL(page.url()).hash,'');
  await page.getByLabel('New password',{exact:true}).fill('fixture-password-1');await page.getByLabel('Confirm new password').fill('fixture-password-2');await page.getByRole('button',{name:'Save new password'}).click();
  await page.getByRole('alert').filter({hasText:'don’t match'}).waitFor();assert.equal(await page.evaluate(()=>testCalls.update.length),0);
  await page.getByLabel('Confirm new password').fill('fixture-password-1');await page.getByLabel('Show passwords').check();assert.equal(await page.getByLabel('New password',{exact:true}).getAttribute('type'),'text');
  await page.getByRole('button',{name:'Save new password'}).click();await page.getByRole('heading',{name:'Password updated'}).waitFor();assert.equal(await page.evaluate(()=>testCalls.update.length),1);await context.close();

  ({context,page}=await setup({session:true}));assert.equal(await page.locator('#reset-change').isVisible(),false);await context.close();
  ({context,page}=await setup({hash:'#error=access_denied&error_code=otp_expired'}));await page.getByRole('alert').filter({hasText:'expired'}).waitFor();assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('#reset-request').isVisible(),true);await context.close();
  ({context,page}=await setup({failRequest:true}));await page.getByLabel('Email address').fill('owner@example.test');await page.getByRole('button',{name:'Send reset link',exact:true}).click();await page.getByRole('alert').filter({hasText:'Network unavailable'}).waitFor();assert.equal(await page.locator('#reset-send').isEnabled(),true);await context.close();
  ({context,page}=await setup({session:true,failUpdate:true,hash:'#type=recovery&access_token=fixture'}));await page.getByRole('heading',{name:'Choose a new password'}).waitFor();await page.getByLabel('New password',{exact:true}).fill('fixture-password-1');await page.getByLabel('Confirm new password').fill('fixture-password-1');await page.getByRole('button',{name:'Save new password'}).click();await page.getByRole('alert').waitFor();assert.equal(await page.locator('#reset-save').isEnabled(),true);await context.close();
  ({context,page}=await setup({session:true,url:'/',hash:'#type=recovery&access_token=fixture'}));await page.waitForURL('**/reset-password.html');await page.getByRole('heading',{name:'Choose a new password'}).waitFor();await context.close();
  console.log('Password reset passed: request, recovery redirect, matching passwords, success, expired link, normal-session guard, mobile overflow and retry after failure. No live emails or password changes.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
