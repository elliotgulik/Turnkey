import test from 'node:test';
import assert from 'node:assert/strict';
import {parseImport,lengthMeters,measure,validatePayload} from '../measurement.js';
const line={type:'LineString',coordinates:[[0,0],[1,0]]};
const polygon={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]};
const parse=g=>parseImport(JSON.stringify(g),'geojson');
test('geodesic length and spherical area against analytic equatorial values',()=>{
 assert.ok(Math.abs(lengthMeters(line.coordinates)-111195.0802335)<0.001);
 const expected=6371008.8**2*Math.PI/180*Math.sin(Math.PI/180);
 assert.ok(Math.abs(measure(polygon).siValue-expected)<0.1);
 assert.ok(Math.abs(lengthMeters([[179,0],[-179,0]])-222390.160467)<0.001);
});
test('holes and reversed winding',()=>{
 const half=[[0,0],[0.5,0],[0.5,1],[0,1],[0,0]];
 assert.ok(Math.abs(measure({type:'Polygon',coordinates:[polygon.coordinates[0],half]}).siValue/measure(polygon).siValue-0.5)<1e-10);
 assert.equal(measure({type:'Polygon',coordinates:[polygon.coordinates[0].toReversed?.()||[...polygon.coordinates[0]].reverse()]}).siValue,measure(polygon).siValue);
});
test('GeoJSON collection strips metadata and altitude',()=>{
 const result=parse({type:'FeatureCollection',features:[{type:'Feature',properties:{secret:'omitted'},geometry:{type:'LineString',coordinates:[[0,0,4],[1,0,5]]}}]});
 assert.deepEqual(result[0].geometry,line);assert.equal(result[0].secret,undefined);
});
test('KML polygon with namespace and path',()=>{
 assert.deepEqual(parseImport('<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>','kml')[0].geometry,polygon);
 assert.deepEqual(parseImport('<k:kml><k:LineString><k:coordinates>0,0,3 1,0,4</k:coordinates></k:LineString></k:kml>','kml')[0].geometry,line);
});
test('invalid and oversized imports fail closed',()=>{
 for(const g of [{type:'Point',coordinates:[0,0]}, {type:'LineString',coordinates:[[181,0],[0,0]]},{type:'LineString',coordinates:[[0,91],[0,0]]},{type:'LineString',coordinates:[[null,0],[0,0]]},{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1]]]}, {type:'FeatureCollection',features:Array(51).fill(line)}, {type:'LineString',coordinates:Array(10001).fill([0,0])}, {...line,crs:{}}]) assert.throws(()=>parse(g));
 assert.throws(()=>parseImport(' '.repeat(1048577),'kml'));
 for(const xml of ['<!DOCTYPE kml><kml/>','<kml><NetworkLink/></kml>','<kml><LineString></kml>','<kml><Point/></kml>','<kml/>']) assert.throws(()=>parseImport(xml,'kml'));
});
test('wire validation recalculates and removes extra fields',()=>{
 const m={geometry:line,service:'Gutter cleaning',kind:'length',unit:'m',value:lengthMeters(line.coordinates),secret:'discard'};
 const p={version:1,measurements:[m],filename:'private.kml'};
 assert.deepEqual(Object.keys(validatePayload(p)),['version','measurements']);
 assert.equal(validatePayload(p).measurements[0].secret,undefined);
 for(const patch of [{value:1},{unit:'m2'},{service:''},{service:'<script>'},{kind:'area'}]) assert.throws(()=>validatePayload({...p,measurements:[{...m,...patch}]}));
 assert.throws(()=>validatePayload({...p,version:2}));
});
