// Turnkey service worker — caches static assets for speed/offline; HTML pages always go to the network first.
// OneSignal's Web Push handling (the actual `push`/`notificationclick`
// listeners that make a background notification appear and open the right
// TurnKey page on click — see sendNotification()'s `url` field, backend/src/
// services/notifications.js) is merged into THIS SAME worker rather than
// registered as a second one — only one service worker can control the
// root scope at a time, and this one already claims it (see the
// navigator.serviceWorker.register('sw.js') call in index.html). This is
// OneSignal's own documented "existing service worker" integration path.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
const CACHE='turnkey-v2';
// Note: HTML pages are deliberately NOT precached here — they're handled by the
// network-first navigate branch below so refreshes always pick up the newest deploy.
const SHELL=['./config.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  // Page loads (index.html, booking.html, /) — always try the network first so
  // deployments show up on refresh; fall back to the last cached copy when offline.
  if(req.mode==='navigate'){
    e.respondWith(
      fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(req,copy));
        return res;
      }).catch(()=>caches.match(req))
    );
    return;
  }
  // Static assets — serve from cache instantly, but refresh the cache in the background
  // so the next load picks up changes without needing a full cache-busting reset.
  e.respondWith(
    caches.match(req).then(hit=>{
      const network=fetch(req).then(res=>{
        caches.open(CACHE).then(c=>c.put(req,res.clone()));
        return res;
      }).catch(()=>hit);
      return hit||network;
    })
  );
});
