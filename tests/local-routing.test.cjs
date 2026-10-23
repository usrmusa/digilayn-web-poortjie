const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function load(page, prefix = '/web-poortjie/dist/local/') {
  const url = `http://localhost:63343${prefix}${page}`;
  const window = { location: { href: url } };
  const document = { currentScript: { src: `http://localhost:63343${prefix}scripts/local-routing.js` }, addEventListener() {} };
  const context = vm.createContext({ window, document, URL });
  vm.runInContext(fs.readFileSync(path.join(root, 'dist/local/scripts/local-routing.js'), 'utf8'), context);
  return { context, window, resolve: window.PoortjieLocalRouting.resolve };
}
test('root-relative home preserves the IntelliJ project prefix and URL state', () => {
  const state = load('index.html');
  assert.equal(state.resolve('/home?_ijt=key#section'), 'http://localhost:63343/web-poortjie/dist/local/home.html?_ijt=key#section');
});
test('nested login, registration and profile paths resolve to real files', () => {
  const state = load('authentication/login.html');
  assert.equal(state.resolve('register'), 'http://localhost:63343/web-poortjie/dist/local/authentication/register.html');
  assert.equal(state.resolve('profile?action=set-password'), 'http://localhost:63343/web-poortjie/dist/local/authentication/profile.html?action=set-password');
  assert.equal(state.resolve('../'), 'http://localhost:63343/web-poortjie/dist/local/index.html');
});
test('root hosting, encoded paths, assets and Rider directory navigation work', () => {
  const state = load('home.html', '/');
  assert.equal(state.resolve('services/food%20%26%20catering'), 'http://localhost:63343/services/food%20&%20catering.html');
  assert.equal(state.resolve('/scripts/site.js'), 'http://localhost:63343/scripts/site.js');
  assert.equal(state.resolve('laynfleet/laynrider/'), 'http://localhost:63343/laynfleet/laynrider/index.html');
});
test('external links, fragments and unknown destinations remain unchanged', () => {
  const state = load('home.html');
  for (const value of ['https://digilayn.co.za/', 'mailto:admin@digilayn.co.za', 'tel:0123', '#details', '/unknown-page']) {
    assert.equal(state.resolve(value), value);
  }
});
test('local index redirects to the real home file while preserving query and hash', () => {
  const state = load('index.html');
  let destination;
  Object.assign(state.window.location, { search: '?_ijt=key', hash: '#home', replace: url => { destination = url; } });
  const source = fs.readFileSync(path.join(root, 'dist/local/index.html'), 'utf8');
  const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInContext(script, state.context);
  assert.equal(destination, 'http://localhost:63343/web-poortjie/dist/local/home.html?_ijt=key#home');
  assert.match(source, /content="0; url=home.html"/);
});
test('local site script does not strip file extensions or send analytics', () => {
  const state = load('home.html');
  vm.runInContext(fs.readFileSync(path.join(root, 'dist/local/scripts/site.js'), 'utf8'), state.context);
  assert.equal(state.window.location.href.endsWith('/home.html'), true);
  assert.equal(state.window.dataLayer, undefined);
});
test('live output retains original HTML and JavaScript byte for byte', () => {
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'dist', 'node_modules', 'tools', 'tests'].includes(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(filename);
      else if (/\.(html|js)$/.test(entry.name)) {
        const relative = path.relative(root, filename);
        assert.equal(fs.readFileSync(path.join(root, 'dist/live', relative), 'utf8'), fs.readFileSync(filename, 'utf8'), relative);
      }
    }
  }
  inspect(root);
});
