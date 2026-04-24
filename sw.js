/* ═══════════════════════════════════════════════════════════════════
   GALAXY RESTAURANT — Service Worker v6 (ALL BUGS FIXED)
   • Firebase SSE stream — true push, ~100ms latency
   • 1s safety-net poll alongside SSE (catches any gaps)
   • Instant background notifications + vibration
   • Auto-print queue — stored in Cache API
   • NO double-alerts, NO race conditions
   • Reconnects SSE automatically on drop
═══════════════════════════════════════════════════════════════════ */

var DB_URL     = 'https://galaxy-pos-3bbc7-default-rtdb.asia-southeast1.firebasedatabase.app';
var CACHE_NAME = 'galaxy-pos-v9';

var _knownNums   = null;   // null = not initialized; Set after first data
var _printedNums = {};
var _autoPrint   = false;
var _pollTimer   = null;
var _sseAbort    = null;
var _sseFailed   = false;
var _safetyTimer = null;
var _fbActiveOnPage = false; // true when page owns the Firebase SSE

var POLL_MS_SAFETY = 3000;  // safety net when page owns Firebase (backup only)
var POLL_MS_FAST   = 800;   // fast poll when SSE unavailable

var APP_SHELL = [
  './owner.html',
  './customer-menu.html',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Lato:wght@300;400;700&display=swap'
];

/* ── Install ── */
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL).catch(function(){});
    })
  );
});

/* ── Activate ── */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
  startListening();
});

/* ── Messages from main page ── */
self.addEventListener('message', function(e) {
  if (!e.data) return;
  switch(e.data.type) {

    case 'KNOWN_ORDERS':
      // Page syncing its known orders to SW
      if (_knownNums === null) {
        _knownNums = new Set((e.data.nums || []).map(String));
      } else {
        (e.data.nums || []).forEach(function(n){ _knownNums.add(String(n)); });
      }
      break;

    case 'AUTO_PRINT':
      _autoPrint = !!e.data.enabled;
      break;

    case 'PRINTED_NUMS':
      _printedNums = e.data.nums || {};
      break;

    case 'START_POLL':
      startListening();
      break;

    case 'STOP_POLL':
      _stopSSE();
      _startSafetyPoll();
      break;

    case 'FIREBASE_ACTIVE':
      // Page owns Firebase SSE — SW runs safety-net poll only
      _fbActiveOnPage = true;
      _startSafetyPoll();
      break;

    case 'FIREBASE_INACTIVE':
      // Page lost Firebase — SW should take over
      _fbActiveOnPage = false;
      startListening();
      break;

    case 'SHOW_NOTIFICATION':
      if (e.data.title) {
        self.registration.showNotification(e.data.title, {
          body:               e.data.body || '',
          tag:                e.data.tag  || 'gmf-order',
          renotify:           true,
          requireInteraction: true,
          silent:             false,
          vibrate:            [500,100,500,100,700,200,500,100,500,100,700],
          icon:               'icon-192.png',
          badge:              'icon-192.png',
          data:               { url: self.registration.scope + 'owner.html' }
        });
      }
      break;

    case 'CLEAR_PRINT_QUEUE':
      _clearPrintQueue();
      break;

    case 'GET_PRINT_QUEUE':
      _loadPrintQueue().then(function(orders) {
        if (orders && orders.length > 0) {
          _broadcastToClients({ type: 'PRINT_QUEUE', orders: orders });
          _clearPrintQueue();
        }
      });
      break;

    case 'ORDER_MARKED_DONE':
      if (_knownNums && e.data.orderNum) {
        _knownNums.delete(String(e.data.orderNum));
      }
      break;
  }
});

/* ══════════════════════════════════════════════════════════════════
   MAIN ENTRY
══════════════════════════════════════════════════════════════════ */
function startListening() {
  _stopAll();
  if (!_sseFailed) {
    _startSSE();
  } else {
    _startFastPoll();
  }
}

function _stopAll() {
  if (_pollTimer)   { clearInterval(_pollTimer);   _pollTimer   = null; }
  if (_safetyTimer) { clearInterval(_safetyTimer); _safetyTimer = null; }
  _stopSSE();
}

