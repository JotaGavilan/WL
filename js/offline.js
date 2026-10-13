// Guardado opcional de las teselas del mapa de la zona de una ruta, para verla con mapa sin conexión.
// (Sin esto, el track, el perfil y los datos ya funcionan sin conexión; solo faltaría el mapa de fondo.)
//
// Respeta a los servidores de teselas: pocas teselas (tope), peticiones espaciadas y solo bajo petición del usuario.

export const OFFLINE_CACHE = 'wt-offline-tiles';
export const MAX_TILES = 600;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export function tileUrl(template, subdomains, x, y, z) {
  const subs = subdomains || 'abc';
  const s = subs[(x + y) % subs.length];
  return template.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** Lista de URLs de teselas que cubren los límites [[sur,oeste],[norte,este]] entre zMin y zMax. */
export function tilesFor(bounds, template, { subdomains, zMin, zMax }) {
  const [[s, w], [n, e]] = bounds;
  const urls = [];
  for (let z = zMin; z <= zMax; z++) {
    const x0 = lon2x(w, z), x1 = lon2x(e, z), y0 = lat2y(n, z), y1 = lat2y(s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push(tileUrl(template, subdomains, x, y, z));
  }
  return urls;
}

/**
 * Elige el mayor zMax (≤ maxZoom) tal que todas las capas juntas quepan en MAX_TILES,
 * con un margen alrededor de la ruta. `layers`: [{ template, subdomains }] (p. ej. satélite + nombres).
 */
export function planTilesMulti(bounds, layers, { maxZoom = 15, minZoom = 11 } = {}) {
  const padLat = (bounds[1][0] - bounds[0][0]) * 0.1 + 0.002;
  const padLon = (bounds[1][1] - bounds[0][1]) * 0.1 + 0.002;
  const b = [[bounds[0][0] - padLat, bounds[0][1] - padLon], [bounds[1][0] + padLat, bounds[1][1] + padLon]];
  for (let zMax = maxZoom; zMax >= minZoom; zMax--) {
    const urls = layers.flatMap((l) => tilesFor(b, l.template, { subdomains: l.subdomains, zMin: Math.max(8, minZoom - 3), zMax }));
    if (urls.length <= MAX_TILES) return { urls, zMax };
  }
  return { urls: [], zMax: 0 };
}

/** Una sola capa (ver planTilesMulti). */
export function planTiles(bounds, template, { subdomains, maxZoom = 15, minZoom = 11 }) {
  return planTilesMulti(bounds, [{ template, subdomains }], { maxZoom, minZoom });
}

export const offlineSupported = () => typeof caches !== 'undefined';

/**
 * Descarga las teselas a la caché. onProgress(hechas, total). Devuelve las URLs guardadas.
 * Usa CORS (no "opaque") para que el navegador contabilice el tamaño real.
 */
export async function saveTiles(urls, onProgress, { signal } = {}) {
  const cache = await caches.open(OFFLINE_CACHE);
  const saved = [];
  let done = 0;
  const queue = [...urls];
  let tried = 0, failed = 0;
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const u = queue.shift();
      let ok = false;
      try {
        if (await cache.match(u)) ok = true;
        else {
          const res = await fetch(u, { mode: 'cors', signal });
          if (res.ok) { await cache.put(u, res); ok = true; }
        }
      } catch { /* se omite la tesela */ }
      tried++;
      if (ok) saved.push(u); else failed++;
      onProgress?.(++done, urls.length);
      // Sin conexión o servidor que rechaza las peticiones: no insistir con cientos de teselas
      if (tried >= 8 && failed === tried) queue.length = 0;
      await new Promise((r) => setTimeout(r, 60)); // espaciar peticiones
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return saved;
}

export async function deleteTiles(urls) {
  if (!offlineSupported()) return;
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all(urls.map((u) => cache.delete(u)));
}

/** Pide al navegador que no borre los datos de la app al faltar espacio. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignorar */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch { /* ignorar */ }
  return null;
}
