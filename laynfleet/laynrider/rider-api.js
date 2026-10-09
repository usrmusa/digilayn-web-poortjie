(function (global) {
  'use strict';

  class RiderApi {
    constructor(auth, storage = global.localStorage, fetchRequest = global.fetch.bind(global), cryptoApi = global.crypto) {
      this.auth = auth;
      this.storage = storage;
      this.fetchRequest = fetchRequest;
      this.cryptoApi = cryptoApi;
      this.sessionPromise = null;
      this.sessionUid = null;
    }

    sessionKey(uid) { return `laynrider-v2-session:${uid}`; }

    async send(method, path, body, session) {
      const user = this.auth.currentUser;
      if (!user || user.uid !== session.uid) throw new Error('Sign in to continue.');
      const token = await user.getIdToken();
      if (this.auth.currentUser?.uid !== session.uid) throw new Error('Your signed-in account changed.');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await this.fetchRequest(`https://api.digilayn.co.za/v2/prod${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Layn-App': 'laynrider',
            'X-Device-Id': session.deviceId,
            'X-Device-Session-Id': session.sessionId,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) {
          const error = new Error(result.error?.message || 'The request could not be completed.');
          error.code = result.error?.code;
          if (['invalidSession', 'sessionReplaced', 'sessionEnded'].includes(error.code)) {
            this.storage.removeItem(this.sessionKey(session.uid));
            this.sessionPromise = null;
            if (this.auth.currentUser?.uid === session.uid) await this.auth.signOut();
          }
          throw error;
        }
        if (!result.data || typeof result.data !== 'object') throw new Error('The service returned an invalid response.');
        if (this.auth.currentUser?.uid !== session.uid) throw new Error('Your signed-in account changed.');
        return result.data;
      } finally {
        clearTimeout(timeout);
      }
    }

    async ensureSession() {
      const uid = this.auth.currentUser?.uid;
      if (!uid) throw new Error('Sign in to continue.');
      if (this.sessionPromise && this.sessionUid === uid) return this.sessionPromise;
      this.sessionUid = uid;
      this.sessionPromise = (async () => {
        let deviceId = this.storage.getItem('laynrider-v2-device');
        if (!deviceId) {
          deviceId = this.cryptoApi.randomUUID();
          this.storage.setItem('laynrider-v2-device', deviceId);
        }
        const saved = this.storage.getItem(this.sessionKey(uid));
        const session = saved ? JSON.parse(saved) : { uid, deviceId, sessionId: this.cryptoApi.randomUUID(), registered: false };
        if (session.uid !== uid || session.deviceId !== deviceId || !/^[A-Za-z0-9_-]{1,128}$/.test(session.sessionId)) {
          throw new Error('Your saved ride session is invalid. Sign out and sign in again.');
        }
        // Save before registration so an uncertain response retries the same session ID.
        this.storage.setItem(this.sessionKey(uid), JSON.stringify(session));
        const data = await this.send(session.registered ? 'GET' : 'POST', session.registered ? '/session' : '/sessions',
          session.registered ? undefined : {}, session);
        if (data.uid !== uid || data.appId !== 'laynrider' || data.environment !== 'prod') {
          throw new Error('The service returned a mismatched ride session.');
        }
        session.registered = true;
        this.storage.setItem(this.sessionKey(uid), JSON.stringify(session));
        return session;
      })();
      try { return await this.sessionPromise; }
      catch (error) { this.sessionPromise = null; throw error; }
    }

    async request(method, path, body) {
      const session = await this.ensureSession();
      return this.send(method, path, body, session);
    }

    async createBooking(input) {
      const uid = this.auth.currentUser?.uid;
      if (!uid) throw new Error('Sign in to continue.');
      const key = `laynrider-v2-booking:${uid}`;
      const fingerprint = JSON.stringify(input);
      const saved = this.storage.getItem(key);
      const previous = saved ? JSON.parse(saved) : null;
      const requestId = previous?.fingerprint === fingerprint ? previous.requestId : this.cryptoApi.randomUUID();
      this.storage.setItem(key, JSON.stringify({ fingerprint, requestId }));
      const result = await this.request('POST', '/bookings', { ...input, requestId });
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.bookingId) || !['PENDING', 'CANCELLED_NO_DRIVER'].includes(result.status) ||
          !Number.isSafeInteger(result.upfrontPrice) || result.upfrontPrice <= 0) {
        throw new Error('The service returned an invalid booking confirmation.');
      }
      return result;
    }

    finishBookingRequest() {
      const uid = this.auth.currentUser?.uid;
      if (uid) this.storage.removeItem(`laynrider-v2-booking:${uid}`);
    }

    async signOut() {
      const uid = this.auth.currentUser?.uid;
      if (!uid) return;
      const saved = this.storage.getItem(this.sessionKey(uid));
      if (saved) {
        const session = JSON.parse(saved);
        await this.send('DELETE', `/sessions/${session.sessionId}`, undefined, session);
      }
      this.storage.removeItem(this.sessionKey(uid));
      this.storage.removeItem(`laynrider-v2-booking:${uid}`);
      this.sessionPromise = null;
    }
  }

  global.RiderApi = RiderApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = { RiderApi };
})(typeof window !== 'undefined' ? window : globalThis);
