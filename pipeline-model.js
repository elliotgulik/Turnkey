/* Sales stages preserve stored identities while grouping overlapping legacy steps. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TK_PIPELINE=api;})(typeof window==='object'?window:globalThis,function(){
 const stages=[
  {key:'new',label:'New lead',description:'New enquiry awaiting contact.',action:'Contact customer'},
  {key:'contacted',label:'Contacted',description:'Customer contacted; prepare and send their quote.',action:'Build quote'},
  {key:'quoted',label:'Quote sent',description:'Quote delivered; awaiting the customer’s decision.',action:'Follow up'},
  {key:'won',label:'Quote confirmed',description:'Customer accepted the quote; ready for booking.',action:'View record'},
  {key:'lost',label:'Cancelled',description:'Enquiry or job cancelled; history is preserved.',action:'View record'}
 ];
 function key(r){if(r.stage==='lost'||r.stage==='cancelled')return 'lost';if(['won','scheduled','completed','paid'].includes(r.stage))return 'won';if(['qualified','quoting'].includes(r.stage))return 'contacted';if(r.stage==='followup')return 'quoted';return r.stage;}
 function visible(r,scope='open'){const s=key(r);if(scope==='all')return true;if(scope==='won'||scope==='lost')return s===scope;return s!=='won'&&s!=='lost';}
 // Invoke only after an actual successful communication/approval event.
 function applyEvent(r,event,at=Date.now()){
  const current=key(r);
  if(['won','lost'].includes(current))return false;
  let to;
  if(event==='contacted'&&current==='new')to='contacted';
  if(event==='quote-sent')to='quoted';
  if(!to)return false;
  r.firstResponseAt=r.firstResponseAt||at;
  if(event==='quote-sent'){r.quoteSentAt=r.quoteSentAt||at;r.lastQuoteSentAt=at;}
  const changed=current!==to;r.stage=to;
  if(changed)r.salesHistory=[...(r.salesHistory||[]),{at,to,label:stages.find(s=>s.key===to).label,automatic:true}];
  return changed;
 }

 function next(r){const s=key(r);return s==='new'?'contact':s==='contacted'||s==='quoting'?'quote':s==='quoted'?'contact':'detail';}
 return {stages,key,visible,next,applyEvent};
});
