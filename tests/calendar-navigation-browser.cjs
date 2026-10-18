/* Focused navigation check; optionally exercise the real SDK via TURNKEY_CALENDAR_SDK. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const cached=path.join(require('node:os').homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser=await chromium.launch({headless:true,...(!fs.existsSync(chromium.executablePath())?{executablePath:cached}:{})});
  try{
    const page=await browser.newPage({timezoneId:'Pacific/Auckland'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.clock.setFixedTime(new Date('2026-10-18T01:00:00Z'));
    await page.setContent(fs.readFileSync('tests/fixtures/job-calendar.html','utf8'));
    await page.evaluate(()=>{
      window.renderAll=()=>{};window.openMoreSheet=()=>{};
      window.switchView=()=>window.renderCalendar();
    });
    if(process.env.TURNKEY_CALENDAR_SDK){
      await page.addScriptTag({path:process.env.TURNKEY_CALENDAR_SDK});
      await page.evaluate(()=>{const Original=FullCalendar.Calendar;FullCalendar.Calendar=class extends Original{constructor(...args){super(...args);window.calendarUnderTest=this;}};});
    }
    await page.addScriptTag({path:path.resolve('job-calendar.js')});
    await page.evaluate(()=>{
      window.pending=[];
      TK_JOB_CALENDAR.configure({getBusinessId:()=> 'navigation-test',getUserId:()=> 'owner',request:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
      renderCalendar();
    });
    // Navigation must respond before the backend returns, including cold starts.
    const title=()=>page.locator('#tkjc-title').innerText();
    assert.equal(await title(),'Oct 2026');
    await page.click('[data-tkjc="next"]');assert.equal(await title(),'Nov 2026');
    await page.click('[data-tkjc="prev"]');assert.equal(await title(),'Oct 2026');
    for(const [view,type] of [['week','timeGridWeek'],['day','timeGridDay'],['list','listMonth'],['month','dayGridMonth']]){
      await page.click('[data-tkjc-view="'+view+'"]');
      assert.equal(await page.locator('[data-tkjc-view="'+view+'"]').getAttribute('aria-pressed'),'true');
      if(process.env.TURNKEY_CALENDAR_SDK)assert.equal(await page.evaluate(()=>calendarUnderTest.view.type),type);
    }
    await page.click('[data-tkjc-view="day"]');
    const day=await title();await page.click('[data-tkjc="next"]');assert.notEqual(await title(),day);
    await page.click('[data-tkjc="prev"]');assert.equal(await title(),day);
    await page.click('[data-tkjc-view="week"]');
    const week=await title();await page.click('[data-tkjc="next"]');assert.notEqual(await title(),week);
    await page.click('[data-tkjc="prev"]');assert.equal(await title(),week);
    await page.click('[data-tkjc="today"]');
    // Resolve the newest request first. Old requests must not reset the display.
    await page.evaluate(()=>{pending.at(-1).resolve({jobs:[],events:[],blocks:[],staff:[],canManage:true});});
    await page.waitForFunction(()=>document.querySelector('#tkjc-load-status').hidden);
    const latest=await title();
    await page.evaluate(()=>pending.slice(0,-1).forEach(p=>p.resolve({jobs:[],events:[],blocks:[],staff:[]})));
    assert.equal(await title(),latest);
    // A failed request leaves navigation usable and exposes a retry.
    await page.click('[data-tkjc="next"]');
    await page.evaluate(()=>pending.at(-1).reject(Error('Backend unavailable')));
    await page.getByRole('button',{name:'Retry loading calendar'}).waitFor();
    await page.click('[data-tkjc-view="month"]');assert.match(await title(),/2026/);
    await page.evaluate(()=>pending.at(-1).resolve({jobs:[],events:[],blocks:[],staff:[],canManage:true}));
    await page.waitForFunction(()=>document.querySelector('#tkjc-load-status').hidden);
    assert.deepEqual(errors,[]);
    console.log('PASS calendar date/view navigation, delayed responses, stale replies and recovery'+(process.env.TURNKEY_CALENDAR_SDK?' (real FullCalendar)':''));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
