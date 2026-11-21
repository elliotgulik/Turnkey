const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
test('welcome editor saves explicitly, previews plain text and guards readiness, retries and company changes',async()=>{
  const cached=path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached})});
  try{
    for(const width of [1440,390]){
      const page=await browser.newPage({viewport:{width,height:1000}});
      await page.route('**/*',route=>route.abort());
      const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
      const styles=[...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"?]+)[^"]*"[^>]*>|<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[2]??(!/^https?:/.test(m[1])?fs.readFileSync(path.join(root,m[1]),'utf8'):''));
      await page.setContent(`<style>${styles.join('\n')}</style><main id="settings-body" style="display:block;padding:16px;max-width:700px;box-sizing:border-box"></main>`);
      await page.evaluate(()=>{
        window.currentBusinessId='business-a';window.currentUserId='owner';window.currentUserRole='owner';window.businessSessionVersion=1;
        window.docBizName=()=> 'Nova Exterior';window.calls=[];window.failLoad=false;window.failSave=false;window.defer=false;
        window.settingsGroup=(label,inner)=>`<details class="settings-group" open><summary>${label}</summary><div class="settings-group-body">${inner}</div></details>`;
        window.openSettings=()=>{document.getElementById('settings-body').innerHTML='';};
        window.TK_SALES_PLATFORM={request:async(url,opts={})=>{
          calls.push({url,...opts});
          if(failLoad&&!opts.method)throw Error('Load failed');
          if(opts.method==='PUT'&&failSave)throw Error('Save failed');
          if(defer)await new Promise(resolve=>window.release=resolve);
          return {settings:opts.body?JSON.parse(opts.body):TK_LEAD_WELCOME.defaults(),readiness:{sms:false,email:true},history:Array.from({length:12},(_,i)=>({id:i,status:i%2?'failed':'sent',channel:'sms',created_at:'2026-11-21T00:00:00Z',error_summary:i%2?'<img src=x onerror=alert(1)>':null}))};
        }};
      });
      await page.addScriptTag({path:path.join(root,'lead-welcome.js')});
      await page.evaluate(()=>openSettings());
      const form=page.locator('#lead-welcome-form');await form.waitFor();
      assert.equal(await form.locator('[name=enabled]').isChecked(),false);
      assert.equal(await form.locator('[name=channel]').inputValue(),'sms');
      assert.match(await form.locator('[data-lw-readiness]').innerText(),/Twilio configuration/);
      assert.match(await form.locator('[data-lw-preview]').innerText(),/Hi Alex, thanks for contacting Nova Exterior!/);
      assert.equal(await page.locator('.lw-history li').count(),10);assert.equal(await page.locator('.lw-history img').count(),0);
      assert.equal(await page.evaluate(()=>calls.length),1);
      assert.equal(await form.locator('[name=subject]').isVisible(),true);
      const originalBody=await form.locator('[name=body]').inputValue();
      await form.locator('[name=body]').fill('No link placeholder here');await form.locator('[type=submit]').click();
      assert.match(await form.locator('[data-lw-error]').innerText(),/Include \{trust_link\}/);
      assert.equal(await page.evaluate(()=>calls.length),1);
      await form.locator('[name=body]').fill(originalBody);
      await form.locator('[name=enabled]').check();await form.locator('[type=submit]').click();
      assert.match(await form.locator('[data-lw-error]').innerText(),/Twilio/);assert.equal(await page.evaluate(()=>calls.length),1);
      await form.locator('[name=enabled]').uncheck();await form.locator('[type=submit]').click();
      await page.waitForFunction(()=>document.querySelector('[data-lw-status]').textContent==='Saved: automatic welcomes are off.');
      assert.equal(await page.evaluate(()=>JSON.parse(calls.at(-1).body).enabled),false);
      await form.locator('[name=channel]').selectOption('email');
      assert.match(await form.locator('[data-lw-readiness]').innerText(),/ready through Gmail/);
      await form.locator('[name=body]').fill('Hi {customer_name}, <script>plain text</script> {trust_link}');
      assert.match(await form.locator('[data-lw-preview]').innerText(),/<script>plain text<\/script>/);
      assert.equal(await form.locator('[data-lw-preview] script').count(),0);
      await form.locator('[name=source-wix]').check();await form.locator('[name=enabled]').check();
      await page.evaluate(()=>window.failSave=true);await form.locator('[type=submit]').click();
      await page.waitForFunction(()=>document.querySelector('[data-lw-error]').textContent==='Save failed');
      assert.equal(await form.locator('[name=enabled]').isChecked(),true);assert.equal(await form.locator('[type=submit]').isEnabled(),true);
      await page.evaluate(()=>window.failSave=false);await form.locator('[type=submit]').click();
      await page.waitForFunction(()=>document.querySelector('[data-lw-status]').textContent==='Saved: automatic welcomes are on.');
      assert.deepEqual(await page.evaluate(()=>{const v=JSON.parse(calls.at(-1).body);return {enabled:v.enabled,channel:v.channel,sources:v.sources,consentMode:v.consentMode};}),{enabled:true,channel:'email',sources:['wix','meta','booking'],consentMode:'explicit'});
      assert(await page.locator('[data-lw-subject]').isVisible());
      await page.screenshot({path:path.join(os.tmpdir(),`turnkey-lead-welcome-${width}.png`),fullPage:true});
      const bounds=await form.boundingBox();assert(bounds.x+bounds.width<=width+1);
      await page.evaluate(()=>{window.currentBusinessId='business-b';window.businessSessionVersion++;});
      const count=await page.evaluate(()=>calls.length);await form.locator('[type=submit]').click();assert.equal(await page.evaluate(()=>calls.length),count);
      await page.evaluate(()=>{window.failLoad=true;openSettings();});await page.locator('[data-lw-retry]').waitFor();assert.equal(await page.locator('#lead-welcome-form').count(),0);
      await page.evaluate(()=>window.failLoad=false);await page.locator('[data-lw-retry]').click();await form.waitFor();
      await page.evaluate(()=>{window.defer=true;openSettings();});
      await page.waitForFunction(()=>!!window.release);
      await page.evaluate(()=>{window.currentBusinessId='business-c';window.businessSessionVersion++;release();});
      await page.waitForTimeout(20);assert.equal(await page.locator('#lead-welcome-form').count(),0);
      await page.close();
    }
  }finally{await browser.close();}
});
