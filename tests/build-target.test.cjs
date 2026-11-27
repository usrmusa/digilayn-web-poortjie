const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function load(target, hostname = 'localhost', failingService = null) {
  const events = [];
  const window = { location: { hostname, protocol: 'http:' }, installAccountAccess: () => events.push(['account-gate']) };
  const service = name => ({
    useEmulator(...args) {
      events.push([name, ...args]);
      if (name === failingService) throw new Error('Emulator setup failed');
    },
    enablePersistence() { events.push(['persistence']); return Promise.resolve(); }
  });
  const firebase = {
    apps: [], initializeApp: () => events.push(['initialize']),
    auth: () => service('auth'), firestore: () => service('firestore'), storage: () => service('storage'),
    functions() {}, app: () => ({ functions: () => service('functions') }),
    database: () => { events.push(['rtdb-initialize']); return { live: true }; }
  };
  const context = vm.createContext({ window, firebase, location: window.location, console });
  if (target) vm.runInContext(fs.readFileSync(path.join(root, 'dist', target, 'scripts/build-target.js'), 'utf8'), context);
  return { events, window, context, run: () => vm.runInContext(fs.readFileSync(path.join(root, 'scripts/firebase.js'), 'utf8'), context) };
}

test('local build connects directly to online services without emulators', () => {
  const state = load('local', 'poortjie.info');
  state.run();
  assert.equal(state.events.some(event => ['auth', 'firestore', 'storage', 'functions'].includes(event[0])), false);
  assert.equal(state.events.at(-1)[0], 'account-gate');
  assert.equal(state.events.some(event => event[0] === 'rtdb-initialize'), true);
  assert.equal(state.window.rtdb.live, true);
});

test('live build remains live on localhost because the build decides', () => {
  const state = load('live');
  state.run();
  assert.equal(state.events.some(event => ['auth', 'firestore', 'storage', 'functions'].includes(event[0])), false);
  assert.equal(state.window.rtdb.live, true);
});

test('missing build target fails before Firebase initializes', () => {
  const state = load(null);
  assert.throws(state.run, /valid website build target/);
  assert.equal(state.events.length, 0);
});

test('local legacy Rider API reports unavailable without fetching or acquiring a token', async () => {
  const state = load('local');
  vm.runInContext(fs.readFileSync(path.join(root, 'laynfleet/laynrider/rider-api.js'), 'utf8'), state.context);
  let fetches = 0;
  let tokens = 0;
  const api = new state.window.RiderApi({ currentUser: { uid: 'user', getIdToken: () => { tokens++; } } }, {}, () => { fetches++; }, {});
  await assert.rejects(api.send('POST', '/sessions', {}, { uid: 'user' }), /Local ride API is not configured/);
  assert.equal(fetches, 0);
  assert.equal(tokens, 0);
});

test('every Firebase page loads build config first with matching defer semantics', () => {
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(fullPath);
      else if (entry.name.endsWith('.html')) {
        const source = fs.readFileSync(fullPath, 'utf8');
        const scripts = [...source.matchAll(/<script src="([^"]+)"([^>]*)>/g)];
        const firebaseIndex = scripts.findIndex(match => match[1].endsWith('scripts/firebase.js'));
        if (firebaseIndex < 0) continue;
        assert.equal(scripts[firebaseIndex - 1][1].endsWith('scripts/build-target.js'), true, fullPath);
        assert.equal(scripts[firebaseIndex - 1][2], scripts[firebaseIndex][2], fullPath);
      }
    }
  }
  inspect(root);
});
