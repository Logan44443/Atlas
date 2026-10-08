/** Registers the chunk-caching service worker. Resolves once it controls the page (or gives up). */
export async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || new URLSearchParams(location.search).has('nosw')) return false;
  try {
    await navigator.serviceWorker.register('/sw.js');
    if (navigator.serviceWorker.controller) return true;
    // First visit: wait briefly for clients.claim() so chunk fetches go through it.
    await Promise.race([
      new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    return !!navigator.serviceWorker.controller;
  } catch (err) {
    console.warn('service worker registration failed', err);
    return false;
  }
}
