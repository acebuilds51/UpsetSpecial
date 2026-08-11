// ============================================================
// Upset Special League — Firebase Cloud Messaging Service Worker
// Deploy this file to: acebuilds51.github.io/UpsetSpecial/firebase-messaging-sw.js
// ============================================================

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDYt3OeHN0yorpDAWu4MPvH55GnkO_yD44",
  authDomain: "ladle-and-spoon-push-notify.firebaseapp.com",
  projectId: "ladle-and-spoon-push-notify",
  storageBucket: "ladle-and-spoon-push-notify.firebasestorage.app",
  messagingSenderId: "432229384791",
  appId: "1:432229384791:web:2cb34b4d3a1c5878a95912"
});

const messaging = firebase.messaging();

// Handle background messages (when app is closed or not in focus)
messaging.onBackgroundMessage(function(payload) {
  const { title, body, icon } = payload.notification || {};
  const data = payload.data || {};

  self.registration.showNotification(title || 'Upset Special', {
    body: body || '',
    icon: icon || '/UpsetSpecial/icon-192.png',
    badge: '/UpsetSpecial/icon-192.png',
    tag: data.tag || 'upset-special',
    data: { url: data.url || 'https://acebuilds51.github.io/UpsetSpecial' },
    requireInteraction: data.requireInteraction === 'true',
    vibrate: [200, 100, 200]
  });
});

// When player taps the notification, open/focus the app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://acebuilds51.github.io/UpsetSpecial';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.includes('UpsetSpecial') && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
