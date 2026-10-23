const test = require('node:test');
const assert = require('node:assert/strict');
const { SharedProfileRepository } = require('../scripts/shared-profile-repository.js');
class Timestamp { constructor(time) { this.time = time; } toMillis() { return this.time; } }
const clone = value => {
  if (value instanceof Timestamp) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
};
function fixture() {
  const records = new Map([['users/A', { email: 'a@example.test' }], ['users/B', { email: 'b@example.test' }]]);
  let sequence = 0;
  let time = 0;
  let queue = Promise.resolve();
  const ref = pathname => ({ path: pathname, id: pathname.split('/').at(-1), collection: key => collection(`${pathname}/${key}`) });
  const collection = pathname => ({ doc: id => ref(`${pathname}/${id === undefined ? 'claim' + ++sequence : id}`) });
  const db = { collection, runTransaction(operation) {
    const run = queue.then(async () => {
      const writes = [];
      const tx = {
        get: async reference => {
          assert.equal(writes.length, 0, 'all transaction reads must precede writes');
          const data = clone(records.get(reference.path));
          return { exists: data !== undefined, data: () => data };
        },
        set: (reference, data, options) => writes.push({ path: reference.path, data: clone(data), merge: options?.merge }),
        update: (reference, data) => writes.push({ path: reference.path, data: clone(data), merge: true })
      };
      const result = await operation(tx);
      const timestamp = new Timestamp(++time);
      const resolve = value => {
        if (value?.serverTimestamp === true) return timestamp;
        if (value && typeof value === 'object' && !(value instanceof Timestamp)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
        return value;
      };
      for (const write of writes) records.set(write.path, { ...(write.merge ? records.get(write.path) : {}), ...resolve(write.data) });
      return result;
    });
    queue = run.catch(() => {});
    return run;
  } };
  const auth = { currentUser: { uid: 'A' } };
  const repository = uid => new SharedProfileRepository(db, { currentUser: { uid } }, () => ({ serverTimestamp: true }));
  return { records, auth, db, repository, a: repository('A'), b: repository('B') };
}
test('claim atomically links the profile, reservation and start of history', async () => {
  const s = fixture();
  await s.a.save('A', { username: 'alpha' });
  assert.equal(s.records.get('users/A').username, 'alpha');
  const claim = s.records.get('usernames/alpha');
  assert.equal(claim.userId, 'A');
  const history = s.records.get(`usernames/alpha/history/${claim.claimId}`);
  assert.equal(history.userId, 'A');
  assert.equal(history.endedAt, null);
  assert.equal(typeof history.startedAt.toMillis(), 'number');
});
test('two claimants cannot acquire the same username', async () => {
  const s = fixture();
  const results = await Promise.allSettled([s.a.save('A', { username: 'shared' }), s.b.save('B', { username: 'shared' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'auth/username-taken');
  assert.equal(s.records.get('users/B').username, undefined);
});
test('rename releases the old name immediately and retains closed ownership history', async () => {
  const s = fixture();
  await s.a.save('A', { username: 'alpha' });
  const oldId = s.records.get('usernames/alpha').claimId;
  await s.a.save('A', { username: 'beta' });
  assert.deepEqual(s.records.get('usernames/alpha'), { userId: null, claimId: null });
  assert.ok(s.records.get(`usernames/alpha/history/${oldId}`).endedAt instanceof Timestamp);
  await s.b.save('B', { username: 'alpha' });
  assert.equal(s.records.get('usernames/alpha').userId, 'B');
  assert.equal(s.records.get(`usernames/alpha/history/${oldId}`).userId, 'A');
  assert.notEqual(s.records.get('usernames/alpha').claimId, oldId);
});
test('clearing releases the username without deleting history; repeats create no extra claim', async () => {
  const s = fixture();
  await s.a.save('A', { username: 'alpha' });
  await s.a.save('A', { username: 'alpha' });
  assert.equal([...s.records.keys()].filter(key => key.includes('/history/')).length, 1);
  await s.a.save('A', { username: '' });
  assert.equal(s.records.get('users/A').username, '');
  assert.equal(s.records.get('usernames/alpha').userId, null);
  assert.equal([...s.records.keys()].filter(key => key.includes('/history/')).length, 1);
});
test('a taken rename preserves the old claim and profile', async () => {
  const s = fixture();
  await s.a.save('A', { username: 'alpha' });
  await s.b.save('B', { username: 'beta' });
  await assert.rejects(s.a.save('A', { username: 'beta' }), error => error.code === 'auth/username-taken');
  assert.equal(s.records.get('users/A').username, 'alpha');
  assert.equal(s.records.get('usernames/alpha').userId, 'A');
});
test('legacy or missing reservation history fails without synthesizing ownership', async () => {
  const s = fixture();
  s.records.set('users/A', { username: 'legacy' });
  s.records.set('usernames/legacy', { userId: 'A', lockedUntil: null });
  await assert.rejects(s.a.save('A', { username: 'beta' }), /history mismatch/);
  assert.equal(s.records.has('usernames/beta'), false);
});
test('wrong identity, invalid username, overlong bio and invalid phone cannot be saved', async () => {
  const s = fixture();
  for (const username of ['aa', 'UPPER', 'has space', 'x'.repeat(31)]) await assert.rejects(s.a.save('A', { username }));
  await assert.rejects(s.a.save('B', { username: 'alpha' }), /account changed/);
  await assert.rejects(s.a.save('A', { bio: 'x'.repeat(129) }));
  await assert.rejects(s.a.save('A', { phone: '123' }));
  assert.equal(s.records.size, 2);
});
test('profile output matches app normalization, preserves bio text and unrelated fields', async () => {
  const s = fixture();
  s.records.set('users/A', { email: 'a@example.test', ratingCount: 7 });
  await s.a.save('A', { displayName: '  mUSA   mGIJIMA ', phone: '0123456789', bio: '  hello  ' });
  assert.deepEqual(s.records.get('users/A'), { email: 'a@example.test', ratingCount: 7, displayName: 'Musa Mgijima', phone: '0123456789', bio: '  hello  ' });
});
test('Google creation seeds real identity only and never invents a username', async () => {
  const s = fixture();
  const user = { uid: 'A', email: 'a@example.test', displayName: 'Google Name', photoURL: 'https://example.test/avatar' };
  await s.a.ensureIdentity(user);
  assert.equal(s.records.get('users/A').displayName, 'Google Name');
  assert.equal(s.records.get('users/A').username, undefined);
  assert.equal([...s.records.keys()].some(key => key.startsWith('usernames/')), false);
});
test('public profile consent keeps the app requirement for a username', async () => {
  const s = fixture();
  await s.a.save('A', { username: 'alpha' });
  s.records.get('users/A').publicProfileConsent = true;
  await assert.rejects(s.a.save('A', { username: '' }), /consent/);
  assert.equal(s.records.get('usernames/alpha').userId, 'A');
});
