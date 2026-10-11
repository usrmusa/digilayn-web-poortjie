/** Classic Firebase adapter; call after the existing Firebase initialization. */
(function (global) {
  'use strict';
  global.installAccountAccess = function () {
    if (global.AccountAccess) return global.AccountAccess;
    const auth = global.firebase.auth();
    const db = global.firebase.firestore();
    const normalize = (doc) => ({ exists: doc.exists, data: doc.data() || {}, fromCache: doc.metadata.isFromCache, pendingWrites: doc.metadata.hasPendingWrites });
    global.AccountAccess = global.AccountAccessCore.createAccountAccess({
      currentUser: () => auth.currentUser,
      observeAuth: (listener) => auth.onAuthStateChanged(listener),
      signOut: () => auth.signOut(),
      readAccount: async (uid) => normalize(await db.collection('users').doc(uid).get({ source: 'server' })),
      watchAccount: (uid, next, fail) => db.collection('users').doc(uid).onSnapshot({ includeMetadataChanges: true }, (doc) => next(normalize(doc)), fail)
    });
    return global.AccountAccess;
  };
})(window);
