const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('settings are rendered as searchable collapsible groups without removing existing sections',()=>{
  const html=fs.readFileSync('index.html','utf8');
  assert.match(html,/function filterSettings\(query\)/);
  assert.match(html,/<details class="settings-group"/);
  for(const label of ['Business','Branding','Team','Pricing','Notifications','Calendar','Email','Integrations','Imports','Advanced'])
    assert.ok(html.includes(`settingsGroup('${label}'`),`missing ${label} settings group`);
});
