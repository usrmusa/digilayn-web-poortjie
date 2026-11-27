(function () {
  'use strict';
  const element = id => document.getElementById(`spotlight-${id}`);
  const root = document.getElementById('local-spotlight');
  let candidates = [];
  let current = null;
  let photoIndex = 0;
  let observer;
  const track = (name, extra = {}) => {
    if (typeof window.gtag === 'function') window.gtag('event', name, {
      business_id: current?.id, service_category: current?.category, ...extra
    });
  };
  const text = (id, value) => { element(id).textContent = typeof value === 'string' ? value : ''; };
  const validPhoto = value => {
    try { return typeof value === 'string' && new URL(value).protocol === 'https:'; }
    catch { return false; }
  };
  function whatsappUrl(value) {
    if (typeof value !== 'string' || !/^\+?[\d\s()-]+$/.test(value)) return null;
    let digits = value.replace(/\D/g, '');
    if (/^0\d{9}$/.test(digits)) digits = `27${digits.slice(1)}`;
    return /^[1-9]\d{7,14}$/.test(digits) ? `https://wa.me/${digits}` : null;
  }
  // "View full details" reuses the shared business-card modal — the exact card
  // customers get when they list their business — so the spotlight stays visually
  // consistent with the rest of the site instead of using a bespoke layout.
  function openFullDetails() {
    if (!current || typeof current.id !== 'string' || typeof window.showPromoBusiness !== 'function') return;
    track('spotlight_details_open');
    window.showPromoBusiness(current.id, current.category);
  }
  element('full-details').addEventListener('click', openFullDetails);
  element('whatsapp').addEventListener('click', () => track('spotlight_whatsapp'));
  function loadPhoto(url) {
    return new Promise(resolve => {
      const image = new Image();
      const timeout = setTimeout(() => { image.src = ''; resolve(false); }, 8000);
      image.onload = () => { clearTimeout(timeout); resolve(image.naturalWidth > 0); };
      image.onerror = () => { clearTimeout(timeout); resolve(false); };
      image.src = url;
    });
  }
  async function showNext() {
    element('next').disabled = true;
    element('pictures').disabled = true;
    element('full-details').disabled = true;
    root.setAttribute('aria-busy', 'true');
    const pool = candidates.filter(item => item !== current);
    let chosen;
    while (pool.length) {
      const item = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const photoPool = [...item.photos];
      while (photoPool.length) {
        const photo = photoPool.splice(Math.floor(Math.random() * photoPool.length), 1)[0];
        if (await loadPhoto(photo)) { chosen = { item, photo }; break; }
      }
      if (chosen) break;
      candidates = candidates.filter(candidate => candidate !== item);
    }
    if (chosen) {
      observer?.disconnect();
      current = chosen.item;
      text('category', current.category);
      text('name', current.businessName);
      text('service', current.subHeading);
      text('description', current.description);
      text('address', current.address);
      element('photo').src = chosen.photo;
      element('photo').alt = `Work by ${current.businessName}`;
      element('contact').hidden = !(typeof current.phone === 'string' && /^\+?[\d\s()-]{6,25}$/.test(current.phone));
      if (!element('contact').hidden) {
        element('contact').href = `tel:${current.phone.replace(/[\s()-]/g, '')}`;
        text('contact', `Call ${current.phone}`);
      }
      const whatsapp = whatsappUrl(current.whatsapp);
      element('whatsapp').hidden = !whatsapp;
      if (whatsapp) element('whatsapp').href = whatsapp;
      else element('whatsapp').removeAttribute('href');
      element('category-link').href = `/services/${encodeURIComponent(current.category.toLowerCase())}`;
      element('card').hidden = false;
      element('status').hidden = true;
      element('loader').hidden = true;
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          track('spotlight_view'); observer.disconnect();
        }
      }, { threshold: 0.5 });
      observer.observe(element('photo'));
    } else if (!current) {
      element('loader').hidden = true;
      element('status').hidden = false;
      text('status', 'No business pictures available right now. Explore the services below.');
    }
    element('next').hidden = candidates.length < 2;
    element('next').disabled = false;
    element('pictures').disabled = false;
    element('full-details').disabled = false;
    root.setAttribute('aria-busy', 'false');
  }
  function showGalleryPhoto() {
    const image = element('gallery-photo');
    text('gallery-status', 'Loading picture…');
    image.onload = () => text('gallery-status', '');
    image.onerror = () => text('gallery-status', 'This picture could not load. Try another picture.');
    image.src = current.photos[photoIndex];
    image.alt = `${current.businessName}, picture ${photoIndex + 1}`;
    text('count', `${photoIndex + 1} / ${current.photos.length}`);
    element('previous-photo').disabled = current.photos.length < 2;
    element('next-photo').disabled = current.photos.length < 2;
  }
  element('next').addEventListener('click', () => { track('spotlight_next'); void showNext(); });
  element('pictures').addEventListener('click', () => {
    photoIndex = current.photos.indexOf(element('photo').src);
    if (photoIndex < 0) photoIndex = 0;
    text('gallery-title', current.businessName);
    showGalleryPhoto();
    element('gallery').showModal();
    track('spotlight_gallery_open');
  });
  element('close').addEventListener('click', () => element('gallery').close());
  element('gallery').addEventListener('close', () => track('spotlight_gallery_close'));
  for (const [id, step] of [['previous-photo', -1], ['next-photo', 1]]) {
    element(id).addEventListener('click', () => {
      photoIndex = (photoIndex + step + current.photos.length) % current.photos.length;
      showGalleryPhoto(); track('spotlight_photo_change', { photo_number: photoIndex + 1 });
    });
  }
  element('contact').addEventListener('click', () => track('spotlight_contact'));
  element('category-link').addEventListener('click', () => track('spotlight_category_open'));
  async function start() {
    try {
      const services = window.db.collection('poortjie').doc('services');
      const config = await services.get({ source: 'server' });
      if (!config.exists || !config.data().homeScreen) throw new Error('Missing service categories');
      // Existing category configuration treats an omitted status as enabled;
      // provider status is always required to be explicitly active.
      const categories = Object.entries(config.data().homeScreen)
        .filter(([, value]) => value && (value.status === undefined || value.status === 'active')).map(([key]) => key);
      const snapshots = await Promise.all(categories.map(async category => ({
        category, snapshot: await services.collection(category).where('status', '==', 'active').get({ source: 'server' })
      })));
      candidates = snapshots.flatMap(({ category, snapshot }) => snapshot.docs.map(doc => {
        const data = doc.data();
        return { ...data, id: doc.id, category, photos: Array.isArray(data.photos) ? data.photos.filter(validPhoto) : [] };
      })).filter(item => typeof item.businessName === 'string' && item.businessName.trim() && item.photos.length);
      await showNext();
    } catch (error) {
      console.error('Could not load business spotlight', error);
      element('loader').hidden = true;
      element('status').hidden = false;
      text('status', 'Business pictures could not load. Explore the services below or refresh to try again.');
      root.setAttribute('aria-busy', 'false');
      track('spotlight_load_error');
    }
  }
  void start();
})();
