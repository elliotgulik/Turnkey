import test from 'node:test';
import assert from 'node:assert/strict';
import { quotePdf, approvedLines, SCOPES } from './salesTransfer.js';
const snapshot=()=>({amount:115,details:{gstRegistered:true,services:[{svc:'driveway',qty:10,priceSnapshot:115}]}});
const pdf=(s,mode='quote')=>quotePdf({reference:'Q-TEST',business:{name:'Test Business'},customer:{name:'Customer'},snapshot:s,mode});
function validPdf(buffer) {
  const source=buffer.toString();const start=Number(/startxref\n(\d+)/.exec(source)[1]);
  assert.equal(buffer.subarray(start,start+4).toString(),'xref');
  const xref=source.slice(start).split('\n');const count=Number(xref[1].split(' ')[1]);
  for(let i=1;i<count;i++){
    const offset=Number(xref[i+2].slice(0,10));assert.ok(buffer.subarray(offset).toString().startsWith(`${i} 0 obj\n`));
  }
  for(const m of source.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g))assert.equal(Buffer.byteLength(m[2]),Number(m[1]));
}
test('PDF modes and fallback material labels distinguish draft from approved without changing totals',()=>{
  for(const mode of ['quote','approved']){
    const s=snapshot();delete s.details.services[0].priceSnapshot;
    const out=pdf(s,mode);validPdf(out);
    assert.match(out.toString(),mode==='quote'?/DRAFT QUOTE/:/APPROVED QUOTE/);
    assert.match(approvedLines(s,{mode})[0].name,mode==='quote'?/^Draft/:/^Approved/);
    if(mode==='quote')assert.doesNotMatch(out.toString(),/APPROVED|Approved/);
    assert.match(out.toString(),/115.00/);
  }
});
test('PDF vector outline uses public service labels and colors, closes polygons and keeps lines open',()=>{
  const s=snapshot();s.details.areaPolys=[
    {service:'driveway',points:[{x:0,y:0},{x:100,y:0},{x:100,y:100}],notes:'PRIVATE',cost:123},
    {service:'gutter',points:[{x:0,y:30},{x:20,y:40}],label:'SECRET'}];
  s.details.estimatedCost='PRIVATE COST';const out=pdf(s);validPdf(out);
  const text=out.toString();assert.match(text,/Measured service outlines/);assert.match(text,/Driveway \/ Patio Cleaning/);
  assert.match(text,/Gutter Cleaning/);assert.match(text,/not aerial imagery/);assert.match(text,/ h S/);
  assert.match(text,/0.7608 0.4078 0.2275 RG/);assert.doesNotMatch(text,/PRIVATE|SECRET|estimatedCost|NaN|Infinity/);
  assert.equal((text.match(/ h S/g)||[]).length,1);
});
test('geographic outlines project saved geometry, including across the date line',()=>{
  const s=snapshot();s.details.areaPolys=[{service:'driveway',geoPts:[{lat:-37,lng:179.999},{lat:-37,lng:-179.999},{lat:-37.001,lng:-179.999}]}];
  const out=pdf(s);validPdf(out);assert.match(out.toString(),/Geographic coordinates/);assert.doesNotMatch(out.toString(),/NaN|Infinity/);
});
test('invalid, mixed-coordinate and oversized geometry never fabricates a partial outline',()=>{
  for(const areaPolys of [
    [{service:'driveway',points:[{x:0,y:0},null,{x:2,y:2}]}],
    [{service:'driveway',points:Array(2001).fill({x:0,y:0})}],
    [{service:'unknown',points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]}],
    [{service:'gutter',points:[{x:0,y:0},{x:1,y:1}]},{service:'gutter',geoPts:[{lat:-37,lng:174},{lat:-37.1,lng:174.1}]}]
  ]){const s=snapshot();s.details.areaPolys=areaPolys;const out=pdf(s);validPdf(out);assert.doesNotMatch(out.toString(),/Measured service outlines|NaN|Infinity/);}
});
test('PDF paginates long terms and outline legends without losing valid areas',()=>{
  const s=snapshot();s.details.publicTerms=Array(100).fill('Public terms').join('\n');
  s.details.areaPolys=Array.from({length:17},(_,i)=>({service:'gutter',points:[{x:i,y:0},{x:i+1,y:1}]}));
  const out=pdf(s);validPdf(out);assert.match(out.toString(),/17. Gutter Cleaning/);assert.match(out.toString(),/\/Count 5/);
});

test('shared OAuth scopes include job promotion permission exactly once',()=>{
  const scopes=SCOPES.split(' ');
  for(const scope of ['read_jobs','create_jobs','manage_jobs'])assert.equal(scopes.filter(s=>s===scope).length,1);
});
