/* Account-scoped display snapshots. Never cache sessions, credentials or sends. */
(function(root){
 'use strict';
 const PREFIX='turnkey-workspace-cache-v1:',MAX_AGE=7*86400000,MAX_BYTES=1800000;
 const scopeKey=s=>s?.businessId&&s?.userId?encodeURIComponent(s.businessId)+':'+encodeURIComponent(s.userId)+':':null;
 const key=(s,name)=>{const scope=scopeKey(s);return scope?PREFIX+scope+encodeURIComponent(name):null;};
 function read(scope,name){const id=key(scope,name);if(!id)return null;try{const value=JSON.parse(root.localStorage.getItem(id)||'null');if(!value||value.version!==1||!Number.isFinite(value.savedAt)||value.savedAt>Date.now()+60000||Date.now()-value.savedAt>MAX_AGE){root.localStorage.removeItem(id);return null;}return value;}catch{return null;}}
 function entries(){const list=[];try{for(let i=0;i<root.localStorage.length;i++){const id=root.localStorage.key(i);if(id?.startsWith(PREFIX)){let at=0;try{at=JSON.parse(root.localStorage.getItem(id)).savedAt||0;}catch{}list.push({id,at});}}}catch{}return list.sort((a,b)=>a.at-b.at);}
 function write(scope,name,data){const id=key(scope,name);if(!id)return false;try{const json=JSON.stringify({version:1,savedAt:Date.now(),data});if(json.length>MAX_BYTES)return false;const all=entries();while(all.length>=12){const old=all.shift();if(old.id!==id)root.localStorage.removeItem(old.id);}try{root.localStorage.setItem(id,json);}catch{for(const old of entries())if(old.id!==id)root.localStorage.removeItem(old.id);root.localStorage.setItem(id,json);}return true;}catch{return false;}}
 function clearAll(){for(const row of entries())try{root.localStorage.removeItem(row.id);}catch{}}
 root.TK_WORKSPACE_CACHE={read,write,clearAll};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.TK_WORKSPACE_CACHE;
})(typeof window!=='undefined'?window:globalThis);
