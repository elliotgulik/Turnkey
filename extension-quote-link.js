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

// Google Earth customer handoff — THE quoting entry point for an EXISTING
// customer's "Build quote" / customer-profile "Quote" button: this
// REPLACES the old in-page quote builder for that click, it does not fall
// back to it. Whenever the clicked record's tenant/session checks out, a
// compact Earth-launch modal takes over — showing the saved address, an
// "Open Google Earth" link, and (if the extension isn't installed/ready,
// or a launch attempt fails) install/update instructions — instead of
// ever reopening the old builder. Already-SAVED quotes are completely
// untouched: "Edit quote" and "Review & send quote" are never intercepted,
// and nothing here ever reads/writes an existing quote record, only (via
// the extension, once launched) creates a brand-new draft under the SAME
// customer — see extension/content/panel/quote.js's locked customer chip
// and quote-create.js's isNewCustomer=false path.
//
// Talks to the extension's content script
// (extension/content/bridge/customer-launch.js, installed on this same
// origin) purely via same-origin postMessage; this script never touches
// chrome.* APIs directly.
(function(){
  'use strict';
  const PAGE_SOURCE='turnkey-crm-page', EXT_SOURCE='turnkey-customer-launch';
  const LAUNCH_TIMEOUT_MS=8000;
  const ZIP_URL='/assets/turnkey-earth-extension-0.2.8.zip';
  let extensionReady=false;
  const pendingLaunches=new Map(); // nonce -> {resolve,reject,timer}

  window.addEventListener('message',function(event){
    if(event.source!==window||event.origin!==window.location.origin)return;
    const msg=event.data;
    if(!msg||typeof msg!=='object'||msg.source!==EXT_SOURCE)return;
    if(msg.type==='TK_READY'){extensionReady=true;return;}
    if(msg.type==='TK_LAUNCH_ACK'||msg.type==='TK_LAUNCH_ERROR'){
      const pending=pendingLaunches.get(msg.nonce);
      if(!pending)return;
      pendingLaunches.delete(msg.nonce);
      clearTimeout(pending.timer);
      if(msg.type==='TK_LAUNCH_ACK')pending.resolve();
      else pending.reject(new Error(msg.error||'Could not open Google Earth.'));
    }
  });
  // Content scripts may announce readiness before this deferred page script
  // loads. Ask again instead of depending on that one-time announcement.
  window.postMessage({source:PAGE_SOURCE,type:'TK_HELLO'},window.location.origin);

  function launchViaExtension(recordId,customerId,businessId,jobId){
    return new Promise(function(resolve,reject){
      const nonce=(window.crypto&&window.crypto.randomUUID)?window.crypto.randomUUID():('n'+Date.now()+'_'+Math.random().toString(36).slice(2));
      const timer=setTimeout(function(){
        pendingLaunches.delete(nonce);
        reject(new Error('The TurnKey extension did not respond — check the extension is up to date and try again.'));
      },LAUNCH_TIMEOUT_MS);
      pendingLaunches.set(nonce,{resolve:resolve,reject:reject,timer:timer});
      window.postMessage({source:PAGE_SOURCE,type:'TK_LAUNCH',nonce:nonce,recordId:recordId,customerId:customerId,businessId:businessId,jobId:jobId},window.location.origin);
    });
  }

  // Only "Build quote" (any stage/locked-SOP wording that includes both
  // words) and the customer-profile .cp-qa "Quote" icon button — never
  // "Edit quote" or "Review & send quote", which open an ALREADY-built
  // quote for review, not a fresh build. Those keep using the old builder
  // untouched — this handoff only ever replaces a fresh "Build quote".
  function isQuoteTrigger(el){
    if(!el||typeof el.getAttribute!=='function')return false;
    if(el.id==='quote-builder-open'||['quote','quote-select'].includes(el.getAttribute('data-sale-action')))return true;
    const onclick=el.getAttribute('onclick')||'';
    if(!/openQuoteModal\(\s*\d+\s*\)/.test(onclick))return false;
    const text=(el.textContent||'').trim().toLowerCase();
    if(/edit quote|review\s*(&|and)?\s*send/.test(text))return false;
    if(el.classList&&el.classList.contains('cp-qa'))return text==='quote';
    return text.indexOf('build')!==-1&&text.indexOf('quote')!==-1;
  }

  function escapeHtmlLocal(s){
    return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});
  }

  let stylesInjected=false;
  function ensureEarthModalStyles(){
    if(stylesInjected||!document||!document.getElementById)return;
    if(document.getElementById('tk-eh-style')){stylesInjected=true;return;}
    const style=document.createElement('style');
    style.id='tk-eh-style';
    style.textContent='.tk-eh-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px}'
      +'.tk-eh-modal{position:relative;background:#fff;border-radius:12px;max-width:420px;width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3);color:#0f172a;font-family:inherit}'
      +'.tk-eh-modal h3{margin:0 0 10px;font-size:17px;padding-right:20px}'
      +'.tk-eh-modal p{margin:6px 0;font-size:13px;line-height:1.45;color:#334155}'
      +'.tk-eh-close{position:absolute;top:10px;right:14px;background:none;border:none;font-size:18px;line-height:1;cursor:pointer;color:#64748b}'
      +'.tk-eh-btn{display:inline-block;margin-top:8px;padding:8px 14px;border-radius:8px;background:#0f766e;color:#fff;text-decoration:none;font-size:13px;font-weight:600;border:none;cursor:pointer}'
      +'.tk-eh-steps{margin:8px 0;padding-left:18px;font-size:12.5px;color:#334155}'
      +'.tk-eh-error{color:#b91c1c;font-size:12.5px;margin-top:6px}'
      +'.tk-eh-note{color:#64748b;margin-top:12px}';
    if(document.head&&document.head.appendChild)document.head.appendChild(style);
    stylesInjected=true;
  }

  /**
   * THE quoting entry point for a "Build quote"/customer-profile Quote
   * click on an existing record — not a fallback UI, the replacement for
   * the old in-page builder. Shown immediately, synchronously, whenever
   * tenant/session checks already passed; its content then adapts to
   * whether the extension is ready, errors, or times out — it never hands
   * control back to openQuoteModal().
   */
  function openEarthLaunchModal(r,extensionReadyNow){
    ensureEarthModalStyles();
    const address=[r.address,r.suburb].filter(Boolean).join(', ');
    const errors=[];
    if(!r.customerId)errors.push('Save this lead as a customer before using Google Earth.');
    if(!address)errors.push('Add an address for this customer before using Google Earth.');

    const backdrop=document.createElement('div');
    backdrop.className='tk-eh-backdrop';
    const panel=document.createElement('div');
    panel.className='tk-eh-modal';
    backdrop.appendChild(panel);

    function close(){
      if(backdrop.parentNode&&backdrop.parentNode.removeChild)backdrop.parentNode.removeChild(backdrop);
    }
    backdrop.addEventListener('click',function(e){if(e.target===backdrop)close();});

    const closeBtn=document.createElement('button');
    closeBtn.type='button';
    closeBtn.className='tk-eh-close';
    closeBtn.textContent='×';
    closeBtn.setAttribute('aria-label','Close');
    closeBtn.setAttribute('data-eh-close','');
    closeBtn.addEventListener('click',close);
    panel.appendChild(closeBtn);

    const heading=document.createElement('h3');
    heading.textContent='Google Earth quote'+(r.name?' — '+r.name:'');
    panel.appendChild(heading);

    const body=document.createElement('div');
    body.setAttribute('data-eh-body','');
    panel.appendChild(body);

    function paint(phase,launchError){
      while(body.firstChild)body.removeChild(body.firstChild);

      if(errors.length){
        const p=document.createElement('p');
        p.className='tk-eh-error';
        p.setAttribute('data-eh-validation-error','');
        p.textContent=errors.join(' ');
        body.appendChild(p);
        return;
      }

      if(phase==='auto'){
        const p=document.createElement('p');
        p.textContent='Opening Google Earth automatically for '+(r.name||'this customer')+'…';
        body.appendChild(p);
      }else{
        const addrP=document.createElement('p');
        addrP.textContent='Address: '+address;
        body.appendChild(addrP);
        const link=document.createElement('a');
        link.className='tk-eh-btn';
        link.setAttribute('href','https://earth.google.com/web/search/'+encodeURIComponent(address));
        link.setAttribute('target','_blank');
        link.setAttribute('rel','noopener');
        link.setAttribute('data-eh-earth-link','');
        link.textContent='Open Google Earth';
        body.appendChild(link);
      }

      if(launchError){
        const p=document.createElement('p');
        p.className='tk-eh-error';
        p.setAttribute('data-eh-launch-error','');
        p.textContent=launchError;
        body.appendChild(p);
      }

      if(!extensionReadyNow||launchError){
        const install=document.createElement('div');
        install.setAttribute('data-eh-install','');
        const lead=document.createElement('p');
        lead.textContent='Get the automatic handoff — install or update the TurnKey Google Earth extension so this opens straight to the right customer every time:';
        install.appendChild(lead);
        const zip=document.createElement('a');
        zip.setAttribute('href',ZIP_URL);
        zip.setAttribute('data-eh-zip-link','');
        zip.textContent='Download turnkey-earth-extension-0.2.8.zip';
        install.appendChild(zip);
        const steps=document.createElement('ol');
        steps.className='tk-eh-steps';
        ['Unzip the downloaded file','Go to chrome://extensions and enable Developer mode','Click "Load unpacked" and select the unzipped folder','Refresh this page'].forEach(function(t){
          const li=document.createElement('li');li.textContent=t;steps.appendChild(li);
        });
        install.appendChild(steps);
        body.appendChild(install);
      }

      const note=document.createElement('p');
      note.className='tk-eh-note';
      note.textContent='Measuring in Google Earth prices the job with your saved TurnKey rates and costs — nothing is sent to the customer until you review and send the quote.';
      body.appendChild(note);
    }

    paint(extensionReadyNow&&!errors.length?'auto':'manual');
    document.body.appendChild(backdrop);
    return {close:close,paint:paint,errors:errors};
  }

  if(typeof renderQuoteBuilderHome==='function'){
    const originalHome=renderQuoteBuilderHome;
    renderQuoteBuilderHome=function(){
      originalHome();
      const home=document.getElementById('view-quote-builder');
      const text=home&&home.querySelector('p');
      if(text)text.textContent='Select a customer to measure in Google Earth. Review expenses, recommended pricing and your final price in the extension; the new draft returns to their customer file.';
    };
  }

  async function openEarthQuote(recordId){
    if(!Number.isFinite(Number(recordId)))return false;
    if(typeof records==='undefined'||typeof currentBusinessId==='undefined'||typeof recordBusinesses==='undefined')return false;
    recordId=Number(recordId);
    const r=records.find(function(x){return x.id===recordId;});
    if(!r)return false;
    if(typeof businessStateReady==='undefined'||!businessStateReady||recordBusinesses.get(r)!==currentBusinessId){
      toast('Your business account is still loading. Please try Build quote again once it has loaded.');
      return false;
    }
    const picker=document.getElementById('sales-dialog');
    if(picker&&picker.open&&typeof picker.close==='function')picker.close();
      if((!r.customerId||!r.jobId)&&typeof syncRecordToSupabase==='function'){
        const biz=currentBusinessId,version=typeof businessSessionVersion!=='undefined'?businessSessionVersion:null;
        try{await syncRecordToSupabase(r);}catch(e){/* handled below as a validation error in the modal */}
        // The business session can change WHILE this await was in flight
        // (operator disconnected/reconnected a different account) — a
        // context captured before that point must never be used to launch
        // a handoff for the business that's signed in now.
        if(currentBusinessId!==biz||(version!==null&&typeof businessSessionVersion!=='undefined'&&businessSessionVersion!==version)||recordBusinesses.get(r)!==biz){
          toast('Your business session changed while saving this lead — try again.');
          return false;
        }
      }

      const modal=openEarthLaunchModal(r,extensionReady);
      if(extensionReady&&!modal.errors.length){
        try{
          await launchViaExtension(recordId,r.customerId,currentBusinessId,r.jobId);
          modal.close();
          toast('Opening Google Earth for '+(r.name||'this customer')+'…');
        }catch(err){
          modal.paint('manual',(err&&err.message)||'Could not open Google Earth automatically.');
        }
      }
      return !modal.errors.length;
  }
  window.TK_EARTH_QUOTES={open:openEarthQuote};

  document.addEventListener('click',function(event){
    const target=event.target&&typeof event.target.closest==='function'?event.target.closest('[onclick],[data-sale-action="quote"],[data-sale-action="quote-select"],#quote-builder-open'):null;
    if(!isQuoteTrigger(target))return;
    const match=(target.getAttribute('onclick')||'').match(/openQuoteModal\(\s*(\d+)\s*\)/);
    const selected=document.getElementById('quote-builder-lead');
    const recordId=Number(match?match[1]:(target.getAttribute('data-id')||(target.id==='quote-builder-open'&&selected?selected.value:NaN)));
    event.preventDefault();event.stopPropagation();
    if(typeof event.stopImmediatePropagation==='function')event.stopImmediatePropagation();
    openEarthQuote(recordId).catch(function(err){toast((err&&err.message)||'Could not open Google Earth. Refresh this page and try again.');});
  },true);
})();
