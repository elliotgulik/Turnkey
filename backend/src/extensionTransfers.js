// Read-only, per-job progress for the extension's existing ServiceM8 handoff.
// Queueing continues to use /api/sales/servicem8/handoff and its durable worker.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const read=async q=>{const {data,error}=await q;if(error)throw error;return data}
export function installExtensionTransfers(app,{db,requireBusiness}){
 app.get('/api/extension/servicem8/jobs/:jobId',requireBusiness,async(req,res)=>{
  try{
   if(!UUID.test(req.params.jobId))return res.status(400).json({error:'Invalid job reference.'})
   const job=await read(db.from('jobs').select('id').eq('id',req.params.jobId).eq('business_id',req.businessId).maybeSingle())
   if(!job)return res.status(404).json({error:'Job not found in this business.'})
   const conn=await read(db.from('servicem8_connections').select('generation').eq('business_id',req.businessId).maybeSingle())
   res.set('Cache-Control','no-store')
   if(!conn)return res.json({state:'not_connected',message:'Connect ServiceM8 in TurnKey Connections, then retry.'})
   const tasks=await read(db.from('integration_tasks').select('state,created_at').eq('business_id',req.businessId).eq('kind','handoff').eq('payload->>jobId',job.id).eq('payload->>generation',conn.generation).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1))
   const task=tasks[0]
   if(task&&task.state!=='succeeded'){
    const state=['failed','running','pending'].includes(task.state)?(task.state==='pending'?'queued':task.state):'queued'
    return res.json({state,message:state==='failed'?'Transfer needs attention. Open TurnKey Connections to retry the failed transfer.':'Your saved quote is queued for ServiceM8. Check again shortly.'})
   }
   const map=await read(db.from('external_object_mappings').select('external_uuid').eq('business_id',req.businessId).eq('connection_generation',conn.generation).eq('object_type','job').eq('local_id',job.id).maybeSingle())
   if(map&&UUID.test(map.external_uuid))return res.json({state:'transferred',openUrl:'https://go.servicem8.com/OpenJob/'+map.external_uuid,message:'Transferred to ServiceM8. Open the job there to review and send the quote.'})
   return res.json({state:task?'queued':'not_queued',message:task?'Transfer is processing. Check again shortly.':'This quote has not been queued for ServiceM8 yet.'})
  }catch(e){console.error('[extension transfer status]',e.code||e.name);res.status(500).json({error:'Could not check this transfer. Your TurnKey quote remains saved.'})}
 })
}
