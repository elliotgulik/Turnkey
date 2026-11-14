/* Employee job close-out. The server owns completion, identity and audit timestamps. */
(function(root){
  'use strict';
  const essential=[
    ['injectorFlushed','Flushed the chemical injector with clean water','Ran clean water through the injector to remove remaining chemicals.'],
    ['fuelSwitchOff','Turned off the pressure washer using the fuel switch','Shut down the washer using the fuel supply, following the approved shutdown procedure.'],
    ['objectsReturned','Returned all moved objects to their original positions','Put furniture, pot plants, mats and other moved items back correctly.'],
    ['propertyLap','Completed a final lap of the property','Checked for equipment, tools, hoses, rubbish or anything left behind.']
  ];
  const empty=()=>({customerHome:null,qualityCheck:false,reviewScanned:false,askedUpcomingWork:false,upcomingWorkNotes:'',askedFrequency:false,frequencyAnswer:'',injectorFlushed:false,fuelSwitchOff:false,objectsReturned:false,propertyLap:false});
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const closeIcon='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  let config={},active=null,identity=null,identityPending=null,cardSerial=0;
  const ctx=()=>{const value=config.context?config.context():({biz:typeof currentBusinessId==='undefined'?null:currentBusinessId,user:typeof currentUserId==='undefined'?null:currentUserId,version:typeof businessSessionVersion==='undefined'?0:businessSessionVersion,role:typeof currentUserRole==='undefined'?null:currentUserRole});return {...value};};
  const key=c=>JSON.stringify([c.biz,c.user,c.version]);
  const current=c=>key(ctx())===key(c)&&!!c.biz&&!!c.user;
  const find=id=>(config.records?config.records():typeof records==='undefined'?[]:records).find(r=>String(r.id)===String(id));
  const notify=text=>config.notify?config.notify(text):typeof toast==='function'?toast(text):null;
  const storageKey=(c,r)=>'turnkey:post-job:v1:'+c.biz+':'+c.user+':'+r.jobId;
  function cached(c,r){try{return JSON.parse(localStorage.getItem(storageKey(c,r))||'null');}catch{return null;}}
  function stash(s){if(!current(s.scope))return;try{localStorage.setItem(storageKey(s.scope,s.record),JSON.stringify({responses:s.responses,dirty:s.dirty,updatedAt:Date.now()}));}catch{if(!s.storageWarned){s.storageWarned=true;message(s,'This browser cannot save offline progress. Keep this page open until saved.','error');}}}
  async function request(path,options={},scope=ctx()){
    if(!current(scope))throw Error('Your account changed. Reopen this job.');
    const run=config.request||root.TK_SALES_PLATFORM?.request;
    if(!run)throw Error('Job connection is not ready. Refresh and try again.');
    const data=await run('/api/job-work'+path,options);
    if(!current(scope))throw Error('Your account changed. Reopen this job.');
    return data;
  }
  const route=r=>'/jobs/'+encodeURIComponent(r.jobId)+'/post-job';
  function missing(a){return [...(typeof a.customerHome!=='boolean'?['customerHome']:[]),...essential.filter(([id])=>a[id]!==true).map(([id])=>id),...(a.customerHome===true&&a.qualityCheck!==true?['qualityCheck']:[])];}
  function normalize(a){const result={...empty(),...a};if(result.customerHome!==true){result.qualityCheck=false;result.reviewScanned=false;result.askedUpcomingWork=false;result.upcomingWorkNotes='';result.askedFrequency=false;result.frequencyAnswer='';}return result;}
  function message(s,text,kind=''){if(!s.dialog.isConnected)return;const el=s.dialog.querySelector('[data-pj-message]');el.textContent=text;el.dataset.kind=kind;}
  function setSaveLabel(s,text){if(s.dialog.isConnected)s.dialog.querySelector('[data-pj-saved]').textContent=text;}
  function enqueue(s){
    clearTimeout(s.timer);if(s.completed||!s.loaded||!s.dirty)return s.chain;
    const snapshot=JSON.stringify(s.responses),version=++s.saveVersion;
    s.chain=s.chain.catch(()=>{}).then(async()=>{
      if(!current(s.scope))return;
      setSaveLabel(s,'Saving progress…');
      try{
        const saved=await request(route(s.record),{method:'PUT',body:JSON.stringify({responses:JSON.parse(snapshot)})},s.scope);
        if(saved.checklist?.completedAt){s.completed=saved.checklist;s.responses=normalize(saved.checklist.responses);s.dirty=false;stash(s);if(s.dialog.isConnected)update(s);return;}
        if(version===s.saveVersion&&snapshot===JSON.stringify(s.responses)){s.dirty=false;stash(s);setSaveLabel(s,'Progress saved');}
      }catch(e){if(current(s.scope)){setSaveLabel(s,'Saved on this phone, waiting to sync');message(s,e.message+' Your progress is kept on this phone.','error');}throw e;}
    });
    s.chain.catch(()=>{});return s.chain;
  }
  function close(s){
    if(s.busy)return;
    stash(s);if(s.loaded&&s.dirty)enqueue(s);
    clearTimeout(s.timer);clearInterval(s.watcher);s.qr?.close();s.qr?.remove();
    s.dialog.close();s.dialog.remove();if(active===s)active=null;
    s.returnFocus?.isConnected&&s.returnFocus.focus({preventScroll:true});
  }
  function checkbox(id,title,help,required=false){return `<label class="pj-check" data-pj-field="${id}"><input type="checkbox" name="${id}"><span><strong>${title}${required?'<span class="pj-required">Required</span>':''}</strong>${help?`<small>${help}</small>`:''}</span></label>`;}
  function update(s){
    const form=s.dialog.querySelector('form'),a=s.responses;
    form.querySelector('[data-pj-handover]').hidden=a.customerHome!==true;
    form.querySelector('[data-pj-skipped]').hidden=a.customerHome!==false;
    form.querySelectorAll('[name="customerHome"]').forEach(el=>{el.checked=(el.value==='yes')===a.customerHome&&typeof a.customerHome==='boolean';});
    form.querySelectorAll('input[type="checkbox"]').forEach(el=>{el.checked=a[el.name]===true;});
    form.querySelector('[data-pj-upcoming]').hidden=!a.askedUpcomingWork||a.customerHome!==true;
    form.querySelector('[data-pj-frequency]').hidden=!a.askedFrequency||a.customerHome!==true;
    const count=essential.filter(([id])=>a[id]).length;
    form.querySelector('[data-pj-progress]').textContent=count+'/4 essential checks completed';
    form.querySelector('progress').value=count;
    form.querySelectorAll('input,textarea').forEach(el=>{el.disabled=!!s.completed||s.busy;});
    const submit=form.querySelector('[type="submit"]');submit.hidden=!!s.completed;form.querySelector('.pj-done').hidden=!s.completed;submit.disabled=s.busy||!s.loaded;
    submit.textContent=s.busy?'Completing job…':'Complete Job';
    s.dialog.querySelector('[data-pj-close]').disabled=s.busy;
    form.querySelector('[data-pj-hours]').disabled=s.busy;
    form.querySelector('[data-pj-qr]').disabled=s.busy;
    if(s.completed){setSaveLabel(s,'Completed '+dateLabel(s.completed.completedAt));message(s,'Checklist completed by '+(s.completed.employeeName||'Employee')+'. Responses are saved against this job.');}
  }
  function highlight(s,fields){
    s.dialog.querySelectorAll('[data-pj-field]').forEach(el=>{const bad=fields.includes(el.dataset.pjField);el.classList.toggle('pj-missing',bad);el.querySelector('input')?.setAttribute('aria-invalid',String(bad));});
    s.dialog.querySelector('.pj-missing')?.scrollIntoView({block:'center',behavior:'smooth'});
    s.dialog.querySelector('.pj-missing input')?.focus({preventScroll:true});
  }
  const dateLabel=value=>new Date(value).toLocaleString('en-NZ',{dateStyle:'medium',timeStyle:'short'});
  async function load(s){
    try{
      const data=await request(route(s.record),{},s.scope);
      if(!s.dialog.isConnected)return;
      s.settings=data.settings||{};
      if(s.settings.enabled===false){close(s);if(s.whenDisabled)await s.whenDisabled();else notify('Post-job checklists are turned off in Settings.');return;}
      s.loaded=true;s.completed=data.checklist?.completedAt?data.checklist:null;
      if(s.completed||!s.dirty)s.responses=normalize(data.checklist?.responses||empty());
      s.dialog.querySelector('[name="upcomingWorkNotes"]').value=s.responses.upcomingWorkNotes||'';
      s.dialog.querySelector('[name="frequencyAnswer"]').value=s.responses.frequencyAnswer||'';
      message(s,'');update(s);if(s.dirty)enqueue(s);else setSaveLabel(s,s.completed?'Completed checklist':'Progress saves automatically');
      s.dialog.querySelector('[data-pj-retry]').hidden=true;
    }catch(e){if(current(s.scope)&&s.dialog.isConnected){message(s,'Could not load the saved checklist: '+e.message,'error');s.dialog.querySelector('[data-pj-retry]').hidden=false;}}
  }
  async function loadHours(s){
    try{
      const data=await request('/logs?'+new URLSearchParams({jobId:s.record.jobId}),{},s.scope);
      if(!s.dialog.isConnected)return;
      const own=(data.logs||[]).filter(log=>log.user_id===s.scope.user||log.userId===s.scope.user);
      const minutes=own.reduce((n,log)=>n+(Number(log.minutes)||0),0);
      s.dialog.querySelector('[data-pj-hours-summary]').textContent=minutes?'Your recorded time for this job: '+Math.floor(minutes/60)+'h '+minutes%60+'m':'No work hours recorded by you for this job yet.';
    }catch(e){if(s.dialog.isConnected&&current(s.scope))s.dialog.querySelector('[data-pj-hours-summary]').textContent='Could not check work hours. You can still record them using Log work hours.';}
  }
  async function logHours(s){
    if(!root.TK_JOB_WORK?.openLogHoursDialog){message(s,'Work-hour logging is not ready. Refresh the page and try again.','error');return;}
    // A native dialog must step out of the top layer while the existing hours form is open.
    s.dialog.close();
    const resume=()=>{if(current(s.scope)&&s.dialog.isConnected&&!s.dialog.open){s.dialog.showModal();loadHours(s);}};
    try{const opened=await root.TK_JOB_WORK.openLogHoursDialog(s.record,{onClose:resume});if(!opened)resume();}catch(e){resume();message(s,e.message,'error');}
  }
  function validReviewUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.href.length<=1024?url.href:null;}catch{return null;}}
  function showReview(s){
    const url=validReviewUrl(s.settings?.reviewUrl);
    if(!url){message(s,'Ask a manager to add the Google review link in Settings. An unscanned review does not block completion.','error');return;}
    if(typeof root.qrcode!=='function'){message(s,'The QR code could not load. Refresh and try again.','error');return;}
    const qr=root.qrcode(0,'M');qr.addData(url);try{qr.make();}catch{message(s,'This review link is too long for a QR code. Ask a manager to use the direct Google review link.','error');return;}
    const top=document.createElement('dialog');s.qr=top;top.className='pj-review';top.setAttribute('aria-labelledby','pj-review-title');
    const logo=validReviewUrl(s.settings.logoUrl);
    top.innerHTML=`<button type="button" class="pj-close pj-review-close" aria-label="Close review QR code">${closeIcon}</button><div class="pj-review-content">${logo?`<img class="pj-review-logo" src="${esc(logo)}" alt="${esc(s.settings.businessName||'Nova Exterior')} logo">`:`<p class="pj-review-brand">${esc(s.settings.businessName||'Nova Exterior')}</p>`}<h2 id="pj-review-title">Happy with our work?<br>We'd love a Google review!</h2><div class="pj-qr-code" role="img" aria-label="Scan to leave a Google review">${qr.createSvgTag({cellSize:6,margin:24,scalable:true})}</div><p>Scan with your phone’s camera</p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open review page</a></div>`;
    document.body.appendChild(top);const back=()=>{top.close();top.remove();s.qr=null;s.dialog.querySelector('[data-pj-qr]')?.focus({preventScroll:true});};
    top.querySelector('button').addEventListener('click',back);top.addEventListener('cancel',e=>{e.preventDefault();back();});top.showModal();
  }
  async function complete(s){
    if(s.busy||!s.loaded||s.completed)return;
    const fields=missing(s.responses);highlight(s,fields);
    if(fields.length){message(s,'Answer whether the customer was home, complete the four essential checks, and confirm the quality walkthrough when they were home. The Google review is optional.','error');return;}
    s.busy=true;clearTimeout(s.timer);update(s);message(s,'Saving your checklist and job completion…');
    try{
      await s.chain.catch(()=>{});
      const result=await request(route(s.record)+'/complete',{method:'POST',body:JSON.stringify({responses:s.responses})},s.scope);
      if(!result.checklist?.completedAt)throw Error('Completion was not confirmed. Your progress is saved; please retry.');
      s.completed=result.checklist;s.responses=normalize(result.checklist.responses);s.dirty=false;stash(s);s.busy=false;update(s);
      if(result.job){
        if(result.job.status)s.record.stage=result.job.status;
        for(const field of ['jobStatus','finishedAt','durationMin','postJobCompletedAt','fieldWorkCompletedAt'])if(Object.hasOwn(result.job.details||{},field))s.record[field]=result.job.details[field];
      }
      if(result.statusManagedByServiceM8)message(s,'Field work and checklist are recorded. ServiceM8’s job status remains managed in ServiceM8.');
      try{
        if(config.onComplete)config.onComplete(result,s.record);else{if(typeof saveState==='function')saveState();if(typeof render==='function')render();if(typeof renderAll==='function')renderAll();renderCard(s.record.id);}
      }catch{message(s,'Completion is saved. Refresh the job to see the latest status.');}
      root.dispatchEvent(new CustomEvent('turnkey:job-checklist-completed',{detail:{jobId:s.record.jobId}}));
      notify('Job checklist completed and saved.');
    }catch(e){if(current(s.scope)){s.busy=false;update(s);highlight(s,Array.isArray(e.missingFields)?e.missingFields:[]);message(s,'Could not complete the job: '+e.message+' Your progress is kept.','error');}}
  }
  function open(recordId,options={}){
    const record=find(recordId),scope=ctx();
    if(!record?.jobId||!scope.biz||!scope.user){notify('Save this job and sign in before completing it.');return;}
    if(active&&current(active.scope)&&active.record.jobId===record.jobId){if(!active.dialog.open)active.dialog.showModal();return;}
    if(active){if(active.busy)return;close(active);}
    const local=cached(scope,record),dialog=document.createElement('dialog');dialog.className='pj-dialog';dialog.setAttribute('aria-labelledby','pj-title');
    const s={record,scope,dialog,responses:normalize(local?.responses||empty()),dirty:!!local?.dirty,loaded:false,busy:false,completed:null,saveVersion:0,chain:Promise.resolve(),returnFocus:document.activeElement,whenDisabled:options.whenDisabled};active=s;
    dialog.innerHTML=`<form novalidate><header class="pj-heading"><div><h2 id="pj-title">Post-job checklist</h2><p>${esc(record.name||'Job')}<span>${esc(record.address||'')}</span></p></div><button type="button" class="pj-close" data-pj-close aria-label="Save and close checklist">${closeIcon}</button></header><div class="pj-body"><p class="pj-save-state" data-pj-saved role="status">Loading saved checklist…</p><p data-pj-message class="pj-message" role="alert"></p><button type="button" data-pj-retry class="btn ghost" hidden>Retry loading</button><section aria-labelledby="pj-handover-title"><h3 id="pj-handover-title">Customer handover</h3><fieldset class="pj-presence" data-pj-field="customerHome"><legend>Was the customer home when you finished?</legend><label><input type="radio" name="customerHome" value="yes">Yes</label><label><input type="radio" name="customerHome" value="no">No</label></fieldset><p data-pj-skipped hidden class="pj-help">Customer wasn’t home. Handover questions are skipped.</p><div data-pj-handover hidden>${checkbox('qualityCheck','Completed a final quality check with the customer','Walked through the finished work and confirmed they were satisfied.',true)}${checkbox('reviewScanned','Customer scanned the Google Review QR code','Optional. Leave unchecked if the customer declines.')}<button type="button" class="btn ghost pj-qr-button" data-pj-qr>Show Review QR Code</button>${checkbox('askedUpcomingWork','I asked the customer about any upcoming work they’re considering','Record anything useful for the next visit.')}<label class="pj-answer" data-pj-upcoming hidden>Upcoming work<textarea name="upcomingWorkNotes" maxlength="2000" rows="2" placeholder="What are they considering?"></textarea></label>${checkbox('askedFrequency','I asked how frequently they want these services done','For example, every three months, six months or yearly.')}<label class="pj-answer" data-pj-frequency hidden>Preferred frequency<input name="frequencyAnswer" maxlength="500" placeholder="Customer’s answer"></label></div></section><section aria-labelledby="pj-equipment-title"><h3 id="pj-equipment-title">Equipment &amp; site checks</h3><p class="pj-help">Complete all four checks before finishing.</p>${essential.map(([id,title,help])=>checkbox(id,title,help)).join('')}</section><section class="pj-hours" aria-labelledby="pj-hours-title"><h3 id="pj-hours-title">Your work hours</h3><p data-pj-hours-summary class="pj-help">Checking recorded hours…</p><button type="button" class="btn ghost" data-pj-hours>Log work hours</button></section></div><footer class="pj-footer"><div><strong data-pj-progress>0/4 essential checks completed</strong><progress max="4" value="0" aria-label="Essential checklist progress"></progress></div><button type="submit" class="btn primary" disabled>Complete Job</button><button type="button" class="btn ghost pj-done" hidden>Close completed checklist</button></footer></form>`;
    document.body.appendChild(dialog);
    const form=dialog.querySelector('form');
    const changed=e=>{
      if(!e.target.name||s.completed||s.busy)return;
      const input=e.target;
      s.responses[input.name]=input.type==='radio'?input.value==='yes':input.type==='checkbox'?input.checked:input.value;
      s.responses=normalize(s.responses);s.dirty=true;stash(s);update(s);highlight(s,[]);setSaveLabel(s,'Saved on this phone');clearTimeout(s.timer);s.timer=setTimeout(()=>enqueue(s),350);
    };
    form.addEventListener('change',changed);form.addEventListener('input',e=>{if(e.target.matches('textarea,input:not([type="checkbox"]):not([type="radio"])'))changed(e);});
    form.addEventListener('submit',e=>{e.preventDefault();complete(s);});
    dialog.querySelector('[data-pj-close]').addEventListener('click',()=>close(s));
    dialog.querySelector('[data-pj-retry]').addEventListener('click',()=>load(s));
    dialog.querySelector('[data-pj-qr]').addEventListener('click',()=>showReview(s));
    dialog.querySelector('[data-pj-hours]').addEventListener('click',()=>logHours(s));
    dialog.querySelector('.pj-done').addEventListener('click',()=>close(s));
    dialog.addEventListener('cancel',e=>{e.preventDefault();close(s);});
    s.watcher=setInterval(()=>{if(!current(scope)){s.busy=false;close(s);}},300);
    dialog.addEventListener('change',()=>{dialog.querySelector('.pj-done').hidden=!s.completed;});
    update(s);dialog.showModal();load(s).then(()=>{if(dialog.isConnected)dialog.querySelector('.pj-done').hidden=!s.completed;});loadHours(s);
  }
  function auditRows(history){return history.map(row=>`<details class="pj-audit"><summary>${esc(row.employeeName||'Employee')}, ${esc(dateLabel(row.completedAt))}</summary><dl><dt>Customer home</dt><dd>${row.responses.customerHome?'Yes':'No'}</dd>${row.responses.customerHome?`<dt>Quality check with customer</dt><dd>${row.responses.qualityCheck?'Done':'Not done'}</dd><dt>Review QR scanned</dt><dd>${row.responses.reviewScanned?'Yes':'No, optional'}</dd><dt>Asked about upcoming work</dt><dd>${row.responses.askedUpcomingWork?'Yes':'No'}</dd>${row.responses.upcomingWorkNotes?`<dt>Upcoming work</dt><dd>${esc(row.responses.upcomingWorkNotes)}</dd>`:''}<dt>Asked about service frequency</dt><dd>${row.responses.askedFrequency?'Yes':'No'}</dd>${row.responses.frequencyAnswer?`<dt>Preferred frequency</dt><dd>${esc(row.responses.frequencyAnswer)}</dd>`:''}`:'<dt>Customer handover</dt><dd>Skipped, customer wasn’t home</dd>'}${essential.map(([id,title])=>`<dt>${title}</dt><dd>${row.responses[id]?'Done':'Not done'}</dd>`).join('')}<dt>Job ID</dt><dd>${esc(row.jobId)}</dd></dl></details>`).join('');}
  async function renderCard(id){
    const record=find(id),scope=ctx(),serial=++cardSerial,host=document.getElementById('view-detail');if(!host||!record?.jobId||!scope.biz||!scope.user)return;
    document.getElementById('post-job-card')?.remove();
    const card=document.createElement('section');card.id='post-job-card';card.className='panel pj-job-card';card.innerHTML='<h3>Post-job checklist</h3><p class="pj-help">Finish the handover and site checks before completing this job.</p><button type="button" class="btn ghost" data-pj-open>Open checklist</button><p class="pj-help" data-pj-status>Loading checklist record…</p><div data-pj-audit></div>';
    (host.querySelector('.detail-grid')||host).appendChild(card);card.querySelector('button').addEventListener('click',()=>open(id));
    try{const data=await request(route(record),{},scope);if(!card.isConnected||serial!==cardSerial)return;if(data.settings?.enabled===false){card.remove();return;}
      card.querySelector('[data-pj-status]').textContent=data.checklist?.completedAt?'Your checklist is complete.':data.checklist?'Your saved checklist is ready to continue.':'No completed checklist recorded yet.';
      card.querySelector('button').textContent=data.checklist?.completedAt?'View your checklist':'Open checklist';card.querySelector('[data-pj-audit]').innerHTML=auditRows(data.history||[]);
    }catch(e){if(card.isConnected&&current(scope))card.querySelector('[data-pj-status]').textContent='Could not load checklist history. Open checklist to retry.';}
  }
  async function refreshIdentity(){
    const scope=ctx();if(!scope.biz||!scope.user)return;if(identity?.scope===key(scope))return identity.data;if(identityPending?.scope===key(scope))return identityPending.promise;
    const promise=request('/post-job/settings',{},scope).then(data=>{identity={scope:key(scope),data};root.dispatchEvent(new Event('turnkey:staff-identity-ready'));if(typeof render==='function')render();if(typeof renderAll==='function')renderAll();return data;}).catch(()=>null).finally(()=>{if(identityPending?.scope===key(scope))identityPending=null;});identityPending={scope:key(scope),promise};return promise;
  }
  function isAssigned(record){const scope=ctx(),aliases=new Set([scope.user,...(identity?.scope===key(scope)?identity.data.employee?.aliases||[]:[])]);return [record.assignedStaffId,...(record.assignedStaffIds||[])].some(id=>id&&aliases.has(id));}
  async function settings(){
    const scope=ctx();if(!['owner','manager'].includes(scope.role)){notify('Only an owner or manager can change checklist settings.');return;}
    const dialog=document.createElement('dialog');dialog.className='pj-settings';dialog.setAttribute('aria-labelledby','pj-settings-title');dialog.innerHTML=`<form><header class="pj-heading"><h2 id="pj-settings-title">Post-job checklist settings</h2><button type="button" class="pj-close" aria-label="Close settings">${closeIcon}</button></header><div class="pj-body"><p role="alert" data-settings-message>Loading settings…</p><label class="pj-check"><input name="enabled" type="checkbox" disabled><span>Require the employee post-job checklist before completing jobs</span></label><label class="pj-answer">Google review link<input name="reviewUrl" type="url" maxlength="1024" placeholder="https://g.page/r/…/review" disabled></label><p class="pj-help">Use your direct Google review link. The review is optional for customers. Your business-profile logo appears above the QR code.</p></div><footer class="pj-footer"><button class="btn primary" type="submit" disabled>Save settings</button></footer></form>`;
    document.body.appendChild(dialog);dialog.showModal();const watcher=setInterval(()=>{if(!current(scope))dismiss();},300);const dismiss=()=>{clearInterval(watcher);dialog.close();dialog.remove();};dialog.querySelector('[aria-label="Close settings"]').onclick=dismiss;dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();});const form=dialog.querySelector('form'),msg=dialog.querySelector('[data-settings-message]');
    try{const data=await request('/post-job/settings',{},scope);if(!dialog.isConnected)return;const value=data.settings||data;form.elements.enabled.checked=value.enabled!==false;form.elements.reviewUrl.value=value.reviewUrl||'';form.querySelectorAll('input,button').forEach(el=>el.disabled=false);msg.textContent='';}catch(e){msg.textContent=e.message;}
    form.onsubmit=async e=>{e.preventDefault();const value=form.elements.reviewUrl.value.trim();if(value&&!validReviewUrl(value)){msg.textContent='Use an HTTPS review link without a username or password.';return;}const button=form.querySelector('[type="submit"]');button.disabled=true;try{await request('/post-job/settings',{method:'PUT',body:JSON.stringify({enabled:form.elements.enabled.checked,reviewUrl:value})},scope);identity=null;dismiss();notify('Post-job checklist settings saved.');}catch(error){msg.textContent=error.message;button.disabled=false;}};
  }
  if(typeof openDetail==='function'){const previous=openDetail;root.openDetail=function(id){const result=previous.apply(this,arguments);renderCard(id);return result;};}
  root.addEventListener('turnkey:business-ready',()=>{identity=null;refreshIdentity();});
  root.addEventListener('turnkey:work-logged',()=>{if(active&&current(active.scope))loadHours(active);});
  root.addEventListener('online',()=>{refreshIdentity();if(active&&current(active.scope)&&active.dirty)enqueue(active);});
  root.addEventListener('focus',()=>refreshIdentity());
  root.addEventListener('pagehide',()=>{if(active)stash(active);});
  root.TK_POST_JOB={open,settings,renderCard,isAssigned,refreshIdentity,missing,normalize,configure(value){config=value||{};identity=null;identityPending=null;},getActive:()=>active};
  if(ctx().biz&&ctx().user)refreshIdentity();
})(window);
