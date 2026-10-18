const {test}=require('node:test'),assert=require('node:assert/strict'),P=require('../pipeline-model.js');
test('legacy qualified and followup retain useful sales groups',()=>{assert.equal(P.key({stage:'qualified'}),'contacted');assert.equal(P.key({stage:'followup'}),'quoted');assert.equal(P.key({stage:'scheduled'}),'won');assert.equal(P.stages.length,5);});
test('open work does not mix with outcomes or cancelled operations',()=>{assert.equal(P.visible({stage:'scheduled'}),false);assert.equal(P.visible({stage:'cancelled'}),false);assert.equal(P.visible({stage:'cancelled',lostAt:1},'lost'),true);assert.equal(P.visible({stage:'qualified'}),true);});
test('next actions match the actual sales job',()=>{assert.equal(P.next({stage:'new'}),'contact');assert.equal(P.next({stage:'qualified'}),'quote');assert.equal(P.next({stage:'followup'}),'contact');assert.equal(P.next({stage:'won'}),'detail');});

test('five clear stages preserve older quoting and cancelled records',()=>{
 assert.deepEqual(P.stages.map(s=>s.label),['New lead','Contacted','Quote sent','Quote confirmed','Cancelled']);
 assert.equal(P.key({stage:'quoting'}),'contacted');assert.equal(P.key({stage:'cancelled'}),'lost');assert.equal(P.visible({stage:'cancelled'},'lost'),true);
});
test('successful events advance once and never regress confirmed or cancelled records',()=>{
 const r={stage:'new'};assert.equal(P.applyEvent(r,'contacted',100),true);assert.equal(r.stage,'contacted');
 assert.equal(P.applyEvent(r,'contacted',200),false);assert.equal(r.firstResponseAt,100);
 assert.equal(P.applyEvent(r,'quote-sent',300),true);assert.equal(r.stage,'quoted');assert.equal(r.quoteSentAt,300);
 P.applyEvent(r,'quote-sent',400);assert.equal(r.quoteSentAt,300);assert.equal(r.lastQuoteSentAt,400);assert.equal(r.salesHistory.length,2);
 for(const stage of ['won','scheduled','completed','paid','cancelled','lost']){const terminal={stage};assert.equal(P.applyEvent(terminal,'quote-sent'),false);assert.equal(terminal.stage,stage);}
});
