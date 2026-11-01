// Shared by the manual sync route and background polling. The emails table's
// unique(account_id, provider_message_id) protects concurrent deliveries.
const unwrap=async q=>{const {data,error}=await q;if(error)throw error;return data;};
const escLike=s=>s.replace(/[\\%_]/g,c=>'\\'+c);
export function createMailboxSync({db,gmail,getValidAccessToken,sendNotification,now=()=>Date.now()}){
 const pending=new Map();
 async function run(businessId,userId){
  const auth=await getValidAccessToken(businessId,userId,'gmail');
  if(!auth)throw Object.assign(Error('Connect your Gmail account first (Connections)'),{status:400});
  const started=now(),parsedSince=Date.parse(auth.account.last_sync_at),since=Number.isFinite(parsedSince)?parsedSince:started-30*86400000;
  const ids=await gmail.listMessageIds(auth.accessToken,{afterUnix:Math.max(0,Math.floor(since/1000)-120)});
  let imported=0;
  for(const id of ids){
   const existing=await unwrap(db.from('emails').select('id').eq('account_id',auth.account.id).eq('provider_message_id',id).maybeSingle());
   if(existing)continue;
   const msg=await gmail.getMessage(auth.accessToken,id),direction=msg.isSentByUs?'sent':'received';
   const counterpart=String(direction==='sent'?msg.to:msg.from),match=counterpart.match(/<([^>]+)>/),address=(match?match[1]:counterpart).trim().toLowerCase();
   const customer=address?await unwrap(db.from('customers').select('id,name').eq('business_id',businessId).ilike('email',escLike(address)).maybeSingle()):null;
   const sentAt=msg.date?new Date(msg.date).toISOString():new Date(started).toISOString();
   const {error}=await db.from('emails').insert({business_id:businessId,account_id:auth.account.id,customer_id:customer?.id||null,provider_message_id:msg.id,thread_id:msg.threadId,direction,from_address:msg.from,to_addresses:msg.to,subject:msg.subject,snippet:msg.snippet,body_html:msg.bodyHtml||null,body_text:msg.bodyText||null,sent_at:sentAt});
   if(error){if(error.code==='23505')continue;throw error;}
   imported++;
   if(customer){
    await db.from('activity_log').insert({business_id:businessId,customer_id:customer.id,type:direction==='sent'?'email_sent':'email_received',summary:(direction==='sent'?'Email sent: ':'Email received: ')+(msg.subject||'(no subject)')});
    // Avoid replaying old mailbox history as fresh alerts on first connection.
    if(direction==='received'&&msg.date&&started-Date.parse(sentAt)<3*86400000&&sendNotification){
     await sendNotification(db,{business_id:businessId,user_id:userId,type:'customer_reply',title:(customer.name||'Customer')+' emailed you',message:msg.subject||'New customer email — open Conversations to read and respond.',url:'/index.html?open=inbox'});
    }
   }
  }
  await unwrap(db.from('email_accounts').update({last_sync_at:new Date(started).toISOString()}).eq('id',auth.account.id).eq('business_id',businessId));
  return {ok:true,imported};
 }
 return function sync(businessId,userId){const key=businessId+':'+userId;if(pending.has(key))return pending.get(key);const work=run(businessId,userId).finally(()=>pending.delete(key));pending.set(key,work);return work;};
}
export function installEmailSync(app,deps){
 const sync=createMailboxSync(deps);
 app.post('/api/email/sync',deps.requireBusiness,async(req,res)=>{try{res.json(await sync(req.businessId,req.userId));}catch(error){if(error.code==='AUTH_EXPIRED')return res.status(401).json({error:'Gmail connection expired — please reconnect in Connections'});res.status(error.status||500).json({error:error.status?error.message:'Email sync failed. Please retry.'});}});
 let running=false;
 async function tick(){if(running)return;running=true;try{
  // Read all connected mailboxes in bounded pages, without depending on a browser.
  for(let offset=0;;offset+=100){
   const rows=await unwrap(deps.db.from('email_accounts').select('business_id,user_id').eq('provider','gmail').order('id').range(offset,offset+99));
   for(let i=0;i<rows.length;i+=3)await Promise.all(rows.slice(i,i+3).map(row=>sync(row.business_id,row.user_id).catch(error=>console.warn('[Email sync]',error.code||error.status||'failed'))));
   if(rows.length<100)break;
  }
 }catch(error){console.warn('[Email polling]',error.code||'failed');}finally{running=false;}}
 const timer=setInterval(tick,90000);timer.unref?.();
 return {sync,tick,stop(){clearInterval(timer);}};
}
