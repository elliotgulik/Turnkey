/* A resumable setup checklist, derived from real account data; never sends mail. */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const scope=()=>typeof currentBusinessId!=='undefined'&&currentBusinessId&&typeof currentUserId!=='undefined'&&currentUserId?currentBusinessId+':'+currentUserId:null;
 const owner=()=>typeof currentUserRole!=='undefined'&&['owner','manager'].includes(currentUserRole);
 let forced=false;
 const key=()=>scope()?'turnkey-setup-guide:'+scope():null;
 function paused(){try{return localStorage.getItem(key())==='paused';}catch{return false;}}
 function steps(){
  const profile=typeof currentBusinessProfile!=='undefined'?currentBusinessProfile||{}:{};
  const rs=typeof records!=='undefined'?records:[];
  return [
   {title:'Business & travel',note:'Add your branding and depot address for travel estimates.',done:!!(profile.name&&profile.home_address),group:'Business'},
   {title:'Pricing & quote templates',note:'Set rates, expenses and your customer-facing documents.',done:!!profile.pricing_config,group:'Pricing'},
   {title:'Connect your inbox',note:'Send quotes and keep customer replies together.',done:typeof emailAccount!=='undefined'&&!!emailAccount,group:'Email'},
   {title:'Bring in your leads',note:'Connect Wix or Meta, import customers, or add a lead.',done:rs.length>0,group:'Integrations'},
   {title:'Build your first quote',note:'Measure a property in Earth, review prices, then preview the PDF.',done:rs.some(r=>r.quoteId),action:'quote'}
  ];
 }
 function render(){
  const host=document.getElementById('view-dashboard');if(!host)return;
  const previous=host.querySelector('#tk-setup-guide');previous?.remove();
  if(!scope()||!owner())return;
  const rows=steps(),complete=rows.filter(r=>r.done).length;
  if(!forced&&(paused()||(typeof records!=='undefined'&&records.length>0)||complete===rows.length))return;
  const section=document.createElement('section');section.id='tk-setup-guide';section.className='tk-setup-guide';
  section.innerHTML=`<div class="tk-setup-head"><div><h3>Set up your workspace</h3><p>${complete} of ${rows.length} ready. Your progress updates as you work.</p></div><button type="button" class="btn ghost sm" data-setup="pause">Hide for now</button></div><ol>${rows.map((row,i)=>`<li class="${row.done?'done':''}"><span class="tk-setup-number" aria-hidden="true">${row.done?'✓':i+1}</span><div><strong>${esc(row.title)}</strong><p>${esc(row.note)}</p></div><button type="button" class="btn ${row.done?'ghost':'primary'} sm" data-setup="${row.group?'settings':'quote'}" ${row.group?`data-group="${esc(row.group)}"`:''}>${row.done?'Review':'Continue'}</button></li>`).join('')}</ol>`;
  host.prepend(section);
 }
 function open(){if(!scope())return;forced=true;switchView('dashboard');render();document.getElementById('tk-setup-guide')?.scrollIntoView({block:'start',behavior:'smooth'});}
 document.addEventListener('click',event=>{
  const el=event.target.closest('[data-setup]');if(!el)return;
  if(el.dataset.setup==='open'){closeModal('settings-overlay');open();return;}
  if(el.dataset.setup==='pause'){forced=false;try{localStorage.setItem(key(),'paused');}catch{}render();return;}
  if(el.dataset.setup==='settings'){openSettings();root.TK_SETTINGS_EXPERIENCE?.showGroup(el.dataset.group);return;}
  if(el.dataset.setup==='quote'){document.querySelector('#tabs [data-sale-action="quote-home"]')?.click();}
 });
 const dashboard=root.renderDashboard;
 if(typeof dashboard==='function')root.renderDashboard=function(){const result=dashboard.apply(this,arguments);render();return result;};
 const settings=root.openSettings;
 if(typeof settings==='function')root.openSettings=function(){const result=settings.apply(this,arguments);const host=document.querySelector('#settings-body .sx-intro');if(host&&!host.querySelector('[data-setup]')){const button=document.createElement('button');button.type='button';button.className='btn ghost sm';button.dataset.setup='open';button.textContent='Open setup guide';host.append(button);}return result;};
 root.TK_ONBOARDING={open,render,steps};
})(window);
