/* GALAXY RESTAURANT — Service Worker v4
   Polls Firebase every 5s, vibrates 3x per new order */

var DB_URL  = 'https://galaxy-pos-3bbc7-default-rtdb.asia-southeast1.firebasedatabase.app';
var POLL_MS = 5000;
var VIB     = [400,150,400,150,500,150,600];
var _known  = null;
var _timer  = null;

self.addEventListener('install',  function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); startPolling(); });

self.addEventListener('message', function(e){
  if(!e.data) return;
  if(e.data.type==='KNOWN_ORDERS'){ _known=new Set(e.data.nums); }
  if(e.data.type==='START_POLL'){ startPolling(); }
  if(e.data.type==='STOP_POLL'){ if(_timer){clearInterval(_timer);_timer=null;} }
});

function startPolling(){
  if(_timer) clearInterval(_timer);
  _timer=setInterval(poll,POLL_MS);
  poll();
}

function poll(){
  fetch(DB_URL+'/orders.json?t='+Date.now())
    .then(function(r){return r.ok?r.json():null;})
    .then(function(data){
      if(!data) return;
      var orders=[];
      Object.keys(data).forEach(function(k){if(data[k]&&!data[k].init)orders.push(data[k]);});
      var pending=orders.filter(function(o){return o.status==='pending';});
      var nums=pending.map(function(o){return o.orderNum;});

      if(_known===null){
        _known=new Set(nums);
        broadcast({type:'SW_KNOWN',nums:nums});
        return;
      }

      var newOrders=pending.filter(function(o){return !_known.has(o.orderNum);});
      newOrders.forEach(function(o){_known.add(o.orderNum);});
      if(!newOrders.length) return;

      broadcast({type:'NEW_ORDERS',orders:newOrders,allPending:pending});

      newOrders.forEach(function(o){
        var title='🔔 New Order! Table '+o.tableNumber;
        var body=(o.customerName?o.customerName+' • ':'')+
                 (Array.isArray(o.items)?o.items.length+' item(s)':'')+
                 ' • ₹'+(o.total||0);
        var tag='order-'+o.orderNum;

        self.registration.showNotification(title,{
          body:body, tag:tag,
          requireInteraction:true,
          silent:false, vibrate:VIB, renotify:true,
          icon:'https://api.dicebear.com/7.x/icons/svg?seed=galaxy',
          badge:'https://api.dicebear.com/7.x/icons/svg?seed=galaxy',
          data:{orderNum:o.orderNum,url:self.registration.scope+'owner.html'}
        });

        // Re-vibrate at 4s and 8s
        setTimeout(function(){reVib(tag);}, 4000);
        setTimeout(function(){reVib(tag);}, 8000);

        // Auto-close at 12s
        setTimeout(function(){
          self.registration.getNotifications({tag:tag})
            .then(function(ns){ns.forEach(function(n){n.close();});});
        },12000);
      });
    })
    .catch(function(){});
}

function reVib(tag){
  self.registration.getNotifications({tag:tag}).then(function(ns){
    if(!ns.length) return;
    var n=ns[0];
    self.registration.showNotification(n.title,{
      body:n.body, tag:tag,
      requireInteraction:true, silent:false,
      vibrate:VIB, renotify:true,
      icon:n.icon, badge:n.badge, data:n.data
    });
  }).catch(function(){});
}

self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)
    ?e.notification.data.url
    :self.registration.scope+'owner.html';
  e.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
      for(var i=0;i<cs.length;i++){
        if(cs[i].url.indexOf('owner')!==-1&&'focus' in cs[i]) return cs[i].focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

function broadcast(msg){
  self.clients.matchAll({type:'window',includeUncontrolled:true})
    .then(function(cs){cs.forEach(function(c){c.postMessage(msg);});});
}

self.addEventListener('fetch',function(e){
  if(e.request.url.indexOf(DB_URL)!==-1) return;
  if(e.request.method!=='GET') return;
});
