/* Service worker for the multi-file build: cache everything on first load so
   the app opens with no network at all.

   Note the single-file build (brc-YEAR.html) does not need this and does not
   use it -- see docs for why that is the build you should actually carry. */
var CACHE = "brc-2026-20260829145618";
var ASSETS = ["./", "./index.html", "./app.js", "./style.css", "./data.js", "./manifest.webmanifest"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* Stale-while-revalidate.

   The cached copy is still what gets returned, so the app opens instantly with
   no network at all -- that property is the entire point out there and it is
   unchanged. What is new is that any load *with* signal also refetches in the
   background and overwrites the cache, so the next open is fresh.

   Why the cache stamp in CACHE above is not enough on its own: a new stamp only
   reaches the phone if it re-requests sw.built.js, and iOS only does that on a
   real navigation. A Home Screen app resumed from the app switcher never
   navigates, so it can sit on a stale build indefinitely -- which is why
   deleting and re-adding the icon appeared to be the only way to update. This
   path does not depend on the worker being replaced at all.

   Cross-origin GETs are left alone: this app has none by design (see CLAUDE.md
   on the offline requirement), so anything cross-origin is not ours to cache. */
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return;

  // Start the network immediately, independent of the cache lookup below.
  var fresh = fetch(e.request).then(function (res) {
    if (!res || !res.ok) return res;
    var copy = res.clone();   // a body reads once; keep one for the cache
    return caches.open(CACHE).then(function (c) {
      return c.put(e.request, copy);
    }).then(function () { return res; });
  });

  // Keep the worker alive until the cache write lands, even though the response
  // handed back below has probably already come from the cache. Swallow the
  // rejection: on playa, offline is the normal case, not an error.
  e.waitUntil(fresh.catch(function () {}));

  e.respondWith(caches.match(e.request).then(function (hit) {
    if (hit) return hit;                       // instant, signal or not
    return fresh.catch(function () {           // cold cache and no network
      return caches.match("./index.html");
    });
  }));
});
