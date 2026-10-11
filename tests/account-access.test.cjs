const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sourcePath = path.join(__dirname, '../scripts/account-access-core.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const context = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
  let current = null, authListener;
  let signOuts = 0;
  let account = { exists: true, data: { suspended: false }, fromCache: false, pendingWrites: false };
  let readError;
  const watches = [];
  const adapter = {
    currentUser: () => current,
    observeAuth: listener => { authListener = listener; listener(current); },
    signOut: async () => { signOuts++; current = null; authListener?.(null); },
    readAccount: async () => { if (readError) throw readError; return account; },
    watchAccount: (uid, next, fail) => { const watch = { next, fail, stopped: false }; watches.push(watch); return () => { watch.stopped = true; }; }
  };
  const gate = context.AccountAccessCore.createAccountAccess(adapter);
  const events = [];
  gate.observe(user => events.push(user));
  return {
    gate, events, watches,
    get signOuts() { return signOuts; },
    set account(value) { account = value; },
    set readError(value) { readError = value; },
    setAuth(user) { current = user; authListener(user); },
    credential(user) { current = user; authListener(user); return { user }; },
    emit(data, extra = {}) { watches.at(-1).next({ exists: true, data, fromCache: false, pendingWrites: false, ...extra }); },
    close() { current = null; authListener(null); }
  };
}

test('both sites ship identical gate logic', () => {
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), fs.readFileSync(path.join(__dirname, '../../web-main/scripts/account-access-core.js'), 'utf8'));
});
test('suspended sign-in never publishes protected user', async () => {
  const f = fixture();
  f.account = { exists: true, data: { suspended: true }, fromCache: false, pendingWrites: false };
  await assert.rejects(f.gate.signIn(async () => f.credential({ uid: 'suspended' })), { code: 'auth/account-suspended' });
  assert.equal(f.gate.currentUser, null);
  assert.equal(f.events.some(Boolean), false);
  assert.equal(f.signOuts, 1);
  f.close();
});
test('active sign-in waits for server read, then publishes user', async () => {
  const f = fixture(), user = { uid: 'active' };
  const result = await f.gate.signIn(async () => f.credential(user));
  assert.equal(result.user, user);
  assert.equal(f.gate.currentUser, user);
  assert.equal(f.signOuts, 0);
  f.close();
});
test('restored user is withheld until authoritative snapshot', async () => {
  const f = fixture(), user = { uid: 'restored' };
  f.setAuth(user);
  f.emit({ suspended: false }, { fromCache: true });
  assert.equal(f.gate.currentUser, null);
  f.emit({ suspended: false });
  assert.equal(f.gate.currentUser, user);
  f.close();
});
test('live suspension removes access and signs out', async () => {
  const f = fixture(); f.setAuth({ uid: 'live' }); f.emit({ suspended: false });
  f.emit({ suspended: true }); await tick();
  assert.equal(f.gate.currentUser, null);
  assert.equal(f.signOuts, 1);
  assert.ok(f.watches[0].stopped);
  f.close();
});
test('missing account and invalid suspension value fail closed', async () => {
  for (const account of [
    { exists: false, data: {}, fromCache: false, pendingWrites: false },
    { exists: true, data: { suspended: 'false' }, fromCache: false, pendingWrites: false }
  ]) {
    const f = fixture(); f.account = account;
    await assert.rejects(f.gate.signIn(async () => f.credential({ uid: 'invalid' })), { code: 'auth/account-unverified' });
    assert.equal(f.events.some(Boolean), false); f.close();
  }
});
test('failed server read never authorizes', async () => {
  const f = fixture(); f.readError = new Error('permission denied');
  await assert.rejects(f.gate.signIn(async () => f.credential({ uid: 'denied' })), { code: 'auth/account-unverified' });
  assert.equal(f.gate.currentUser, null); f.close();
});
test('previous account callbacks cannot grant access after switch', () => {
  const f = fixture(); f.setAuth({ uid: 'first' }); const old = f.watches.at(-1);
  f.setAuth({ uid: 'second' });
  old.next({ exists: true, data: { suspended: false }, fromCache: false, pendingWrites: false });
  assert.equal(f.gate.currentUser, null);
  f.emit({ suspended: false }); assert.equal(f.gate.currentUser.uid, 'second'); f.close();
});
test('new account provisioning runs before gate verification and observers', async () => {
  const f = fixture(); let release;
  const provisioning = new Promise(resolve => { release = resolve; });
  const promise = f.gate.signIn(async () => { const credential = f.credential({ uid: 'new' }); await provisioning; return credential; });
  await tick(); assert.equal(f.events.some(Boolean), false); assert.equal(f.watches.length, 0);
  release(); await promise; assert.equal(f.gate.currentUser.uid, 'new'); f.close();
});
test('local pending profile writes do not authorize or revoke account', () => {
  const f = fixture(); f.setAuth({ uid: 'profile' });
  f.emit({ suspended: false }, { pendingWrites: true }); assert.equal(f.gate.currentUser, null);
  f.emit({ suspended: false });
  f.emit({ suspended: false }, { pendingWrites: true }); assert.equal(f.gate.currentUser.uid, 'profile'); f.close();
});
test('loss of server confirmation closes access and fresh server snapshot restores it', () => {
  const f = fixture(); f.setAuth({ uid: 'network' }); f.emit({ suspended: false });
  f.emit({ suspended: false }, { fromCache: true }); assert.equal(f.gate.currentUser, null);
  f.emit({ suspended: false }); assert.equal(f.gate.currentUser.uid, 'network'); f.close();
});
test('failed account listener removes access', async () => {
  const f = fixture(); f.setAuth({ uid: 'failed' }); f.emit({ suspended: false });
  f.watches.at(-1).fail(new Error('permission denied')); await tick();
  assert.equal(f.gate.currentUser, null); assert.equal(f.signOuts, 1); f.close();
});
