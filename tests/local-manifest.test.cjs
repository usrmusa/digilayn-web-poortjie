const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('local registration manifest includes IntelliJ credentials and resolves to a real file', () => {
  const page = path.join(root, 'dist/local/authentication/register.html');
  const source = fs.readFileSync(page, 'utf8');
  const tag = source.match(/<link\b[^>]*rel="manifest"[^>]*>/)[0];
  assert.match(tag, /crossorigin="use-credentials"/);
  const href = tag.match(/href="([^"]+)"/)[1];
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(page), href), 'utf8'));
  assert.equal(manifest.name, 'Poortjie Services');
});
test('live manifest links remain unchanged', () => {
  for (const target of ['authentication/register.html', 'authentication/profile.html', 'home.html']) {
    assert.equal(fs.readFileSync(path.join(root, 'dist/live', target), 'utf8'), fs.readFileSync(path.join(root, target), 'utf8'));
  }
});
