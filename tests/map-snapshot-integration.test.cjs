const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const index=fs.readFileSync('index.html','utf8'),pub=fs.readFileSync('quote.html','utf8');
const areas=()=>[{service:'driveway',size:40,geoPts:[{lat:-36.8,lng:174.7},{lat:-36.8001,lng:174.7001},{lat:-36.8002,lng:174.7}]}];
function harness(){
 const c={console:{warn(){}},structuredClone,URLSearchParams,currentBusinessId:'A',currentUserId:'user-a',businessSessionVersion:1,sb:{},recordBusinesses:new WeakMap(),TURNKEY_CONFIG:{mapsKey:'fixture-key'}};c.window=c;vm.createContext(c);
 for(const f of ['pricing-engine.js','map-snapshot.js'])vm.runInContext(fs.readFileSync(f,'utf8'),c);
 const start=index.indexOf('const mapSnapshotLoads=new WeakMap();'),end=index.indexOf('// One-way seed, not a sync:',start);
 vm.runInContext(index.slice(start,end),c);
 const r={areaPolys:areas(),_mapSnapshotDataUrl:null};c.recordBusinesses.set(r,'A');return {c,r};
}
const snap=(imagery=true)=>({dataUrl:'data:image/png;base64,fixture',width:640,height:458,hasImagery:imagery});
test('overlapping preview/send calls deduplicate, retain dimensions and reuse confirmed imagery',async()=>{
 const {c,r}=harness();let resolve,calls=0;c.TK_MAP_SNAPSHOT.buildSnapshot=()=>{calls++;return new Promise(done=>resolve=done);};
 const a=c.preloadMapSnapshot(r),b=c.preloadMapSnapshot(r);await Promise.resolve();assert.equal(calls,1);resolve(snap());await Promise.all([a,b]);
 assert.equal(r._mapSnapshotWidth,640);assert.equal(r._mapSnapshotHeight,458);await c.preloadMapSnapshot(r);assert.equal(calls,1);
 assert.equal(Object.values(r).some(v=>v&&typeof v.then==='function'),false,'No promise is attached to the record');
});
test('both synchronous failure and rejected fetch retry; successful diagram remains usable while imagery retry is possible',async()=>{
 const {c,r}=harness();let calls=0;c.TK_MAP_SNAPSHOT.buildSnapshot=()=>{calls++;if(calls===1)throw Error('Unavailable');return Promise.resolve(snap(false));};
 await c.preloadMapSnapshot(r);assert.equal(r._mapSnapshotDataUrl,null);await c.preloadMapSnapshot(r);assert.equal(calls,2);assert.ok(r._mapSnapshotDataUrl);
 await c.preloadMapSnapshot(r);assert.equal(calls,3);
 c.TK_MAP_SNAPSHOT.buildSnapshot=async()=>{throw Error('Rejected');};await c.preloadMapSnapshot(r);assert.equal(r._mapSnapshotDataUrl,null);
 c.TK_MAP_SNAPSHOT.buildSnapshot=async()=>snap();await c.preloadMapSnapshot(r);assert.ok(r._mapSnapshotDataUrl);
});
test('missing Maps key caches measured fallback and geometry/key changes invalidate it',async()=>{
 const {c,r}=harness();c.TURNKEY_CONFIG.mapsKey='';let calls=0;c.TK_MAP_SNAPSHOT.buildSnapshot=async()=>{calls++;return snap(false);};
 await c.preloadMapSnapshot(r);await c.preloadMapSnapshot(r);assert.equal(calls,1);
 r.areaPolys[0].size=99;await c.preloadMapSnapshot(r);assert.equal(calls,2);
 c.TURNKEY_CONFIG.mapsKey='new-fixture-key';await c.preloadMapSnapshot(r);assert.equal(calls,3);
});
test('late results cannot write after business, user, session or geometry changes',async()=>{
 for(const mutate of [c=>c.currentBusinessId='B',c=>c.currentUserId='other-user',c=>c.businessSessionVersion++,(_,r)=>r.areaPolys[0].size=91]){
  const {c,r}=harness();let resolve;c.TK_MAP_SNAPSHOT.buildSnapshot=()=>new Promise(done=>resolve=done);
  const work=c.preloadMapSnapshot(r);await Promise.resolve();mutate(c,r);resolve(snap());assert.equal(await work,null);assert.equal(r._mapSnapshotDataUrl,undefined);assert.equal(r._mapSnapshotWidth,undefined);
 }
});
test('a stale generation cannot clear or replace the newer snapshot',async()=>{
 const {c,r}=harness();const pending=[];c.TK_MAP_SNAPSHOT.buildSnapshot=()=>new Promise(resolve=>pending.push(resolve));
 const first=c.preloadMapSnapshot(r);await Promise.resolve();r.areaPolys[0].size=21;
 const second=c.preloadMapSnapshot(r);await Promise.resolve();pending[1]({...snap(),dataUrl:'new'});await second;pending[0]({...snap(),dataUrl:'old'});await first;
 assert.equal(r._mapSnapshotDataUrl,'new');
});
test('public filtering accepts geographic-only shapes and text shows saved measurement, never private fields',()=>{
 const {c}=harness();c.TK_PRICING.SERVICES.driveway.label='Driveway <customer>';
 const extract=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
 vm.runInContext(extract(pub,'function pubAreasWithGeo(', '\nfunction pubLatLngToSvg(')+extract(pub,'function pubShapeSvg(', '\nfunction pubRenderAreas('),c);
 const normalized=c.pubAreasWithGeo(areas());assert.equal(normalized.length,1);
 const svg=c.pubShapeSvg({...normalized[0],svgPts:[{x:10,y:10},{x:80,y:10},{x:50,y:50}],notes:'PRIVATE',cost:999});
 assert.match(svg,/40 m²/);assert.match(svg,/&lt;customer&gt;/);assert.doesNotMatch(svg,/PRIVATE|999/);
});
test('job persistence strips snapshot dimensions and legacy promise fields in both cleanup lists',()=>{
 const lists=index.match(/\[(?:'[^']*',?)+\]/g).filter(s=>s.includes("'dueDate'")&&s.includes("'_mapSnapshotDataUrl'"));
 assert.equal(lists.length,2);for(const list of lists)for(const field of ['_mapSnapshotWidth','_mapSnapshotHeight','_mapSnapshotPromise'])assert.ok(list.includes("'"+field+"'"));
});
