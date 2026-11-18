const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { chromium } = require('playwright');

// Use the real renderer and production stylesheet order without connecting to CRM data.
function fixture() {
  const host = { innerHTML:'' }, store = new Map();
  const records = [
    {id:1,stage:'new',name:'Urgent customer',urgency:'ASAP',createdAt:Date.now()},
    {id:2,stage:'new',name:'Partial enquiry'},
    {id:3,stage:'new',name:'Outside area',suburb:'Manurewa'},
    {id:4,stage:'new',createdAt:Date.now()},
    {id:5,stage:'new',name:'Already read',createdAt:Date.now()},
  ];
  const context = {
    records,currentBusinessId:'badge-test',render(){},switchView(){},handleAuthedSession(){},openMoreSheet(){},
    document:{addEventListener(){},querySelector(){return null;},getElementById(id){return id==='view-leads'?host:null;}},
    localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},
    window:{TK_LEAD_ANSWERS:require('../lead-answer-utils.js')},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../nova-lead-manager.js'),'utf8'),context);
  context.window.TK_NOVA_LEAD_MANAGER.setRead(records[4],true);
  context.window.TK_NOVA_LEAD_MANAGER.render();
  const index = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const styles = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"?]+)[^"]*"[^>]*>|<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map(m=>m[2]??(!/^https?:/.test(m[1])?fs.readFileSync(path.join(__dirname,'..',m[1]),'utf8'):''));
  return `<style>${styles.join('\n')}</style><main id="view-leads">${host.innerHTML}</main>`;
}
function contrast(fg,bg) {
  const luminance=color=>color.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
  const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}

test('production cascade keeps neutral rows, square readable grades and prominent unread markers', async()=>{
  const cached=path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{executablePath:cached})});
  try {
    const markup=fixture();
    for(const width of [1440,390,360]) {
      const page=await browser.newPage({viewport:{width,height:980}});
      await page.route('**/*',route=>route.abort());
      await page.setContent(markup);
      const rows=page.locator('[data-nlm-record]');
      assert.equal(await rows.count(),5);
      for(let i=0;i<5;i++) {
        const row=page.locator(`[data-nlm-record="${i+1}"]`),badge=row.locator('.nlm-grade');
        const style=await badge.evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {fg:s.color,bg:s.backgroundColor,w:r.width,h:r.height,font:parseFloat(s.fontSize),text:el.textContent};});
        assert.equal(style.w,28);assert.equal(style.h,28);assert(style.font>=15);
        assert.equal(style.text,['A','B','C','?','B'][i]);
        assert(contrast(style.fg,style.bg)>=4.5,`${style.text} contrast at ${width}`);
        assert.match(await badge.getAttribute('aria-label'),/Grade [ABC]:|Needs review:/);
        assert.equal(await row.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
        const rect=await row.boundingBox();assert(rect.x+rect.width<=width+1,`Row overflow at ${width}`);
      }
      const fresh=page.locator('[data-nlm-record="1"] .nlm-new'),older=page.locator('[data-nlm-record="2"] .nlm-new');
      assert.equal(await fresh.innerText(),'NEW');assert.equal(await older.innerText(),'UNREAD');
      const marker=await fresh.evaluate(el=>{const s=getComputedStyle(el);return {fg:s.color,bg:s.backgroundColor,h:el.getBoundingClientRect().height};});
      assert(contrast(marker.fg,marker.bg)>=7);assert(marker.h>=28);
      assert.equal(await page.locator('[data-nlm-record="5"] .nlm-new').isVisible(),false);
      await page.locator('[data-nlm-record="1"]').hover();
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-nlm-record="1"]')).backgroundColor==='rgb(243, 245, 245)');
      const hover=await page.locator('[data-nlm-record="1"]').evaluate(el=>getComputedStyle(el).backgroundColor);
      assert.equal(hover,'rgb(243, 245, 245)');
      await page.screenshot({path:path.join(os.tmpdir(),`turnkey-lead-badges-${width}.png`),fullPage:true});
      await page.close();
    }
  } finally {await browser.close();}
});
