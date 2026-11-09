/* Account discovery only. Database membership policies enforce access. */
(function(){
 const company='83c8112c-ad39-468d-b384-de593767e291';let generation=0,lastUser=null;
 const client=typeof sb!=='undefined'?sb:null;if(!client)return;
 async function update(session){
  const uid=session?.user?.id||null;if(uid&&uid===lastUser)return;lastUser=uid;const version=++generation;
  document.getElementById('post-office-workspace-link')?.remove();if(!uid)return;
  try{const {data,error}=await client.from('users').select('business_id').eq('id',uid).maybeSingle();if(version!==generation||error||data?.business_id!==company)return;
   const nav=document.getElementById('tabs');if(nav){const link=document.createElement('a');link.id='post-office-workspace-link';link.href='post-office.html';link.textContent='Production workspace';link.className='tab';nav.prepend(link);}
   if(new URLSearchParams(location.search).get('standard')!=='1')location.replace('post-office.html');
  }catch(_){lastUser=null;}
 }
 client.auth.onAuthStateChange((_event,session)=>setTimeout(()=>update(session),0));client.auth.getSession().then(({data})=>update(data.session));
})();
