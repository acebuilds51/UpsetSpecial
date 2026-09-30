// ============================================================
// Upset Special League — Push Notification Service Worker
// Uses raw Web Push (not Firebase compat) to avoid duplicate notifications
// ============================================================

// SW v2 (2026-09-30). A new version of this file takes over at once instead of waiting until
// every window of the app is closed -- a home-screen app parked in the background never
// closes, so phones kept running the old click handler (tap = just open the app).
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(self.clients.claim()); });

// Where a tapped notification wants to go, kept for a minute so an app that was paused in
// the background (iPhone) can pick it up when it comes back even if the message is lost.
var PENDING_VIEW_CACHE = 'usl-pending-view';
function rememberView(url) {
  return caches.open(PENDING_VIEW_CACHE).then(function(cache) {
    return cache.put('/UpsetSpecial/__pending_view', new Response(JSON.stringify({ url: url, at: Date.now() })));
  }).catch(function() {});
}

// Handle push events directly — no Firebase SDK needed here
self.addEventListener('push', function(event) {
  if (!event.data) return;

  var payload;
  try {
    payload = event.data.json();
  } catch(e) {
    payload = { notification: { title: 'Upset Special', body: event.data.text() } };
  }

  // FCM V1 API sends data in different formats — handle both
  var notification = payload.notification || {};
  var data = payload.data || {};
  var title = notification.title || data.title || 'Upset Special 🏈';
  var body  = notification.body  || data.body  || '';
  // A notification only replaces an earlier one with the SAME tag. The backend gives each
  // kind its own (chat pushes share 'chat'); a push without one gets a unique tag, so a
  // commissioner post or pick reminder is never wiped by the next message.
  var tag   = data.tag || notification.tag || ('upset-special-' + Date.now());
  var url   = data.url || 'https://acebuilds51.github.io/UpsetSpecial/';

  // Check if app is open and focused — skip system notification if so
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      var appOpen = clients.some(function(c) {
        return c.url.includes('UpsetSpecial') && c.visibilityState === 'visible';
      });

      if (appOpen) {
        // post message to app instead so it can show a toast
        clients.forEach(function(c) {
          if (c.url.includes('UpsetSpecial')) {
            c.postMessage({ type: 'FCM_FOREGROUND', title: title, body: body, tag: tag, url: url });
          }
        });
        return;
      }

      // close any existing notification with same tag to prevent duplicates
      return self.registration.getNotifications({ tag: tag }).then(function(existing) {
        existing.forEach(function(n) { n.close(); });
        return self.registration.showNotification(title, {
          body: body,
          icon: '/UpsetSpecial/icon-192.png',
          badge: '/UpsetSpecial/icon-192.png',
          tag: tag,
          renotify: false,
          data: { url: url },
          vibrate: [200, 100, 200]
        });
      });
    })
  );
});

// Handle notification click: open the app on the notification's tab (url carries ?view=...).
// An app already open is focused and told which tab to show (no reload, so nothing typed
// is lost); otherwise a new window opens at the url.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://acebuilds51.github.io/UpsetSpecial/';
  event.waitUntil(rememberView(url).then(function() {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  }).then(function(clients) {
    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      if (c.url.includes('UpsetSpecial') && 'focus' in c) {
        c.postMessage({ type: 'OPEN_VIEW', url: url }); // before focus: some phones only deliver it on resume
        return c.focus().then(function(focused) {
          if (focused && focused !== c) focused.postMessage({ type: 'OPEN_VIEW', url: url });
        }).catch(function() {
          // not allowed to focus that window: open the app at the url instead
          if (self.clients.openWindow) return self.clients.openWindow(url);
        });
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
