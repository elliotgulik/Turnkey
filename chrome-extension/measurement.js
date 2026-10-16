/* Shared, dependency-free import and wire validation. Coordinates are [longitude, latitude]. */
export const LIMITS = Object.freeze({ bytes: 1048576, features: 50, points: 10000 });
const R = 6371008.8, rad = x => x * Math.PI / 180;
const fail = message => { throw new Error(message); };
function point(p) {
  if (!Array.isArray(p) || p.length < 2 || p.length > 3 || p.some(n => typeof n !== 'number' || !Number.isFinite(n)) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) fail('Invalid coordinate or longitude/latitude bounds.');
  return p.slice(0, 2);
}
const same = (a,b) => a[0] === b[0] && a[1] === b[1];
function geometry(g, budget) {
  if (!g || !['Polygon','LineString'].includes(g.type)) fail('Only Polygon and LineString geometries are supported.');
  const groups = g.type === 'Polygon' ? g.coordinates : [g.coordinates];
  if (!Array.isArray(groups) || !groups.length || groups.length > 100) fail('Invalid geometry.');
  const result = groups.map(group => {
    if (!Array.isArray(group) || group.length < (g.type === 'Polygon' ? 4 : 2)) fail('Too few coordinates.');
    budget.points += group.length;
    if (budget.points > LIMITS.points) fail('Too many coordinates (maximum 10,000).');
    const ps = group.map(point);
    if (g.type === 'Polygon' && !same(ps[0],ps.at(-1))) fail('Polygon rings must be closed.');
    if (new Set(ps.map(p=>p.join(','))).size < (g.type === 'Polygon' ? 3 : 2)) fail('Degenerate geometry.');
    return ps;
  });
  return { type:g.type, coordinates:g.type === 'Polygon' ? result : result[0] };
}
export function lengthMeters(ps) {
  let total = 0;
  for (let i=1;i<ps.length;i++) {
    const [a,b] = [ps[i-1],ps[i]];
    const h = Math.sin(rad(b[1]-a[1])/2)**2 + Math.cos(rad(a[1]))*Math.cos(rad(b[1]))*Math.sin(rad(b[0]-a[0])/2)**2;
    total += 2*R*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
  }
  return total;
}
function ringArea(ps) {
  let sum=0;
  for(let i=1;i<ps.length;i++) {
    let d=rad(ps[i][0]-ps[i-1][0]);
    if(d>Math.PI) d-=2*Math.PI;
    if(d< -Math.PI) d+=2*Math.PI;
    sum+=d*(2+Math.sin(rad(ps[i-1][1]))+Math.sin(rad(ps[i][1])));
  }
  const area=Math.abs(sum*R*R/2), sphere=4*Math.PI*R*R;
  return Math.min(area,sphere-area);
}
export function measure(g) {
  if(g.type === 'LineString') return {kind:'length',siValue:lengthMeters(g.coordinates)};
  const siValue=ringArea(g.coordinates[0])-g.coordinates.slice(1).reduce((n,r)=>n+ringArea(r),0);
  if(siValue<=0) fail('Polygon area must be positive; check holes.');
  return {kind:'area',siValue};
}
// A deliberately narrow XML reader: no DTDs, entities, external resources or network links.
function kmlGeometries(text) {
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:\w+:)?NetworkLink\b/i.test(text)) fail('KML external resources and declarations are unsupported.');
  const root={name:'root',children:[],text:''}, stack=[root];
  let nodes=0;
  const tokens=text.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g)||[];
  if(tokens.join('')!==text) fail('Malformed KML.');
  for(const token of tokens) {
    if(token.startsWith('<!--') || token.startsWith('<?')) continue;
    if(token.startsWith('</')) {
      const name=token.slice(2,-1).trim();
      if(stack.length===1 || stack.pop().full!==name) fail('Malformed KML nesting.');
    } else if(token.startsWith('<')) {
      const match=token.match(/^<([\w:.-]+)(?:\s[^<>]*)?\s*\/?>$/);
      if(!match) fail('Malformed KML tag.');
      if(++nodes>20000) fail('Too many KML elements.');
      const node={full:match[1],name:match[1].split(':').at(-1),children:[],text:''};
      stack.at(-1).children.push(node);
      if(!token.endsWith('/>')) stack.push(node);
      if(stack.length>64) fail('KML nesting too deep.');
    } else stack.at(-1).text+=token;
  }
  if(stack.length!==1 || root.children.length!==1 || root.children[0].name!=='kml') fail('Expected a complete KML document.');
  const all=[];
  function walk(n) { all.push(n); n.children.forEach(walk); } walk(root);
  if(all.some(n=>['Point','MultiGeometry','Track','Model','LinearRing'].includes(n.name) && (n.name!=='LinearRing' || !all.some(p=>p.name==='Polygon' && contains(p,n))))) fail('Unsupported KML geometry. Export individual polygons or paths.');
  function contains(a,b) { return a.children.some(c=>c===b || contains(c,b)); }
  function coords(n) {
    const cs=all.filter(c=>c.name==='coordinates' && contains(n,c));
    if(cs.length!==1 || !cs[0].text.trim()) fail('Expected one coordinate sequence.');
    return cs[0].text.trim().split(/\s+/).map(t=>t.split(',').map(v=>v.trim()==='' ? NaN : Number(v)));
  }
  return all.filter(n=>['Polygon','LineString'].includes(n.name)).map(n=> {
    if(n.name==='LineString') return {type:n.name,coordinates:coords(n)};
    const outer=n.children.filter(c=>c.name==='outerBoundaryIs'), inner=n.children.filter(c=>c.name==='innerBoundaryIs');
    if(outer.length!==1) fail('Polygon needs one outer boundary.');
    return {type:n.name,coordinates:[coords(outer[0]),...inner.map(coords)]};
  });
}
export function parseImport(text, format) {
  if(typeof text!=='string' || new TextEncoder().encode(text).length>LIMITS.bytes) fail('File exceeds 1 MiB.');
  let gs;
  if(format==='kml') gs=kmlGeometries(text);
  else if(format==='geojson' || format==='json') {
    const data=JSON.parse(text);
    if(data.crs) fail('Use WGS84 longitude/latitude GeoJSON.');
    const fs=data.type==='FeatureCollection' ? data.features : [data];
    if(!Array.isArray(fs)) fail('Invalid feature collection.');
    gs=fs.map(f=> { if(f.crs) fail('Custom CRS is unsupported.'); return f.type==='Feature' ? f.geometry : f; });
  } else fail('Choose a .kml, .geojson or .json file.');
  if(!gs.length || gs.length>LIMITS.features) fail('Import 1–50 geometries.');
  const budget={points:0};
  return gs.map(g=>{ const clean=geometry(g,budget); return {geometry:clean,...measure(clean)}; });
}
export const UNITS = Object.freeze({m:{kind:'length',factor:1},ft:{kind:'length',factor:3.280839895},m2:{kind:'area',factor:1},ft2:{kind:'area',factor:10.763910417}});
export function validatePayload(payload) {
  if(!payload || payload.version!==1 || !Array.isArray(payload.measurements) || !payload.measurements.length || payload.measurements.length>LIMITS.features) fail('Invalid v1 measurement payload.');
  const budget={points:0};
  return {version:1,measurements:payload.measurements.map(m=> {
    if(typeof m.service!=='string' || !/^[a-zA-Z0-9 _-]{1,80}$/.test(m.service)) fail('Enter a service name or ID (1–80 letters, numbers, spaces, _ or -).');
    const g=geometry(m.geometry,budget), calculated=measure(g), unit=UNITS[m.unit];
    if(!unit || unit.kind!==calculated.kind || m.kind!==calculated.kind || !Number.isFinite(m.value) || Math.abs(m.value-calculated.siValue*unit.factor)>Math.max(1e-6,calculated.siValue*unit.factor*1e-9)) fail('Measurement does not match coordinates or unit.');
    return {service:m.service,kind:calculated.kind,unit:m.unit,value:calculated.siValue*unit.factor,geometry:g};
  })};
}
