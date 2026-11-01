const test=require('node:test');const assert=require('node:assert/strict');const view=require('../servicem8-pricing-view.js');
const pricing={items:[{name:'House wash',quantity:1,unitPrice:300,lineTotal:300},{name:'Windows',quantity:2,unitPrice:50,lineTotal:100},{name:'Discount',quantity:1,unitPrice:-20,lineTotal:-20}],total:437,currency:'NZD',taxLabel:'including GST',lineTaxLabel:'Line prices excluding GST'};
test('ServiceM8 snapshot displays actual upstream items and total without changing the original quote',()=>{
 const r={total:999,services:[{svc:'housewash'}],serviceM8Pricing:pricing};const before=JSON.stringify(r);const html=view.render(r);
 for(const text of ['House wash','Windows','Discount','300.00','100.00','-$20.00','437.00','excluding GST','including GST'])assert.ok(html.includes(text),text);
 assert.equal(view.total(r),'$437.00');assert.equal(JSON.stringify(r),before);assert.ok(!html.includes('999.00'));
});
test('zero amounts remain zero, missing and malformed prices never silently become zero',()=>{
 const html=view.render({serviceM8Pricing:{items:[null,{name:'Free follow-up',quantity:1,unitPrice:0,lineTotal:0},{name:'Unknown',lineTotal:null}],total:null,currency:'NZD'}});
 assert.match(html,/\$0\.00/);assert.match(html,/Price unavailable/);assert.match(html,/Unavailable/);
 assert.equal(view.total({serviceM8Pricing:{total:'500',currency:'NZD'}}),'Unavailable');assert.equal(view.total({},'Saved quote'),'Saved quote');
});
test('names and upstream labels are escaped and calendar snapshots use the same display',()=>{
 const r={details:{pricing:{...pricing,items:[{name:'<script>unsafe</script>',lineTotal:20}],taxLabel:'<unsafe>'}}};
 const html=view.render(r,{compact:true});assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;unsafe&gt;/);assert.match(html,/compact/);
});
