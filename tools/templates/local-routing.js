/** Included only in generated local builds. Resolve real files under the served site prefix. */
(function (global) {
  'use strict';
  const root = new URL('../', document.currentScript.src);
  const files = new Set(__LOCAL_FILES__);
  const pages = __LOCAL_PAGES__;
  function resolve(value) {
    if (typeof value !== 'string' || !value || value.startsWith('#')) return value;
    const target = new URL(value, global.location.href);
    if (target.origin !== root.origin || !/^https?:$/.test(target.protocol)) return value;
    let pathname = decodeURIComponent(target.pathname);
    const prefix = decodeURIComponent(root.pathname);
    if (pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length);
    else if (value.startsWith('/')) pathname = pathname.slice(1);
    else return value;
    const file = Object.hasOwn(pages, pathname) ? pages[pathname] : pathname;
    if (!files.has(file)) return value;
    target.pathname = root.pathname + file;
    return target.href;
  }
  global.PoortjieLocalRouting = Object.freeze({ resolve });
  function updateLinks() {
    document.querySelectorAll('a[href]').forEach(link => {
      link.setAttribute('href', resolve(link.getAttribute('href')));
    });
  }
  document.addEventListener('DOMContentLoaded', updateLinks);
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (link) link.setAttribute('href', resolve(link.getAttribute('href')));
  }, true);
})(window);
