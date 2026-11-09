/* Production planning forecasts; never represented as official weather warnings. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.TK_POST_OFFICE_WEATHER=factory();})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';let cache=null,inflight=null;
 function risks(day,settings={}){if(!day)return[];const out=[];const rain=Number(settings.rainThreshold??60),wind=Number(settings.windThreshold??35);if(Number.isFinite(day.rain)&&day.rain>=rain)out.push('Rain risk '+day.rain+'%');if(Number.isFinite(day.wind)&&day.wind>=wind)out.push('Wind risk '+day.wind+' km/h');if([95,96,99].includes(day.code))out.push('Thunderstorm risk');return out;}
 function decode(json){const d=json?.daily;if(!Array.isArray(d?.time))throw Error('Weather forecast is unavailable.');return d.time.map((date,i)=>({date,rain:typeof d.precipitation_probability_max?.[i]==='number'?d.precipitation_probability_max[i]:null,wind:typeof d.wind_speed_10m_max?.[i]==='number'?d.wind_speed_10m_max[i]:null,high:typeof d.temperature_2m_max?.[i]==='number'?d.temperature_2m_max[i]:null,code:d.weather_code?.[i]}));}
 async function load(settings={}){const lat=Number(settings.latitude??-36.79),lon=Number(settings.longitude??174.77);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw Error('Set valid forecast coordinates in Settings.');const key=lat+','+lon;
  if(cache?.key===key&&Date.now()-cache.at<3*3600000)return cache;
  try{const stored=JSON.parse(sessionStorage.getItem('post-office-weather')||'null');if(stored?.key===key&&Date.now()-stored.at<3*3600000){cache=stored;return cache;}}catch(_){}
  if(inflight?.key===key)return inflight.promise;
  const promise=(async()=>{const url=new URL('https://api.open-meteo.com/v1/forecast');url.search=new URLSearchParams({latitude:lat,longitude:lon,daily:'weather_code,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max',timezone:'Pacific/Auckland',forecast_days:16});const res=await fetch(url,{signal:AbortSignal.timeout(9000)});if(!res.ok)throw Error('Weather provider is unavailable.');const days=decode(await res.json());cache={key,at:Date.now(),days};try{sessionStorage.setItem('post-office-weather',JSON.stringify(cache));}catch(_){}return cache;})();inflight={key,promise};try{return await promise;}finally{if(inflight?.promise===promise)inflight=null;}
 }
 return{risks,decode,load};
});
