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
