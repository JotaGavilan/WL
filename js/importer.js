// Importación de rutas: página de Wikiloc (HTML), archivo GPX o URL (vía proxy opcional).
// Todo lo extraído se devuelve como un objeto "ruta" autosuficiente que se guarda en IndexedDB,
// de modo que después se puede consultar sin conexión.

import { parseGPX, computeStats, buildProfile, nearestIndex } from './gpx.js';
import { parseWikilocPage, isWikilocPage } from './wikiloc-page.js';
import { newId } from './db.js';

export const SETTINGS_KEY = 'wt-settings';

export function getSettings() {
  try {
    return { proxyUrl: '', ...(globalThis.WT_CONFIG || {}), ...JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { proxyUrl: '', ...(globalThis.WT_CONFIG || {}) };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* sin almacenamiento */ }
}

export function isWikilocUrl(u) {
  try {
    const url = new URL(u.trim());
    return /(^|\.)wikiloc\.com$/i.test(url.hostname) && /-\d+(?:[/?#]|$)/.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

/**
 * Construye la ruta que se almacena.
 * @param {object} o  { name, points, sourceUrl, waypoints, description, info, wikilocStats, id }
 */
export function buildRoute({ name, points, sourceUrl, waypoints = [], description = '', info = {}, wikilocStats = null, id }) {
  const stats = computeStats(points);
  const profile = buildProfile(points, stats.cumDistances);
  const { cumDistances, ...cleanStats } = stats;

  // Si la página de Wikiloc aporta cifras de desnivel/altitud, son las que verá el usuario en Wikiloc:
  // se usan como principales y se conservan las calculadas aparte.
  if (wikilocStats) {
    cleanStats.calc = { ascent: cleanStats.ascent, descent: cleanStats.descent, minEle: cleanStats.minEle, maxEle: cleanStats.maxEle };
    for (const k of ['ascent', 'descent', 'minEle', 'maxEle']) {
      if (Number.isFinite(wikilocStats[k])) cleanStats[k] = wikilocStats[k];
    }
  }

  const pts = points.map((p, i) => ({ ...p, d: Math.round(cumDistances[i] * 10) / 10 }));
  const wps = waypoints.map((w) => {
    const i = nearestIndex(points, w.lat, w.lon);
    return { ...w, d: pts[i].d, idx: i };
  });

  return {
    id: id || newId(),
    name: name || 'Ruta sin nombre',
    sourceUrl: sourceUrl || '',
    createdAt: Date.now(),
    points: pts,
    waypoints: wps,
    description,
    info,
    wikilocStats,
    profile,
    stats: cleanStats,
  };
}

export function routeFromGpxText(text, { sourceUrl, fallbackName } = {}) {
  const { name, points, waypoints } = parseGPX(text);
  const wps = (waypoints || []).map((w, i) => ({ name: w.name || `Punto ${i + 1}`, lat: w.lat, lon: w.lon, ele: w.ele, type: '', time: w.time }));
  return buildRoute({ name: name || fallbackName, points, sourceUrl, waypoints: wps });
}

/** Ruta a partir del HTML de una página de Wikiloc (guardada, pegada o enviada por el marcador). */
export function routeFromWikilocHtml(html, { sourceUrl } = {}) {
  const page = parseWikilocPage(html);
  const ws = page.wikilocStats;
  return buildRoute({
    id: page.sourceId ? `wikiloc-${page.sourceId}` : undefined, // reimportar la misma ruta la sustituye
    name: page.title,
    points: page.points,
    waypoints: page.waypoints,
    description: page.description,
    sourceUrl: sourceUrl || page.url,
    wikilocStats: ws,
    info: {
      location: page.location,
      author: page.author,
      loop: page.loop,
      routeType: ws.routeType,
      difficulty: ws.difficulty,
      trailRank: ws.trailRank,
      rating: ws.rating,
      recordedDate: ws.recordedDate,
      uploadDate: ws.uploadDate,
      timeText: ws.timeText,
    },
  });
}

/** Detecta qué es el texto de un archivo y devuelve la ruta. */
export function routeFromFileText(text, { fileName = '', sourceUrl } = {}) {
  if (isWikilocPage(text)) return routeFromWikilocHtml(text, { sourceUrl });
  if (/<gpx\b/i.test(text)) return routeFromGpxText(text, { sourceUrl, fallbackName: fileName.replace(/\.gpx$/i, '') });
  throw new Error('No reconozco el archivo: debe ser un GPX o la página de una ruta de Wikiloc guardada con «Guardar como… → Página web completa».');
}

/**
 * Importación por URL mediante el proxy opcional (ver worker/).
 * Devuelve { route } o { needFile: true, message }.
 */
export async function importFromUrl(url) {
  const { proxyUrl } = getSettings();
  if (!proxyUrl) {
    const err = new Error('Falta configurar la URL del proxy (Ajustes).');
    err.code = 'NO_PROXY';
    throw err;
  }
  if (!isWikilocUrl(url)) throw new Error('La URL no parece una ruta de Wikiloc (debe terminar en un número de ruta).');

  let res;
  try {
    res = await fetch(`${proxyUrl.replace(/\/$/, '')}/?url=${encodeURIComponent(url.trim())}`);
  } catch {
    throw new Error('No se pudo contactar con el proxy. Revisa su URL en Ajustes.');
  }
  let data;
  try { data = await res.json(); } catch { throw new Error(`Respuesta no válida del proxy (HTTP ${res.status}).`); }

  if (data.html) return { route: routeFromWikilocHtml(data.html, { sourceUrl: url.trim() }) };
  if (data.gpx) return { route: routeFromGpxText(data.gpx, { sourceUrl: url.trim(), fallbackName: data.meta?.title }) };
  return { needFile: true, message: data.error || 'No se pudo obtener el track automáticamente.' };
}
