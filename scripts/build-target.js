/** Generated local/live builds select services independently of fleet data. */
(function (global) {
  'use strict';
  const target = 'live';
  global.DigilaynBuild = Object.freeze({ target, isLocal: target === 'local' });
})(typeof window !== 'undefined' ? window : globalThis);