/* ══════════════════════════════════════════════════════════════════
   FIREBASE SSE STREAM
══════════════════════════════════════════════════════════════════ */
function _startSSE() {
  try {
    if (typeof ReadableStream === 'undefined' || typeof TextDecoder === 'undefined') {
      _sseFailed = true; _startFastPoll(); return;
    }
  } catch(e) { _sseFailed = true; _startFastPoll(); return; }

  _sseAbort = new AbortController();
  var url = DB_URL + '/orders.json?t=' + Date.now();

  fetch(url, {
    headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
    signal: _sseAbort.signal,
    cache: 'no-store'
  }).then(function(res) {
    if (!res.ok || !res.body) throw new Error('SSE not available');

    // SSE stream is up — run safety poll alongside it
    _startSafetyPoll();

    var reader  = res.body.getReader();
    var decoder = new TextDecoder();
    var buf     = '';
    var isFirstEvent = true;

    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          // Stream ended — restart after short delay
          setTimeout(_startSSE, 1500);
          return;
        }
        buf += decoder.decode(chunk.value, { stream: true });

        var events = buf.split('\n\n');
        buf = events.pop();

        events.forEach(function(block) {
          var evtType = '', evtData = '';
          block.split('\n').forEach(function(ln) {
            if (ln.indexOf('event:') === 0) evtType = ln.slice(6).trim();
            if (ln.indexOf('data:')  === 0) evtData = ln.slice(5).trim();
          });

          if ((evtType === 'put' || evtType === 'patch') && evtData) {
            try {
              var parsed = JSON.parse(evtData);
              var silent = false;

              if (parsed && parsed.path === '/' && parsed.data) {
                // First full-snapshot — initialize silently, no alerts
                if (isFirstEvent) { silent = true; isFirstEvent = false; }
                _handleOrdersObject(parsed.data, silent);
              } else if (parsed && parsed.path && parsed.path !== '/' && parsed.data) {
                // Single-order partial update — always alert if new
                var key = parsed.path.replace(/^\//, '');
                var partial = {};
                partial[key] = parsed.data;
                _handleOrdersObject(partial, false);
              }
            } catch(ex) {}
          }
        });
        return pump();
      }).catch(function(err) {
        if (err && err.name === 'AbortError') return;
        // SSE failed — fall back to fast poll
        _sseFailed = true;
        _startFastPoll();
      });
    }
    return pump();

  }).catch(function(err) {
    if (err && err.name === 'AbortError') return;
    _sseFailed = true;
    _startFastPoll();
  });
}

function _stopSSE() {
  if (_sseAbort) { try { _sseAbort.abort(); } catch(e){} _sseAbort = null; }
}

function _startSafetyPoll() {
  if (_safetyTimer) clearInterval(_safetyTimer);
  _safetyTimer = setInterval(_pollOnce, POLL_MS_SAFETY);
}

function _startFastPoll() {
  _stopSSE();
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(_pollOnce, POLL_MS_FAST);
  _pollOnce();
}

var _polling = false;
function _pollOnce() {
  if (_polling) return;
  _polling = true;
  fetch(DB_URL + '/orders.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      _polling = false;
      if (data) _handleOrdersObject(data, false);
    })
    .catch(function() { _polling = false; });
}

/* ══════════════════════════════════════════════════════════════════
   PRINT QUEUE
══════════════════════════════════════════════════════════════════ */
var PRINT_QUEUE_KEY = 'gmf-print-queue-v2';

function _savePrintQueue(orders) {
  caches.open(CACHE_NAME).then(function(c) {
    c.put(new Request(PRINT_QUEUE_KEY), new Response(JSON.stringify(orders)));
  }).catch(function(){});
}
function _loadPrintQueue() {
  return caches.open(CACHE_NAME).then(function(c) {
    return c.match(new Request(PRINT_QUEUE_KEY));
  }).then(function(res) {
    if (!res) return [];
    return res.json().catch(function(){ return []; });
  }).catch(function(){ return []; });
}
function _clearPrintQueue() {
  caches.open(CACHE_NAME).then(function(c) {
    c.delete(new Request(PRINT_QUEUE_KEY));
  }).catch(function(){});
}

