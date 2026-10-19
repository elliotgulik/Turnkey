const test=require('node:test'),assert=require('node:assert/strict');
const binding={businessId:'B',customerId:'C',jobId:'J',quoteId:'Q',recordId:7};
const payload={customer:{id:'C'},isNewCustomer:false,address:'42 Road',lines:[{svc:'windows',qty:12,fixedPrice:650.37}],total:650.37,areaPolys:[]};
async function fixture({quoteId='Q',quoteStatus='draft',lostResponse=false}={}) {
  const {TurnKeyClient}=await import('../api/turnkey-api.js');
  const client=new TurnKeyClient({},{}),calls=[];
  client.getProfile=async()=>({business_id:'B'});
  let job={id:'J',business_id:'B',customer_id:'C',quote_id:quoteId,status:'new',details:{requestedServices:['Windows'],jobNotes:'Back panes',other:'preserve'}};
  let quote=quoteId ? {id:quoteId,business_id:'B',lead_id:'C',amount:300,status:quoteStatus,public_token:'token'} : null;
  client._rest=async(route,options)=>{
    calls.push({route,options});
    const table=route.split('?')[0];
    if(!options)return table==='jobs'?[job]:table==='quotes'?[quote]:[];
    const data=JSON.parse(options.body);
    if(table==='quotes') {quote={...quote,...data,public_token:'token'};return [quote]}
    job={...job,...data};
    if(lostResponse){lostResponse=false;throw Error('Response lost')}
    return [job];
  };
  return {client,calls,job:()=>job};
}

test('bound save updates the original draft/job, preserves enquiry fields, and safely retries a lost response',async()=>{
  const {createQuoteDraft}=await import('../content/panel/quote-create.js');
  const f=await fixture({lostResponse:true});
  f.client.logActivity=async()=>{};
  f.client.createJob=()=>assert.fail('must never create another job');
  const progress={};
  const result=await createQuoteDraft(f.client,progress,{businessId:'B',binding,payload});
  assert.equal(result.job.id,'J');assert.equal(result.quote.id,'Q');
  assert.equal(result.job.details.jobNotes,'Back panes');assert.deepEqual(result.job.details.requestedServices,['Windows']);
  assert.equal(result.job.details.total,650.37);
  const before=f.calls.length;
  await createQuoteDraft(f.client,progress,{businessId:'B',binding,payload});assert.equal(f.calls.length,before);
  const patches=f.calls.filter(call=>call.options?.method==='PATCH');
  assert.equal(patches.length,2);
  for(const {route} of patches){assert.match(route,/business_id=eq.B/);assert.match(route,/id=eq.[JQ]/)}
  assert.match(patches[1].route,/customer_id=eq.C/);assert.match(patches[1].route,/details=eq./);
});

test('a new draft is attached to the existing opportunity, never a new job',async()=>{
  const f=await fixture({quoteId:null});
  const result=await f.client.saveBoundQuote('B',{binding:{...binding,quoteId:null},quoteId:'stable-id',total:650.37,details:{services:payload.lines,total:650.37}});
  assert.equal(result.job.id,'J');assert.equal(result.job.quote_id,'stable-id');
  assert.equal(f.calls.filter(call=>call.route==='quotes'&&call.options?.method==='POST').length,1);
});

test('sent quotes, reassigned job bindings and foreign businesses cannot be overwritten',async()=>{
  const sent=await fixture({quoteStatus:'sent'});
  await assert.rejects(sent.client.saveBoundQuote('B',{binding,quoteId:'unused',total:500,details:{}}),/already sent/);
  assert.equal(sent.calls.filter(call=>call.options).length,0);
  const foreign=await fixture();
  await assert.rejects(foreign.client.saveBoundQuote('OTHER',{binding,quoteId:'unused',total:500,details:{}}),/business changed/);
  assert.equal(foreign.calls.length,0);
  foreign.client.getJob=async()=>null;
  await assert.rejects(foreign.client.saveBoundQuote('B',{binding,quoteId:'unused',total:500,details:{}}),/no longer editable/);
});

test('creation rejects changed customers, changed opportunities and legacy local-only record references',async()=>{
  const {createQuoteDraft}=await import('../content/panel/quote-create.js');
  await assert.rejects(createQuoteDraft({}, {}, {businessId:'B',binding,payload:{...payload,customer:{id:'OTHER'}}}),/original business and customer/);
  await assert.rejects(createQuoteDraft({}, {}, {businessId:'B',binding:{...binding,jobId:null},payload}),/saved job ID/);
  await assert.rejects(createQuoteDraft({}, {binding}, {businessId:'B',binding:{...binding,jobId:'OTHER'},payload}),/original opportunity/);
});


test('an async account change after the job read prevents all bound quote writes',async()=>{
  const f=await fixture();let checks=0;
  await assert.rejects(f.client.saveBoundQuote('B',{binding,quoteId:'unused',total:500,details:{}},async()=>{
    if(++checks===2)throw Error('Account changed during read');
  }),/Account changed/);
  assert.equal(f.calls.filter(call=>call.options).length,0);
});

test('saving a draft preserves contacted stage until it is actually sent',async()=>{
  const f=await fixture();
  const original=f.client.getJob.bind(f.client);
  f.client.getJob=async(...args)=>({...await original(...args),status:'contacted'});
  await f.client.saveBoundQuote('B',{binding,quoteId:'unused',total:650.37,details:{services:payload.lines,total:650.37}});
  const write=f.calls.find(c=>c.route.startsWith('jobs?')&&c.options?.method==='PATCH');
  assert.equal(JSON.parse(write.options.body).status,'contacted');
});
