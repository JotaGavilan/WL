// Service worker: la app y las rutas guardadas funcionan sin conexión.
//  - La app (HTML/JS/CSS/Leaflet/iconos) se precachea al instalar.
//  - Las rutas viven en IndexedDB (no dependen del SW).
//  - Teselas de mapa: se sirven de la caché (teselas guardadas a propósito o vistas antes) y, si no están, de la red.
const VERSION = 'v5';
const APP_CACHE = `wt-app-${VERSION}`;
const TILE_CACHE = 'wt-tiles';          // últimas teselas vistas (se recorta)
const OFFLINE_CACHE = 'wt-offline-tiles'; // teselas guardadas por el usuario (no se recorta)
const TILE_LIMIT = 600;

const APP_FILES = [
  './', 'index.html', 'config.js', 'manifest.webmanifest',
  'css/styles.css',
  'js/app.js', 'js/db.js', 'js/gpx.js', 'js/importer.js', 'js/profile.js', 'js/wikiloc-page.js', 'js/offline.js', 'js/geo.js', 'js/gps.js',
  'vendor/leaflet.js', 'vendor/leaflet.css',
  'vendor/images/layers.png', 'vendor/images/layers-2x.png',
  'vendor/images/marker-icon.png', 'vendor/images/marker-icon-2x.png', 'vendor/images/marker-shadow.png',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wt-app-') && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await c.delete(keys[i]);
}

const isTile = (h) => /tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com/.test(h);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url.hostname)) {
    e.respondWith((async () => {
      // 1) teselas guardadas a propósito, 2) teselas vistas antes
      const off = await caches.open(OFFLINE_CACHE).then((c) => c.match(req.url));
      if (off) return off;
      const tc = await caches.open(TILE_CACHE);
      const hit = await tc.match(req.url);
      if (hit) return hit;
      try {
        // CORS (no opaque) para que el navegador cuente el tamaño real en la cuota
        let res;
        try { res = await fetch(req.url, { mode: 'cors' }); } catch { res = await fetch(req); }
        if (res.ok) { tc.put(req.url, res.clone()); trimTiles(); }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (url.origin === location.origin) {
    // Navegación y recursos de la app: red primero (para recibir actualizaciones), caché si no hay conexión
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(APP_CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
  }
});
