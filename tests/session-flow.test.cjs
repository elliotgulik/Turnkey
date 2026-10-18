const {test}=require('node:test'),assert=require('node:assert/strict'),{create}=require('../session-flow.js');
test('initial and repeated sign-in events initialize once, then preserve a ready workspace on tab refocus',async()=>{
 let calls=0,ready=false,finish;
 const gate=create({isReady:id=>ready&&id==='a',initialize:async()=>{calls++;await new Promise(resolve=>finish=resolve);ready=true;}});
 const first=gate.start({user:{id:'a'}}),second=gate.start({user:{id:'a'}});
 assert.equal(first,second);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
 finish();await first;await gate.start({user:{id:'a'},access_token:'refreshed'});assert.equal(calls,1);
});
test('sign out invalidates queued work and different accounts initialize separately',async()=>{
 const queue=[],calls=[],gate=create({isReady:()=>false,defer:fn=>new Promise(resolve=>queue.push(()=>resolve(fn()))),initialize:session=>calls.push(session.user.id)});
 const a=gate.start({user:{id:'a'}});gate.reset();queue.shift()();await a;assert.deepEqual(calls,[]);
 const b=gate.start({user:{id:'b'}});queue.shift()();await b;assert.deepEqual(calls,['b']);
});
test('a failed load can retry, without a permanently locked pending session',async()=>{
 let count=0;const gate=create({isReady:()=>false,initialize:()=>{if(++count===1)throw Error('Offline');}});
 await assert.rejects(gate.start({user:{id:'a'}}),/Offline/);await gate.start({user:{id:'a'}});assert.equal(count,2);
});
