const SHELL_CACHE = "stash-shell-v2";
const STATIC_CACHE = "stash-static-v2";
const PRECACHE = ["/offline.html", "/stash-icon.svg", "/stash-icon-maskable.svg"];
const PUBLIC_SHELL_ASSETS = new Set(PRECACHE);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("stash-") && ![SHELL_CACHE, STATIC_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") || PUBLIC_SHELL_ASSETS.has(url.pathname))
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request).then(async (response) => {
          if (response.ok && response.type === "basic") {
            await cache.put(request, response.clone());
          }
          return response;
        });
        if (cached) {
          event.waitUntil(network.catch(() => undefined));
          return cached;
        }
        return network;
      }),
    );
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
  }
});
