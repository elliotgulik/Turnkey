const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../measure.js'),'utf8');

test('unresolved address keeps a neutral location pin and never labels it camera fallback',()=>{
  assert.match(source,/propertyResolved\s*\?\s*'Property'\s*:\s*'Location pin'/);
  assert.match(source,/propertyMarker2d\?\.setOptions\(\{position:propertyPosition/);
  assert.match(source,/propertyMarker3d\.position\s*=\s*propertyPosition/);
  assert.doesNotMatch(source,/Camera fallback|camera fallback|original Earth camera location/);
});
