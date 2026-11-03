/* Optional TOTP enrollment and owner/manager step-up. No secrets are persisted. */
(function(){
 'use strict';
 let pending=null,dialog=null,enrollment=null;
 const $=id=>document.getElementById(id);
 const auth=()=>sb.auth;
 async function factors(){const {data,error}=await auth().mfa.listFactors();if(error)throw error;return (data?.totp||[]).filter(f=>f.status==='verified');}
 function errorText(el,error){el.textContent=error?.message||'Could not verify your code. Try again.';}
 async function verify(factorId,code){if(!/^\d{6}$/.test(code))throw Error('Enter the six-digit code from your authenticator.');const {error}=await auth().mfa.challengeAndVerify({factorId,code});if(error)throw error;const {data,error:sessionError}=await auth().getSession();if(sessionError)throw sessionError;window.TK_CURRENT_SESSION=data.session;}
 function reset(){if(pending){pending.resolve(false);pending=null;}$('auth-card-mfa')?.remove();dialog?.remove();dialog=null;enrollment=null;}
 async function requireFor(session,role){
  if(!['owner','manager'].includes(role))return true;
  if(!auth().mfa)throw Error('Two-factor sign-in could not load. Refresh and try again.');
  const list=await factors();if(!list.length)return true;
  const {data,error}=await auth().mfa.getAuthenticatorAssuranceLevel();if(error)throw error;if(data?.currentLevel==='aal2')return true;
  reset();showAuth();$('auth-card-normal').style.display='none';
  const card=document.createElement('section');card.className='auth-card';card.id='auth-card-mfa';
  card.innerHTML='<h1>Two-factor sign-in</h1><p>Enter the code from your authenticator app.</p><form><div class="field"><label for="auth-mfa-code">Six-digit code</label><input id="auth-mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div><p class="auth-msg" role="alert"></p><button class="btn primary block" type="submit">Verify and sign in</button><button class="btn ghost block" type="button" data-cancel>Back to sign in</button></form>';
  document.querySelector('.auth-cards').append(card);
  return new Promise(resolve=>{
   pending={resolve,userId:session.user.id};
   card.querySelector('[data-cancel]').onclick=async()=>{reset();await auth().signOut();showAuth();};
   card.querySelector('form').onsubmit=async e=>{
    e.preventDefault();const submit=card.querySelector('[type=submit]'),message=card.querySelector('[role=alert]');submit.disabled=true;message.textContent='Checking code…';
    try{await verify(list[0].id,$('auth-mfa-code').value.trim());if(!pending||pending.userId!==session.user.id||window.TK_CURRENT_SESSION?.user?.id!==session.user.id)return;const done=pending.resolve;pending=null;card.remove();done(true);}
    catch(error){errorText(message,error);}finally{submit.disabled=false;}
   };$('auth-mfa-code').focus();
  });
 }
 async function settings(){
  if(!['owner','manager'].includes(currentUserRole))return;
  dialog?.remove();dialog=document.createElement('dialog');dialog.className='auth-mfa-settings';
  dialog.innerHTML='<div class="auth-card"><h2>Two-factor sign-in</h2><p>Protect your account with an authenticator app.</p><div data-content></div><p role="status" data-message></p><button class="btn ghost block" data-close>Close</button></div>';
  document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{dialog.remove();dialog=null;enrollment=null;},{once:true});dialog.showModal();
  const host=dialog.querySelector('[data-content]'),message=dialog.querySelector('[data-message]');
  try{
   const list=await factors();if(!dialog)return;
   host.innerHTML=list.length?'<p>Your authenticator is connected.</p><button class="btn ghost block" data-remove>Remove authenticator</button>':'<button class="btn primary block" data-enroll>Set up authenticator</button>';
   if(list.length)host.querySelector('[data-remove]').onclick=async e=>{
    e.target.disabled=true;
    try{const {error}=await auth().mfa.unenroll({factorId:list[0].id});if(error)throw error;message.textContent='Authenticator removed.';host.replaceChildren();}
    catch(error){errorText(message,error);e.target.disabled=false;}
   };
   else host.querySelector('[data-enroll]').onclick=async e=>{
    e.target.disabled=true;
    try{
     const {data,error}=await auth().mfa.enroll({factorType:'totp',friendlyName:'TurnKey authenticator'});if(error)throw error;if(!dialog)return;enrollment=data.id;
     host.innerHTML='<p>Scan this QR code in your authenticator, then enter its code.</p><img data-qr alt="Scan in your authenticator app" width="220" height="220"><form><div class="field"><label for="mfa-enroll-code">Six-digit code</label><input id="mfa-enroll-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div><button class="btn primary block" type="submit">Verify authenticator</button></form>';
     host.querySelector('[data-qr]').src=data.totp.qr_code;
     host.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{await verify(enrollment,$('mfa-enroll-code').value.trim());enrollment=null;host.replaceChildren();message.textContent='Two-factor sign-in is enabled.';}catch(error){errorText(message,error);}finally{button.disabled=false;}};
    }catch(error){errorText(message,error);e.target.disabled=false;}
   };
  }catch(error){errorText(message,error);}
 }
 window.TK_MFA={requireFor,settings,reset};
})();
