// Geometría para la posición GPS: dónde está el usuario respecto al track.
// Sin dependencias; funciona en navegador y en Node.

const R = 6371008.8; // radio medio de la Tierra (m)
const rad = (x) => (x * Math.PI) / 180;

/** Distancia entre dos puntos (m). */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Proyecta la posición (lat, lon) sobre el track.
 * `points`: [{lat, lon, d}] con `d` = distancia acumulada desde el inicio (m).
 * Devuelve:
 *   d        distancia recorrida a lo largo del track en el punto más cercano (m)
 *   offTrack distancia desde la posición hasta el track (m)
 *   lat/lon  punto del track más cercano (sobre el segmento)
 *   ele      altitud interpolada en ese punto (si el track la tiene)
 *   idx      índice del segmento (entre idx e idx+1)
 *
 * Se proyecta sobre cada segmento (no solo sobre los vértices) para que la distancia
 * recorrida sea precisa aunque los puntos estén espaciados. Con un plano local
 * equirectangular, más que suficiente a escala de una ruta.
 */
export function projectOnTrack(points, lat, lon) {
  if (!points || points.length < 2) return null;
  const k = Math.cos(rad(lat));
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    // coordenadas locales en metros, con el origen en la posición
    const ax = rad(a.lon - lon) * k * R, ay = rad(a.lat - lat) * R;
    const bx = rad(b.lon - lon) * k * R, by = rad(b.lat - lat) * R;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const dist = Math.hypot(px, py);
    if (!best || dist < best.offTrack) best = { offTrack: dist, i, t, a, b };
  }
  const { a, b, t, i, offTrack } = best;
  const segLen = Number.isFinite(b.d) && Number.isFinite(a.d) ? b.d - a.d : distance(a, b);
  const out = {
    d: (Number.isFinite(a.d) ? a.d : 0) + t * segLen,
    offTrack,
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
    idx: i,
  };
  if (Number.isFinite(a.ele) && Number.isFinite(b.ele)) out.ele = a.ele + t * (b.ele - a.ele);
  return out;
}

/**
 * Resumen de progreso a partir de la proyección y la longitud total.
 * `accuracy` (m) es la precisión que da el GPS: se usa para no avisar de "fuera de ruta" por error de medida.
 */
export function progress(proj, total, accuracy = 0) {
  const done = Math.max(0, Math.min(total, proj.d));
  const margin = Math.max(50, 2 * (accuracy || 0));
  return {
    done,
    left: Math.max(0, total - done),
    pct: total > 0 ? (done / total) * 100 : 0,
    offTrack: proj.offTrack,
    isOff: proj.offTrack > margin,
  };
}