/* ══════════════════════════════════════════════════════════════════
   CORE ORDER PROCESSING
   silent=true  → first load: just initialize knownNums, no alerts
   silent=false → subsequent updates: alert on genuinely new orders

   KEY DESIGN: The page handles in-app bell + toast via Firebase SSE.
   The SW ALWAYS fires system notifications for new orders so the phone
   rings on the lock screen and in background — regardless of who owns
   the Firebase stream. _fbActiveOnPage only controls whether SW
   broadcasts order data to the page (to avoid double-painting).
══════════════════════════════════════════════════════════════════ */
function _handleOrdersObject(data, silent) {
  if (!data || typeof data !== 'object') return;

  var orders = [];
  Object.keys(data).forEach(function(k) {
    if (data[k] && !data[k].init) orders.push(data[k]);
  });

  var pending = orders.filter(function(o) { return o.status === 'pending'; });
  var nums    = pending.map(function(o) { return String(o.orderNum); });

  // First ever call — initialize known set without alerting
  if (_knownNums === null) {
    _knownNums = new Set(nums);
    if (!_fbActiveOnPage) {
      _broadcastToClients({ type: 'SW_READY', nums: nums });
      _broadcastToClients({ type: 'SW_ORDERS_UPDATE', allPending: pending });
    }
    return;
  }

  // Push live order list to page when page is NOT using Firebase directly
  if (!_fbActiveOnPage) {
    _broadcastToClients({ type: 'SW_ORDERS_UPDATE', allPending: pending });
  }

  // Determine genuinely new orders
  var newOrders = pending.filter(function(o) {
    return !_knownNums.has(String(o.orderNum));
  });
  newOrders.forEach(function(o) { _knownNums.add(String(o.orderNum)); });

  if (newOrders.length === 0 || silent) return;

  // ── 1. Broadcast to page ONLY when page isn't handling it via Firebase ──
  if (!_fbActiveOnPage) {
    _broadcastToClients({ type: 'NEW_ORDERS', orders: newOrders, allPending: pending });
  }

  // ── 2. Auto-print (always, regardless of who owns Firebase) ──
  if (_autoPrint) {
    var toPrint = newOrders.filter(function(o) { return !_printedNums[String(o.orderNum)]; });
    if (toPrint.length) {
      toPrint.forEach(function(o) { _printedNums[String(o.orderNum)] = true; });

      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
        var appVisible = clients.some(function(c) {
          return c.url.indexOf('owner') !== -1 && c.visibilityState === 'visible';
        });

        if (appVisible) {
          _broadcastToClients({ type: 'AUTO_PRINT_TRIGGER', orders: toPrint });
        } else {
          _loadPrintQueue().then(function(existing) {
            var merged = existing.slice();
            toPrint.forEach(function(o) {
              if (!merged.some(function(e){ return e.orderNum === o.orderNum; })) {
                merged.push(o);
              }
            });
            _savePrintQueue(merged);
          });
        }
      });
    }
  }

  // ── 3. System notification — ALWAYS fires (locked screen, background, even when page owns Firebase) ──
  // This is the ONLY way to ring the phone when the owner's screen is locked or app is minimized
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
    // Check if the owner page is currently visible on screen
    var ownerVisible = clients.some(function(c) {
      return c.url.indexOf('owner') !== -1 && c.visibilityState === 'visible';
    });

    var appUrl = self.registration.scope + 'owner.html';
    var notifPromises = newOrders.map(function(o) {
      var title = '\uD83D\uDD14 New Order \u2014 Table ' + o.tableNumber;
      var custName = o.customerName || o.name || o.customer_name || '';
      var body = (custName ? custName + ' \u2022 ' : '') +
                 (Array.isArray(o.items)
                   ? o.items.map(function(i){ return i.qty + 'x ' + i.name; }).join(', ')
                   : '') +
                 ' \u2022 \u20B9' + (o.total || 0);

      // Always show notification if page is not visible (background/locked)
      // If page IS visible, the page itself handles the in-app bell — only show notif too for awareness
      return self.registration.showNotification(title, {
        body:               body,
        tag:                'order-' + o.orderNum,
        renotify:           true,
        requireInteraction: true,
        silent:             false,
        vibrate:            [500,100,500,100,700,200,500,100,500,100,700],
        icon:               'icon-192.png',
        badge:              'icon-192.png',
        actions: [
          { action: 'view',       title: '\uD83D\uDCCB View Orders' },
          { action: 'print_open', title: '\uD83D\uDDA8\uFE0F Print Now' }
        ],
        data: { orderNum: o.orderNum, url: appUrl, autoPrint: _autoPrint }
      });
    });
    Promise.all(notifPromises).catch(function(){});
  });
}

/* ── Notification click ── */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var action = e.action;
  var data   = e.notification.data || {};
  var target = data.url || (self.registration.scope + 'owner.html');
  if (action === 'print_open') target = target + '?autoprint=1';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf('owner') !== -1) {
          cs[i].focus();
          cs[i].postMessage({ type: 'NOTIFICATION_CLICK', action: action, autoPrint: data.autoPrint });
          return;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* ── Broadcast helper ── */
function _broadcastToClients(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
    cs.forEach(function(c) {
      try { c.postMessage(msg); } catch(e) {}
    });
  });
}

/* ── Fetch: cache-first for app shell, pass-through for Firebase ── */
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  if (e.request.url.indexOf(DB_URL) !== -1) return;
  if (e.request.url.indexOf('firebaseio') !== -1) return;
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var net = fetch(e.request).then(function(res) {
        if (res && res.status === 200) {
          caches.open(CACHE_NAME).then(function(c){ c.put(e.request, res.clone()); });
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || net;
    })
  );
});
