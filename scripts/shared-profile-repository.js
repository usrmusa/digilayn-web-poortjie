/** Shared users/{uid} identity and atomic global username ownership. */
(function (global) {
  'use strict';
  class SharedProfileRepository {
    constructor(db, auth, serverTimestamp) {
      this.db = db;
      this.auth = auth;
      this.serverTimestamp = serverTimestamp;
    }
    checkIdentity(uid) {
      if (!uid || this.auth.currentUser?.uid !== uid) throw new Error('Signed-in account changed.');
    }
    static normalizeName(value) {
      const words = value.trim().split(/\s+/u).filter(Boolean);
      if (words.length < 1 || words.length > 3 || value.length > 64) throw new Error('Full name must contain 1–3 words, up to 64 characters.');
      return words.map(word => { const lower = word.toLowerCase(); return lower.charAt(0).toUpperCase() + lower.slice(1); }).join(' ');
    }
    static usernameValid(value) { return typeof value === 'string' && (value === '' || /^[a-z0-9]{3,30}$/.test(value)); }
    static optionalString(data, field) {
      if (!Object.hasOwn(data, field)) return '';
      if (typeof data[field] !== 'string') throw new Error(`Invalid stored profile field: ${field}`);
      return data[field];
    }
    async ensureIdentity(user) {
      this.checkIdentity(user.uid);
      const ref = this.db.collection('users').doc(user.uid);
      return this.db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        this.checkIdentity(user.uid);
        const data = snapshot.exists ? snapshot.data() : {};
        const fields = {};
        for (const [field, input] of [['email', user.email], ['displayName', user.displayName], ['photoUrl', user.photoURL]]) {
          const saved = SharedProfileRepository.optionalString(data, field);
          if (!saved && typeof input === 'string' && input) fields[field] = input;
        }
        if (!Object.hasOwn(data, 'createdAt')) fields.createdAt = this.serverTimestamp();
        if (Object.keys(fields).length) tx.set(ref, fields, { merge: true });
        return { ...data, ...fields };
      });
    }
    async save(uid, fields, create = false) {
      this.checkIdentity(uid);
      const sharedFields = ['displayName', 'phone', 'bio', 'photoUrl', 'username'];
      for (const field of sharedFields) {
        if (Object.hasOwn(fields, field) && typeof fields[field] !== 'string') throw new Error(`Invalid profile field: ${field}`);
      }
      fields = { ...fields };
      if (Object.hasOwn(fields, 'displayName')) fields.displayName = SharedProfileRepository.normalizeName(fields.displayName);
      if (Object.hasOwn(fields, 'phone') && !/^\p{Nd}{10}$/u.test(fields.phone)) throw new Error('Phone number must contain exactly 10 digits.');
      if (Object.hasOwn(fields, 'username') && !SharedProfileRepository.usernameValid(fields.username)) throw new Error('Username must contain 3–30 lowercase letters or digits.');
      if (Object.hasOwn(fields, 'bio') && fields.bio.length > 128) throw new Error('Bio must be at most 128 characters.');
      const ref = this.db.collection('users').doc(uid);
      return this.db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists && !create) throw new Error('Shared account is missing.');
        const data = snapshot.exists ? snapshot.data() : {};
        const previous = SharedProfileRepository.optionalString(data, 'username');
        if (!SharedProfileRepository.usernameValid(previous)) throw new Error('Stored username is invalid.');
        const next = Object.hasOwn(fields, 'username') ? fields.username : previous;
        if (Object.hasOwn(data, 'publicProfileConsent') && typeof data.publicProfileConsent !== 'boolean') throw new Error('Invalid stored profile consent.');
        if (next === '' && data.publicProfileConsent === true) throw new Error('A username is required while public profile consent is enabled.');
        const names = this.db.collection('usernames');
        const oldRef = previous ? names.doc(previous) : null;
        const old = oldRef ? await tx.get(oldRef) : null;
        const oldOwnerId = old && old.exists ? (old.data().ownerId ?? null) : null;
        const nextRef = next && next !== previous ? names.doc(next) : null;
        if (nextRef) {
          const nextSnapshot = await tx.get(nextRef);
          if (nextSnapshot.exists) {
            const ownerId = nextSnapshot.data().ownerId ?? null;
            if (ownerId !== null && ownerId !== uid) {
              const error = new Error('This username is already taken.');
              error.code = 'auth/username-taken';
              throw error;
            }
          }
        }
        this.checkIdentity(uid);
        if (previous !== next) {
          if (oldRef && oldOwnerId === uid) {
            tx.set(oldRef, { ownerId: null, ownedAt: null });
          }
          if (nextRef) {
            tx.set(nextRef, { ownerId: uid, ownedAt: this.serverTimestamp() });
            const period = nextRef.collection('history').doc(uid).collection('periods').doc();
            tx.set(period, { ownedAt: this.serverTimestamp(), endedAt: null });
          }
        }
        const update = { ...fields };
        if (!snapshot.exists) update.createdAt = this.serverTimestamp();
        tx.set(ref, update, { merge: true });
        return { ...data, ...update };
      });
    }
  }
  global.SharedProfileRepository = SharedProfileRepository;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SharedProfileRepository };
})(typeof window !== 'undefined' ? window : globalThis);
