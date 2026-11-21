import crypto from 'node:crypto';
import * as gmail from './providers/gmail.js';

export const DEFAULT_WELCOME = Object.freeze({enabled:false,channel:'sms',trustUrl:'https://www.instagram.com/novaexterior/',
 body:'Hi {customer_name}, thanks for contacting {business_name}! While we review your enquiry, see our work and how we care for your property: {trust_link}',
 subject:'Thanks for your enquiry — {business_name}',consentMode:'explicit',sources:['wix','meta','booking']});
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const unwrap = async query => {const {data,error}=await query;if(error)throw error;return data;};
const esc = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function validateWelcome(input) {
 if(!input || typeof input.enabled!=='boolean' || !['sms','email'].includes(input.channel) || !['explicit','enquiries'].includes(input.consentMode))throw fail('Choose a channel and recipient permission rule.');
 let url;try{url=new URL(input.trustUrl);}catch{throw fail('Enter a full HTTPS Instagram or video URL.');}
 if(url.protocol!=='https:' || url.username || url.password || url.href.length>500)throw fail('Use an HTTPS link without credentials.');
 if(typeof input.body!=='string' || !input.body.trim() || input.body.length>800 || !input.body.includes('{trust_link}'))throw fail('Enter a message of up to 800 characters including {trust_link}.');
 if(typeof input.subject!=='string' || !input.subject.trim() || input.subject.length>160 || /[\r\n]/.test(input.subject))throw fail('Enter an email subject of up to 160 characters.');
 if(!Array.isArray(input.sources) || (input.enabled&&!input.sources.length) || input.sources.length>4 || input.sources.some(s=>!['wix','meta','booking','manual'].includes(s)))throw fail('Choose valid new-lead sources.');
 const tokens=(input.body+' '+input.subject).match(/\{[^{}]+\}/g)||[];
 if(tokens.some(t=>!['{customer_name}','{business_name}','{trust_link}'].includes(t)))throw fail('Use only the supported personalisation fields.');
 return {enabled:input.enabled,channel:input.channel,trustUrl:url.href,body:input.body.trim(),subject:input.subject.trim(),consentMode:input.consentMode,sources:[...new Set(input.sources)]};
}
export function normalizeSmsPhone(raw) {
 let phone=String(raw||'').replace(/[\s().-]/g,'');
 if(phone.startsWith('0064'))phone='+'+phone.slice(2);
 else if(/^02\d{7,9}$/.test(phone))phone='+64'+phone.slice(1);
 // This welcome sender is intentionally limited to NZ mobile numbers.
 return /^\+642\d{7,9}$/.test(phone)?phone:null;
}
export function welcomeContent(settings,customer,businessName) {
 const vars={customer_name:String(customer.name||'there').replace(/[\r\n]/g,' ').trim().split(/\s+/)[0].slice(0,80),business_name:String(businessName||'Our team').replace(/[\r\n]/g,' ').slice(0,160),trust_link:settings.trustUrl};
 const fill=value=>value.replace(/\{(customer_name|business_name|trust_link)\}/g,(_,key)=>vars[key]);
 return {body:fill(settings.body),subject:fill(settings.subject)};
}
export function welcomeEligibility(payload,settings,createdAt,now=Date.now()) {
 if(payload?.historicalImport===true)return 'Historical import excluded';
 const submitted=Number(payload?.submittedAt)||Date.parse(payload?.submittedAt);
 const received=Date.parse(createdAt);
 if(!Number.isFinite(received)||now-received>86400000)return 'Welcome expired; not sent to an old lead';
 if(Number.isFinite(submitted)&&(submitted<received-3600000||submitted>now+300000))return 'Historical or invalid submission time';
 const customer=payload?.customer||{};
 if(customer.followups_disabled===true||customer.marketingOptOut===true||payload?.marketingOptOut===true)return 'Customer opted out';
 if(settings.consentMode==='explicit') {
   const field=settings.channel==='sms'?'smsConsent':'emailConsent';
   const answers=Array.isArray(payload.formAnswers)?payload.formAnswers:[];
   const label=settings.channel==='sms'?/^(sms|text message|text) (consent|permission)$/i:/^email (consent|permission)$/i;
   const allowed=customer[field]===true||payload[field]===true||answers.some(answer=>label.test(String(answer.label||'').trim())&&/^(yes|true|checked|i agree)$/i.test(String(answer.answer||'').trim()));
   if(!allowed)return 'No recorded channel consent';
 }
 return null;
}
export function smsReady(env,businessId) {
 return env.TWILIO_BUSINESS_ID===businessId && /^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID||'') && !!env.TWILIO_AUTH_TOKEN && /^MG[a-f0-9]{32}$/i.test(env.TWILIO_MESSAGING_SERVICE_SID||'') && env.TWILIO_OPT_OUT_READY==='true';
}
export async function sendWelcomeSms(env,businessId,to,body,fetcher=fetch) {
 if(!smsReady(env,businessId))throw fail('SMS provider is not configured for this business.');
 const form=new URLSearchParams({To:to,MessagingServiceSid:env.TWILIO_MESSAGING_SERVICE_SID,Body:body+'\nReply STOP to opt out.'});
 const response=await fetcher('https://api.twilio.com/2010-04-01/Accounts/'+env.TWILIO_ACCOUNT_SID+'/Messages.json',{
   method:'POST',headers:{Authorization:'Basic '+Buffer.from(env.TWILIO_ACCOUNT_SID+':'+env.TWILIO_AUTH_TOKEN).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(20000)});
 let data;try{data=await response.json();}catch{throw fail('SMS result unknown. Check the provider before resending.',502);}
 if(!response.ok)throw Object.assign(fail(data.code===21610?'Recipient has opted out of SMS.':'SMS provider rejected the message. Check provider logs.',502),{definitelyRejected:true});
 if(!data.sid)throw fail('SMS result unknown. Check the provider before resending.',502);
 return {id:data.sid};
}

export function installLeadWelcome(app,{db,requireBusiness,getValidAccessToken,env=process.env,sendSms=sendWelcomeSms,sendEmail=gmail.sendMessage}) {
 let running=false,timer;
 const secret=env.LEAD_WELCOME_UNSUBSCRIBE_SECRET||env.SUPABASE_SERVICE_ROLE_KEY;
 const frontend=env.PUBLIC_BACKEND_URL||'https://turnkeynova.onrender.com';
 const sign=value=>crypto.createHmac('sha256',secret).update(value).digest('base64url');
 const admin=(req,res,next)=>['owner','manager'].includes(req.businessRole)?next():res.status(403).json({error:'Only owners and managers can manage welcome messages.'});
 const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(error=>{console.error('[lead welcome]',error.code||error.status||'failed');res.status(error.status||503).json({error:error.status?error.message:'Welcome messages are unavailable. Apply the migration and retry.'});});
 async function readiness(businessId,senderUserId){
   let email=false;
   if(senderUserId){const account=await unwrap(db.from('email_accounts').select('id,status').eq('business_id',businessId).eq('user_id',senderUserId).eq('provider','gmail').maybeSingle());email=!!account&&account.status!=='needs_reconnect';}
   return {sms:smsReady(env,businessId),email};
 }
 async function view(req){
   const row=await unwrap(db.from('lead_welcome_settings').select('settings').eq('business_id',req.businessId).maybeSingle());
   const settings={...DEFAULT_WELCOME,...row?.settings};
   const history=await unwrap(db.from('lead_welcome_messages').select('id,status,channel,created_at,sent_at,error_summary').eq('business_id',req.businessId).order('created_at',{ascending:false}).limit(20));
   const {senderUserId,...publicSettings}=settings;
   return {settings:publicSettings,readiness:await readiness(req.businessId,senderUserId||req.userId),history:history||[]};
 }
 app.get('/api/leads/welcome-settings',requireBusiness,admin,wrap(async(req,res)=>res.json(await view(req))));
 app.put('/api/leads/welcome-settings',requireBusiness,admin,wrap(async(req,res)=>{
   const settings={...validateWelcome(req.body),senderUserId:req.userId};
   const ready=await readiness(req.businessId,req.userId);
   if(settings.enabled&&!ready[settings.channel])throw fail(settings.channel==='sms'?'Connect an SMS provider with opt-out handling before enabling texts.':'Connect Gmail before enabling welcome emails.');
   if(settings.enabled&&settings.channel==='email'&&!secret)throw fail('The backend unsubscribe secret is missing.');
   await unwrap(db.from('lead_welcome_settings').upsert({business_id:req.businessId,settings,updated_at:new Date().toISOString()},{onConflict:'business_id'}));
   res.json(await view(req));
 }));
 async function unsubscribeRecord(req){
   const {id,token}=req.query;
   if(!secret||typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)||typeof token!=='string')throw fail('Invalid unsubscribe link.');
   const expected=Buffer.from(sign(id)),provided=Buffer.from(token);
   if(expected.length!==provided.length||!crypto.timingSafeEqual(expected,provided))throw fail('Invalid unsubscribe link.');
   const row=await unwrap(db.from('lead_welcome_messages').select('business_id,lead_id,channel').eq('id',id).maybeSingle());
   if(!row||row.channel!=='email')throw fail('Unsubscribe link not found.',404);
   const lead=await unwrap(db.from('leads').select('payload').eq('id',row.lead_id).eq('business_id',row.business_id).maybeSingle());
   const recipient=String(lead?.payload?.customer?.email||'').trim().toLowerCase();
   if(!recipient)throw fail('Recipient not found.',404);
   return {...row,recipient};
 }
 app.get('/api/leads/welcome-unsubscribe',wrap(async(req,res)=>{
   await unsubscribeRecord(req);
   res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>Welcome email preferences</title><main><h1>Stop welcome emails?</h1><form method="post"><button type="submit">Unsubscribe from welcome emails</button></form></main>');
 }));
 app.post('/api/leads/welcome-unsubscribe',wrap(async(req,res)=>{
   const row=await unsubscribeRecord(req);
   await unwrap(db.from('lead_welcome_suppressions').upsert({business_id:row.business_id,channel:'email',recipient:row.recipient},{onConflict:'business_id,channel,recipient'}));
   res.type('text').send('You have been unsubscribed from automatic welcome emails.');
 }));
 async function finish(row,status,error_summary=null,extra={}){
   await unwrap(db.from('lead_welcome_messages').update({status,error_summary,...extra}).eq('id',row.id).eq('business_id',row.business_id).eq('status','sending'));
 }
 async function processRow(row){
   let sending=false;
   try{
     const active=await unwrap(db.from('lead_welcome_settings').select('settings').eq('business_id',row.business_id).maybeSingle());
     if(active?.settings?.enabled!==true)return await finish(row,'skipped','Welcome messages switched off');
     const settings=row.settings;
     const lead=await unwrap(db.from('leads').select('payload,created_at,source').eq('id',row.lead_id).eq('business_id',row.business_id).maybeSingle());
     const reason=welcomeEligibility(lead?.payload,settings,lead?.created_at);
     if(reason)return await finish(row,'skipped',reason);
     const currentReason=welcomeEligibility(lead?.payload,active.settings,lead?.created_at);
     const source=String(lead?.source||lead?.payload?.source||'manual').toLowerCase();
     const sourceKey=source==='turnkey quote widget'?'booking':source;
     if(!active.settings.sources?.includes(sourceKey))return await finish(row,'skipped','Lead source disabled');
     if(currentReason||active.settings.channel!==settings.channel)return await finish(row,'skipped',currentReason||'Welcome channel changed');
     const customer=lead.payload.customer||{};
     const recipient=settings.channel==='sms'?normalizeSmsPhone(customer.phone):String(customer.email||'').trim().toLowerCase();
     if(!recipient||(settings.channel==='email'&&!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)))return await finish(row,'skipped','Valid recipient details missing');
     const blocked=await unwrap(db.from('lead_welcome_suppressions').select('recipient').eq('business_id',row.business_id).eq('channel',settings.channel).eq('recipient',recipient).maybeSingle());
     if(blocked)return await finish(row,'skipped','Recipient unsubscribed');
     let existing=db.from('customers').select('id').eq('business_id',row.business_id).eq('followups_disabled',true);
     existing=settings.channel==='email'?existing.ilike('email',recipient.replace(/[%_\\]/g,'\\$&')):existing.in('phone',[recipient,'0'+recipient.slice(3)]);
     if((await unwrap(existing.limit(1)))?.length)return await finish(row,'skipped','Customer has automatic messages switched off');
     const business=await unwrap(db.from('businesses').select('name').eq('id',row.business_id).maybeSingle());
     if(!business)return await finish(row,'failed','Business profile unavailable');
     const {body,subject}=welcomeContent(settings,customer,business.name);
     let sent;
     if(settings.channel==='sms'){
       if(body.length>1500)return await finish(row,'failed','Message is too long after personalisation');
       if(!smsReady(env,row.business_id))return await finish(row,'failed','SMS provider unavailable for this business');
       sending=true;sent=await sendSms(env,row.business_id,recipient,body);
     }else{
       const sender=await unwrap(db.from('users').select('business_id,role').eq('id',settings.senderUserId).maybeSingle());
       if(sender?.business_id!==row.business_id||!['owner','manager'].includes(sender.role))return await finish(row,'skipped','Email sender no longer has company permission');
       const auth=await getValidAccessToken(row.business_id,settings.senderUserId,'gmail');
       if(!auth||!secret)return await finish(row,'failed','Reconnect Gmail before sending welcome emails');
       const unsubscribe=frontend.replace(/\/$/,'')+'/api/leads/welcome-unsubscribe?id='+row.id+'&token='+sign(row.id);
       const text=body+'\n\nStop welcome emails: '+unsubscribe;
       sending=true;sent=await sendEmail(auth.accessToken,{from:auth.account.email_address,to:recipient,subject,
         bodyText:text,bodyHtml:'<div style="font-family:Arial,sans-serif;line-height:1.6">'+esc(body).replace(/\n/g,'<br>')+'<p><a href="'+esc(settings.trustUrl)+'">See our work and process</a></p><p><a href="'+esc(unsubscribe)+'">Stop welcome emails</a></p></div>'});
     }
     await finish(row,'accepted',null,{provider_id:sent.id,sent_at:new Date().toISOString()});
   }catch(error){
     // An ambiguous send is never replayed automatically: the provider may have accepted it.
     const unknown=sending&&!error.definitelyRejected&&error.code!=='SEND_REJECTED';
     await finish(row,unknown?'unknown':'failed',unknown?'Check provider/mailbox history before retrying. Delivery may have been accepted.':sending?'Provider rejected the welcome message; check provider logs.':'Welcome processing failed; check backend logs.').catch(()=>{});
     console.error('[lead welcome worker]',error.code||error.status||'failed');
   }
 }
 async function tick(){
   if(running)return;running=true;
   try{
     await unwrap(db.from('lead_welcome_messages').update({status:'unknown',error_summary:'Interrupted send; check provider history before retrying.'}).eq('status','sending').lt('claimed_at',new Date(Date.now()-300000).toISOString()));
     const rows=await unwrap(db.rpc('claim_lead_welcomes'));
     for(const row of rows||[])await processRow(row);
   }catch(error){console.error('[lead welcome queue]',error.code||'unavailable');}
   finally{running=false;}
 }
 return {tick,processRow,start(){if(!timer){void tick();timer=setInterval(()=>void tick(),15000);timer.unref?.();}},stop(){clearInterval(timer);timer=null;}};
}
