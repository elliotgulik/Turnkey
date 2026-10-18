const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const moduleReady=import('data:text/javascript;base64,'+fs.readFileSync(path.join(__dirname,'../measurement-editor.js')).toString('base64'));
const camera=()=>({center:{lat:-36.8,lng:174.7,altitude:10},range:300,heading:0,tilt:60});
const point={lat:-36.8001,lng:174.7001,altitude:22.75};
async function setup(){
 const {createCameraPickGuard}=await moduleReady;
 let time=0;
 const guard=createCameraPickGuard({now:()=>time});
 const map=camera();guard.sample(map);guard.scene(true);
 return {guard,map,at(t){time=t;}};
}
test('requires 500ms stable pose, ignores render ticks and bounded subpixel noise',async()=>{
 const {guard,map,at}=await setup();
 for(let t=0;t<500;t+=16){at(t);map.heading=t%32?0.003:359.997;map.center.lat=-36.8+(t%32?1:-1)*1e-8;guard.scene(true);assert.equal(guard.status(map),'moving');}
 at(500);assert.deepEqual(guard.pick(map,point),{point});
});
test('fake orbit/tilt animation blocks; slow cumulative movement cannot evade anchor',async()=>{
 const {guard,map,at}=await setup();
 for(let t=100;t<=2000;t+=100){at(t);map.heading+=0.008;map.tilt+=0.004;assert.equal(guard.status(map),'moving');}
 at(2499);assert.equal(guard.status(map),'moving');at(2500);assert.equal(guard.status(map),'ready');
 let settledAt=2500;
 for(const mutate of [()=>map.center.lng+=0.001,()=>map.center.altitude+=1,()=>map.range+=5,()=>map.roll=2,()=>map.fov=40]){
  mutate();assert.equal(guard.pick(map,point).reason,'moving');at(settledAt+=500);assert.equal(guard.status(map),'ready');
 }
});
test('stationary scene loading remains blocked; malformed steady events cannot change readiness',async()=>{
 const {guard,map,at}=await setup();
 guard.scene(false);at(10000);assert.equal(guard.pick(map,point).reason,'loading');
 guard.reset();at(11000);guard.sample(map);at(12000);assert.equal(guard.status(map),'loading');
 guard.scene(undefined);assert.equal(guard.status(map),'loading');guard.scene(true);guard.scene(undefined);assert.equal(guard.status(map),'ready');
});
test('requires valid SDK geographic/elevation pick and property zoom; never derives elevation',async()=>{
 const {guard,map,at}=await setup();at(500);
 for(const p of [null,{...point,altitude:undefined},{...point,altitude:NaN},{...point,lat:Infinity},{...point,lng:181}])assert.equal(guard.pick(map,p).reason,'surface');
 assert.deepEqual(guard.pick(map,{...point,altitude:0}),{point:{...point,altitude:0}});
 map.range=1600;guard.sample(map);at(1000);assert.equal(guard.pick(map,point).reason,'zoom');
 map.center=null;assert.equal(guard.pick(map,point).reason,'moving');
});
