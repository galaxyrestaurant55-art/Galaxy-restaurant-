/* ═══════════════════════════════════════════════════════════════════
   GALAXY RESTAURANT — Service Worker v4
   • PRIMARY:  Firebase SSE stream — true push, ~100ms latency
   • FALLBACK: 800ms polling if SSE fails/unsupported
   • Auto-print trigger sent instantly when new order detected
   • Background notifications with vibration
═══════════════════════════════════════════════════════════════════ */

var DB_URL     = 'https://galaxy-pos-3bbc7-default-rtdb.asia-southeast1.firebasedatabase.app';
var CACHE_NAME = 'galaxy-pos-v6';

var _knownNums    = null;   // Set of order nums already seen
var _printedNums  = {};     // mirrors _autoPrintPrinted from main page
var _autoPrint    = false;  // mirrors owner setting
var _pollTimer    = null;
var _sseAbort     = null;   // AbortController for SSE fetch
var _sseFailed    = false;  // true if SSE not supported / keeps erroring

var POLL_MS_FAST  = 800;    // fallback poll when SSE is down
var POLL_MS_SLOW  = 3000;   // safety-net poll alongside SSE

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
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
  startListening();
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
    case 'PRINTED_NUMS':
      // Sync already-printed set so SW never double-prints across restarts
      _printedNums = e.data.nums || {};
      break;
    case 'START_POLL':
      startListening();
      break;
    case 'STOP_POLL':
      stopAll();
      break;
    case 'FIREBASE_ACTIVE':
      // Owner page Firebase listener active — keep SW running at slow safety rate
      _startSafetyPoll();
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
      // Page successfully printed — clear the saved queue
      _clearPrintQueue();
      break;
    case 'GET_PRINT_QUEUE':
      // Page asking for queued print jobs (called on focus/load)
      _loadPrintQueue().then(function(orders) {
        if (orders && orders.length > 0) {
          // Send queue to page then clear it
          self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
            cs.forEach(function(c) {
              c.postMessage({ type: 'PRINT_QUEUE', orders: orders });
            });
          });
          _clearPrintQueue();
        }
      });
      break;
  }
});

/* ══════════════════════════════════════════════════════════════════
   MAIN ENTRY — try SSE first, fall back to fast polling
══════════════════════════════════════════════════════════════════ */
function startListening() {
  stopAll();
  _startSSE();
}

function stopAll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _stopSSE();
}

