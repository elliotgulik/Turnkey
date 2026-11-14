/* Assigned-work portal. It never loads CRM financial engines or company inbox code. */
(function(root){
 'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let client=null,dependencies={},bound=false,authBound=false,starting=null,poll=null,loadSerial=0,toastTimer=null;
 const state={biz:null,user:null,role:null,version:0,records:[],view:'today',date:localDate(new Date()),employee:null,business:null,ready:false};
 const scope=()=>({biz:state.biz,user:state.user,role:state.role,version:state.version});
 const same=c=>c.biz===state.biz&&c.user===state.user&&c.version===state.version;
 const clean=(v,max=500)=>typeof v==='string'?v.slice(0,max):'';
 function localDate(date){return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');}
 function dayShift(value,delta){const d=new Date(value+'T12:00:00');d.setDate(d.getDate()+delta);return localDate(d);}
 function normaliseJob(job){
  const d=job.details||{},c=job.customer||{};
  return {id:clean(job.id,36),jobId:clean(job.id,36),name:clean(c.name,160)||'Customer',phone:clean(c.phone,60),email:clean(c.email,254),address:[clean(c.address),clean(c.suburb,120)].filter(Boolean).join(', '),
   stage:job.status==='paid'?'completed':clean(job.status,40),jobStatus:clean(d.jobStatus,40),scheduledDateISO:clean(job.scheduled_date,10),calendarStartAt:clean(d.calendarStartAt,50),calendarEndAt:clean(d.calendarEndAt,50),postJobCompletedAt:clean(d.postJobCompletedAt,50),
   workerInstructions:clean(d.workerInstructions,4000),assignedStaffIds:Array.isArray(d.assignedStaffIds)?d.assignedStaffIds.filter(x=>typeof x==='string').slice(0,20):[],
   services:(Array.isArray(job.services)?job.services:[]).map(x=>({label:clean(typeof x==='string'?x:x?.name||x?.label,160)})).filter(x=>x.label),
   crew:(Array.isArray(job.crew)?job.crew:[]).map(x=>clean(typeof x==='string'?x:x?.name,160)).filter(x=>x&&!x.includes('@')).slice(0,20)};
 }
 function normaliseSavedRecord(record){return normaliseJob({id:record.jobId,status:record.stage,scheduled_date:record.scheduledDateISO,customer:{name:record.name,phone:record.phone,email:record.email,address:record.address},details:record,services:record.services,crew:record.crew});}
 function cacheKey(date=state.date){return 'turnkey:employee-jobs:v1:'+state.biz+':'+state.user+':'+date;}
 function dropCache(user){try{for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k?.startsWith('turnkey:employee-jobs:v1:')&&k.split(':')[4]===user)localStorage.removeItem(k);}}catch{}}
 function notify(text){$('employee-toast').textContent=text;$('employee-toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('employee-toast').hidden=true,4500);}
 function status(text,error=false){$('employee-status').textContent=text;$('employee-status').dataset.error=String(error);}
 function showAuth(){state.ready=false;$('employee-app').hidden=true;$('employee-auth').hidden=false;$('auth-card-normal').style.display='';}
 root.showAuth=showAuth;
 function authMessage(text,error=false){$('employee-auth-message').textContent=text;$('employee-auth-message').dataset.error=String(error);}
 function reset(){const user=state.user;state.version++;state.ready=false;state.biz=null;state.user=null;state.role=null;state.employee=null;state.business=null;state.records=[];starting=null;loadSerial++;clearInterval(poll);poll=null;root.TK_MFA?.reset();$('employee-job-list').replaceChildren();$('view-detail').replaceChildren();$('view-worklog').replaceChildren();dropCache(user);showAuth();}
 async function request(path,options={}){
  if(!path.startsWith('/api/job-work/'))throw Error('This feature is not available in the employee portal.');
  const captured=scope();if(!captured.user||!captured.biz)throw Error('Please sign in again.');
  if(dependencies.request){const result=await dependencies.request(path,options,captured);if(!same(captured))throw Error('Your account changed.');return result;}
  const {data,error}=await client.auth.getSession();if(!same(captured)||error||data.session?.user?.id!==captured.user)throw Error('Please sign in again.');
  const base=root.TURNKEY_CONFIG?.backendUrl?.replace(/\/$/,'');if(!base)throw Error('Your job connection is not configured. Contact your manager.');
  const response=await fetch(base+path,{...options,credentials:'omit',headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token,...options.headers},signal:AbortSignal.timeout(30000)});
  const result=await response.json().catch(()=>({error:'The server returned an incomplete response. Please retry.'}));
  if(!same(captured))throw Error('Your account changed.');
  if(!response.ok)throw Object.assign(Error(result.error||'Could not load your work.'),{status:response.status,missingFields:result.missingFields});
  return result;
 }
 function configureWork(){
  const common={getBusinessId:()=>state.biz,getUserId:()=>state.user,getVersion:()=>state.version,getRecords:()=>state.records,notify,employeePortal:true};
  root.TK_JOB_WORK?.configure({...common,request:(path,options)=>request('/api/job-work'+path,options)});
  root.TK_POST_JOB?.configure({context:scope,records:()=>state.records,notify,request,onComplete:(result,r)=>{if(result.job?.status)r.stage=result.job.status==='paid'?'completed':result.job.status;renderJobs();writeCache();}});
 }
 function safeLogo(url){try{return new URL(url).protocol==='https:'?url:'';}catch{return '';}}
 function renderIdentity(){
  $('employee-company-name').textContent=state.business?.name||'Your team';const logo=safeLogo(state.business?.logoUrl),host=$('employee-logo');host.hidden=!logo;host.replaceChildren();if(logo){const img=document.createElement('img');img.src=logo;img.alt=(state.business?.name||'Company')+' logo';img.onerror=()=>{host.hidden=true;};host.append(img);}
  $('employee-greeting').textContent=state.employee?.name?'Signed in as '+state.employee.name:'Only jobs assigned to you are shown.';
  $('employee-full-crm').hidden=!['owner','manager'].includes(state.role);
 }
 function dateFor(r){if(r.calendarStartAt&&!Number.isNaN(Date.parse(r.calendarStartAt)))return localDate(new Date(r.calendarStartAt));return r.scheduledDateISO;}
 function timeLabel(r){if(!r.calendarStartAt||Number.isNaN(Date.parse(r.calendarStartAt)))return ['Time not set',''];const format=v=>new Date(v).toLocaleTimeString('en-NZ',{hour:'numeric',minute:'2-digit'});return [format(r.calendarStartAt),r.calendarEndAt&&!Number.isNaN(Date.parse(r.calendarEndAt))?'to '+format(r.calendarEndAt):''];}
 function jobStatus(r){return r.postJobCompletedAt?'Field checklist saved':({scheduled:'Booked',won:'Ready to schedule',completed:'Completed',cancelled:'Cancelled'})[r.stage]||'Assigned job';}
 function weekDates(){const day=new Date(state.date+'T12:00:00').getDay(),first=dayShift(state.date,-(day===0?6:day-1));return Array.from({length:7},(_,i)=>dayShift(first,i));}
 function renderJobs(){
  if(!state.ready)return;
  $('employee-title').textContent=state.view==='schedule'?'My schedule':'My jobs';$('employee-date').value=state.date;$('employee-week').hidden=state.view!=='schedule';
  if(state.view==='schedule')$('employee-week').innerHTML=weekDates().map(date=>{const d=new Date(date+'T12:00:00');return `<button type="button" data-day="${date}" aria-pressed="${date===state.date}" aria-label="${esc(d.toLocaleDateString('en-NZ',{weekday:'long',day:'numeric',month:'long'}))}"><span>${esc(d.toLocaleDateString('en-NZ',{weekday:'short'}))}</span><strong>${d.getDate()}</strong></button>`;}).join('');
  const jobs=state.records.filter(r=>dateFor(r)===state.date).sort((a,b)=>(a.calendarStartAt||'').localeCompare(b.calendarStartAt||'')||a.name.localeCompare(b.name));
  $('employee-job-list').innerHTML=jobs.length?jobs.map(r=>{const [time,end]=timeLabel(r);return `<article class="employee-job-row"><time class="employee-job-time">${esc(time)}<small>${esc(end)}</small></time><div><h2>${esc(r.name)}</h2><p>${esc(r.address||'Address not set')}</p><p>${esc(r.services.map(x=>x.label).join(', ')||'No services listed')}</p>${r.crew.length?`<p class="employee-job-meta">Crew: ${esc(r.crew.join(', '))}</p>`:''}</div><div><span class="employee-job-status">${esc(jobStatus(r))}</span><button class="btn ghost" type="button" data-job="${esc(r.id)}">Open job</button></div></article>`;}).join(''):'<div class="employee-empty"><h2>No jobs booked for this day</h2><p>Try another date or check with your manager. Only your assigned jobs appear here.</p></div>';
 }
 function writeCache(){if(!state.ready)return;try{localStorage.setItem(cacheKey(),JSON.stringify({savedAt:Date.now(),records:state.records}));}catch{}}
 async function refresh(){
  if(!state.ready)return;
  const captured=scope(),seq=++loadSerial;$('employee-refresh').disabled=true;status(state.records.length?'Checking for job updates…':'Loading your assigned jobs…');
  try{
   const data=await request('/api/job-work/portal?date='+encodeURIComponent(state.date));if(!same(captured)||seq!==loadSerial)return;
   if(data.business?.id&&data.business.id!==state.biz){reset();authMessage('Your company changed. Sign in again to load the correct workspace.',true);return;}
   state.records=(data.jobs||[]).map(normaliseJob).filter(r=>r.jobId);state.employee=data.employee||null;state.business=data.business||null;renderIdentity();renderJobs();writeCache();status('Up to date, '+new Date().toLocaleTimeString('en-NZ',{hour:'numeric',minute:'2-digit'}));
  }catch(e){if(same(captured)&&seq===loadSerial){status((state.records.length?'Showing saved jobs. ':'')+e.message,true);if(!state.records.length)renderJobs();}}
  finally{if(same(captured)&&seq===loadSerial)$('employee-refresh').disabled=false;}
 }
 function changeDate(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return;state.date=date;renderJobs();refresh();}
 function view(name){
  if(!state.ready)return;state.view=name;
  $('employee-jobs').hidden=name==='hours'||name==='detail';$('view-detail').hidden=name!=='detail';$('view-worklog').hidden=name!=='hours';$('view-worklog').classList.toggle('active',name==='hours');
  document.querySelectorAll('[data-employee-view]').forEach(button=>{if(button.dataset.employeeView===name||name==='detail'&&button.dataset.employeeView==='today')button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  if(name==='hours')root.TK_JOB_WORK.openWorkLogPage();else if(name!=='detail'){renderJobs();if(name==='schedule')refresh();}root.scrollTo(0,0);
 }
 function openDetail(id){
  const r=state.records.find(row=>String(row.id)===String(id));if(!r)return;view('detail');
  const [start,end]=timeLabel(r),date=dateFor(r);$('view-detail').innerHTML=`<header class="employee-detail-heading"><button type="button" class="btn ghost" data-back>Back to my jobs</button><h1>${esc(r.name)}</h1><p>${esc(r.address||'Address not set')}</p><div class="employee-contact-actions">${r.phone?`<a class="btn ghost" href="tel:${esc(r.phone.replace(/[^+\d]/g,''))}">Call customer</a>`:''}${r.address?`<a class="btn ghost" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(r.address)}" target="_blank" rel="noopener noreferrer">Directions</a>`:''}</div></header><div class="detail-grid"><section class="employee-instructions"><h2>Job details</h2><dl class="employee-detail-schedule"><dt>Date</dt><dd>${esc(date?new Date(date+'T12:00:00').toLocaleDateString('en-NZ',{weekday:'long',day:'numeric',month:'long'}):'Not scheduled')}</dd><dt>Time</dt><dd>${esc(start+' '+end)}</dd><dt>Crew</dt><dd>${esc(r.crew.join(', ')||'Not listed')}</dd><dt>Status</dt><dd>${esc(jobStatus(r))}</dd>${r.email?`<dt>Customer email</dt><dd>${esc(r.email)}</dd>`:''}</dl><h3>Services</h3><ul>${r.services.map(x=>`<li>${esc(x.label)}</li>`).join('')||'<li>No services listed</li>'}</ul>${r.workerInstructions?`<h3>Work instructions</h3><p>${esc(r.workerInstructions)}</p>`:''}<button class="btn primary" type="button" data-complete>${r.postJobCompletedAt?'View post-job checklist':'Post-job checklist / complete job'}</button></section></div>`;
  $('view-detail').querySelector('[data-back]').onclick=()=>view('today');$('view-detail').querySelector('[data-complete]').onclick=()=>root.TK_POST_JOB.open(r.id);
 }
 root.openDetail=openDetail;
 async function start(session){
  if(!session?.user?.id){reset();authMessage('Sign in with the account your manager invited.');return;}
  root.TK_CURRENT_SESSION=session;if(state.ready&&state.user===session.user.id)return;if(starting?.user===session.user.id)return starting.promise;
  const uid=session.user.id,version=++state.version;state.ready=false;state.records=[];$('employee-app').hidden=true;authMessage('Checking your access…');
  const promise=(async()=>{
   const {data,error}=await client.from('users').select('id,business_id,role').eq('id',uid).maybeSingle();if(state.version!==version)return;
   if(error||!data?.business_id||!['technician','owner','manager'].includes(data.role))throw Error('Your employee access is not set up. Ask your manager to check your invitation.');
   if(data.business_id==='83c8112c-ad39-468d-b384-de593767e291'){location.replace('post-office.html');return;}
   if(root.TK_MFA&&!await root.TK_MFA.requireFor(session,data.role))return;if(state.version!==version)return;
   state.user=uid;state.biz=data.business_id;state.role=data.role;state.ready=true;configureWork();
   try{const saved=JSON.parse(localStorage.getItem(cacheKey())||'null');if(saved?.savedAt>Date.now()-7*86400000&&Array.isArray(saved.records))state.records=saved.records.map(normaliseSavedRecord);}catch{}
   $('employee-auth').hidden=true;$('employee-app').hidden=false;$('employee-password').value='';renderIdentity();view('today');await refresh();root.TK_POST_JOB?.refreshIdentity();
   clearInterval(poll);poll=setInterval(()=>{if(!document.hidden&&state.ready)refresh();},60000);
  })().catch(e=>{if(state.version===version){reset();authMessage(e.message,true);}}).finally(()=>{if(starting?.user===uid)starting=null;});starting={user:uid,promise};return promise;
 }
 async function boot(){
  const c=root.TURNKEY_CONFIG||{};client=dependencies.client||(c.supabaseUrl&&c.supabaseAnonKey&&root.supabase?.createClient(c.supabaseUrl,c.supabaseAnonKey));root.sb=client;
  if(!client){authMessage('Employee sign-in is unavailable. Contact your manager.',true);$('employee-sign-in').disabled=true;return;}
  $('employee-sign-in').disabled=false;
  if(!bound){bound=true;
   $('employee-login-form').onsubmit=async e=>{e.preventDefault();const button=$('employee-sign-in');button.disabled=true;authMessage('Signing in…');try{const {data,error}=await client.auth.signInWithPassword({email:$('employee-email').value.trim(),password:$('employee-password').value});if(error)throw error;await start(data.session);}catch{authMessage('Could not sign in. Check your email and password, then retry.',true);}finally{button.disabled=false;}};
   $('employee-sign-out').onclick=async()=>{const button=$('employee-sign-out');button.disabled=true;try{const {error}=await client.auth.signOut();if(error)throw error;reset();root.TK_CURRENT_SESSION=null;authMessage('You’ve signed out.');}catch{notify('Could not sign out. Check your connection and try again.');}finally{button.disabled=false;}};
   $('employee-refresh').onclick=refresh;$('employee-date').onchange=e=>changeDate(e.target.value);$('employee-previous').onclick=()=>changeDate(dayShift(state.date,-1));$('employee-next').onclick=()=>changeDate(dayShift(state.date,1));$('employee-today').onclick=()=>changeDate(localDate(new Date()));
   $('employee-week').onclick=e=>{const button=e.target.closest('[data-day]');if(button)changeDate(button.dataset.day);};
   $('employee-job-list').onclick=e=>{const button=e.target.closest('[data-job]');if(button)root.openDetail(button.dataset.job);};
   document.querySelectorAll('[data-employee-view]').forEach(button=>button.onclick=()=>view(button.dataset.employeeView));
   root.addEventListener('turnkey:job-checklist-completed',()=>refresh());root.addEventListener('focus',()=>{if(state.ready)refresh();});
  }
  if(!authBound){authBound=true;client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'){reset();root.TK_CURRENT_SESSION=null;}else if(session){root.TK_CURRENT_SESSION=session;if(!state.ready||state.user!==session.user.id)setTimeout(()=>start(session),0);}});}
  try{const {data,error}=await client.auth.getSession();if(error)throw error;await start(data.session);}catch{showAuth();authMessage('Could not restore your session. Sign in again.',true);}
 }
 root.TK_EMPLOYEE_PORTAL={configure(options){dependencies=options||{};},boot,start,view,refresh,normaliseJob,getState:()=>({biz:state.biz,user:state.user,role:state.role,ready:state.ready,records:state.records.map(r=>({...r}))})};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})(window);
