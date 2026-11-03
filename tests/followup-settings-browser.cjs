/* Isolated real-browser regression: production editor and delegated handlers,
 * with a local settings fixture. No network, accounts or customer sends. */
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../sales-platform.js'),'utf8');
function section(start,end){const a=source.indexOf(start);assert.ok(a>=0);const b=source.indexOf(end,a);assert.ok(b>a);return source.slice(a,b);}
const production=section('  function modal(title, html)',"  function quotePickerRows(")+
  section('  let followupEditorSerial =','  function openStageSettings()')+
  section('  document.addEventListener("click", async (e) => {','  // Match mobile selection');

(async()=>{
  const browser=await chromium.launch({headless:true});
  const screenshots=fs.mkdtempSync(path.join(os.tmpdir(),'turnkey-followup-settings-'));
  try{
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:980}});
      page.setDefaultTimeout(5000);
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>route.abort());
      await page.setContent('<!doctype html><html><head></head><body><button data-sale-action="followup-settings">Manage automatic follow-ups</button></body></html>');
      await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../sales-platform.css'),'utf8')});
      await page.addScriptTag({content:`
        var currentBusinessId='business-a',currentUserRole='owner';
        var saved={enabled:false,steps:[]},calls=[],notices=[],failSave=false,failLoad=false,holdLoad=false,releaseLoad;
        function peopleScope(){return currentBusinessId+':owner:1';}
        function record(){return null;}
        function closeModal(){}
        function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
        function field(label,input){return '<label class="sale-field"><span>'+esc(label)+'</span>'+input+'</label>';}
        function button(text,action,id='',extra=''){return '<button type="button" class="btn ghost sm" data-sale-action="'+action+'" data-id="'+esc(id)+'" '+extra+'>'+esc(text)+'</button>';}
        function toast(message){notices.push(message);}
        function error(err){document.getElementById('sales-dialog-error').textContent=err.message;}
        async function api(url,opts={}){calls.push({url,...opts});if(opts.method==='PUT'){if(failSave)throw Error('Settings are unavailable. Please retry.');saved=JSON.parse(opts.body);return structuredClone(saved);}if(holdLoad)await new Promise(resolve=>releaseLoad=resolve);if(failLoad)throw Error('Could not load settings');return structuredClone(saved);}
      `+production});
      const open=async()=>{await page.getByRole('button',{name:'Manage automatic follow-ups',exact:true}).click();await page.waitForSelector('#sale-followup-settings-form');};
      const add=()=>page.getByRole('button',{name:'Add follow-up step',exact:true}).click();
      const step=n=>page.locator('[data-followup-step]').nth(n);
      await open();
      assert.equal(await page.getByRole('checkbox').isChecked(),false);
      assert.equal(await page.locator('[data-followup-step]').count(),0);
      assert.match(await page.locator('#sales-dialog').innerText(),/Only quotes sent after automatic follow-ups are enabled/);
      assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='PUT').length),0);
      await add();await step(0).getByLabel('Email subject').fill('First "quote" <script>');
      await step(0).getByLabel('Email message').fill('Hi {customer_name},\n\nFirst custom message </textarea><img src=x>');
      await add();
      assert.equal(await step(0).getByLabel('Email subject').inputValue(),'First "quote" <script>');
      assert.equal(await page.locator('#sales-dialog img,#sales-dialog script').count(),0);
      await step(1).getByLabel('Email subject').fill('Second message');
      await step(1).getByLabel('Days after quote was sent').fill('5');
      await add();await page.getByRole('button',{name:'Remove step 2',exact:true}).click();
      assert.equal(await page.locator('[data-followup-step]').count(),2);
      assert.match(await step(0).getByLabel('Email message').inputValue(),/First custom message/);
      await step(1).getByLabel('Days after quote was sent').fill('1');
      await page.getByRole('checkbox').check();
      await page.getByRole('button',{name:'Save follow-up settings',exact:true}).click();
      assert.match(await page.locator('#sales-dialog-error').innerText(),/later than the previous step/);
      assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='PUT').length),0);
      await step(1).getByLabel('Days after quote was sent').fill('7');
      await step(1).getByLabel('Email subject').fill('Second custom subject');
      await step(1).getByLabel('Email message').fill('A different follow-up at day seven.');
      await page.evaluate(()=>failSave=true);
      await page.getByRole('button',{name:'Save follow-up settings',exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('sales-dialog-error').textContent.includes('unavailable'));
      assert.equal(await page.getByRole('button',{name:'Save follow-up settings',exact:true}).isEnabled(),true);
      assert.equal(await step(1).getByLabel('Email subject').inputValue(),'Second custom subject');
      await page.screenshot({path:path.join(screenshots,'editor-'+width+'.png')});
      assert.ok(await page.locator('#sales-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'editor must fit the viewport');
      await page.evaluate(()=>failSave=false);
      await page.getByRole('button',{name:'Save follow-up settings',exact:true}).click();
      await page.waitForFunction(()=>!document.getElementById('sales-dialog').open);
      await open();
      assert.equal(await page.getByRole('checkbox').isChecked(),true);
      assert.equal(await step(1).getByLabel('Email subject').inputValue(),'Second custom subject');
      assert.equal(await step(1).getByLabel('Days after quote was sent').inputValue(),'7');
      await page.getByRole('checkbox').uncheck();
      await page.getByRole('button',{name:'Save follow-up settings',exact:true}).click();
      await page.waitForFunction(()=>!document.getElementById('sales-dialog').open);
      assert.equal(await page.evaluate(()=>saved.enabled),false);
      assert.equal(await page.evaluate(()=>saved.steps.length),2,'disabling preserves configured messages');
      await page.evaluate(()=>currentUserRole='staff');await open();
      assert.equal(await page.getByRole('button',{name:'Save follow-up settings',exact:true}).isEnabled(),false);
      await page.getByRole('button',{name:'Close',exact:true}).click();
      await page.evaluate(()=>{currentUserRole='owner';failLoad=true;});
      await page.getByRole('button',{name:'Manage automatic follow-ups',exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('sales-dialog-error').textContent.includes('Could not load'));
      assert.equal(await page.locator('#sale-followup-settings-form').count(),0,'failed reads cannot open a default-enabled editor');
      await page.getByRole('button',{name:'Close',exact:true}).click();
      await page.evaluate(()=>{failLoad=false;holdLoad=true;});
      await page.getByRole('button',{name:'Manage automatic follow-ups',exact:true}).click();
      await page.waitForFunction(()=>typeof releaseLoad==='function');
      await page.evaluate(()=>{currentBusinessId='business-b';releaseLoad();});
      assert.equal(await page.locator('#sale-followup-settings-form').count(),0,'stale settings must not enter another business editor');
      assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log('Follow-up settings browser regressions passed at desktop and mobile widths. Screenshots: '+screenshots);
  }finally{await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
