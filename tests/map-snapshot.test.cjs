const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const c={URLSearchParams};c.window=c;vm.createContext(c);
for(const f of ['pricing-engine.js','map-snapshot.js'])vm.runInContext(fs.readFileSync(f,'utf8'),c);
const M=c.TK_MAP_SNAPSHOT;
const geo=[{lat:-36.8,lng:174.7},{lat:-36.8001,lng:174.7002},{lat:-36.8002,lng:174.7}];
const pixels=[{x:10,y:10},{x:80,y:10},{x:50,y:90}];
const area=(extra={})=>({service:'driveway',size:42.5,unit:'m²',geoPts:structuredClone(geo),points:structuredClone(pixels),...extra});
test('valid geography renders without obsolete editor pixel points or matching vertex counts',()=>{
 for(const points of [undefined,[],pixels.slice(1)]){
  const url=new URL(M.buildUrl([area({points})],'fixture-key'));
  const path=url.searchParams.get('path');assert.match(path,/-36.800000,174.700000/);assert.match(path,/fillcolor:/);
  assert.equal(path.split('|').at(-1),'-36.800000,174.700000');
 }
});
test('closed areas close once; linear measurements remain open without fill',()=>{
 const closed=new URL(M.buildUrl([area({geoPts:[...geo,geo[0]]})],'fixture-key')).searchParams.get('path');
 assert.equal(closed.match(/-36.800000,174.700000/g).length,2);
 const line=new URL(M.buildUrl([area({service:'fence',geoPts:geo.slice(0,2),size:12})],'fixture-key')).searchParams.get('path');
 assert.doesNotMatch(line,/fillcolor/);assert.equal(line.split('|').length,4);
});
test('invalid vertices never produce phantom polygons or invalid Static Maps requests',()=>{
 for(const bad of [null,{lat:NaN,lng:1},{lat:91,lng:1},{lat:1,lng:181},{lat:'',lng:1},{lat:null,lng:1}]){
  assert.equal(M.buildUrl([area({geoPts:[geo[0],bad,geo[2]],points:undefined})],'fixture-key'),null);
 }
 assert.equal(M.buildUrl([area({geoPts:geo.slice(0,2),points:undefined})],'fixture-key'),null);
 assert.equal(M.buildUrl([area({service:'windows'})],'fixture-key'),null);
});
test('numeric strings normalize before centroid math, without concatenation',()=>{
 const url=new URL(M.buildUrl([area({geoPts:geo.map(p=>({lat:String(p.lat),lng:String(p.lng)}))})],'fixture-key'));
 assert.match(url.searchParams.get('markers'),/color:red\|-36\.800100,174\.700067/);
});
test('SVG carries saved customer measurements and safely escapes labels; no internal data',()=>{
 const input=[area({notes:'PRIVATE_NOTE',cost:999,margin:42,photoPaths:['SECRET_PATH']})];
 const before=JSON.stringify(input),svg=M.buildSvg(input);
 assert.match(svg,/<polygon/);assert.match(svg,/42.5 m²/);assert.match(svg,/Driveway/);assert.doesNotMatch(svg,/PRIVATE|999|margin|SECRET/);
 assert.equal(JSON.stringify(input),before);
 const old=c.TK_PRICING.SERVICES.driveway.label;c.TK_PRICING.SERVICES.driveway.label='<script>bad</script>';
 assert.doesNotMatch(M.buildSvg(input),/<script>/);assert.match(M.buildSvg(input),/&lt;script&gt;/);c.TK_PRICING.SERVICES.driveway.label=old;
});
test('unanchored pixel sketches retain labelled outlines without claiming satellite positioning',()=>{
 const svg=M.buildSvg([area({geoPts:null}),area({service:'gutter',geoPts:null,points:pixels.slice(0,2),size:9})]);
 assert.match(svg,/<polygon/);assert.match(svg,/<polyline/);assert.match(svg,/42.5 m²/);assert.match(svg,/9 m/);assert.match(svg,/not aerial imagery/);
 assert.equal(M.buildUrl([area({geoPts:null})],'fixture-key'),null);
 assert.match(M.buildSvgUrl([area({geoPts:null})]),/^data:image\/svg\+xml/);
});
test('unknown measurements stay unavailable instead of becoming fabricated zeroes',()=>{
 assert.match(M.buildSvg([area({size:null})]),/Measurement unavailable/);
 assert.match(M.buildSvg([area({size:0})]),/0 m²/);
});
test('long paths fail to a local full outline, never silently drop vertices',()=>{
 const pts=Array.from({length:2000},(_,i)=>({lat:-36.8+Math.sin(i/2000*Math.PI*2)*.001,lng:174.7+Math.cos(i/2000*Math.PI*2)*.001}));
 assert.equal(M.buildUrl([area({geoPts:pts,points:undefined})],'fixture-key'),null);
 assert.match(M.buildSvg([area({geoPts:pts,points:undefined})]),/<polygon/);
});
test('fallback address and options are encoded; keys and arbitrary fields never enter SVG',()=>{
 assert.equal(M.buildUrl([area()],''),null);
 const url=new URL(M.buildUrl(null,'test&key',{fallbackAddress:'A & B | Street',size:'999x999',scale:9}));
 assert.equal(url.searchParams.get('center'),'A & B | Street');assert.equal(url.searchParams.get('size'),'640x640');assert.equal(url.searchParams.get('scale'),'2');assert.equal(url.searchParams.get('key'),'test&key');
 assert.equal(M.buildSvg([]),null);
});
test('date-line geometry fits locally and mixed coordinate systems use separate panels',()=>{
 const svg=M.buildSvg([area({geoPts:[{lat:0,lng:179.999},{lat:.001,lng:-179.999},{lat:.002,lng:179.999}],points:undefined})]);
 assert.match(svg,/<polygon/);assert.doesNotMatch(svg,/NaN|Infinity/);
 const mixed=M.buildSvg([area({points:undefined}),area({geoPts:null})]);assert.match(mixed,/Geographic outlines/);assert.match(mixed,/Unanchored sketch/);assert.equal((mixed.match(/<polygon/g)||[]).length,2);
});
