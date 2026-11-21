const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../lead-welcome.js'),'utf8');
function fixture(extra={}){
  const c={window:{},URL,openSettings(){},...extra};vm.runInNewContext(source,c);return {c,api:c.window.TK_LEAD_WELCOME};
}
test('welcome defaults choose email and stay off, use the provided Instagram link and sample preview only',()=>{
  const {api}=fixture({docBizName:()=> 'Nova Exterior'}),d=api.defaults();
  assert.equal(d.enabled,false);assert.equal(d.channel,'email');assert.equal(d.consentMode,'explicit');
  assert.equal(d.trustUrl,'https://www.instagram.com/novaexterior/');
  assert.equal(d.body,'Hi {customer_name}, thanks for contacting {business_name}! While we review your enquiry, check out our work and how we care for your property: {trust_link}');
  assert.equal(d.subject,'Thanks for your enquiry — {business_name}');
  assert.match(api.previewText(d),/^Hi Alex, thanks for contacting Nova Exterior!/);
  assert.match(api.previewText(d),/https:\/\/www.instagram.com\/novaexterior\//);
  assert.equal(d.sources.join(','),'wix,meta,booking');d.sources.push('manual');assert.equal(api.defaults().sources.length,3);
});
test('welcome validation enforces provider readiness, HTTPS, lengths, placeholders and explicit activation',()=>{
  const {api}=fixture(),d={...api.defaults(),channel:'sms',sources:['wix']};
  assert.equal(api.validate(d,{}).enabled,false);
  assert.throws(()=>api.validate({...d,enabled:true},{}),/Twilio/);
  assert.throws(()=>api.validate({...d,enabled:true,channel:'email'},{}),/Gmail/);
  assert.equal(api.validate({...d,enabled:true},{sms:true}).enabled,true);
  assert.equal(api.validate({...d,enabled:true,channel:'email',consentMode:'enquiries'},{email:true}).channel,'email');
  for(const trustUrl of ['http://example.test','javascript:alert(1)','https://user:password@example.test','not a URL'])assert.throws(()=>api.validate({...d,trustUrl}),/HTTPS/);
  for(const body of ['x'.repeat(801)+'{trust_link}','Hello {unknown} {trust_link}','Hi {{customer_name}} {trust_link}'])assert.throws(()=>api.validate({...d,body}),/800|placeholder/);
  for(const subject of ['x'.repeat(161),'Hello\r\nBcc: test'])assert.throws(()=>api.validate({...d,subject}),/subject/);
  for(const changes of [{trustUrl:''},{body:''},{body:'Hello there'},{subject:''},{sources:[]},{channel:'email',subject:''}])assert.throws(()=>api.validate({...d,...changes,enabled:true},{sms:true,email:true}),/HTTPS|message|subject|Choose/);
  assert.equal(api.validate({...d,body:'x'.repeat(788)+'{trust_link}',subject:'x'.repeat(160)}).body.length,800);
  for(const changes of [{trustUrl:''},{body:''},{body:'Hello there'},{subject:''}])assert.throws(()=>api.validate({...d,...changes,enabled:false}),/HTTPS|message|subject/);
  assert.equal(api.validate({...d,enabled:false,sources:[]}).sources.length,0);
  assert.equal(api.validate({...d,sources:['wix','unknown','meta','meta']}).sources.join(','),'wix,meta');
});
test('staff and signed-out sessions never insert or request administrative welcome settings',()=>{
  for(const currentUserId of ['staff',null]){
    let inserts=0;
    const {c}=fixture({currentUserId,currentBusinessId:'business-a',currentUserRole:currentUserId?'staff':'owner',document:{getElementById(){inserts++;throw Error('Must not insert');}}});
    c.openSettings();assert.equal(inserts,0);
  }
});
test('welcome assets are included after sales hooks and registered for static publishing',()=>{
  const index=fs.readFileSync(require.resolve('../index.html'),'utf8'),build=fs.readFileSync(require.resolve('../scripts/build-static.js'),'utf8');
  for(const name of ['lead-welcome.js','lead-welcome.css']){assert(index.includes(name));assert(build.includes('"'+name+'"'));}
  assert(index.indexOf('<script src="lead-welcome.js')>index.indexOf('<script src="sales-platform.js'));
  assert(index.indexOf('<script src="lead-welcome.js')<index.indexOf('<script src="settings-experience.js'));
  assert.doesNotMatch(source,/method:\s*['"]POST|send-test|access_token|api_key/);
});