/* ══════════════════════════════════════════════════════════════════
   FIREBASE SSE STREAM
   Firebase Realtime Database natively supports Server-Sent Events.
   GET /orders.json with Accept: text/event-stream returns a live
   push stream — every write is pushed in ~100ms, zero polling cost.
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

    // SSE stream live — run slow safety-net poll in parallel
    _startSafetyPoll();

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';

    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          // Stream closed by server — reconnect after brief pause
          setTimeout(_startSSE, 1500);
          return;
        }
        buf += decoder.decode(chunk.value, { stream: true });

        // SSE format: "event: put\ndata: {\"path\":\"/\",\"data\":{...}}\n\n"
        var events = buf.split('\n\n');
        buf = events.pop(); // keep incomplete trailing chunk

        events.forEach(function(block) {
          var evtType = '', evtData = '';
          block.split('\n').forEach(function(ln) {
            if (ln.indexOf('event:') === 0) evtType = ln.slice(6).trim();
            if (ln.indexOf('data:')  === 0) evtData = ln.slice(5).trim();
          });
          if ((evtType === 'put' || evtType === 'patch') && evtData) {
            try {
              var parsed = JSON.parse(evtData);
              // Firebase SSE: { path: '/', data: { orderNum: {...}, ... } }
              // On initial load path='/' data=full tree; on change path='/orderNum' data=order
              if (parsed && parsed.path === '/' && parsed.data) {
                _handleOrdersObject(parsed.data);
              } else if (parsed && parsed.path && parsed.path !== '/' && parsed.data) {
                // Single order update — wrap into object keyed by path
                var key = parsed.path.replace(/^\//, '');
                var partial = {};
                partial[key] = parsed.data;
                _handleOrdersObject(partial);
              }
            } catch(ex) { /* malformed chunk */ }
          }
        });
        return pump();
      }).catch(function(err) {
        if (err && err.name === 'AbortError') return; // intentional stop
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

/* ── Safety-net poll alongside SSE (catches any SSE gaps) ── */
function _startSafetyPoll() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(_pollOnce, POLL_MS_SLOW);
}

/* ── Fast poll (SSE unavailable fallback) ── */
function _startFastPoll() {
  _stopSSE();
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(_pollOnce, POLL_MS_FAST);
  _pollOnce();
}

function _pollOnce() {
  fetch(DB_URL + '/orders.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { if (data) _handleOrdersObject(data); })
    .catch(function() {});
}

/* ══════════════════════════════════════════════════════════════════
   PENDING PRINT QUEUE — stored in Cache API (no IndexedDB needed)
   Orders waiting to be printed are saved here. When app opens or
   comes to foreground, it reads this queue and prints immediately.
══════════════════════════════════════════════════════════════════ */
var PRINT_QUEUE_KEY = 'gmf-print-queue';

function _savePrintQueue(orders) {
  // Store as a fake Response in the cache — zero-cost KV store
  var data = JSON.stringify(orders);
  caches.open(CACHE_NAME).then(function(c) {
    c.put(new Request(PRINT_QUEUE_KEY), new Response(data));
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
   CORE ORDER PROCESSING — called by both SSE and poll paths
══════════════════════════════════════════════════════════════════ */
function _handleOrdersObject(data) {
  if (!data || typeof data !== 'object') return;

  var orders = [];
  Object.keys(data).forEach(function(k) {
    if (data[k] && !data[k].init) orders.push(data[k]);
  });

  var pending  = orders.filter(function(o) { return o.status === 'pending'; });
  var nums     = pending.map(function(o) { return o.orderNum; });

  if (_knownNums === null) {
    _knownNums = new Set(nums);
    broadcastToClients({ type: 'SW_READY', nums: nums });
    return;
  }

  var newOrders = pending.filter(function(o) { return !_knownNums.has(o.orderNum); });
  newOrders.forEach(function(o) { _knownNums.add(o.orderNum); });
  if (newOrders.length === 0) return;

  // ── 1. Tell main page immediately (UI repaint + foreground bell + foreground print) ──
  broadcastToClients({ type: 'NEW_ORDERS', orders: newOrders, allPending: pending });

  // ── 2. Auto-print logic ──
  // Web Bluetooth CANNOT run from SW or background page.
  // Solution:
  //   • If page is VISIBLE → page handles print itself via AUTO_PRINT_TRIGGER
  //   • If page is BACKGROUND/CLOSED → save to print queue in cache, fire notification
  //     with "Print Now" action. On tap/open, page reads queue and prints.
  if (_autoPrint) {
    var toPrint = newOrders.filter(function(o) { return !_printedNums[o.orderNum]; });
    if (toPrint.length) {
      toPrint.forEach(function(o) { _printedNums[o.orderNum] = true; });

      // Check if any owner window is visible (foreground)
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
        var appVisible = clients.some(function(c) {
          return c.url.indexOf('owner') !== -1 && c.visibilityState === 'visible';
        });

        if (appVisible) {
          // Page is in foreground — send trigger, page will use BT directly
          broadcastToClients({ type: 'AUTO_PRINT_TRIGGER', orders: toPrint });
        } else {
          // Page is background/closed — save queue so app prints on next open/focus
          _loadPrintQueue().then(function(existing) {
            // Merge, deduplicate by orderNum
            var merged = existing.slice();
            toPrint.forEach(function(o) {
              if (!merged.some(function(e){ return e.orderNum === o.orderNum; })) {
                merged.push(o);
              }
            });
            _savePrintQueue(merged);
            // Also send trigger — page will receive it when it comes to foreground
            broadcastToClients({ type: 'AUTO_PRINT_TRIGGER', orders: toPrint });
          });
        }
      });
    }
  }

  // ── 3. System notification (works on locked screen) ──
  var appUrl = self.registration.scope + 'owner.html';
  var notifPromises = newOrders.map(function(o) {
    var title = '\uD83D\uDD14 New Order \u2014 Table ' + o.tableNumber;
    var body  = (o.customerName ? o.customerName + ' \u2022 ' : '') +
                (Array.isArray(o.items)
                  ? o.items.map(function(i){ return i.qty + 'x ' + i.name; }).join(', ')
                  : '') +
                ' \u2022 \u20B9' + (o.total || 0) +
                (_autoPrint ? ' \u2014 Tap "Print Now" to print!' : '');
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
}

/* ── Notification click ── */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var action = e.action;
  var data   = e.notification.data || {};
  var target = data.url || (self.registration.scope + 'owner.html');
  // For print action, add ?autoprint=1 so page knows to print on load
  if (action === 'print_open') target = target + '?autoprint=1';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
      // Try to find existing owner window
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf('owner') !== -1) {
          cs[i].focus();
          // Tell the page what action was clicked
          cs[i].postMessage({ type: 'NOTIFICATION_CLICK', action: action, autoPrint: data.autoPrint });
          return;
        }
      }
      // No window open — open one (will read print queue on load)
      return self.clients.openWindow(target);
    })
  );
});

/* ── Broadcast to all open owner windows ── */
function broadcastToClients(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
    cs.forEach(function(c) { c.postMessage(msg); });
  });
}

/* ── Fetch: cache-first for app shell, never cache Firebase ── */
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
