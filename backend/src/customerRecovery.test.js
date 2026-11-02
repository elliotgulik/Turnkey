import test from 'node:test';
import assert from 'node:assert/strict';
import { missingServiceM8CustomerFields } from './salesPlatform.js';
test('exact ServiceM8 recovery fills missing contacts and preserves operator changes',()=>{
 const original={name:'Customer One',email:'custom@example.test',phone:null,address:''};
 assert.deepEqual(missingServiceM8CustomerFields(original,{personName:'Other Name',email:'remote@example.test',phone:'0210000000',address:'7 Example Road'}),{phone:'0210000000',address:'7 Example Road'});
 assert.equal(original.phone,null);
 assert.deepEqual(missingServiceM8CustomerFields({name:''},{personName:'Customer One',email:'one@example.test'}),{name:'Customer One',email:'one@example.test'});
});
test('provider fallback labels cannot fabricate a missing customer identity',()=>{
 for(const personName of ['ServiceM8 booking','ServiceM8 customer','Unnamed','Unknown',''])assert.deepEqual(missingServiceM8CustomerFields({name:''},{personName,email:'one@example.test'}),{});
});
