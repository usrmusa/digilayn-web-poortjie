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
                return window.sharedProfileRepository.ensureIdentity(authUser);
            } else {
                if (doc.data().suspended === true) {
                    const error = new Error(AccountAccessCore.messages['auth/account-suspended']);
                    error.code = 'auth/account-suspended';
                    await firebase.auth().signOut();
                    throw error;
                }
                return window.sharedProfileRepository.ensureIdentity(authUser);
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
