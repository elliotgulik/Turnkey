const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('production navigation opens the calendar and renders it', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const source = html.match(/function switchView\(v\)\{[\s\S]*?\n\}/)[0];
  const active = new Set(); let rendered = false;
  const host = { classList: { add: v => active.add(v), remove: v => active.delete(v) } };
  const context = {
    document: { getElementById: id => id === 'view-calendar' ? host : null, querySelectorAll: selector => selector === '.view' ? [host] : [] },
    setAccent() {}, renderCalendar() { rendered = true; }, window: { scrollTo() {} }
  };
  vm.runInNewContext(source + ';switchView("calendar");', context);
  assert.equal(rendered, true);
  assert.equal(active.has('active'), true);
});
