/* ═══════════════════════════════════════════════════════════════════
   GALAXY RESTAURANT — Service Worker v3
   • Background polling every 5s (Firebase REST — works locked screen)
   • Background notification with sound trigger
   • Auto-print trigger message to open clients
   • Cache-first for app shell
═══════════════════════════════════════════════════════════════════ */

var DB_URL     = 'https://galaxy-pos-3bbc7-default-rtdb.asia-southeast1.firebasedatabase.app';
var CACHE_NAME = 'galaxy-pos-v3';
var POLL_MS    = 5000;   // 5s background poll
var _knownNums = null;   // Set of order nums already notified
var _pollTimer = null;
var _autoPrint = false;  // mirrors owner setting

var APP_SHELL = [
  './owner.html',
  './customer-menu.html',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Lato:wght@300;400;700&display=swap'
];

/* ── Install: cache app shell ── */
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL).catch(function(){});
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
  startPolling();
});

/* ── Message from main page ── */
self.addEventListener('message', function(e) {
  if (!e.data) return;
  switch(e.data.type) {
    case 'KNOWN_ORDERS':
      _knownNums = new Set(e.data.nums || []);
      break;
    case 'AUTO_PRINT':
      _autoPrint = !!e.data.enabled;
      break;
    case 'START_POLL':
      startPolling();
      break;
    case 'STOP_POLL':
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      break;
    case 'FIREBASE_ACTIVE':
      // Firebase listener is active in foreground — reduce SW poll to 8s to save battery
      if (_pollTimer) clearInterval(_pollTimer);
      _pollTimer = setInterval(pollOrders, 8000);
      break;
  }
});

/* ── Background polling ── */
function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(pollOrders, POLL_MS);
  pollOrders();
}

function pollOrders() {
  var url = DB_URL + '/orders.json?t=' + Date.now();
  fetch(url, { cache: 'no-store' }).then(function(r) {
    if (!r.ok) return null;
    return r.json();
  }).then(function(data) {
    if (!data) return;
    var orders = [];
    if (typeof data === 'object') {
      Object.keys(data).forEach(function(k) {
        if (data[k] && !data[k].init) orders.push(data[k]);
      });
    }
    var pending = orders.filter(function(o) { return o.status === 'pending'; });
    var nums    = pending.map(function(o) { return o.orderNum; });

    if (_knownNums === null) {
      _knownNums = new Set(nums);
      broadcastToClients({ type: 'SW_READY', nums: nums });
      return;
    }

    var newOrders = pending.filter(function(o) { return !_knownNums.has(o.orderNum); });
    newOrders.forEach(function(o) { _knownNums.add(o.orderNum); });

    if (newOrders.length === 0) return;

    // Tell main page (handles sound + UI if open)
    broadcastToClients({ type: 'NEW_ORDERS', orders: newOrders, allPending: pending });

    // Show persistent notification for EACH new order
    var promises = newOrders.map(function(o) {
      var title = '\uD83D\uDD14 New Order \u2014 Table ' + o.tableNumber;
      var body  = (o.customerName ? o.customerName + ' \u2022 ' : '') +
                  (Array.isArray(o.items) ? o.items.map(function(i){ return i.qty+'x '+i.name; }).join(', ') : '') +
                  ' \u2022 \u20B9' + (o.total || 0);
      return self.registration.showNotification(title, {
        body:               body,
        tag:                'order-' + o.orderNum,
        renotify:           true,
        requireInteraction: true,
        vibrate:            [300, 100, 300, 100, 600, 100, 300],
        icon:               'https://api.dicebear.com/7.x/icons/svg?seed=galaxy&backgroundColor=1a0a0a',
        badge:              'https://api.dicebear.com/7.x/icons/svg?seed=galaxy&backgroundColor=1a0a0a',
        actions: [
          { action: 'view',  title: '\uD83D\uDCCB View Orders' },
          { action: 'print', title: '\uD83D\uDDA8\uFE0F Print'       }
        ],
        data: { orderNum: o.orderNum, url: self.registration.scope + 'owner.html' }
      });
    });

    // Auto-print signal if enabled (handled by open client)
    if (_autoPrint) {
      broadcastToClients({ type: 'AUTO_PRINT_TRIGGER', orders: newOrders });
    }

    return Promise.all(promises);
  }).catch(function() { /* silent — background */ });
}

/* ── Notification click ── */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url)
    ? e.notification.data.url
    : self.registration.scope + 'owner.html';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf('owner') !== -1) {
          cs[i].focus();
          cs[i].postMessage({ type: 'NOTIFICATION_CLICK', action: e.action });
          return;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* ── Broadcast helper ── */
function broadcastToClients(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
    cs.forEach(function(c) { c.postMessage(msg); });
  });
}

/* ── Fetch: cache-first for app shell ── */
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  if (e.request.url.indexOf(DB_URL) !== -1) return;        // never cache Firebase
  if (e.request.url.indexOf('firebaseio') !== -1) return;  // never cache Firebase
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var networkFetch = fetch(e.request).then(function(res) {
        if (res && res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(e.request, clone); });
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || networkFetch;
    })
  );
});
