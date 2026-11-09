const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {calculateHours}=require('../post-office-crew.js');

test('paid time includes travel; productive time excludes it, without rounding stored hours',()=>{
 assert.deepEqual(calculateHours({start:'09:00',end:'17:00',breakMinutes:30,travelMinutes:60}),{paidHours:7.5,productiveHours:6.5});
 assert.equal(calculateHours({start:'09:00',end:'09:01'}).paidHours,1/60);
 assert.deepEqual(calculateHours({start:'09:00',end:'10:00',breakMinutes:30,travelMinutes:30}),{paidHours:.5,productiveHours:0});
});
test('rejects unsupported overnight shifts, invalid clocks and excessive deductions',()=>{
 for(const entry of [
  {start:'22:00',end:'02:00'}, {start:'09:00',end:'09:00'},
  {start:'24:00',end:'25:00'}, {start:'09:60',end:'11:00'},
  {start:'9:00',end:'11:00'}, {start:'',end:'11:00'},
  {start:'09:00',end:'10:00',breakMinutes:61},
  {start:'09:00',end:'10:00',breakMinutes:30,travelMinutes:31},
  {start:'09:00',end:'10:00',travelMinutes:-1},
  {start:'09:00',end:'10:00',breakMinutes:'no'},
  {start:'09:00',end:'10:00',travelMinutes:Infinity}
 ]) assert.throws(()=>calculateHours(entry));
});

test('crew and hours pages use parent persistence, scope staff logs, and support assignments',async()=>{
 const {chromium}=require('playwright');
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.setContent('<main id="content"></main>');
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../post-office-crew.js'),'utf8')});
  await page.evaluate(()=>{
   window.s={crew:[{id:'a',name:'Alice',role:'Camera',userId:'ua'},{id:'b',name:'Bob',role:'Sound',userId:'ub'}],projects:[{id:'p',name:'Film',crew:[{name:'Alice',role:'Camera',status:'Tentative'}]}],workLogs:[
    {id:'l1',crewId:'a',userId:'ua',projectId:'p',date:'2026-11-09',start:'09:00',end:'17:00',breakMinutes:30,travelMinutes:60,notes:'<img src=x onerror=alert(1)>'},
    {id:'l2',crewId:'b',userId:'ub',projectId:'p',date:'2026-11-10',start:'09:00',end:'17:00',notes:'PRIVATE BOB'},
    {id:'l3',crewId:'a',userId:'ub',projectId:'p',date:'2026-11-10',start:'09:00',end:'17:00',notes:'MISMATCHED USER'}]};
   const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.saved=[];window.errors=[];
   window.api={state:()=>s,content:document.querySelector('#content'),esc,
    field:(label,name,value='',type='text',required=false)=>`<div class="field"><label for="f-${name}">${esc(label)}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''}></div>`,
    area:(label,name,value='')=>`<label>${label}<textarea name="${name}">${esc(value)}</textarea></label>`,
    openEditor:(title,html,save)=>{window.editor={title,html,save};},
    change:async fn=>fn(s),run:fn=>Promise.resolve().then(fn).catch(e=>errors.push(e.message)),id:()=>`id-${saved.length}`,
    members:()=>[{id:'ua',email:'alice@example.com',role:'staff'},{id:'ub',email:'bob@example.com',role:'staff'}],
    canManage:false,currentUserId:'ua',logHours:async entry=>{saved.push(entry);s.workLogs.push(entry);},removeHours:async id=>{s.workLogs=s.workLogs.filter(l=>l.id!==id);}};
   TK_POST_OFFICE_CREW.renderHours(api);
  });
  assert.equal(await page.locator('[name=crewId] option').count(),2);
  assert.equal(await page.getByText('PRIVATE BOB').count(),0);
  assert.equal(await page.getByText('MISMATCHED USER').count(),0);
  assert.equal(await page.locator('[data-logs] img').count(),0);
  assert.match(await page.locator('[data-weekly]').innerText(),/7.50 h paid · 6.50 h productive/);
  await page.locator('[name=projectId]').selectOption('p');
  await page.locator('[name=start]').fill('08:00');
  await page.locator('[name=end]').fill('12:00');
  await page.locator('[name=breakMinutes]').fill('30');
  await page.locator('[name=travelMinutes]').fill('30');
  await page.getByRole('button',{name:'Save hours',exact:true}).click();
  await page.waitForFunction(()=>saved.length===1);
  assert.deepEqual(await page.evaluate(()=>({hours:saved[0].hours,productiveHours:saved[0].productiveHours,userId:saved[0].userId})),{hours:3.5,productiveHours:3,userId:'ua'});
  await page.evaluate(()=>TK_POST_OFFICE_CREW.renderCrew(api));
  assert.equal(await page.locator('[data-add]').count(),0);
  await page.locator('[data-person="b"]').click();
  assert.equal(await page.locator('[data-edit]').count(),0);
  assert.match(await page.locator('#content').innerText(),/0.00 h paid/);
  await page.evaluate(()=>{api.canManage=true;TK_POST_OFFICE_CREW.renderCrew(api);});
  await page.locator('[name=crewProject]').selectOption('p');
  assert.equal(await page.locator('[data-person]').count(),1);
  await page.locator('#poc-search').fill('Sound');
  assert.equal(await page.locator('[data-person]').count(),0);
  await page.locator('#poc-search').fill('');
  await page.locator('[data-person="a"]').click();
  assert.match(await page.locator('#content').innerText(),/Film/);
  await page.locator('[data-assignment="p"]').click();
  assert.match(await page.evaluate(()=>editor.html),/<select[^>]*name="crewId"/);
  await page.evaluate(async()=>{const f=new FormData();for(const [k,v] of Object.entries({projectId:'p',crewId:'a',role:'Director',status:'Confirmed'}))f.set(k,v);await editor.save(f);});
  assert.deepEqual(await page.evaluate(()=>s.projects[0].crew),[{crewId:'a',name:'Alice',contact:'',role:'Director',status:'Confirmed'}]);
  await page.locator('[data-edit]').click();
  assert.match(await page.evaluate(()=>editor.html),/<select[^>]*name="userId"/);
  assert.match(await page.evaluate(()=>editor.html),/alice@example.com/);
  await page.evaluate(async()=>{const f=new FormData();for(const [k,v]of Object.entries({name:'Alice Updated',role:'Director',email:'',phone:'',userId:'ua'}))f.set(k,v);await editor.save(f);});
  assert.equal(await page.evaluate(()=>s.crew[0].name),'Alice Updated');
  await page.locator('[data-person="a"]').click();
  await page.locator('[data-delete]').click();
  await page.evaluate(()=>editor.save(new FormData()));
  assert.equal(await page.evaluate(()=>s.crew.length),1);
  assert.equal(await page.evaluate(()=>s.projects[0].crew.length),0);
  assert.equal(await page.evaluate(()=>s.workLogs.find(l=>l.id==='l1').crewName),'Alice Updated');
  assert.deepEqual(await page.evaluate(()=>errors),[]);
 } finally {await browser.close();}
});
