// Geographic measurements: no viewport dimensions, camera angle or screen scale.
export const EARTH_RADIUS = 6378137;
const RAD=Math.PI/180, MAX_POINTS=2000, EPS=1e-8;
const fail=message=>{throw new Error(message);};
function point(p, surface=false) {
  if(!p||typeof p.lat!=='number'||typeof p.lng!=='number'||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||Math.abs(p.lat)>85||Math.abs(p.lng)>180)fail('Invalid geographic coordinate (latitude must be between −85° and 85°).');
  const out={lat:p.lat,lng:p.lng};
  if(p.altitude!==undefined){if(typeof p.altitude!=='number'||!Number.isFinite(p.altitude)||p.altitude < -12000||p.altitude>100000)fail('Invalid elevation.');out.altitude=p.altitude;}
  if(surface&&out.altitude===undefined)fail('3D surface measurements need a valid elevation at every point. Use footprint mode or trace a loaded 3D surface.');
  return out;
}
export function distanceMeters(a,b) {
  a=point(a);b=point(b);
  const dlat=(b.lat-a.lat)*RAD,dlng=(b.lng-a.lng)*RAD;
  const h=Math.sin(dlat/2)**2+Math.cos(a.lat*RAD)*Math.cos(b.lat*RAD)*Math.sin(dlng/2)**2;
  return 2*EARTH_RADIUS*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
}
function ecef(p) {
  const lat=p.lat*RAD,lng=p.lng*RAD,e2=6.6943799901413165e-3;
  const n=EARTH_RADIUS/Math.sqrt(1-e2*Math.sin(lat)**2),h=p.altitude||0;
  return [(n+h)*Math.cos(lat)*Math.cos(lng),(n+h)*Math.cos(lat)*Math.sin(lng),(n*(1-e2)+h)*Math.sin(lat)];
}
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const norm=a=>Math.hypot(...a);
const orient=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function project(points,surface) {
  const xyz=points.map(p=>ecef({...p,altitude:surface?p.altitude:0})),origin=xyz[0];
  if(surface){
    const normal=[0,0,0];
    for(let i=0;i<xyz.length;i++){const v=cross(sub(xyz[i],origin),sub(xyz[(i+1)%xyz.length],origin));v.forEach((n,k)=>normal[k]+=n);}
    if(norm(normal)<EPS)fail('The outline has no measurable surface. Check for crossed edges or duplicate points.');
    const omit=normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
    return {xyz,flat:xyz.map(v=>sub(v,origin).filter((_,i)=>i!==omit))};
  }
  const lat=points[0].lat*RAD,lng=points[0].lng*RAD;
  const east=[-Math.sin(lng),Math.cos(lng),0],north=[-Math.sin(lat)*Math.cos(lng),-Math.sin(lat)*Math.sin(lng),Math.cos(lat)];
  return {xyz,flat:xyz.map(v=>{const d=sub(v,origin);return [dot(d,east),dot(d,north)];})};
}
const onSegment=(a,b,p)=>Math.abs(orient(a,b,p))<EPS&&p[0]>=Math.min(a[0],b[0])-EPS&&p[0]<=Math.max(a[0],b[0])+EPS&&p[1]>=Math.min(a[1],b[1])-EPS&&p[1]<=Math.max(a[1],b[1])+EPS;
function intersects(a,b,c,d) {
  const x=orient(a,b,c),y=orient(a,b,d),z=orient(c,d,a),w=orient(c,d,b);
  return (x*y < -EPS&&z*w < -EPS)||onSegment(a,b,c)||onSegment(a,b,d)||onSegment(c,d,a)||onSegment(c,d,b);
}
function simplePolygon(flat) {
  for(let i=0;i<flat.length;i++)for(let j=i+1;j<flat.length;j++){
    if(j===i+1||(i===0&&j===flat.length-1))continue;
    if(intersects(flat[i],flat[(i+1)%flat.length],flat[j],flat[(j+1)%flat.length]))fail('Outline edges cross or overlap. Undo the crossed point and trace around the outside.');
  }
}
export function validatePoints(input,{kind='area',mode='ground'}={}) {
  if(!['area','line','perimeter'].includes(kind)||!['ground','surface'].includes(mode))fail('Unsupported measurement type.');
  if(!Array.isArray(input)||input.length>MAX_POINTS)fail('Too many measurement points.');
  const points=input.map(p=>point(p,mode==='surface'));
  const same=(a,b)=>a.lat===b.lat&&a.lng===b.lng&&(mode!=='surface'||a.altitude===b.altitude);
  if(kind!=='line'&&points.length>1&&same(points[0],points.at(-1)))points.pop();
  if(points.length<(kind==='line'?2:3))fail(kind==='line'?'Choose at least two different points.':'Choose at least three different outline points.');
  for(let i=0;i<points.length;i++){
    if(i&&same(points[i-1],points[i]))fail('Two consecutive points are identical.');
    if(distanceMeters(points[0],points[i])>20000)fail('This outline spans more than 20 km. Zoom to a single property.');
  }
  if(kind!=='line'){
    const {flat}=project(points,mode==='surface');simplePolygon(flat);
    if(Math.abs(flat.reduce((s,p,i)=>s+p[0]*flat[(i+1)%flat.length][1]-flat[(i+1)%flat.length][0]*p[1],0))<EPS)fail('The outline has no measurable area.');
  }
  return points;
}
function sphereArea(points) {
  const vectors=points.map(p=>[Math.cos(p.lat*RAD)*Math.cos(p.lng*RAD),Math.cos(p.lat*RAD)*Math.sin(p.lng*RAD),Math.sin(p.lat*RAD)]);
  let excess=0;
  for(let i=1;i<vectors.length-1;i++){
    const a=vectors[0],b=vectors[i],c=vectors[i+1];
    // Equivalent scalar triple product, using local differences so small
    // property outlines do not lose precision through cancellation.
    excess+=2*Math.atan2(dot(a,cross(sub(b,a),sub(c,a))),1+dot(a,b)+dot(b,c)+dot(c,a));
  }
  return Math.abs(excess)*EARTH_RADIUS**2;
}
function surfaceArea(points) {
  const {flat,xyz}=project(points,true),ids=flat.map((_,i)=>i);
  const winding=Math.sign(flat.reduce((s,p,i)=>s+p[0]*flat[(i+1)%flat.length][1]-flat[(i+1)%flat.length][0]*p[1],0));
  let sum=0,guard=0;
  while(ids.length>2){
    let clipped=false;
    for(let k=0;k<ids.length;k++){
      const a=ids[(k+ids.length-1)%ids.length],b=ids[k],c=ids[(k+1)%ids.length];
      if(orient(flat[a],flat[b],flat[c])*winding<=EPS)continue;
      if(ids.some(i=>![a,b,c].includes(i)&&orient(flat[a],flat[b],flat[i])*winding>=-EPS&&orient(flat[b],flat[c],flat[i])*winding>=-EPS&&orient(flat[c],flat[a],flat[i])*winding>=-EPS))continue;
      sum+=norm(cross(sub(xyz[b],xyz[a]),sub(xyz[c],xyz[a])))/2;ids.splice(k,1);clipped=true;break;
    }
    if(!clipped||++guard>MAX_POINTS)fail('Cannot triangulate this surface. Trace each roof face separately without collinear or crossed points.');
  }
  return sum;
}
export function measureGeometry(input,options={}) {
  const {kind='area',mode='ground'}=options,points=validatePoints(input,{kind,mode});
  let length=0,perimeter=0;
  const segment=(a,b)=>mode==='surface'?norm(sub(ecef(a),ecef(b))):distanceMeters(a,b);
  for(let i=1;i<points.length;i++)length+=segment(points[i-1],points[i]);
  perimeter=length+(kind!=='line'?segment(points.at(-1),points[0]):0);
  const groundArea=kind==='area'?sphereArea(points):undefined;
  const surface=kind==='area'&&mode==='surface'?surfaceArea(points):undefined;
  const value=kind==='area'?(mode==='surface'?surface:groundArea):kind==='perimeter'?perimeter:length;
  if(!Number.isFinite(value)||value<=1e-6)fail('The measurement is too small or invalid.');
  return {value,unit:kind==='area'?'m²':'m',groundArea,surfaceArea:surface,length,perimeter,points,
    method:mode==='surface'?'3D vertex surface estimate; trace each flat face separately':'Geodesic ground measurement'};
}
