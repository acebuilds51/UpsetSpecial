// ============================================================
// Upset Special League — Push Notification Service Worker
// Uses raw Web Push (not Firebase compat) to avoid duplicate notifications
// ============================================================

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
  var tag   = data.tag || notification.tag || 'upset-special';
  var url   = data.url || 'https://acebuilds51.github.io/UpsetSpecial';

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
            c.postMessage({ type: 'FCM_FOREGROUND', title: title, body: body });
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

// Handle notification click
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://acebuilds51.github.io/UpsetSpecial';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url.includes('UpsetSpecial') && 'focus' in clients[i]) {
          return clients[i].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
