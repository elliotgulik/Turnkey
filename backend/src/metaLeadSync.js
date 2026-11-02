import crypto from 'node:crypto';
import { importMetaBatch } from './metaImport.js';
import { decodeMetaCredentials } from './metaCredentials.js';
import { fetchMetaEdge } from './metaGraph.js';
import { encryptToken, decryptToken } from './crypto.js';

const unwrap=async query=>{const {data,error}=await query;if(error)throw error;return data;};
// Webhooks remain the fast path. This reconciles missed deliveries without a
// browser, with DB leases/cursors surviving restarts and concurrent instances.
export function createMetaLeadSync({db,addLead,notify=async()=>{},fetchEdge=fetchMetaEdge,
 encrypt=encryptToken,decrypt=decryptToken,now=Date.now,log=console,batch=importMetaBatch}){
 let running=false,timer;
 async function run(source){
  const lease=crypto.randomUUID();
  const rows=await unwrap(db.rpc('claim_meta_lead_sync',{p_source_id:source.id,p_lease_token:lease}));
  const job=rows?.[0];if(!job)return;
  const cycle=job.cycle_started_at||new Date(now()).toISOString();
  try{
   const credentials=decodeMetaCredentials(decrypt(source.token_enc));
   // Three-day overlap catches delayed Meta availability, with database
   // uniqueness preventing duplicate webhook/manual/background deliveries.
   const since=Math.max(0,Math.floor((Date.parse(job.last_success_at||cycle)-3*86400000)/1000));
   const result=await batch({businessId:source.business_id,pageId:source.external_id,token:credentials.pageToken,
    cursor:job.cursor,encrypt,decrypt,fetchEdge,since,historical:false,now,
    addLead:async payload=>{
     const saved=await addLead(payload);
     if(saved?.id&&!saved.deduped&&now()-payload.submittedAt<=3*86400000){
      try{await notify({businessId:source.business_id,name:payload.customer.name});}
      catch{log.warn('[Meta auto import] notification failed');}
     }
     return saved;
    }});
   await unwrap(db.from('meta_lead_sync').update({cursor:result.cursor,
    cycle_started_at:result.done?null:cycle,last_success_at:result.done?cycle:job.last_success_at,
    last_checked_at:new Date(now()).toISOString(),last_error:null,
    next_run_at:new Date(now()+(result.done?60000:0)).toISOString(),lease_until:null,lease_token:null,
    imported_count:Number(job.imported_count||0)+result.imported})
    .eq('source_id',source.id).eq('lease_token',lease));
  }catch(error){
   const message=error.publicMessage||'Automatic Meta import failed. Check the Meta connection; TurnKey will retry.';
   await unwrap(db.from('meta_lead_sync').update({last_error:message,
    // Expired cursors restart from the last completed cycle. Replays dedupe.
    ...(error.status===400?{cursor:null,cycle_started_at:null}:{}),
    next_run_at:new Date(now()+60000).toISOString(),lease_until:null,lease_token:null})
    .eq('source_id',source.id).eq('lease_token',lease));
   log.warn('[Meta auto import]',error.status||error.code||'failed');
  }
 }
 async function tick(){
  if(running)return;running=true;
  try{
   for(let offset=0;;offset+=100){
    const sources=await unwrap(db.from('lead_sources').select('id,business_id,external_id,token_enc,updated_at')
     .eq('provider','meta').order('id').range(offset,offset+99));
    for(let i=0;i<sources.length;i+=3)await Promise.all(sources.slice(i,i+3).map(source=>run(source).catch(error=>log.warn('[Meta auto import]',error.code||'storage failed'))));
    if(sources.length<100)break;
   }
  }catch(error){log.warn('[Meta auto import]',error.code||'storage failed');}finally{running=false;}
 }
 return {tick,start(){if(!timer){void tick();timer=setInterval(tick,15000);timer.unref?.();}},stop(){clearInterval(timer);timer=null;},
  async status(businessId){return unwrap(db.from('meta_lead_sync').select('last_success_at,last_checked_at,last_error,next_run_at,imported_count')
   .eq('business_id',businessId).maybeSingle());}};
}
