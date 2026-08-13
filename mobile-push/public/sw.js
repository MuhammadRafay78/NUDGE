self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'Nudge', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Nudge';
  const options = {
    body: data.body || '',
    icon: '/icons/icon.png',
    badge: '/icons/icon.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  /* A card URL is a different origin than this PWA (e.g. trello.com), and a
     service worker cannot navigate an existing window cross-origin — that
     call fails silently, so only reuse a window already sitting on the exact
     same URL. Anything else opens a fresh window/tab, same as tapping a
     regular link. */
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url === url && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
