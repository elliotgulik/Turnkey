const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('customer profile edits and persists the lead source field', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const profile = html.slice(html.indexOf('function renderCustomerProfile(){'), html.indexOf('async function saveCustomerContact(btn){'));
  const save = html.slice(html.indexOf('async function saveCustomerContact(btn){'), html.indexOf('async function saveCustomerNotes('));
  assert.match(profile, /id="cp-source"/);
  assert.match(save, /source:document\.getElementById\('cp-source'\)\.value\.trim\(\)/);
  assert.match(save, /\.from\('customers'\)\.update\(payload\)/);
  assert.match(save, /records\.filter\(r=>r\.customerId===ctx\.customerId\)\.forEach\(r=>Object\.assign\(r,payload\)\)/);
});
