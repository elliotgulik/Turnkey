import test from 'node:test';import assert from 'node:assert/strict';
import {distanceMeters,measureGeometry,EARTH_RADIUS} from '../geometry.js';
const degree=180/Math.PI/EARTH_RADIUS;
test('ground distances use real coordinates, including antimeridian',()=>{
 assert(Math.abs(distanceMeters({lat:0,lng:0},{lat:0,lng:degree*100})-100)<1e-8);
 assert(Math.abs(distanceMeters({lat:0,lng:179.999},{lat:0,lng:-179.999})-222.63898)<.001);
});
test('ground area and perimeter are independent of camera metadata and winding',()=>{
 const p=[{lat:0,lng:0},{lat:0,lng:20*degree},{lat:10*degree,lng:20*degree},{lat:10*degree,lng:0}];
 const a=measureGeometry(p),b=measureGeometry(p.slice().reverse().map(p=>({...p,x:1000,y:999,tilt:70,heading:180})));
 assert(Math.abs(a.value-200)<.001);assert(Math.abs(a.value-b.value)<1e-8);assert(Math.abs(a.perimeter-60)<.001);
 assert(Math.abs(measureGeometry(p,{kind:'perimeter'}).value-60)<.001);
 assert(Math.abs(measureGeometry([...p,p[0]]).value-200)<.001);
});
test('3D sloped surface includes elevation; footprint stays separate',()=>{
 const p=[{lat:0,lng:0,altitude:0},{lat:0,lng:3*degree,altitude:4},{lat:10*degree,lng:3*degree,altitude:4},{lat:10*degree,lng:0,altitude:0}];
 const s=measureGeometry(p,{mode:'surface'}),g=measureGeometry(p);
 // At the equator WGS84's meridional radius is R*(1-e²), while ground
 // geodesics use the Maps geometry library's spherical radius R.
 assert(Math.abs(s.value-50*(1-6.6943799901413165e-3))<.001);assert(Math.abs(g.value-30)<.001);assert.equal(s.unit,'m²');
 assert(Math.abs(measureGeometry(p.slice(0,2),{kind:'line',mode:'surface'}).value-5)<.001);
});
test('concave surfaces are triangulated without counting cut-outs',()=>{
 const p=[[0,0],[4,0],[4,2],[2,2],[2,4],[0,4]].map(([x,y])=>({lat:y*degree,lng:x*degree,altitude:0}));
 assert(Math.abs(measureGeometry(p).value-12)<.001);
 assert(Math.abs(measureGeometry(p,{mode:'surface'}).value-12)<.1);
});
test('small outlines retain precision away from the equator and across longitude wrap',()=>{
 for(const [lat,lng] of [[-36.8,174.75],[60,179.999999]]){
  const dlng=degree/Math.cos(lat*Math.PI/180),wrap=n=>((n+180)%360+360)%360-180;
  const p=[[0,0],[1,0],[1,1],[0,1]].map(([x,y])=>({lat:lat+y*degree,lng:wrap(lng+x*dlng)}));
  assert(Math.abs(measureGeometry(p).value-1)<.00001);
 }
});
test('crossed, degenerate, duplicate and malformed coordinates fail closed',()=>{
 assert.throws(()=>measureGeometry([{lat:0,lng:0},{lat:.001,lng:.001},{lat:0,lng:.001},{lat:.001,lng:0}]),/cross|overlap/);
 assert.throws(()=>measureGeometry([{lat:0,lng:0},{lat:0,lng:0} ],{kind:'line'}),/identical/);
 assert.throws(()=>measureGeometry([{lat:0,lng:0},{lat:NaN,lng:1}],{kind:'line'}),/Invalid/);
 assert.throws(()=>measureGeometry([{lat:0,lng:0},{lat:1,lng:1}],{kind:'line'}),/20 km/);
 assert.throws(()=>measureGeometry([{lat:0,lng:0},{lat:0,lng:.0001},{lat:.0001,lng:0}],{mode:'surface'}),/elevation/);
});
