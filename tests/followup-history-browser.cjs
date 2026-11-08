/* Real production history modal/handlers, isolated API fixture; no live accounts. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../sales-platform.js'),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const production=section('  function modal(title, html)', '  function quotePickerRows(')+section('  let followupHistorySerial =','  let followupEditorSerial =')+section('  document.addEventListener("click", async (e) => {','  // Match mobile selection');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const screenshots=fs.mkdtempSync(path.join(os.tmpdir(),'turnkey-followup-history-'));
 try{for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:980}});page.setDefaultTimeout(5000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());
 await page.setContent('<!doctype html><html><body><button data-sale-action="followup-history">Sent follow-ups</button></body></html>');
 await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../sales-platform.css'),'utf8')});
 await page.addScriptTag({content:`
 var currentBusinessId='a',currentUserRole='owner',calls=[],fail=false,hold=false,release,emptyPage=false;
 function peopleScope(){return currentBusinessId+':owner:1';}
 function canEditFollowupSettings(){return ['owner','manager'].includes(currentUserRole);}
 function record(){return null;}function closeModal(){}function error(e){throw e;}
 function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
 function button(t,a,id='',extra=''){return '<button type="button" class="btn ghost sm" data-sale-action="'+a+'" data-id="'+esc(id)+'" '+extra+'>'+esc(t)+'</button>';}
 function dates(v){return new Date(v).toLocaleString();}function empty(t){return '<p>'+esc(t)+'</p>';}
 async function api(url){calls.push(url);if(hold)await new Promise(r=>release=r);if(fail)throw Error('fixture unavailable');const q=new URL(url,'https://fixture.test').searchParams,offset=Number(q.get('offset')),replyOffset=Number(q.get('repliesOffset'));return {items:emptyPage?[]:[{id:'one',customer_name:'Customer <img src=x onerror=alert(1)>',subject:'Quote </summary><script>alert(1)</script>',bodyText:'Hello\\n'+('VeryLongUnbrokenCustomerMessage'.repeat(12)),sent_at:'2026-11-01T01:00:00Z',status:offset?'unknown':'sent',stoppedReason:'customer_replied',replyMatch:'thread',replies:[{id:replyOffset?'reply-2':'reply-1',subject:'Re: quote',bodyText:replyOffset?'Second response':'Thanks <img src=x>\\nPlease call.',sent_at:'2026-11-02T01:00:00Z'}],repliesHasMore:!replyOffset,repliesNextOffset:replyOffset?null:25}],hasMore:!offset};}
 `+production});
 const open=()=>page.getByRole('button',{name:'Sent follow-ups',exact:true}).click();
 await open();await page.waitForSelector('.sale-followup-history-row');
 assert.match(await page.locator('#sales-dialog').innerText(),/Stopped · Customer replied/);
 assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
 assert.equal(await page.locator('#sales-dialog img,#sales-dialog script').count(),0);
 await page.locator('summary').click();await page.getByRole('button',{name:'More responses',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('sales-dialog').textContent.includes('Second response'));
 assert.match(await page.locator('#sales-dialog').innerText(),/Thanks <img src=x>/);
 assert.equal(await page.locator('details').getAttribute('open'),'');
 assert.equal(await page.locator('#sales-dialog img,#sales-dialog script').count(),0);
 assert.ok(await page.locator('#sales-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'modal fits viewport');
 await page.screenshot({path:path.join(screenshots,'history-'+width+'.png')});
 await page.getByRole('button',{name:'Next',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#sale-followup-history').textContent.includes('Page 2'));
 assert.match(await page.locator('#sales-dialog').innerText(),/Delivery unconfirmed/);
 assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
 await page.evaluate(()=>fail=true);await page.getByRole('button',{name:'More responses',exact:true}).click();
 await page.waitForSelector('.sale-followup-replies [role="alert"]');
 assert.match(await page.locator('.sale-followup-replies').innerText(),/Thanks/);
 await page.evaluate(()=>fail=false);await page.getByRole('button',{name:'More responses',exact:true}).click();await page.waitForFunction(()=>document.getElementById('sales-dialog').textContent.includes('Second response'));
 await page.evaluate(()=>fail=true);await page.getByRole('button',{name:'Previous',exact:true}).click();await page.waitForSelector('#sale-followup-history [role="alert"]');
 await page.evaluate(()=>{fail=false;emptyPage=true;});await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>document.getElementById('sales-dialog').textContent.includes('No follow-up history'));
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.evaluate(()=>{emptyPage=false;hold=true;});await open();await page.waitForFunction(()=>typeof release==='function');
 await page.evaluate(()=>{currentBusinessId='b';release();});await page.waitForTimeout(30);
 assert.equal(await page.locator('.sale-followup-history-row').count(),0,'stale business responses discarded');
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.evaluate(()=>{hold=false;currentUserRole='staff';});
 const before=await page.evaluate(()=>calls.length);await open();assert.equal(await page.evaluate(()=>calls.length),before,'staff cannot fetch history');
 assert.deepEqual(errors,[]);await page.close();
 }
 console.log('History browser checks passed at 1280px and 390px; screenshots: '+screenshots);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
