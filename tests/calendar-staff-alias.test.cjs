const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('one named staff filter finds both native and ServiceM8 bookings through preserved IDs',()=>{
 const source=fs.readFileSync('job-calendar.js','utf8'),context={state:{staff:[{id:'local',name:'Elliot Gulik',aliases:['local','servicem8:remote']}],staffFilter:new Set(['local'])}};
 const find=source.slice(source.indexOf('  function findStaff('),source.indexOf('\n',source.indexOf('  function findStaff(')));
 const start=source.indexOf('  function matchesStaffFilter('),end=source.indexOf('\n  }',start)+4;
 vm.runInNewContext(find+'\n'+source.slice(start,end),context);
 assert.equal(context.findStaff('servicem8:remote').name,'Elliot Gulik');assert.equal(context.matchesStaffFilter(['servicem8:remote']),true);assert.equal(context.matchesStaffFilter(['local']),true);assert.equal(context.matchesStaffFilter(['another']),false);
 context.state.staffFilter=new Set(['servicem8:remote']);assert.equal(context.matchesStaffFilter(['local']),true);
});
