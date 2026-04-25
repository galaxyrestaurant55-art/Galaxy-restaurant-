/* ═══════════════════════════════════════════════════════════════════
   GALAXY RESTAURANT — Service Worker v10 (ULTRA-INSTANT)
   • Firebase SSE stream — true push, ~50ms latency
   • Instant background notifications + vibration
   • 500ms SSE reconnect on drop
   • Smart dedup — no double alerts, no race conditions
═══════════════════════════════════════════════════════════════════ */

var DB_URL     = 'https://galaxy-pos-3bbc7-default-rtdb.asia-southeast1.firebasedatabase.app';
var CACHE_NAME = 'galaxy-pos-v10';

var _knownNums      = null;
var _sseAbort       = null;
var _safetyTimer    = null;
var _fastPollTimer  = null;
var _sseFailed      = false;
var _fbActiveOnPage = false;

var SAFETY_POLL_MS = 2500;
var FAST_POLL_MS   = 600;

var APP_SHELL = [
  './owner.html',
  './customer-menu.html',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Lato:wght@300;400;700&display=swap'
];

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(function(c){ return c.addAll(APP_SHELL).catch(function(){}); }));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
  startListening();
});

self.addEventListener('message', function(e) {
  if (!e.data) return;
  switch(e.data.type) {
    case 'KNOWN_ORDERS':
      if (_knownNums === null) { _knownNums = new Set((e.data.nums||[]).map(String)); }
      else { (e.data.nums||[]).forEach(function(n){ _knownNums.add(String(n)); }); }
      break;
    case 'START_POLL': startListening(); break;
    case 'STOP_POLL':  _stopSSE(); _startSafetyPoll(); break;
    case 'FIREBASE_ACTIVE':
      _fbActiveOnPage = true;
      _startSafetyPoll();
      break;
    case 'FIREBASE_INACTIVE':
      _fbActiveOnPage = false;
      startListening();
      break;
    case 'SHOW_NOTIFICATION':
      if (e.data.title) {
        self.registration.showNotification(e.data.title, {
          body: e.data.body||'', tag: e.data.tag||'gmf-order',
          renotify: true, requireInteraction: true, silent: false,
          vibrate: [500,100,500,100,700,200,500,100,500,100,700],
          icon: 'icon-192.png', badge: 'icon-192.png',
          data: { url: self.registration.scope + 'owner.html' }
        });
      }
      break;
    case 'ORDER_MARKED_DONE':
      if (_knownNums && e.data.orderNum) _knownNums.delete(String(e.data.orderNum));
      break;
  }
});

function startListening() {
  _stopAll();
  if (!_sseFailed) { _startSSE(); } else { _startFastPoll(); }
}

function _stopAll() {
  if (_fastPollTimer)  { clearInterval(_fastPollTimer);  _fastPollTimer  = null; }
  if (_safetyTimer)    { clearInterval(_safetyTimer);    _safetyTimer    = null; }
  _stopSSE();
}

function _startSSE() {
  try {
    if (typeof ReadableStream === 'undefined' || typeof TextDecoder === 'undefined') {
      _sseFailed = true; _startFastPoll(); return;
    }
  } catch(e) { _sseFailed = true; _startFastPoll(); return; }

  _sseAbort = new AbortController();
  var url = DB_URL + '/orders.json';

  fetch(url, {
    headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
    signal: _sseAbort.signal,
    cache: 'no-store'
  }).then(function(res) {
    if (!res.ok || !res.body) throw new Error('SSE not available');
    _startSafetyPoll();

    var reader  = res.body.getReader();
    var decoder = new TextDecoder();
    var buf     = '';
    var isFirst = true;

    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) { setTimeout(_startSSE, 500); return; }
        buf += decoder.decode(chunk.value, { stream: true });
        var events = buf.split('\n\n');
        buf = events.pop();

        for (var i = 0; i < events.length; i++) {
          var block = events[i];
          var evtType = '', evtData = '';
          block.split('\n').forEach(function(ln) {
            if (ln.indexOf('event:') === 0) evtType = ln.slice(6).trim();
            if (ln.indexOf('data:')  === 0) evtData = ln.slice(5).trim();
          });
          if ((evtType === 'put' || evtType === 'patch') && evtData) {
            try {
              var parsed = JSON.parse(evtData);
              if (parsed && parsed.path === '/' && parsed.data !== null && parsed.data !== undefined) {
                if (isFirst) { isFirst = false; _handleOrdersObject(parsed.data, true); }
                else { _handleOrdersObject(parsed.data, false); }
              } else if (parsed && parsed.path && parsed.path !== '/' && parsed.data) {
                var key = parsed.path.replace(/^\//, '');
                var partial = {}; partial[key] = parsed.data;
                _handleOrdersObject(partial, false);
              } else if (parsed && parsed.path && parsed.path !== '/' && parsed.data === null) {
                if (_knownNums) _knownNums.delete(parsed.path.replace(/^\//, ''));
              }
            } catch(ex) {}
          }
        }
        return pump();
      }).catch(function(err) {
        if (err && err.name === 'AbortError') return;
        _sseFailed = true; _startFastPoll();
      });
    }
    return pump();
  }).catch(function(err) {
    if (err && err.name === 'AbortError') return;
    _sseFailed = true; _startFastPoll();
  });
}

