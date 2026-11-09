/* Standalone crew and time pages. Persistence and authorization belong to the parent API. */
(function (root) {
'use strict';
function calculateHours(entry) {
 const minutes = value => {
  if (!/^\d{2}:\d{2}$/.test(String(value))) throw Error('Enter a start and end time.');
  const [h,m] = value.split(':').map(Number);
  if (h > 23 || m > 59) throw Error('Enter valid times.');
  return h * 60 + m;
 };
 const start = minutes(entry.start), end = minutes(entry.end);
 if (end <= start) throw Error('End must be after start. Overnight shifts are not supported; split them across dates.');
 const duration = name => {
  const raw = entry[name] ?? 0;
  const n = typeof raw === 'number' ? raw : /^\d+(\.\d+)?$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) throw Error('Break and travel minutes must be non-negative numbers.');
  return n;
 };
 const breakMinutes = duration('breakMinutes'), travelMinutes = duration('travelMinutes');
 if (breakMinutes + travelMinutes > end - start) throw Error('Break and travel cannot exceed the shift duration.');
 return {paidHours:(end-start-breakMinutes)/60, productiveHours:(end-start-breakMinutes-travelMinutes)/60};
}
const text = (form, name) => String(form.get(name) ?? '').trim();
const list = (state, key) => Array.isArray(state[key]) ? state[key] : [];
const ownCrew = (api, crew) => !!api.currentUserId && crew.userId === api.currentUserId;
function visibleLogs(api, state) {
 return list(state,'workLogs').filter(log => api.canManage || (list(state,'crew').some(c => c.id === log.crewId && ownCrew(api,c)) && (!log.userId || log.userId === api.currentUserId)));
}
function assigned(entry, person) {
 return entry.crewId ? entry.crewId === person.id : String(entry.name || '').trim().toLowerCase() === person.name.trim().toLowerCase();
}
function localDate(date = new Date()) {
 return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function validDate(value) {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
 const d = new Date(value+'T12:00:00');
 return Number.isFinite(d.getTime()) && localDate(d) === value;
}
function weekOf(date) {
 const d = new Date(date+'T12:00:00');
 d.setDate(d.getDate() - (d.getDay()+6)%7);
 return localDate(d);
}
function totals(logs) {
 return logs.reduce((sum, log) => {
  try { const h = calculateHours(log); sum.paidHours += h.paidHours; sum.productiveHours += h.productiveHours; }
  catch (_) { const hours = Number(log.hours); if (Number.isFinite(hours) && hours >= 0) sum.paidHours += hours; }
  return sum;
 }, {paidHours:0,productiveHours:0});
}
const hoursText = h => `${h.paidHours.toFixed(2)} h paid · ${h.productiveHours.toFixed(2)} h productive`;
function select(api, label, name, rows, value='', placeholder='Choose…', required=true) {
 return `<div class="field"><label for="poc-${name}">${api.esc(label)}</label><select id="poc-${name}" name="${name}" ${required?'required':''}><option value="">${api.esc(placeholder)}</option>${rows.map(r=>`<option value="${api.esc(r.id)}" ${r.id===value?'selected':''}>${api.esc(r.name)}</option>`).join('')}</select></div>`;
}
function manager(api) { if (!api.canManage) throw Error('Only managers can change crew or assignments.'); }
function editPerson(api, person) {
 manager(api);
 const p = person || {};
 const members=()=>typeof api.members==='function'?api.members()||[]:[];
 const accounts=members().map(m=>({id:m.id,name:[m.name,m.email,m.role].filter(Boolean).join(' · ')}));
 if(p.userId&&!accounts.some(m=>m.id===p.userId)) accounts.push({id:p.userId,name:'Current linked login (unavailable)'});
 api.openEditor(person?'Edit crew member':'Add crew member', `<div class="poc-editor fields">${api.field('Name','name',p.name||'','text',true)}${api.field('Role','role',p.role||'','text',true)}${api.field('Email','email',p.email||'','email')}${api.field('Phone','phone',p.phone||'','tel')}${select(api,'Linked staff login (optional)','userId',accounts,p.userId||'','No linked login',false)}</div><p class="muted">Link a company login so this person can record their own hours. This does not create an account or grant manager access.</p>`, async form => {
  manager(api);
  const item = {...p,id:p.id||api.id(), name:text(form,'name'),role:text(form,'role'),email:text(form,'email'),phone:text(form,'phone'),userId:text(form,'userId')};
  if (!item.name || !item.role) throw Error('Name and role are required.');
  if(item.userId&&item.userId!==p.userId&&!members().some(m=>m.id===item.userId)) throw Error('Choose a current company login.');
  await api.change(s => {
   manager(api); s.crew = list(s,'crew');
   if (item.userId && s.crew.some(c=>c.id!==item.id && c.userId===item.userId)) throw Error('That account is already linked to a crew member.');
   if (p.id) {
    const i=s.crew.findIndex(c=>c.id===p.id); if(i<0) throw Error('Crew member no longer exists.');
    const previous=s.crew[i];
    list(s,'projects').forEach(project=>{project.crew=list(project,'crew').map(a=>assigned(a,previous)?{...a,crewId:item.id,name:item.name,contact:item.email||item.phone||''}:a);});
    s.crew[i]=item;
   }
   else s.crew.push(item);
  });
  renderCrew(api);
 });
}
function editAssignment(api, person, projectId) {
 manager(api);
 const s=api.state(), project=list(s,'projects').find(p=>p.id===projectId);
 const existing=project && list(project,'crew').find(c=>assigned(c,person));
 api.openEditor(existing?'Edit project assignment':'Assign crew to project', `<div class="poc-editor fields">${select(api,'Project','projectId',list(s,'projects'),projectId)}${select(api,'Crew member','crewId',list(s,'crew'),person.id)}${api.field('Role on this project','role',existing?.role||person.role||'','text',true)}${api.field('Assignment status','status',existing?.status||'','text',true)}</div><p class="muted">Enter the agreed role and status for this assignment.</p>`, async form => {
  manager(api);
  const pid=text(form,'projectId'), cid=text(form,'crewId'), role=text(form,'role'), status=text(form,'status');
  if (!role || !status) throw Error('Enter a role and assignment status.');
  await api.change(state => {
   manager(api);
   const p=list(state,'projects').find(p=>p.id===pid), c=list(state,'crew').find(c=>c.id===cid);
   if (!p || !c) throw Error('Choose an existing project and crew member.');
   p.crew=list(p,'crew');
   const i=p.crew.findIndex(a=>assigned(a,c));
   const item={...(i>=0?p.crew[i]:{}),crewId:c.id,name:c.name,contact:c.email||c.phone||'',role,status};
   if(i>=0) p.crew[i]=item; else p.crew.push(item);
  });
  renderCrew(api,{personId:person.id});
 });
}
function renderCrew(api, view={}) {
 const s=api.state(), e=api.esc, person=list(s,'crew').find(c=>c.id===view.personId);
 if(person) {
  const projects=list(s,'projects').filter(p=>list(p,'crew').some(c=>assigned(c,person)));
  const logs=visibleLogs(api,s).filter(l=>l.crewId===person.id);
  api.content.innerHTML=`<div class="poc-page"><div class="toolbar"><button data-back>All crew</button>${api.canManage?'<button data-edit>Edit person</button><button data-assign class="primary">Assign to project</button><button data-delete>Delete person</button>':''}</div><section class="surface"><h2>${e(person.name)}</h2><p>${e(person.role)}</p><p>${e(person.email)} ${e(person.phone)}</p><h3>Hours logged</h3><p>${e(hoursText(totals(logs)))}</p>${!api.canManage&&!ownCrew(api,person)?'<p class="muted">Only your own hours are visible.</p>':''}</section><section class="surface"><h2>Project assignments</h2>${projects.map(p=>`<div class="list-row"><div><h3>${e(p.name)}</h3>${list(p,'crew').filter(c=>assigned(c,person)).map(c=>`<p>${e(c.role)} · ${e(c.status||'No status entered')}</p>`).join('')}</div>${api.canManage?`<div class="row-actions"><button data-assignment="${e(p.id)}">Edit assignment</button><button data-unassign="${e(p.id)}">Remove assignment</button></div>`:''}</div>`).join('')||'<p class="empty">No project assignments yet.</p>'}</section></div>`;
  api.content.querySelector('[data-back]').onclick=()=>renderCrew(api);
  if(api.canManage) {
   api.content.querySelector('[data-edit]').onclick=()=>editPerson(api,person);
   api.content.querySelector('[data-assign]').onclick=()=>editAssignment(api,person,'');
   api.content.querySelectorAll('[data-assignment]').forEach(b=>b.onclick=()=>editAssignment(api,person,b.dataset.assignment));
   api.content.querySelectorAll('[data-unassign]').forEach(b=>b.onclick=()=>api.run(async()=>{
    await api.change(state=>{ manager(api); const p=list(state,'projects').find(p=>p.id===b.dataset.unassign); if(p) p.crew=list(p,'crew').filter(c=>!assigned(c,person)); });
    renderCrew(api,{personId:person.id});
   }));
   api.content.querySelector('[data-delete]').onclick=()=>api.openEditor('Delete crew member',`<p>Delete ${e(person.name)} and remove their project assignments? Existing hour logs will be retained.</p>`,async()=>{
    await api.change(state=>{manager(api); state.workLogs=list(state,'workLogs').map(l=>l.crewId===person.id?{...l,crewName:person.name,userId:l.userId||person.userId||''}:l); state.crew=list(state,'crew').filter(c=>c.id!==person.id); list(state,'projects').forEach(p=>{p.crew=list(p,'crew').filter(c=>!assigned(c,person));});});
    renderCrew(api);
   });
  }
  return;
 }
 api.content.innerHTML=`<div class="poc-page"><div class="toolbar"><h2>Crew directory</h2>${api.canManage?'<button data-add class="primary">Add person</button>':''}</div><div class="fields"><div class="field"><label for="poc-search">Search name, role or contact</label><input id="poc-search" type="search" autocomplete="off"></div>${select(api,'Filter by project','crewProject',list(s,'projects'),'','All projects',false)}</div><section class="surface" data-people aria-live="polite"></section></div>`;
 const draw=()=>{
  const q=api.content.querySelector('#poc-search').value.trim().toLowerCase();
  const state=api.state(), pid=api.content.querySelector('#poc-crewProject').value;
  const project=list(state,'projects').find(p=>p.id===pid);
  const people=list(state,'crew').filter(c=>(!pid||project&&list(project,'crew').some(a=>assigned(a,c)))&&[c.name,c.role,c.email,c.phone].some(v=>String(v||'').toLowerCase().includes(q)));
  api.content.querySelector('[data-people]').innerHTML=people.map(c=>`<div class="list-row"><span class="po-person-initials" aria-hidden="true">${e(c.name.trim().split(/\s+/).map(n=>n[0]).slice(0,2).join(''))}</span><div><h3>${e(c.name)}</h3><p>${e(c.role)}</p><p>${e(c.email)} ${e(c.phone)}</p></div><button data-person="${e(c.id)}">View person</button></div>`).join('')||'<p class="empty">No crew members found.</p>';
  api.content.querySelectorAll('[data-person]').forEach(b=>b.onclick=()=>renderCrew(api,{personId:b.dataset.person}));
 };
 api.content.querySelector('#poc-search').oninput=draw;
 api.content.querySelector('#poc-crewProject').onchange=draw;
 if(api.canManage) api.content.querySelector('[data-add]').onclick=()=>editPerson(api);
 draw();
}
function renderHours(api) {
 const s=api.state(), e=api.esc, crew=list(s,'crew').filter(c=>api.canManage||ownCrew(api,c));
 api.content.innerHTML=`<div class="poc-page"><section class="surface"><h2>Log work hours</h2><p class="muted">Paid time excludes breaks. Productive time also excludes travel. Overnight shifts must be split across dates.</p>${crew.length?`<form data-hours><div class="fields">${select(api,'Crew member','crewId',crew,crew.length===1?crew[0].id:'')}${select(api,'Project','projectId',list(s,'projects'))}${api.field('Work date','date',localDate(),'date',true)}${api.field('Start time','start','','time',true)}${api.field('End time','end','','time',true)}${api.field('Break (minutes)','breakMinutes',0,'number',true)}${api.field('Travel (minutes, included in paid time)','travelMinutes',0,'number',true)}</div>${api.area('Notes','notes','')}<p data-preview role="status">Choose start and end times to calculate hours.</p><button class="primary" type="submit">Save hours</button></form>`:'<p class="empty">'+(api.canManage?'Add a crew member before logging hours.':'Your account is not linked to a crew member. Ask a manager to link your account.')+'</p>'}</section><section class="surface"><h2>Hours recorded</h2><div class="poc-filters">${api.field('From date','from','','date')}${api.field('To date','to','','date')}${select(api,'Filter crew','filterCrew',crew,'','All visible crew',false)}</div><p data-filter-error role="status"></p><div data-weekly></div><div data-logs></div></section></div>`;
 const form=api.content.querySelector('[data-hours]');
 if(form) {
  form.querySelectorAll('input[type="number"]').forEach(el=>{el.min='0';el.step='1';el.inputMode='numeric';});
  form.querySelectorAll('input[type="time"]').forEach(el=>{el.step='60';});
  const preview=()=>{
   try {form.querySelector('[data-preview]').textContent=hoursText(calculateHours(Object.fromEntries(new FormData(form))));}
   catch(err) {form.querySelector('[data-preview]').textContent=err.message;}
  };
  form.oninput=preview;
  form.onsubmit=event=>{
   event.preventDefault(); const button=form.querySelector('button[type="submit"]');
   if(button.disabled) return;
   button.disabled=true;
   api.run(async()=>{
    try {
     const data=new FormData(form), state=api.state(), member=list(state,'crew').find(c=>c.id===text(data,'crewId'));
     if(!member || (!api.canManage&&!ownCrew(api,member))) throw Error('Choose a crew member linked to your account.');
     const projectId=text(data,'projectId'), date=text(data,'date');
     if(!list(state,'projects').some(p=>p.id===projectId)) throw Error('Choose an existing project.');
     if(!validDate(date)) throw Error('Choose a valid work date.');
     const entry={id:api.id(),crewId:member.id,projectId,userId:member.userId||'',date,start:text(data,'start'),end:text(data,'end'),breakMinutes:Number(text(data,'breakMinutes')),travelMinutes:Number(text(data,'travelMinutes')),notes:text(data,'notes')};
     const h=calculateHours(entry);
     await api.logHours({...entry,...h,hours:h.paidHours});
     renderHours(api);
    } finally {button.disabled=false;}
   });
  };
 }
 const draw=()=>{
  const state=api.state(), from=api.content.querySelector('#f-from').value, to=api.content.querySelector('#f-to').value, cid=api.content.querySelector('#poc-filterCrew').value;
  const error=from&&to&&from>to?'From date must be on or before to date.':'';
  api.content.querySelector('[data-filter-error]').textContent=error;
  const all=visibleLogs(api,state), logs=error?[]:all.filter(l=>(!from||l.date>=from)&&(!to||l.date<=to)&&(!cid||l.crewId===cid)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const groups=new Map();
  logs.forEach(l=>{if(!validDate(l.date))return; const week=weekOf(l.date), key=JSON.stringify([week,l.crewId]); if(!groups.has(key))groups.set(key,{week,crewId:l.crewId,logs:[]}); groups.get(key).logs.push(l);});
  const name=l=>list(state,'crew').find(c=>c.id===l.crewId)?.name||l.crewName||'Removed crew member';
  api.content.querySelector('[data-weekly]').innerHTML=`<h3>Weekly totals per crew member</h3><p class="muted">Weeks start Monday. Totals reflect the current date and crew filters.</p>${[...groups.values()].map(g=>`<div class="list-row"><div><strong>${e(name(g.logs[0]))}</strong><p>Week of ${e(g.week)}</p></div><span>${e(hoursText(totals(g.logs)))}</span></div>`).join('')||'<p class="empty">No hours in this period.</p>'}`;
  api.content.querySelector('[data-logs]').innerHTML=`<h3>Work logs</h3>${logs.map(l=>`<div class="list-row"><div><strong>${e(name(l))} · ${e(l.date)}</strong><p>${e(list(state,'projects').find(p=>p.id===l.projectId)?.name||'Removed project')}</p><p>${e(l.start)}–${e(l.end)} · ${e(hoursText(totals([l])))}</p><p>Break: ${e(l.breakMinutes||0)} min · Travel: ${e(l.travelMinutes||0)} min</p><p class="poc-notes">${e(l.notes||'')}</p></div><button data-remove-log="${e(l.id)}">Delete log</button></div>`).join('')||'<p class="empty">No work logs found.</p>'}`;
  api.content.querySelectorAll('[data-remove-log]').forEach(b=>b.onclick=()=>{
   api.openEditor('Delete work log','<p>Delete this work log? This will update weekly totals.</p>',async()=>{
    if(!visibleLogs(api,api.state()).some(l=>l.id===b.dataset.removeLog)) throw Error('You cannot delete this log.');
    await api.removeHours(b.dataset.removeLog); renderHours(api);
   });
  });
 };
 ['#f-from','#f-to','#poc-filterCrew'].forEach(selector=>{api.content.querySelector(selector).onchange=draw;});
 draw();
}
const exported={renderCrew,renderHours,calculateHours};
if(typeof module==='object'&&module.exports) module.exports=exported;
if(root) root.TK_POST_OFFICE_CREW=exported;
})(typeof window==='undefined'?null:window);
