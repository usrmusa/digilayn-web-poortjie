/**
 * auth-store.js — Global AuthStore (ViewModel) : the single source of truth
 * for login state across the entire web app.
 *
 * Any page includes this file and does:
 *
 *   AuthStore.subscribe(state => renderMyUI(state)); // react to changes
 *   AuthStore.init();                                // start listening once
 *
 * State shape:
 *   {
 *     status: 'loading' | 'authenticated' | 'unauthenticated',
 *     isAuthenticated: boolean,
 *     user: UserModel | null   // camelCase domain user (see user-model.js)
 *   }
 *
 * Behaviour / good practices baked in:
 *   - AccountAccess verifies shared account state before publishing authentication.
 *   - Cached profile data never grants protected access.
 *   - init() is idempotent — safe to call from every page.
 */
(function (global) {
    'use strict';

    const CACHE_KEY = 'authUserCache';

    const store = new global.Store({
        status: 'loading',
        isAuthenticated: false,
        user: null
    });

    let initialized = false;

    function clearCache() {
        try {
            sessionStorage.removeItem(CACHE_KEY);
        } catch (err) {
            /* ignore */
        }
    }

    /** Idempotent: wires the Firebase auth listener exactly once. */
    function init() {
        if (initialized) return store;
        initialized = true;

        AccountAccess.observe(async (authUser) => {
            if (!authUser) {
                clearCache();
                store.setState({ status: 'unauthenticated', isAuthenticated: false, user: null });
                return;
            }

            // Enrich the verified identity before publishing profile and roles.
            let user;
            try {
                const doc = await firebase.firestore().collection('users').doc(authUser.uid).get({ source: 'server' });
                if (!doc.exists) throw new Error(AccountAccessCore.messages['auth/account-unverified']);
                if (doc.data().suspended === true) {
                    await AccountAccess.verify(authUser);
                    return;
                }
                user = global.UserModel.fromFirestore(authUser, doc.data());
                if (AccountAccess.currentUser?.uid !== authUser.uid) return;
                store.setState({ status: 'authenticated', isAuthenticated: true, user });

            } catch (err) {
                store.setState({ status: 'unauthenticated', isAuthenticated: false, user: null });
                console.error('AuthStore: failed to load user profile', err);
            }
        });

        return store;
    }

    /** Ensures the user's Firestore document exists upon Google Sign-In or initial auth */
    async function ensureUserDoc(authUser, allowCreate = false) {
        if (!authUser || !authUser.uid) return null;
        try {
            const userRef = firebase.firestore().collection('users').doc(authUser.uid);
            const doc = await userRef.get({ source: 'server' });
            if (!doc.exists) {
                if (!allowCreate) {
                    const error = new Error(AccountAccessCore.messages['auth/account-unverified']);
                    error.code = 'auth/account-unverified';
                    throw error;
                }
                let baseUsername = (authUser.email ? authUser.email.split('@')[0] : (authUser.displayName || 'user'))
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '');
                if (!baseUsername) baseUsername = 'user' + Math.floor(1000 + Math.random() * 9000);

                let finalUsername = baseUsername;
                try {
                    const usernameDoc = await firebase.firestore().collection('usernames').doc(finalUsername).get();
                    if (usernameDoc.exists) {
                        finalUsername = `${baseUsername}${Math.floor(100 + Math.random() * 900)}`;
                    }
                    await firebase.firestore().collection('usernames').doc(finalUsername).set({
                        userId: authUser.uid,
                        lockedUntil: null
                    }, { merge: true });
                } catch (e) {
                    console.warn('AuthStore: error reserving username', e);
                }

                const newDocData = {
                    userId: authUser.uid,
                    username: finalUsername,
                    displayName: authUser.displayName || finalUsername,
                    email: authUser.email || '',
                    emailVerified: authUser.emailVerified || false,
                    phone: authUser.phoneNumber || '',
                    photoUrl: authUser.photoURL || null,
                    registeredWith: 'com.digilayn.web',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                    devices: {}
                };
                await userRef.set(newDocData, { merge: true });
                return newDocData;
            } else {
                if (doc.data().suspended === true) {
                    const error = new Error(AccountAccessCore.messages['auth/account-suspended']);
                    error.code = 'auth/account-suspended';
                    await firebase.auth().signOut();
                    throw error;
                }
                await userRef.set({
                    lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true }).catch(() => {});
                return doc.data();
            }
        } catch (err) {
            console.warn('AuthStore: failed ensuring user doc', err);
            if (AccountAccessCore.messages[err.code]) throw err;
            const error = new Error(AccountAccessCore.messages['auth/account-unverified']);
            error.code = 'auth/account-unverified';
            throw error;
        }
    }

    /** Sign in with Google (Popup with fallback to redirect). */
    async function signInWithGoogle() {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            return await AccountAccess.signIn(async () => {
                const result = await firebase.auth().signInWithPopup(provider);
                if (result && result.user) await ensureUserDoc(result.user, result.additionalUserInfo?.isNewUser === true);
                return result;
            });
        } catch (err) {
            if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
                return firebase.auth().signInWithRedirect(provider);
            }
            throw err;
        }
    }

    /** Sign in with email/password. Resolves with the Firebase UserCredential. */
    function signIn(email, password) {
        return AccountAccess.signIn(() => firebase.auth().signInWithEmailAndPassword(email, password));
    }

    /** Sign out and clear cached state. */
    async function signOut() {
        clearCache();
        return firebase.auth().signOut();
    }

    const subscribe = (listener, options) => store.subscribe(listener, options);
    const getState = () => store.getState();

    global.AuthStore = { init, subscribe, getState, signIn, signInWithGoogle, signOut, ensureUserDoc };
})(window);
