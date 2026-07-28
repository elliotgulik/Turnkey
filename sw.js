// Turnkey service worker — caches static assets for speed/offline; HTML pages always go to the network first.
// OneSignal's Web Push handling (the actual `push`/`notificationclick`
// listeners that make a background notification appear and open the right
// TurnKey page on click — see sendNotification()'s `url` field, backend/src/
// services/notifications.js) is merged into THIS SAME worker rather than
// registered as a second one — only one service worker can control the
// root scope at a time, and this one already claims it (see the
// navigator.serviceWorker.register('sw.js') call in index.html). This is
// OneSignal's own documented "existing service worker" integration path.
// A standalone /OneSignalSDKWorker.js also exists at the root with the same
// single importScripts line, purely so that exact URL always resolves to
// real JS if anything (OneSignal's SDK internals, a stale cached reference)
// ever requests it directly — see netlify.toml's explicit passthrough rule
// for why that file has to exist as a real, non-redirected file.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
const CACHE='turnkey-v5'; // bumped from v4 — new brand icon/favicon/apple-touch-icon assets replaced the old ones under the SAME filenames; static assets are served stale-while-revalidate below, so without this bump an already-installed PWA/returning browser would keep showing the old cached icon bytes indefinitely instead of picking up the new mark
// Note: HTML pages are deliberately NOT precached here — they're handled by the
// network-first navigate branch below so refreshes always pick up the newest deploy.
const SHELL=['./config.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
// Only ever cache a response that's actually safe to store and replay later:
// - GET only — cache.put() throws synchronously for any other method (a
//   POST to Supabase/the TurnKey backend/Stripe flowing through this same
//   fetch handler, since a service worker sees every fetch a controlled
//   page makes, not just same-origin GETs, would hit exactly that).
// - status 200 — a 206 Partial Content response (byte-range requests,
//   which browsers issue for some media/font loads) is explicitly
//   unsupported by the Cache API and throws if you try to store one; a non-
//   200 error response has nothing worth caching either.
// Cloned up front, synchronously, before anything else touches the
// response — the only reliable way to guarantee neither consumer (the one
// returned to the browser, the one written to cache) ever sees a body the
// other has already started reading.
function cachePut(req,res){
  if(req.method!=='GET'||!res||res.status!==200)return;
  try{ caches.open(CACHE).then(c=>c.put(req,res.clone())).catch(()=>{}); }
  catch(e){ /* clone/put failing here must never break the actual response */ }
}
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return; // let the browser handle it normally — nothing here applies to writes
  // Page loads (index.html, booking.html, /) — always try the network first so
  // deployments show up on refresh; fall back to the last cached copy when offline.
  if(req.mode==='navigate'){
    e.respondWith(
      fetch(req).then(res=>{
        cachePut(req,res);
        return res;
      }).catch(()=>caches.match(req).then(hit=>hit||Response.error()))
    );
    return;
  }
  // Static assets — serve from cache instantly, but refresh the cache in the background
  // so the next load picks up changes without needing a full cache-busting reset.
  e.respondWith(
    caches.match(req).then(hit=>{
      const network=fetch(req).then(res=>{
        cachePut(req,res);
        return res;
      }).catch(()=>hit||Response.error());
      return hit||network;
    })
  );
});
