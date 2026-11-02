import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ONESIGNAL_APP_ID='';process.env.ONESIGNAL_API_KEY='';
const {sendNotification,isActionableNotification}=await import('./notifications.js');
test('routine reminders and informational events never write a notification or send push',async()=>{
 const db={from(){throw Error('Disabled event reached notification storage')}};
 for(const type of ['sales_followup_due','quote_viewed','new_lead','job_booked','invoice_overdue','job_tomorrow','general']){
  assert.equal(isActionableNotification(type),false);
  assert.deepEqual(await sendNotification(db,{business_id:'A',type,title:'Test',message:'Test'}),{ok:true,skipped:'notification_type_disabled'});
 }
});
test('customer replies, quote acceptance and payment events are retained for the owning business',async()=>{
 const rows=[],db={from(table){assert.equal(table,'notifications');return {async insert(row){rows.push(row);return {error:null}}}}};
 for(const type of ['customer_reply','email_received','customer_question','quote_accepted','payment_received','invoice_paid']){
  assert.equal(isActionableNotification(type),true);
  assert.equal((await sendNotification(db,{business_id:'A',user_id:'owner',type,title:'Customer update',message:'Test'})).ok,true);
 }
 assert.equal(rows.length,6);assert(rows.every(r=>r.business_id==='A'&&r.user_id==='owner'));
});
