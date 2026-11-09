/* Discovery only: database policies, not this link, enforce account access. */
(function(){
 function update(session){
  const old=document.getElementById('post-office-workspace-link');
  if(session?.user?.email?.toLowerCase()!=='jackie@thepostoffice.co.nz'){old?.remove();return;}
  if(old)return;const nav=document.getElementById('tabs');if(!nav)return;
  const link=document.createElement('a');link.id='post-office-workspace-link';link.href='post-office.html';link.textContent='Production workspace';link.className='tab';nav.prepend(link);
 }
 const client=typeof sb!=='undefined'?sb:null;
 if(client){client.auth.onAuthStateChange((_e,s)=>update(s));client.auth.getSession().then(({data})=>update(data.session));}
})();
