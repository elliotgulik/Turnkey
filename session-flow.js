/* Deduplicate Supabase session notifications; initialization runs outside auth locks. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TK_SESSION_FLOW=api;})(typeof window==='object'?window:globalThis,function(){
  function create({initialize,isReady,beforeInitialize=()=>{},defer=fn=>new Promise((resolve,reject)=>setTimeout(()=>Promise.resolve().then(fn).then(resolve,reject),0))}){
    let pending=null,user=null,epoch=0;
    return {
      start(session){
        const id=session?.user?.id;if(!id)return Promise.resolve();
        if(isReady(id))return Promise.resolve();
        if(pending&&user===id)return pending;
        const version=++epoch;user=id;beforeInitialize(id);
        const task=defer(()=>version===epoch?initialize(session):undefined);
        pending=task;
        task.finally(()=>{if(pending===task){pending=null;user=null;}}).catch(()=>{});
        return task;
      },
      reset(){++epoch;pending=null;user=null;},
      isPending(){return !!pending;}
    };
  }
  return {create};
});
