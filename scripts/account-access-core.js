/** Account access is granted only by server-confirmed shared account state. */
(function (global) {
  'use strict';
  const messages = Object.freeze({
    'auth/account-suspended': 'This account is not active. Please contact support.',
    'auth/account-unverified': "We couldn't verify your account. Please try again."
  });

  function accessError(code) {
    const error = new Error(messages[code]);
    error.code = code;
    return error;
  }

  function checkAccount(snapshot) {
    if (!snapshot.exists || snapshot.fromCache || snapshot.pendingWrites) {
      throw accessError('auth/account-unverified');
    }
    const suspended = snapshot.data.suspended;
    if (suspended === true) throw accessError('auth/account-suspended');
    if (suspended !== undefined && suspended !== false) throw accessError('auth/account-unverified');
  }

  function showError(error) {
    if (!global.document) return;
    try { global.sessionStorage.setItem('accountAccessError', error.message); } catch (_) { /* storage optional */ }
    const render = () => {
      let notice = global.document.getElementById('account-access-error');
      if (!notice) {
        notice = global.document.createElement('div');
        notice.id = 'account-access-error';
        notice.setAttribute('role', 'alert');
        notice.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:16px;background:#991b1b;color:white;text-align:center;';
        global.document.body.prepend(notice);
      }
      notice.textContent = error.message;
    };
    if (global.document.body) render();
    else global.document.addEventListener('DOMContentLoaded', render, { once: true });
  }

  function createAccountAccess(adapter) {
    let verifiedUser = null;
    let ready = false;
    let started = false;
    let pending = 0;
    let revision = 0;
    let stopAccount = null;
    let timeout = null;
    const listeners = new Set();

    function publish(user) {
      if (ready && verifiedUser === user) return;
      verifiedUser = user;
      ready = true;
      if (user && global.document) {
        global.document.getElementById('account-access-error')?.remove();
        try { global.sessionStorage.removeItem('accountAccessError'); } catch (_) { /* storage optional */ }
      }
      for (const listener of listeners) listener(user);
    }
    function stop() {
      revision += 1;
      if (stopAccount) stopAccount();
      stopAccount = null;
      clearTimeout(timeout);
      timeout = null;
    }
    async function reject(user, error) {
      stop();
      showError(error);
      publish(null);
      if (adapter.currentUser()?.uid === user.uid) {
        try { await adapter.signOut(); }
        catch (_) { /* access remains closed even if SDK sign-out fails */ }
      }
    }
    function monitor(user) {
      stop();
      if (!user) { publish(null); return; }
      const expectedRevision = revision;
      let seenServer = false;
      const matches = () => expectedRevision === revision && adapter.currentUser()?.uid === user.uid && pending === 0;
      // Cached events never publish a user. Losing server confirmation closes access.
      timeout = setTimeout(() => {
        if (matches()) void reject(user, accessError('auth/account-unverified'));
      }, 10000);
      stopAccount = adapter.watchAccount(user.uid, (snapshot) => {
        if (!matches()) return;
        if (snapshot.pendingWrites) return;
        if (snapshot.fromCache) {
          if (seenServer && verifiedUser) publish(null);
          if (!timeout) timeout = setTimeout(() => {
            if (matches()) void reject(user, accessError('auth/account-unverified'));
          }, 10000);
          return;
        }
        seenServer = true;
        clearTimeout(timeout);
        timeout = null;
        try {
          checkAccount(snapshot);
          publish(user);
        } catch (error) { void reject(user, error); }
      }, () => {
        if (matches()) void reject(user, accessError('auth/account-unverified'));
      });
    }
    function start() {
      if (started) return;
      started = true;
      adapter.observeAuth((user) => {
        if (pending === 0) monitor(user);
      });
    }
    async function verify(user) {
      try {
        if (!user || adapter.currentUser()?.uid !== user.uid) throw accessError('auth/account-unverified');
        let verificationTimeout;
        try {
          const snapshot = await Promise.race([
            adapter.readAccount(user.uid),
            new Promise((_, rejectRead) => {
              verificationTimeout = setTimeout(() => rejectRead(accessError('auth/account-unverified')), 10000);
            })
          ]);
          checkAccount(snapshot);
        } finally { clearTimeout(verificationTimeout); }
        if (adapter.currentUser()?.uid !== user.uid) throw accessError('auth/account-unverified');
        return user;
      } catch (error) {
        const failure = messages[error.code] ? error : accessError('auth/account-unverified');
        if (user) await reject(user, failure);
        throw failure;
      }
    }
    async function signIn(operation) {
      pending += 1;
      stop();
      publish(null);
      try {
        const credential = await operation();
        if (credential?.user) {
          await verify(credential.user);
          publish(credential.user);
        }
        return credential;
      } catch (error) {
        if (messages[error.code]) {
          const user = adapter.currentUser();
          if (user) await reject(user, error);
          else showError(error);
        }
        throw error;
      } finally {
        pending -= 1;
        if (pending === 0) {
          start();
          monitor(adapter.currentUser());
        }
      }
    }
    return {
      get currentUser() { return verifiedUser; },
      observe(listener) {
        listeners.add(listener);
        if (ready) listener(verifiedUser);
        start();
        return () => listeners.delete(listener);
      },
      verify,
      signIn
    };
  }
  global.AccountAccessCore = { createAccountAccess, messages, showError };
  if (global.document) {
    try {
      const previous = global.sessionStorage.getItem('accountAccessError');
      if (Object.values(messages).includes(previous)) {
        showError(new Error(previous));
        global.sessionStorage.removeItem('accountAccessError');
      }
    } catch (_) { /* storage optional */ }
  }
})(typeof window !== 'undefined' ? window : globalThis);
