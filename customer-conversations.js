/* Customer-scoped reading surface. Data ownership and sending stay in the bridge. */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function readable(value){
  let text=String(value||'');
  for(let i=0;i<2;i++){const el=document.createElement('textarea');el.innerHTML=text.replace(/</g,'&lt;').replace(/>/g,'&gt;');const next=el.value;if(next===text)break;text=next;}
  return text.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim();
 }
 const key=m=>m.account_id+':'+(m.thread_id||m.id);
 const stamp=m=>Number.isFinite(Date.parse(m.sent_at))?Date.parse(m.sent_at):0;
 const date=(m,full=false)=>stamp(m)?new Date(m.sent_at).toLocaleString('en-NZ',{day:'numeric',month:'short',...(full?{year:'numeric',hour:'numeric',minute:'2-digit'}:{})}):'Date unavailable';
 function mount(host,{messages=[],name='',email='',limited=false,onCompose,onReply,onOpenThread,onRefresh}={}){
  host.classList.add('cch');
  const grouped=new Map();
  for(const m of messages){const k=key(m);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(m);}
  const threads=[...grouped].map(([id,rows])=>{rows.sort((a,b)=>stamp(a)-stamp(b));return {id,rows,last:rows.at(-1)};}).sort((a,b)=>stamp(b.last)-stamp(a.last));
  let selected=threads[0]?.id||null,query='',filter='all',reading=false;
  const label=m=>m.direction==='sent'?'Sent':'Received';
  const body=m=>readable(m.body_text||m.snippet)||'No message preview is available. Open this conversation in the inbox to check the original email.';
  const button=(text,action,extra='')=>`<button type="button" data-cch="${action}" ${extra}>${text}</button>`;
  function draw(){
   const q=query.toLowerCase().trim();
   const shown=threads.filter(t=>(filter==='all'||t.rows.some(m=>m.direction===filter))&&(!q||t.rows.some(m=>[m.subject,m.from_address,m.to_addresses,body(m)].join(' ').toLowerCase().includes(q))));
   if(!shown.some(t=>t.id===selected))selected=shown[0]?.id||null;
   const current=shown.find(t=>t.id===selected);
   host.innerHTML=`<header class="cch-head"><div><h3>Conversations</h3><p>${esc(name||email||'Customer')} <span>· ${threads.length} thread${threads.length===1?'':'s'} · ${messages.length} message${messages.length===1?'':'s'}</span></p></div>${onCompose?button('Compose email','compose','class="cch-primary"'):''}</header>
    <div class="cch-tools"><label class="cch-search"><span class="sr-only">Search this customer’s messages</span><input type="search" placeholder="Search this customer’s messages" value="${esc(query)}" data-cch-search></label><div class="cch-filters" role="group" aria-label="Filter customer conversations">${[['all','All'],['received','Received'],['sent','Sent']].map(([v,title])=>button(title,'filter',`data-filter="${v}" aria-pressed="${filter===v}"`)).join('')}</div></div>
    <div class="cch-workspace ${reading?'cch-reading':''}"><nav class="cch-list" aria-label="Customer email threads">${shown.map(t=>`<button type="button" class="cch-thread ${t.id===selected?'selected':''}" data-cch="thread" data-key="${esc(t.id)}" aria-current="${t.id===selected?'true':'false'}"><span class="cch-thread-meta"><span class="cch-direction ${t.last.direction==='sent'?'sent':''}">${label(t.last)}</span><time>${esc(date(t.last))}</time></span><strong>${esc(readable(t.last.subject)||'(No subject)')}</strong><span class="cch-snippet">${esc(body(t.last).replace(/\s+/g,' '))}</span><small>${t.rows.length} message${t.rows.length===1?'':'s'}</small></button>`).join('')||'<div class="cch-empty"><strong>'+ (threads.length?'No matching conversations':'No conversations yet')+'</strong><p>'+(threads.length?'Try another search or filter.':'Sent quotes and customer replies will appear here after your mailbox syncs.')+'</p></div>'}</nav>
    <section class="cch-reader" aria-label="Conversation messages">${current?`<header class="cch-reader-head">${button('Back to conversations','back','class="cch-back"')}<h4 tabindex="-1">${esc(readable(current.last.subject)||'(No subject)')}</h4><div class="cch-reader-actions">${onReply?button(current.last.direction==='sent'?'Follow up':'Reply','reply','class="cch-primary"'):''}${onOpenThread?button('Open in inbox','open'):''}</div></header><div class="cch-messages">${current.rows.map((m,i)=>`<article class="cch-message ${m.direction==='sent'?'outgoing':'incoming'}"><header><div><span class="cch-direction ${m.direction==='sent'?'sent':''}">${label(m)}</span><strong>${esc(m.direction==='sent'?'Your team':name||'Customer')}</strong></div><time datetime="${esc(m.sent_at||'')}">${esc(date(m,true))}</time></header><details class="cch-addresses"><summary>Message details</summary><dl><dt>From</dt><dd>${esc(readable(m.from_address))}</dd><dt>To</dt><dd>${esc(readable(m.to_addresses))}</dd></dl></details>${i<current.rows.length-1?`<details class="cch-earlier"><summary>Show earlier message</summary><div class="cch-body">${esc(body(m))}</div></details>`:`<div class="cch-body">${esc(body(m))}</div>`}</article>`).join('')}</div>`:'<div class="cch-empty"><strong>Your customer emails, together</strong><p>Select a conversation to read the messages.</p></div>'}</section></div>
    <footer class="cch-foot"><details><summary>About this history</summary><p>Emails from your connected Gmail account, matched to this customer.${limited?' Limited to your latest 500 synced mailbox messages. Older messages may not appear here.':''} Refresh checks saved emails; use Inbox → Sync to retrieve new mail from Gmail.</p></details>${onRefresh?button('Refresh','refresh'):''}</footer>`;
  }
  host.onclick=async e=>{
   const el=e.target.closest('[data-cch]');if(!el||!host.contains(el))return;
   const action=el.dataset.cch;
   if(action==='filter'){filter=el.dataset.filter;draw();return;}
   if(action==='thread'){selected=el.dataset.key;reading=true;draw();host.querySelector('.cch-reader-head h4')?.focus({preventScroll:true});return;}
   if(action==='back'){reading=false;draw();return;}
   const id=selected,callback={compose:onCompose,reply:()=>onReply?.(id),open:()=>onOpenThread?.(id),refresh:onRefresh}[action];
   if(!callback)return;el.disabled=true;
   try{await callback();}catch(error){if(host.isConnected){const notice=document.createElement('p');notice.className='cch-error';notice.setAttribute('role','alert');notice.textContent=error.message||'Could not open this action. Please retry.';host.prepend(notice);}}finally{if(el.isConnected)el.disabled=false;}
  };
  host.oninput=e=>{if(!e.target.matches('[data-cch-search]'))return;query=e.target.value;const position=e.target.selectionStart;draw();const input=host.querySelector('[data-cch-search]');input.focus();if(position!=null&&input.type!=='search')input.setSelectionRange(position,position);};
  draw();
  return {threads:threads.length,messages:messages.length};
 }
 root.TK_CUSTOMER_CONVERSATIONS={mount,readable};
})(window);
