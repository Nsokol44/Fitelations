// Fitelations service worker — enables real OS-level notifications
// (via registration.showNotification) instead of the page-only Notification API,
// and handles tapping a notification to focus/open the app on the right tab.
//
// Scope/limits: this fires reminders while the app or its background tab is
// still alive in the browser. It cannot wake the app from a fully closed
// state — that requires a server sending real Web Push, which this project
// doesn't have. See README for details.

const SW_VERSION = "fitel-sw-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Let the page ask the SW to show a notification (used instead of `new Notification()`
// so it renders as a real system notification with actions/tap-to-open support).
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "SHOW_NOTIFICATION") {
    self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: msg.tag || "fitel-reminder",
      renotify: true,
      data: { tab: msg.tab || null },
    });
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetTab = event.notification.data && event.notification.data.tab;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if (targetTab) client.postMessage({ type: "NAVIGATE_TAB", tab: targetTab });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("/");
      }
    })
  );
});
