const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RiderApi } = require('../rider-api.js');

function setup() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let signedOut = 0;
  const auth = { currentUser: { uid: 'riderA', async getIdToken() { return 'test-token'; } }, async signOut() { signedOut++; this.currentUser = null; } };
  let sequence = 0;
  const requests = [];
  let bookingFailure = false;
  let sessionFailure = false;
  const fetchRequest = async (url, options) => {
    requests.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    if (url.endsWith('/bookings')) {
      if (bookingFailure) { bookingFailure = false; throw new Error('Response lost'); }
      return { ok: true, async json() { return { data: { bookingId: 'bookingA', status: 'PENDING', upfrontPrice: 50 } }; } };
    }
    if (sessionFailure) return { ok: false, async json() { return { error: { code: 'invalidSession', message: 'Active session required.' } }; } };
    return { ok: true, async json() { return { data: { uid: 'riderA', appId: 'laynrider', environment: 'prod', active: true } }; } };
  };
  const api = new RiderApi(auth, storage, fetchRequest, { randomUUID: () => `request_${++sequence}` });
  return { api, auth, requests, storage, values, loseBookingResponse: () => { bookingFailure = true; },
    replaceSession: () => { sessionFailure = true; }, signedOut: () => signedOut };
}

const input = () => ({ pickup: { address: 'Pickup', lat: -26.456, lng: 27.77087 },
  dropoff: { address: 'Dropoff', lat: -26.46, lng: 27.78 }, vehicleType: 'PRIVATE_CAR', note: '',
  isReturnTrip: false, returnWaitMinutes: null, requestedDriverId: null });

test('web booking uses the production API and registered Rider session, without a membership request', async () => {
  const s = setup();
  const result = await s.api.createBooking(input());
  assert.equal(result.bookingId, 'bookingA');
  assert.deepEqual(s.requests.map(request => new URL(request.url).pathname), ['/v2/prod/sessions', '/v2/prod/bookings']);
  const booking = s.requests[1];
  assert.equal(booking.headers['X-Layn-App'], 'laynrider');
  assert.equal(booking.headers['X-Device-Session-Id'], s.requests[0].headers['X-Device-Session-Id']);
  assert.equal(booking.body.requestId.length > 0, true);
  for (const field of ['status', 'uid', 'riderId', 'upfrontPrice', 'ratingCount', 'tripsCount']) assert.equal(field in booking.body, false);
});

test('uncertain booking response retains request ID across a retry and a page reload', async () => {
  const s = setup();
  s.loseBookingResponse();
  await assert.rejects(s.api.createBooking(input()), /Response lost/);
  const first = s.requests.find(request => request.url.endsWith('/bookings'));
  s.api.sessionPromise = null;
  await s.api.createBooking(input());
  const attempts = s.requests.filter(request => request.url.endsWith('/bookings'));
  assert.equal(attempts[1].body.requestId, first.body.requestId);
  assert.equal(s.requests.filter(request => request.url.endsWith('/sessions')).length, 1);
  assert.equal(s.requests.filter(request => request.url.endsWith('/session')).length, 1);
});

test('confirmation is retained until the saved booking loads; a completed request permits a fresh ID', async () => {
  const s = setup();
  await s.api.createBooking(input());
  await s.api.createBooking(input());
  const attempts = s.requests.filter(request => request.url.endsWith('/bookings'));
  assert.equal(attempts[0].body.requestId, attempts[1].body.requestId);
  s.api.finishBookingRequest();
  await s.api.createBooking(input());
  assert.notEqual(s.requests.at(-1).body.requestId, attempts[0].body.requestId);
});

test('concurrent actions share one session registration', async () => {
  const s = setup();
  await Promise.all([s.api.request('POST', '/ratings', { tripId: 'tripA', stars: 4, review: '' }),
    s.api.request('POST', '/ratings/ratingA/like', {})]);
  assert.equal(s.requests.filter(request => request.url.endsWith('/sessions')).length, 1);
});

test('a replaced session signs out and does not register a replacement automatically', async () => {
  const s = setup();
  await s.api.ensureSession();
  s.replaceSession();
  await assert.rejects(s.api.request('POST', '/ratings', {}), { code: 'invalidSession' });
  assert.equal(s.signedOut(), 1);
  assert.equal(s.requests.filter(request => request.url.endsWith('/sessions')).length, 1);
  assert.equal(s.storage.getItem(s.api.sessionKey('riderA')), null);
});

test('sign out ends only the current durable API session', async () => {
  const s = setup();
  const session = await s.api.ensureSession();
  await s.api.signOut();
  assert.equal(s.requests.at(-1).method, 'DELETE');
  assert.equal(new URL(s.requests.at(-1).url).pathname, `/v2/prod/sessions/${session.sessionId}`);
  assert.equal(s.storage.getItem(s.api.sessionKey('riderA')), null);
});

test('signed-out or changed accounts cannot send a booking with an old identity', async () => {
  const s = setup();
  s.auth.currentUser = null;
  await assert.rejects(s.api.createBooking(input()), /Sign in/);
  assert.equal(s.requests.length, 0);
});
