/* Sales stages preserve stored identities while grouping overlapping legacy steps. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TK_PIPELINE=api;})(typeof window==='object'?window:globalThis,function(){
 const stages=[
  {key:'new',label:'New enquiries',description:'Contact the customer and understand the work.',action:'Contact customer'},
  {key:'contacted',label:'Discussing the job',description:'Confirm the services, address and scope.',action:'Prepare quote'},
  {key:'quoting',label:'Preparing quote',description:'Measure, price and review profitability.',action:'Continue quote'},
  {key:'quoted',label:'Awaiting customer',description:'Quote sent. Follow up and record the decision.',action:'Follow up'},
  {key:'won',label:'Confirmed',description:'Sale won. Transfer and track it in ServiceM8.',action:'View handoff'},
  {key:'lost',label:'Not proceeding',description:'Keep the reason for future sales analysis.',action:'View record'}
 ];
 function key(r){if(['won','scheduled','completed','paid'].includes(r.stage))return 'won';if(r.stage==='lost'||r.stage==='cancelled'&&r.lostAt)return 'lost';if(r.stage==='qualified')return 'contacted';if(r.stage==='followup')return 'quoted';return r.stage;}
 function visible(r,scope='open'){const s=key(r);if(r.stage==='cancelled'&&!r.lostAt)return false;if(scope==='all')return true;if(scope==='won'||scope==='lost')return s===scope;return s!=='won'&&s!=='lost';}
 function next(r){const s=key(r);return s==='new'?'contact':s==='contacted'||s==='quoting'?'quote':s==='quoted'?'contact':'detail';}
 return {stages,key,visible,next};
});
