// Isolated world: only the extension popup can initiate this bridge.
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || sender.tab || sender.url!==chrome.runtime.getURL('popup.html') || message?.type!=='TK_MEASUREMENT_IMPORT' || window.top!==window) return;
  const allowed=(location.protocol==='https:' && location.hostname==='turnkeycrm.net' && !location.port) || (['http:','https:'].includes(location.protocol) && location.hostname==='localhost');
  if(!allowed) return;
  import(chrome.runtime.getURL('measurement.js')).then(({validatePayload})=>{
    const payload=validatePayload(message.payload);
    window.postMessage({type:'TK_MEASUREMENT_IMPORT',payload},location.origin);
    respond({dispatched:true});
  }).catch(error=>respond({dispatched:false,error:error.message}));
  return true;
});
