/* Mount the standalone workspaces on the existing authenticated CRM state. */
(function(root){
  'use strict';
  const host=document.getElementById('view-operations');
  if(!host||!root.TK_OPERATIONS)return;
  root.TK_OPERATIONS.install({host,actions:{
    createJob:()=>openCalendarJobModal(todayISO()),
    openSchedule:async id=>{
      const r=records.find(x=>x.id===id);
      if(!r||!businessStateReady||recordBusinesses.get(r)!==currentBusinessId)return;
      const biz=currentBusinessId,version=businessSessionVersion;
      if(!r.jobId)await ensureRecordSynced(r);
      if(biz!==currentBusinessId||version!==businessSessionVersion)return;
      return root.TK_JOB_CALENDAR.book(r.jobId,r.scheduledDateISO||null);
    }
  }});
  const priorAuth=root.showAuth;
  root.showAuth=function(){root.TK_OPERATIONS.reset();return priorAuth.apply(this,arguments);};
  const priorRender=root.renderAll;
  root.renderAll=function(){const result=priorRender.apply(this,arguments);if(host.classList.contains('active'))root.TK_OPERATIONS.refresh();return result;};
})(window);
