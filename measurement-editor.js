// Geographic editing only. Display handles never invent surface elevations.
const clone=points=>points.map(p=>({...p}));
export function editOutline(points,{action='add',index=0,point,view='2d'}={}){
  const next=clone(points);
  if(action==='delete'){
    if(!Number.isInteger(index)||index<0||index>=next.length)throw Error('Select a corner first.');
    next.splice(index,1);return next;
  }
  if(!point||!Number.isFinite(point.lat)||!Number.isFinite(point.lng)||Math.abs(point.lat)>85||Math.abs(point.lng)>180)throw Error('Choose a valid point on the loaded map.');
  const p={lat:point.lat,lng:point.lng};
  if(view==='3d'&&Number.isFinite(point.altitude))p.altitude=point.altitude;
  if(action==='move'||action==='insert'){
    if(!Number.isInteger(index)||index<0||index>=next.length)throw Error('Select a corner or edge first.');
    next.splice(action==='insert'?index+1:index,action==='move'?1:0,p);
  }else next.push(p);
  if(next.length>2000)throw Error('This outline has too many corners.');
  return next;
}
export function createOutlineHistory(){
  let current=[],past=[];
  return {
    get points(){return clone(current);},
    get canUndo(){return past.length>0;},
    commit(next){if(JSON.stringify(next)===JSON.stringify(current))return false;past.push(clone(current));if(past.length>100)past.shift();current=clone(next);return true;},
    undo(){if(past.length)current=past.pop();return clone(current);}
  };
}
export function displayAltitude(points,mode,altitudeModes){
  const absolute=mode==='surface'&&points.length>0&&points.every(p=>Number.isFinite(p.altitude));
  return {
    altitudeMode:absolute?altitudeModes.ABSOLUTE:altitudeModes.CLAMP_TO_GROUND,
    coordinates:points.map(p=>absolute?{...p}:{lat:p.lat,lng:p.lng})
  };
}

// Camera pose and scene readiness are independent: steadychange describes
// rendering, not motion. Compare to an anchor (not the previous frame) so
// slow cumulative motion is caught while render ticks and numeric noise aren't.
export function createCameraPickGuard({now=()=>performance.now(),settleMs=500}={}){
  let anchor=null,changedAt=now(),sceneReady=false;
  const angle=(a,b)=>Math.abs(((a-b+540)%360)-180);
  function pose(map){
    const c=map.center;
    const p=c&&{lat:c.lat,lng:c.lng,altitude:c.altitude??0,range:map.range,
      heading:map.heading,tilt:map.tilt,roll:map.roll??0,fov:map.fov??35};
    return p&&Object.values(p).every(Number.isFinite)?p:null;
  }
  function sample(map){
    const p=pose(map);
    if(!p){anchor=null;changedAt=now();return false;}
    // 2 cm floor, rising to 15 cm at the maximum picking range; 0.01°
    // orientation noise is ignored. The fixed anchor catches cumulative drift.
    const tolerance=Math.max(0.02,Math.min(p.range,1500)*0.0001);
    const moved=!anchor||Math.hypot((p.lat-anchor.lat)*111320,
      angle(p.lng,anchor.lng)*111320*Math.cos(p.lat*Math.PI/180))>tolerance||
      Math.abs(p.altitude-anchor.altitude)>tolerance||Math.abs(p.range-anchor.range)>tolerance||
      ['heading','tilt','roll','fov'].some(k=>angle(p[k],anchor[k])>0.01);
    if(moved){anchor=p;changedAt=now();}
    return now()-changedAt>=settleMs;
  }
  return {
    sample,
    scene(ready){if(typeof ready==='boolean')sceneReady=ready;},
    // Retry starts fresh motion sampling; it never fabricates surface readiness.
    reset(){anchor=null;changedAt=now();},
    status(map){
      if(!sample(map))return 'moving';
      return sceneReady?'ready':'loading';
    },
    pick(map,position){
      const status=this.status(map);
      if(status!=='ready')return {reason:status};
      if(!Number.isFinite(map.range)||map.range>1500)return {reason:'zoom'};
      if(!position||!Number.isFinite(position.lat)||!Number.isFinite(position.lng)||
        Math.abs(position.lat)>85||Math.abs(position.lng)>180||!Number.isFinite(position.altitude))return {reason:'surface'};
      return {point:{lat:position.lat,lng:position.lng,altitude:position.altitude}};
    }
  };
}
