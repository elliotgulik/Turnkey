const test=require('node:test'),assert=require('node:assert/strict');
const L=require('../lead-priority.js');
test('value sorting uses real quotes then opportunity estimates, keeping unknown last',()=>{
 const rows=[{id:'a',opportunityValue:1200},{id:'b',total:500,opportunityValue:4000},{id:'c'},{id:'d',opportunityValue:2500}];
 assert.deepEqual(L.sort(rows,'value-high').map(x=>x.id),['d','a','b','c']);
 assert.deepEqual(L.sort(rows,'value-low').map(x=>x.id),['b','a','d','c']);
 assert.equal(rows[0].id,'a');assert.equal(L.grade(rows[2]).label,'Value not estimated');
 assert.equal(L.grade(rows[3]).label,'High value');assert.equal(L.value({total:Infinity}),null);
});
test('lead dates and overdue followups sort with missing dates last',()=>{
 const rows=[{id:'a',createdAt:100,nextFollowUpAt:'2026-10-12'},{id:'b',requestSubmittedAt:300,createdAt:1},{id:'c',createdAt:200,nextFollowUpAt:'2026-10-10'},{id:'d',createdAt:'bad'}];
 assert.deepEqual(L.sort(rows,'newest').map(x=>x.id),['b','c','a','d']);
 assert.deepEqual(L.sort(rows,'oldest').map(x=>x.id),['a','c','b','d']);
 assert.deepEqual(L.sort(rows,'followup').map(x=>x.id),['c','a','b','d']);
});
