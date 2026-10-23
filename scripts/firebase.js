/**
 * firebase.js — Universal Firebase Configuration & Initialization
 * 
 * Single source of truth for Firebase across the entire Poortjie & LaynFleet web app.
 * Exports db (Firestore), auth (Authentication), storage (Cloud Storage),
 * functions (Cloud Functions), and rtdb (Realtime Database).
 */
const firebaseConfig = {
  apiKey: "AIzaSyANCpYHeLyWkgVtWL06xpI7XsP08xu9GPA",
  authDomain: "auth.digilayn.co.za",
  projectId: "digilayn-projects",
  storageBucket: "digilayn-projects.firebasestorage.app",
  messagingSenderId: "95485356681",
  appId: "1:95485356681:web:3cf619a266961009e17458",
  measurementId: "G-27H9WZSCGQ",
  // Realtime Database instance for Europe West (LaynFleet presence)
  databaseURL: "https://digilayn-projects-default-rtdb.europe-west1.firebasedatabase.app"
};

// The build output is the sole service-target decision. Missing config fails closed.
const buildTarget = window.DigilaynBuild;
if (!buildTarget || !['local', 'live'].includes(buildTarget.target) ||
    buildTarget.isLocal !== (buildTarget.target === 'local')) {
  throw new Error('A valid website build target is required.');
}

// Initialize Firebase once globally
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = typeof firebase !== 'undefined' && typeof firebase.firestore === 'function' ? firebase.firestore() : null;
const auth = typeof firebase !== 'undefined' && typeof firebase.auth === 'function' ? firebase.auth() : null;
const storage = typeof firebase !== 'undefined' && typeof firebase.storage === 'function' ? firebase.storage() : null;
const functions = typeof firebase !== 'undefined' && typeof firebase.functions === 'function' ? firebase.app().functions('us-central1') : null;
// RTDB has not been rebuilt locally. Do not instantiate its live SDK in local builds.
const realtimeDatabase = !buildTarget.isLocal && typeof firebase !== 'undefined' && typeof firebase.database === 'function' ? firebase.database() : null;

// Configure every available service before persistence, account listeners, or page code.
if (buildTarget.isLocal) {
  if (auth) auth.useEmulator('http://127.0.0.1:9099');
  if (db) db.useEmulator('127.0.0.1', 8080);
  if (storage) storage.useEmulator('127.0.0.1', 9199);
  if (functions) functions.useEmulator('127.0.0.1', 5001);
}

// Expose globally on window for unified access
if (typeof window !== 'undefined') {
  window.firebaseConfig = firebaseConfig;
  window.LAYNFLEET_FIREBASE_CONFIG = firebaseConfig;
  window.db = db;
  window.auth = auth;
  window.storage = storage;
  window.functions = functions;
  Object.defineProperty(window, 'rtdb', {
    configurable: true,
    get() {
      if (buildTarget.isLocal) throw new Error('Local Realtime Database is not configured.');
      return realtimeDatabase;
    }
  });

  // Cloud Functions dispatch region
  window.FUNCTIONS_REGION = 'us-central1';

  // Firestore layout (camelCase, app-first)
  window.FS = {
    users: 'users',
    laynfleet: 'laynfleet',
    laynfleetDoc: 'main',
    drivers: 'drivers',
    riders: 'riders',
    ratings: 'ratings',
    reviewLikes: 'reviewLikes',
    adminActions: 'adminActions',
    businesses: 'businesses',
    news: 'news',
    products: 'products',
    publicTransport: 'public_transport'
  };

  // Realtime Database presence path & heartbeat window
  window.RTDB_LOCATIONS = 'driverLocations';
  window.HEARTBEAT_FRESHNESS_WINDOW_MS = 60000; // 60s

  // Poortjie service area boundary (locked)
  window.SERVICE_AREA = {
    center: { lat: -26.57537, lng: 27.68133 },
    radiusMeters: 175933 // 175.93 km
  };

  window.APP_PACKAGE = 'com.digilayn.laynrider';
}

// Preserve existing business events; site.js owns the single page-view stream.
const analytics = {
  logEvent(eventName, params) {
    if (typeof window.gtag === 'function') window.gtag('event', eventName, params);
  }
};

// Enable offline persistence with multi-tab support
if (typeof window !== 'undefined' && location.protocol !== 'file:' && db && typeof db.enablePersistence === 'function') {
  db.enablePersistence({ synchronizeTabs: true })
    .catch((err) => {
      if (err.code === 'failed-precondition') {
        console.warn('Firebase persistence warning: multiple tabs open.');
      } else if (err.code === 'unimplemented') {
        console.warn('Firebase persistence warning: browser does not support it.');
      }
    });
}


if (auth && db) window.installAccountAccess();

if (auth && db) {
  let profileRepository;
  Object.defineProperty(window, 'sharedProfileRepository', {
    get() {
      if (!profileRepository) profileRepository = new window.SharedProfileRepository(db, auth, () => firebase.firestore.FieldValue.serverTimestamp());
      return profileRepository;
    }
  });
}
