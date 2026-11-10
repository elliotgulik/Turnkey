import test from 'node:test';
import assert from 'node:assert/strict';
import {staffDirectory,mappedStaff} from './staffDirectory.js';
test('ServiceM8 names replace email accounts without losing booking IDs',()=>{
 const local=[{id:'local-elliot',name:'elliot@example.test',email:'elliot@example.test',role:'owner'}];
 const remote=[{id:'servicem8:elliot',name:'Elliot Gulik',email:'ELLIOT@example.test',readOnly:true,source:'servicem8'},{id:'servicem8:luca',name:'Luca Anderson',email:'luca@example.test',readOnly:true}];
 const staff=staffDirectory(local,remote);assert.equal(staff.length,2);assert.equal(staff[0].name,'Elliot Gulik');assert.equal(staff[0].id,'local-elliot');assert.deepEqual(staff[0].aliases,['local-elliot','servicem8:elliot']);assert.notEqual(staff[0].readOnly,true);
});
test('integration accounts, deleted staff and staff hidden from schedule are excluded',()=>{
 const rows=['TurnKey (API Key)','Zapier','Make','Apingo .','My Custom Calendar','test test'].map((name,id)=>({id:String(id),name}));
 rows.push({id:'inactive',name:'Former Worker',active:0},{id:'hidden',name:'Hidden Worker',hideFromSchedule:1},{id:'aidan',name:'Aidan Corless'});
 assert.deepEqual(staffDirectory([],rows).map(r=>r.name),['Aidan Corless']);
});
test('only unique email or exact full-name matches are merged; original data stays intact',()=>{
 const locals=[{id:'l',name:'luca anderson',email:'old@example.test'}],remote=[{id:'r',name:'Luca Anderson',email:'new@example.test'}];
 const before=JSON.stringify([locals,remote]);assert.equal(staffDirectory(locals,remote).length,1);assert.equal(JSON.stringify([locals,remote]),before);
 assert.equal(staffDirectory([{id:'x',name:'Unknown Person',email:'shared@example.test'}],[{id:'a',name:'Alice',email:'shared@example.test'},{id:'b',name:'Bob',email:'shared@example.test'}]).length,3);
});
test('old connection generations never appear in the staff directory',()=>{assert.equal(mappedStaff([{connection_generation:'old',external_uuid:'x',snapshot:{name:'Old'}}],'current').length,0);});
test('sales assignment keeps unnamed company accounts even when ServiceM8 staff exist',()=>{
 const locals=[{id:'luca-account',name:null,email:'lucaganderson@gmail.com',role:'owner'}];
 const remote=[{id:'servicem8:someone',name:'Other Worker'}];
 const result=staffDirectory(locals,remote,{includeAccounts:true});
 assert.equal(result.length,2);
 assert.equal(result.find(x=>x.id==='luca-account').name,'lucaganderson');
 assert.deepEqual(result.find(x=>x.id==='luca-account').aliases,['luca-account']);
 // Calendar continues to use the filtered human display directory.
 assert.equal(staffDirectory(locals,remote).length,1);
});
test('confirmed identity link gives Luca his ServiceM8 alias instead of the shared email login',()=>{
 const locals=[{id:'shared-login',name:null,email:'office@example.test'},{id:'luca-login',name:null,email:'luca@example.test'}];
 const rows=[{external_uuid:'staff-luca',connection_generation:'current',snapshot:{name:'luca anderson',email:'office@example.test'}}];
 const identities=[{local_id:'luca-login',external_uuid:'staff-luca',connection_generation:'current'}];
 for(const order of [locals,[...locals].reverse()]){
  const people=staffDirectory(order,mappedStaff(rows,'current',identities),{includeAccounts:true});
  const luca=people.find(x=>x.id==='luca-login'),shared=people.find(x=>x.id==='shared-login');
  assert.equal(luca.name,'luca anderson');assert.equal(luca.serviceM8Id,'servicem8:staff-luca');
  assert.ok(luca.aliases.includes('servicem8:staff-luca'));
  assert.ok(!shared.aliases.includes('servicem8:staff-luca'));
 }
 assert.equal(mappedStaff(rows,'current',[{...identities[0],connection_generation:'old'}])[0].linkedUserId,undefined);
});
