(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const request=$('reset-request'),change=$('reset-change'),status=$('reset-status');
 const hash=new URLSearchParams(location.hash.slice(1)),query=new URLSearchParams(location.search);
 const recoveryLink=hash.get('type')==='recovery'||query.has('code');
 const linkError=hash.get('error')||query.get('error')||hash.get('error_code')||query.get('error_code');
 let ready=false,busy=false,recoveryUserId=null;
 const marker='turnkey-password-recovery';
 function message(text,error=false){status.textContent=text;status.classList.toggle('error',error);status.setAttribute('role',error?'alert':'status');}
 function remembered(userId){try{const saved=JSON.parse(sessionStorage.getItem(marker));return saved?.userId===userId&&saved.at>Date.now()-30*60*1000;}catch{return false;}}
 function forget(){try{sessionStorage.removeItem(marker);}catch{}}
 function remember(){try{sessionStorage.setItem(marker,JSON.stringify({userId:recoveryUserId,at:Date.now()}));}catch{}}
 function cleanUrl(){history.replaceState(null,'',location.pathname);}
 function requestMode(text='',error=false){ready=false;recoveryUserId=null;forget();change.reset();request.hidden=false;change.hidden=true;$('reset-another').hidden=true;$('reset-success').hidden=true;$('reset-title').textContent='Reset your password';$('reset-description').textContent='Enter your account email. We’ll send you a link to choose a new password.';message(text,error);}
 function passwordMode(session){if(!session?.user?.id)return;recoveryUserId=session.user.id;ready=true;remember();request.hidden=true;change.hidden=false;$('reset-another').hidden=false;$('reset-title').textContent='Choose a new password';$('reset-description').textContent=session.user.email?'Choose a new password for '+session.user.email+'.':'Enter your new password twice to update your TurnKey account.';message('');cleanUrl();}
 function friendly(error){const text=error?.message||'';if(error?.status===429||/rate.?limit|security purposes/i.test(text))return 'Please wait a minute before requesting another link.';if(/expired|invalid.*token|session.*missing|auth session/i.test(text))return 'This reset link has expired or has already been used. Request a new one below.';return text||'Could not connect. Check your internet connection and try again.';}
 function setBusy(value,button,label){busy=value;button.disabled=value;button.textContent=label;}
 $('reset-show').addEventListener('change',e=>{for(const id of ['reset-password','reset-confirm'])$(id).type=e.target.checked?'text':'password';});
 $('reset-another').addEventListener('click',()=>requestMode());
 try{const email=sessionStorage.getItem('turnkey-reset-email');if(email){$('reset-email').value=email;sessionStorage.removeItem('turnkey-reset-email');}}catch{}
 const config=window.TURNKEY_CONFIG;
 if(!window.supabase||!config?.supabaseUrl||!config?.supabaseAnonKey){message('Password reset is unavailable right now. Reload the page or contact support.',true);$('reset-send').disabled=true;return;}
 const client=window.supabase.createClient(config.supabaseUrl,config.supabaseAnonKey);
 // Keep auth callbacks synchronous: Supabase session APIs can hold the auth lock.
 client.auth.onAuthStateChange((event,session)=>{
  if(event==='PASSWORD_RECOVERY'&&!linkError)passwordMode(session);
  else if(ready&&(event==='SIGNED_OUT'||(session?.user?.id&&session.user.id!==recoveryUserId)))requestMode('Your account session changed. Request a fresh reset link for the correct email.',true);
 });
 request.addEventListener('submit',async e=>{
  e.preventDefault();if(busy||!request.reportValidity())return;
  const button=$('reset-send');setBusy(true,button,'Sending link…');message('');
  try{
   // Root is already the app's allowed Auth redirect. The early root router
   // forwards only recovery callbacks to this page before the CRM initializes.
   const {error}=await client.auth.resetPasswordForEmail($('reset-email').value.trim(),{redirectTo:location.origin+'/'});
   if(error)throw error;
   message('If an account exists for this email, a reset link is on its way. Check your inbox and spam folder.');
  }catch(error){message(friendly(error),true);}finally{setBusy(false,button,'Send reset link');}
 });
 change.addEventListener('submit',async e=>{
  e.preventDefault();if(busy||!ready||!change.reportValidity())return;
  const password=$('reset-password').value;
  if(password!==$('reset-confirm').value){message('The passwords don’t match. Please enter them again.',true);$('reset-confirm').focus();return;}
  const button=$('reset-save');setBusy(true,button,'Saving password…');message('');
  try{
   const {data,error:sessionError}=await client.auth.getSession();if(sessionError)throw sessionError;
   if(!data?.session||data.session.user?.id!==recoveryUserId){requestMode('Your reset session expired or changed. Request a new link.',true);return;}
   const {data:verified,error:verifyError}=await client.auth.getUser();if(verifyError)throw verifyError;
   if(!ready||verified?.user?.id!==recoveryUserId){requestMode('Your account session changed. Request a fresh reset link.',true);return;}
   const {error}=await client.auth.updateUser({password});if(error)throw error;
   ready=false;forget();change.reset();change.hidden=true;$('reset-another').hidden=true;$('reset-success').hidden=false;
   $('reset-title').textContent='Password updated';$('reset-description').textContent='Your new password is saved. You can continue to your workspace.';message('Your password has been changed.');
  }catch(error){if(/expired|session.*missing|auth session/i.test(error?.message||''))requestMode(friendly(error),true);else message(friendly(error),true);}finally{setBusy(false,button,'Save new password');}
 });
 async function initialize(){
  if(linkError){cleanUrl();requestMode('This reset link is invalid or has expired. Request a new link.',true);return;}
  if(recoveryLink){$('reset-send').disabled=true;message('Checking your reset link…');}
  try{
   const {data,error}=await client.auth.getSession();if(error)throw error;
   if(data?.session&&(ready||remembered(data.session.user?.id))){passwordMode(data.session);}
   else if(recoveryLink){cleanUrl();requestMode('This reset link is invalid or has expired. Request a new link.',true);}
  }catch(error){if(recoveryLink)cleanUrl();requestMode(friendly(error),true);}finally{$('reset-send').disabled=false;}
 }
 void initialize();
})();
