/* Transparent value bands, not a predictive lead score. All values include GST. */
(function(root){
  'use strict';
  const value=r=>{const v=Number(r.total)>0?Number(r.total):Number(r.opportunityValue);return Number.isFinite(v)&&v>0?v:null;};
  const timestamp=v=>{if(!v)return null;const n=typeof v==='number'?v:Date.parse(v);return Number.isFinite(n)?n:null;};
  const received=r=>timestamp(r.requestSubmittedAt||r.receivedAt||r.createdAt||r.submittedAt||r.created_at);
  function grade(r){const n=value(r);return n===null?{label:'Value not estimated',description:'Enter an opportunity value or save a quote.'}:{label:n>=2000?'High value':n>=750?'Medium value':'Small job',description:'Indicative customer value including GST: small below $750, medium $750–$1,999, high $2,000+. Uses saved quote total when available, otherwise your opportunity estimate. Not a conversion prediction.'};}
  function sort(records,key='newest'){
    return records.slice().sort((a,b)=>{
      let d=0;
      if(key==='name')d=String(a.name||'').localeCompare(String(b.name||''));
      else if(key==='value-high'||key==='value-low'){const x=value(a),y=value(b);d=x===null?(y===null?0:1):y===null?-1:(key==='value-high'?y-x:x-y);}
      else if(key==='followup'){const x=timestamp(a.nextFollowUpAt),y=timestamp(b.nextFollowUpAt);d=x===null?(y===null?0:1):y===null?-1:x-y;}
      else {const x=received(a),y=received(b);d=x===null?(y===null?0:1):y===null?-1:(key==='oldest'?x-y:y-x);}
      return d||String(a.id||'').localeCompare(String(b.id||''));
    });
  }
  const api={value,grade,sort};if(typeof module==='object'&&module.exports)module.exports=api;else root.TK_LEADS=api;
})(typeof window==='object'?window:globalThis);
