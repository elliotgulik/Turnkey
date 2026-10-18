const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('loading existing jobs does not show a success popup', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.doesNotMatch(html, /Loaded \\$\\{records\\.length\\} job/);
});
