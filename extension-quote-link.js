// Open a newly created extension quote after the authenticated business loads.
// No customer data or credentials are carried in the URL.
(function(){
  'use strict';
  const target=new URL(location.href).searchParams.get('job');
  if(!target||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target))return;
  let opened=false;
  function openImportedQuote(){
    const ready=window.TK_READY_BUSINESS;
    if(opened||!ready||ready.id!==currentBusinessId||ready.version!==businessSessionVersion||!businessStateReady)return;
    const row=records.find(r=>r.jobId===target&&recordBusinesses.get(r)===currentBusinessId);
    if(!row){toast('This quote is not available in the signed-in business. Check you are using the account connected to the extension.');return;}
    opened=true;
    const url=new URL(location.href);url.searchParams.delete('job');history.replaceState(null,'',url.pathname+url.search+url.hash);
    openDetail(row.id);
    toast('Your measured quote is ready.');
  }
  window.addEventListener('turnkey:business-ready',openImportedQuote);
  openImportedQuote();
})();
