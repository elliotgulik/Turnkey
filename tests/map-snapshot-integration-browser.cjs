/* Real public quote page, map helper, preload and PDF builder. RPC/image/SDK
 * boundaries are fixtures; no customer responses, notifications or sends. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const geo={service:'driveway',size:65.25,geoPts:[{lat:-36.8,lng:174.7},{lat:-36.8001,lng:174.7002},{lat:-36.8002,lng:174.7}],notes:'PRIVATE_NOTE',estimatedCost:999};
  const pixel={service:'fence',size:12,points:[{x:20,y:20},{x:90,y:80}],cost:999};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin==='https://quote.test'){
    const name=url.pathname.slice(1)||'quote.html';if(name==='config.js')return route.fulfill({contentType:'text/javascript',body:'window.TURNKEY_CONFIG={supabaseUrl:"https://rpc.test",supabaseAnonKey:"fixture-only",mapsKey:""};'});
    const file=path.resolve(name);if(!file.startsWith(process.cwd()+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
    return route.fulfill({path:file,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'image/png'});
   }
   if(url.origin==='https://rpc.test'){
    assert.equal(url.pathname,'/rest/v1/rpc/get_public_quote','Customer writes must never run');const token=route.request().postDataJSON().p_token;
    return route.fulfill({json:{id:'quote-id',status:'sent',amount:261,createdAt:'2026-10-17',services:[{svc:'driveway',qty:65.25,customRate:4}],business:{name:'Fixture wash'},customer:{name:'Customer',address:'Test property'},areaPolys:token==='pixel'?[pixel]:token==='mixed'?[geo,pixel]:[geo]}});
   }
   if(url.hostname.endsWith('tile.openstreetmap.org'))return route.fulfill({contentType:'image/png',body:png});
   return route.abort();
  });
  await page.goto('https://quote.test/quote.html?t=geo');
  await page.locator('#qmap-svg path').first().waitFor();
  assert.match(await page.locator('#qmap-svg').textContent(),/65.25 m²/);assert.doesNotMatch(await page.locator('body').textContent(),/PRIVATE_NOTE|estimatedCost|999/);
  await page.goto('https://quote.test/quote.html?t=pixel');await page.locator('.measured-outline img').waitFor();
  let svg=decodeURIComponent((await page.locator('.measured-outline img').getAttribute('src')).split(',')[1]);assert.match(svg,/12 m/);assert.match(svg,/<polyline/);
  await page.locator('.measured-outline img').evaluate(img=>img.decode());
  const crop=await page.locator('.measured-outline img').evaluate(img=>({natural:img.naturalHeight/img.naturalWidth,actual:img.getBoundingClientRect().height/img.getBoundingClientRect().width}));assert.ok(Math.abs(crop.natural-crop.actual)<.01,'Fallback diagram must not be cropped');
  await page.goto('https://quote.test/quote.html?t=mixed');await page.locator('#qmap-svg path').first().waitFor();await page.locator('.measured-outline img').waitFor();
  assert.match(await page.locator('#qmap-svg').textContent(),/65.25 m²/);svg=decodeURIComponent((await page.locator('.measured-outline img').getAttribute('src')).split(',')[1]);assert.match(svg,/12 m/);
  // Exercise the actual staff preloader and PDF function against real canvas
  // output. Only jsPDF's output boundary is replaced to inspect image sizing.
  const index=fs.readFileSync('index.html','utf8');const extract=(start,end)=>index.slice(index.indexOf(start),index.indexOf(end,index.indexOf(start)));
  await page.addScriptTag({content:`
   let currentBusinessId='A',currentUserId='user-a',businessSessionVersion=1,sb={};const recordBusinesses=new WeakMap();
   const docTemplate={business:'Test wash',accent:'#138a72',quoteTerms:'Customer terms',invoiceTerms:'Payment terms',footer:'Thank you'};const cachedLogoDataUrl=null;
   const SERVICES=TK_PRICING.SERVICES,ROOF_TYPES=TK_PRICING.ROOF_TYPES,STOREY_TYPES=TK_PRICING.STOREY_TYPES,FENCE_SIDES=TK_PRICING.FENCE_SIDES;
   function docBizName(){return docTemplate.business;}function money(v){return '$'+Number(v).toFixed(2);}
   window.pdfImages=[];window.pdfText=[];
   class SDK {setFillColor(){}rect(){}roundedRect(){}setFont(){}setFontSize(){}setTextColor(){}setDrawColor(){}setLineWidth(){}line(){}addPage(){}text(v){pdfText.push(v);}splitTextToSize(v){return [v];}addImage(...args){pdfImages.push(args);}output(){return 'data:application/pdf;base64,'+btoa('%PDF-1.7 fixture');}}
   window.jspdf={jsPDF:SDK};
  `});
  await page.addScriptTag({content:extract('const mapSnapshotLoads=new WeakMap();','// One-way seed, not a sync:')+extract('function hexToRgb(hex){','\nfunction buildDocEmailBody(')+extract('function docNumber(mode,r){','// Shared by both quote and invoice')+extract('function lineVariantNote(s){','// Green/grey/orange/red')+extract('function docMapSectionHtml(r){','\nfunction renderDocHTML(')});
  const result=await page.evaluate(async()=>{
   const r={id:7,name:'Customer',total:261,areaPolys:currentQuote.areaPolys,services:[{svc:'driveway',qty:65.25,customRate:4}],estimatedCost:999};recordBusinesses.set(r,'A');
   await Promise.all([preloadMapSnapshot(r),preloadMapSnapshot(r)]);buildDocPDF('quote',r,'base64');
   return {width:r._mapSnapshotWidth,height:r._mapSnapshotHeight,image:pdfImages[0].slice(1),data:pdfImages[0][0].slice(0,22),preview:docMapSectionHtml(r),text:pdfText};
  });
  assert.match(result.data,/^data:image\/png;base64,/);const [format,x,y,w,h]=result.image;assert.equal(format,'PNG');assert.ok(Math.abs(h/w-result.height/result.width)<1e-8);assert.ok(y+h<=269);
  assert.match(result.preview,/Property outline and measurements/);assert.doesNotMatch(JSON.stringify(result.text),/estimatedCost|999|PRIVATE_NOTE/);assert.deepEqual(errors,[]);
  console.log('Snapshot integration browser passed: actual public geographic/pixel/mixed outlines and measurements, no crop/private fields, real preload PNG and PDF aspect ratio.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