function _stopSSE() {
  if (_sseAbort) { try { _sseAbort.abort(); } catch(e){} _sseAbort = null; }
}

function _startSafetyPoll() {
  if (_safetyTimer) clearInterval(_safetyTimer);
  _safetyTimer = setInterval(_pollOnce, SAFETY_POLL_MS);
}

function _startFastPoll() {
  _stopSSE();
  if (_fastPollTimer) clearInterval(_fastPollTimer);
  _fastPollTimer = setInterval(_pollOnce, FAST_POLL_MS);
  _pollOnce();
}

var _polling = false;
function _pollOnce() {
  if (_polling) return;
  _polling = true;
  fetch(DB_URL + '/orders.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { _polling = false; if (data) _handleOrdersObject(data, false); })
    .catch(function() { _polling = false; });
}

function _handleOrdersObject(data, silent) {
  if (!data || typeof data !== 'object') return;

  var orders = [];
  var keys = Object.keys(data);
  for (var i = 0; i < keys.length; i++) {
    var o = data[keys[i]];
    if (o && !o.init) orders.push(o);
  }

  var pending = orders.filter(function(o){ return o.status === 'pending'; });
  var nums    = pending.map(function(o){ return String(o.orderNum); });

  if (_knownNums === null) {
    _knownNums = new Set(nums);
    if (!_fbActiveOnPage) {
      _broadcastToClients({ type: 'SW_READY', nums: nums });
      _broadcastToClients({ type: 'SW_ORDERS_UPDATE', allPending: pending });
    }
    return;
  }

  if (!_fbActiveOnPage) {
    _broadcastToClients({ type: 'SW_ORDERS_UPDATE', allPending: pending });
  }

  var newOrders = pending.filter(function(o){ return !_knownNums.has(String(o.orderNum)); });
  newOrders.forEach(function(o){ _knownNums.add(String(o.orderNum)); });

  if (newOrders.length === 0 || silent) return;

  if (!_fbActiveOnPage) {
    _broadcastToClients({ type: 'NEW_ORDERS', orders: newOrders, allPending: pending });
  }

  var appUrl = self.registration.scope + 'owner.html';
  var notifPromises = newOrders.map(function(o) {
    var title    = '\uD83D\uDD14 New Order \u2014 Table ' + o.tableNumber;
    var custName = o.customerName || o.name || o.customer_name || '';
    var itemStr  = Array.isArray(o.items)
      ? o.items.map(function(i){ return (parseInt(i.qty)||1) + '\xD7 ' + i.name; }).join(', ')
      : '';
    var body = (custName ? custName + ' \u2022 ' : '') + (itemStr ? itemStr + ' ' : '') + '\u2022 \u20B9' + (o.total || 0);
    return self.registration.showNotification(title, {
      body:               body,
      tag:                'order-' + o.orderNum,
      renotify:           true,
      requireInteraction: true,
      silent:             false,
      vibrate:            [500,100,500,100,700,200,500,100,500,100,700],
      icon:               'icon-192.png',
      badge:              'icon-192.png',
      actions:            [{ action: 'view', title: '\uD83D\uDCCB View Orders' }],
      data:               { orderNum: o.orderNum, url: appUrl }
    });
  });
  Promise.all(notifPromises).catch(function(){});
}

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var data   = e.notification.data || {};
  var target = data.url || (self.registration.scope + 'owner.html');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf('owner') !== -1) {
          cs[i].focus();
          cs[i].postMessage({ type: 'NOTIFICATION_CLICK', orderNum: data.orderNum });
          return;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

function _broadcastToClients(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
    for (var i = 0; i < cs.length; i++) { try { cs[i].postMessage(msg); } catch(e){} }
  });
}

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var url = e.request.url;
  if (url.indexOf(DB_URL) !== -1) return;
  if (url.indexOf('firebaseio') !== -1) return;
  e.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(e.request).then(function(cached) {
        var net = fetch(e.request).then(function(res) {
          if (res && res.status === 200 && res.type !== 'opaque') cache.put(e.request, res.clone());
          return res;
        }).catch(function(){ return cached; });
        return cached || net;
      });
    })
  );
});
