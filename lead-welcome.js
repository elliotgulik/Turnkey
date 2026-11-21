/* New-enquiry welcome settings only. Delivery and consent enforcement belong to the server. */
(function () {
  'use strict';
  if(window.TK_LEAD_WELCOME)return;
  const endpoint='/api/leads/welcome-settings';
  const sourceNames={wix:'Wix',meta:'Meta',booking:'Booking',manual:'Manual'};
  const defaults={enabled:false,channel:'email',trustUrl:'https://www.instagram.com/novaexterior/',body:'Hi {customer_name}, thanks for contacting {business_name}! While we review your enquiry, check out our work and how we care for your property: {trust_link}',subject:'Thanks for your enquiry — {business_name}',consentMode:'explicit',sources:['wix','meta','booking']};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let serial=0;
  const allowed=()=>typeof currentUserId!=='undefined'&&!!currentUserId&&typeof currentBusinessId!=='undefined'&&!!currentBusinessId&&typeof currentUserRole!=='undefined'&&['owner','manager'].includes(currentUserRole);
  const scope=()=>[typeof currentBusinessId!=='undefined'?currentBusinessId:'',typeof currentUserId!=='undefined'?currentUserId:'',typeof businessSessionVersion!=='undefined'?businessSessionVersion:'',typeof currentUserRole!=='undefined'?currentUserRole:''].join(':');
  function settings(value={}){
    return {...defaults,...value,enabled:value.enabled===true,channel:value.channel==='sms'?'sms':'email',consentMode:value.consentMode==='enquiries'?'enquiries':'explicit',sources:Array.isArray(value.sources)?Object.keys(sourceNames).filter(s=>value.sources.includes(s)):defaults.sources.slice()};
  }
  function validate(draft,readiness={}){
    if(!['sms','email'].includes(draft.channel))throw Error('Choose SMS or email.');
    if(!['explicit','enquiries'].includes(draft.consentMode))throw Error('Choose a permission rule.');
    const value=settings(draft);
    for(const key of ['trustUrl','body','subject'])value[key]=String(value[key]??'').trim();
    if(!value.trustUrl)throw Error('Enter an HTTPS Instagram or video link before saving.');
    if(value.trustUrl){
      let url;try{url=new URL(value.trustUrl);}catch{throw Error('Enter a valid HTTPS Instagram or video link.');}
      if(url.protocol!=='https:'||!url.hostname||url.username||url.password)throw Error('Use an HTTPS link without sign-in credentials.');
    }
    if(!value.body)throw Error('Enter a welcome message before saving.');
    if(!value.body.includes('{trust_link}'))throw Error('Include {trust_link} in the welcome message.');
    if(!value.subject)throw Error('Enter an email subject before saving, including for SMS setup.');
    if(value.body.length>800)throw Error('Keep the message within 800 characters.');
    if(value.subject.length>160||/[\r\n]/.test(value.subject))throw Error('Keep the email subject on one line, within 160 characters.');
    for(const text of [value.body,value.subject]){
      const remaining=text.replace(/\{(?:customer_name|business_name|trust_link)\}/g,'');
      if(/[{}]/.test(remaining))throw Error('Use only {customer_name}, {business_name} and {trust_link} placeholders.');
    }
    if(value.enabled){
      if(!readiness[value.channel])throw Error(value.channel==='sms'?'SMS needs Twilio configuration before enabling.':'Email needs a connected Gmail account before enabling.');
      if(!value.sources.length)throw Error('Choose at least one source before enabling.');
    }
    return value;
  }
  function draft(form){const field=name=>form.elements.namedItem(name);return {enabled:field('enabled').checked,channel:field('channel').value,trustUrl:field('trustUrl').value,body:field('body').value,subject:field('subject').value,consentMode:field('consentMode').value,sources:Object.keys(sourceNames).filter(key=>field('source-'+key).checked)};}
  function previewText(value,text=value.body){
    let business='Your business';try{business=typeof docBizName==='function'?docBizName()||business:business;}catch{}
    const sample={customer_name:'Alex',business_name:business,trust_link:value.trustUrl||'[your link]'};
    return String(text||'').replace(/\{(customer_name|business_name|trust_link)\}/g,(_,key)=>sample[key]);
  }
  function update(form,readiness){
    const value=draft(form),email=value.channel==='email';
    form.querySelector('[data-lw-readiness]').textContent=value.channel==='sms'?(readiness.sms?'SMS ready through Twilio.':'SMS needs Twilio configuration. Ask your administrator to configure it server-side.'):(readiness.email?'Email ready through Gmail.':'Email needs a connected Gmail account. Connect Gmail in Settings → Email.');
    form.querySelector('[data-lw-preview]').textContent=previewText(value);
    form.querySelector('[data-lw-preview-subject]').textContent=email?previewText(value,value.subject):'';
    form.querySelector('[data-lw-body-count]').textContent=`${value.body.length}/800 characters before personalisation.`;
    form.querySelector('[data-lw-delivery-note]').textContent=email?'The server adds an unsubscribe link to emails.':'SMS supports NZ mobile numbers only. The server adds STOP instructions. Longer messages may use multiple SMS segments.';
  }
  function history(rows){
    if(!Array.isArray(rows)||!rows.length)return '<p>No welcome-message outcomes recorded.</p>';
    return `<ol class="lw-history">${rows.slice(0,10).map(row=>{const date=new Date(row.sent_at||row.created_at);return `<li><strong>${esc(row.status||'Unknown status')}</strong><span>${esc(row.channel==='sms'?'SMS':row.channel==='email'?'Email':'Unknown channel')}</span><time>${esc(Number.isFinite(date.getTime())?date.toLocaleString('en-NZ'):'Date unavailable')}</time>${row.error_summary?`<p>${esc(row.error_summary)}</p>`:''}</li>`;}).join('')}</ol>`;
  }
  function editor(view){
    const s=settings(view.settings),checked=value=>value?'checked':'';
    return `<form id="lead-welcome-form" class="lw-form"><p class="lw-saved" role="status" data-lw-status>${s.enabled?'Saved: automatic welcomes are on.':'Saved: automatic welcomes are off.'}</p>
      <fieldset class="lw-editor"><legend class="lw-sr-only">Welcome-message settings</legend>
      <label class="lw-check"><input type="checkbox" name="enabled" ${checked(s.enabled)}>Enable automatic welcomes for new enquiries</label>
      <p>Off by default. Nothing changes until you save. Applies only to future new enquiries from the sources below, never historical records or imports.</p>
      <label>Channel<select name="channel"><option value="sms" ${s.channel==='sms'?'selected':''}>SMS</option><option value="email" ${s.channel==='email'?'selected':''}>Email (Gmail)</option></select></label>
      <p class="lw-readiness" data-lw-readiness></p>
      <label>Instagram or video link (HTTPS)<input name="trustUrl" required type="url" inputmode="url" value="${esc(s.trustUrl)}" placeholder="https://www.instagram.com/novaexterior/"></label>
      <label data-lw-subject>Email subject<input name="subject" required maxlength="160" value="${esc(s.subject)}"><small>Required for setup; used only when email is selected.</small></label>
      <label>Welcome message (plain text)<textarea name="body" required rows="5" maxlength="800" aria-describedby="lw-placeholders lw-body-count">${esc(s.body)}</textarea></label>
      <small id="lw-body-count" data-lw-body-count></small><p id="lw-placeholders">Include <code>{trust_link}</code> in your message. You can also use <code>{customer_name}</code> and <code>{business_name}</code>.</p>
      <label>Permission rule<select name="consentMode"><option value="explicit" ${s.consentMode==='explicit'?'selected':''}>Explicit consent only (default)</option><option value="enquiries" ${s.consentMode==='enquiries'?'selected':''}>Enquiries — requires documented permission</option></select></label>
      <p>Explicit consent uses recorded permission. Choose enquiries only when you have documented permission to send welcome messages to those enquiries.</p>
      <fieldset class="lw-sources"><legend>Sources for future enquiries</legend>${Object.entries(sourceNames).map(([key,label])=>`<label class="lw-check"><input type="checkbox" name="source-${key}" ${checked(s.sources.includes(key))}>${label}</label>`).join('')}</fieldset>
      <details class="lw-preview" open><summary>Message preview (sample customer: Alex)</summary><p data-lw-preview-subject></p><p data-lw-preview></p><small data-lw-delivery-note></small></details>
      <div class="lw-actions"><button type="submit" class="btn primary">Save welcome settings</button></div></fieldset>
      <p class="lw-error" role="alert" data-lw-error></p></form><details class="lw-outcomes"><summary>Recent outcomes (up to 10)</summary>${history(view.history)}</details>`;
  }
  async function load(host){
    if(!allowed())return;
    const call=++serial,key=scope();
    const current=()=>call===serial&&key===scope()&&allowed()&&host.isConnected&&document.getElementById('lead-welcome-settings')===host;
    host.innerHTML='<p role="status">Loading welcome settings…</p>';host.setAttribute('aria-busy','true');
    try{
      const view=await window.TK_SALES_PLATFORM.request(endpoint);
      if(!current())return;
      if(!view?.settings||!view.readiness)throw Error('Invalid settings response');
      installView(host,view,current);
    }catch{if(current()){host.innerHTML='<p class="lw-error" role="alert">Could not load welcome settings. No settings were changed.</p><button class="btn ghost" type="button" data-lw-retry>Retry</button>';host.setAttribute('aria-busy','false');host.querySelector('[data-lw-retry]').addEventListener('click',()=>load(host));}}
  }
  function installView(host,view,current){
      host.innerHTML=editor(view);host.setAttribute('aria-busy','false');
      const form=host.querySelector('form'),readiness={sms:view.readiness.sms===true,email:view.readiness.email===true};
      update(form,readiness);
      form.addEventListener('input',()=>{update(form,readiness);form.querySelector('[data-lw-status]').textContent='Unsaved changes. Save to apply.';});
      form.addEventListener('change',()=>{update(form,readiness);form.querySelector('[data-lw-status]').textContent='Unsaved changes. Save to apply.';});
      form.addEventListener('submit',async event=>{
        event.preventDefault();const fields=form.querySelector('.lw-editor'),error=form.querySelector('[data-lw-error]');
        if(!current()||fields.disabled)return;
        error.textContent='';
        try{
          const value=validate(draft(form),readiness);fields.disabled=true;form.setAttribute('aria-busy','true');
          form.querySelector('[data-lw-status]').textContent='Saving welcome settings…';
          const saved=await window.TK_SALES_PLATFORM.request(endpoint,{method:'PUT',body:JSON.stringify(value)});
          if(!current())return;
          if(!saved?.settings||!saved.readiness)throw Error('Invalid settings response');
          installView(host,saved,current);
          host.querySelector('[type="submit"]').focus();
        }catch(err){if(current()){error.textContent=err.message||'Could not save welcome settings. Please retry.';form.querySelector('[data-lw-status]').textContent='Not saved. Your changes are still here.';}}
        finally{if(current()&&form.isConnected){fields.disabled=false;form.setAttribute('aria-busy','false');}}
      });
  }
  const previous=openSettings;
  openSettings=function(...args){
    const result=previous.apply(this,args);
    if(!allowed())return result;
    const body=document.getElementById('settings-body');
    if(body&&!document.getElementById('lead-welcome-settings')){
      body.insertAdjacentHTML('beforeend',settingsGroup('Lead welcome messages','<div id="lead-welcome-settings" class="lw-settings"></div>'));
      void load(document.getElementById('lead-welcome-settings'));
    }
    return result;
  };
  window.TK_LEAD_WELCOME={defaults:()=>({...defaults,sources:defaults.sources.slice()}),validate,previewText};
})();
