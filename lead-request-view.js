/* Original customer enquiries stay separate from priced quote/job line items. */
(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function requests(r){
    const reader=root.TK_LEAD_ANSWERS;if(!reader)return [];
    const source=String(r?.source||'').toLowerCase();
    const selected=(Array.isArray(r?.requestedServices)?r.requestedServices:[]).map(x=>typeof x==='string'?x:x?.name||x?.label).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim());
    if(source==='wix'&&selected.length)return [...new Set(selected)];
    const notes=String(r?.notes||'');
    const written=reader.servicesFromNotes(notes);
    if(written.length)return [...new Set(written)];
    // Imported job materials describe supplied work, not an incoming enquiry.
    if(source==='servicem8'||r?.importedFrom==='servicem8')return [];
    return [...new Set((Array.isArray(r?.requestedServices)?r.requestedServices:[])
      .map(x=>typeof x==='string'?x:x?.name||x?.label).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))];
  }
  function renderAnswers(r){
    const rows=root.TK_LEAD_ANSWERS?.answersFromSubmission?.(r?.formAnswers)||[];
    return rows.length?`<section class="sale-panel tk-form-submission" aria-label="Original form answers"><h3>${String(r.source||'').toLowerCase()==='wix'?'Wix form answers':'Original form answers'}</h3><dl class="nlm-form-answers">${rows.map(row=>`<div><dt>${esc(row.label)}</dt><dd>${esc(row.answer)}</dd></div>`).join('')}</dl></section>`:'';
  }
  function render(r){const answers=requests(r);if(!answers.length)return '';
    return `<section class="tk-lead-request" aria-label="Customer requested services"><strong>Customer requested</strong>${answers.map(answer=>`<p>${esc(answer.replace(/_/g,' '))}</p>`).join('')}</section>`;
  }
  root.TK_LEAD_REQUEST={requests,render,renderAnswers};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.TK_LEAD_REQUEST;
})(typeof window!=='undefined'?window:globalThis);
