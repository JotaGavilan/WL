// Extrae de una página de ruta de Wikiloc (HTML) el track, los puntos de interés,
// las estadísticas y la descripción. Sin dependencias ni DOM: funciona en navegador, Node y Workers.
//
// Cómo guarda Wikiloc los datos (comprobado en una página real):
//  - Un script inline define  var mapData = {"mapData":[{ "geom":"<TWKB en base64>", "trackStartTimestamp":…, "loop":…, … }],
//    "waypoints":[{ name, lat, lon, elevation, pictogramName, timestamp, photos… }]}.
//  - El TWKB trae 4 dimensiones: lon, lat, altitud (m, 1 decimal) y hora (ms epoch).
//  - Estadísticas en <dl class="data-items"> y <dl class="more-data">; descripción en <div class="description">.
// Es el formato interno actual de Wikiloc: puede cambiar sin aviso.

/* ---------- TWKB ---------- */

export function decodeTwkb(bytes) {
  let c = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do {
      if (c >= bytes.length) throw new Error('TWKB truncado.');
      b = bytes[c++];
      v += (b & 127) * mul; // sin operadores de bits: evita el límite de 32 bits (las horas son ms epoch)
      mul *= 128;
    } while (b & 128);
    return v;
  };
  const zig = () => { const v = varint(); return v % 2 === 0 ? v / 2 : -(v + 1) / 2; };

  const f1 = bytes[c++];
  const type = f1 & 15;
  const pz = (f1 >> 4);
  const precXY = pz % 2 === 0 ? pz / 2 : -(pz + 1) / 2;
  if (type !== 2) throw new Error(`Tipo TWKB no soportado (${type}); se esperaba LineString.`);
  const f2 = bytes[c++];
  const hasBbox = f2 & 1, hasSize = (f2 >> 1) & 1, hasIds = (f2 >> 2) & 1, ext = (f2 >> 3) & 1, empty = (f2 >> 4) & 1;
  let hasZ = 0, hasM = 0, precZ = 0, precM = 0;
  if (ext) {
    const e = bytes[c++];
    hasZ = e & 1; hasM = (e >> 1) & 1; precZ = (e >> 2) & 7; precM = (e >> 5) & 7;
  }
  if (empty) return [];
  const nd = 2 + hasZ + hasM;
  if (hasSize) varint();
  if (hasBbox) for (let i = 0; i < nd; i++) { zig(); zig(); }
  if (hasIds) throw new Error('TWKB con lista de ids no soportado.');
  const n = varint();
  const fac = [10 ** precXY, 10 ** precXY];
  if (hasZ) fac.push(10 ** precZ);
  if (hasM) fac.push(10 ** precM);
  const ref = new Array(nd).fill(0);
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < nd; j++) ref[j] += zig();
    const p = { lon: ref[0] / fac[0], lat: ref[1] / fac[1] };
    if (hasZ) p.ele = ref[2] / fac[2];
    if (hasM) p.time = Math.round(ref[2 + hasZ] / fac[2 + hasZ]);
    pts[i] = p;
  }
  return pts;
}

export function base64ToBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

/* ---------- utilidades de texto/JSON ---------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', acute: '´' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function htmlToText(h) {
  return decodeEntities(
    h.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Devuelve el texto JSON de un array/objeto balanceado que empieza en `start` (respeta cadenas). */
function balanced(src, start) {
  const open = src[start], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function jsonArrayAfter(src, key, from = 0) {
  const k = src.indexOf(`"${key}":[`, from);
  if (k < 0) return null;
  const txt = balanced(src, k + key.length + 3);
  if (!txt) return null;
  try { return { value: JSON.parse(txt), end: k + key.length + 3 + txt.length }; } catch { return null; }
}

/* ---------- extracción ---------- */

function parseNumber(s) {
  // "17,07" (es) · "2.099" (miles, es) · "17.07" (en) · "1,234" (miles, en)
  const m = s.replace(/ /g, ' ').match(/-?\d[\d.,]*/);
  if (!m) return null;
  let t = m[0];
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    t = dec === '.' ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (lastDot >= 0) {
    t = /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t;
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function readDl(html, cls) {
  const m = html.match(new RegExp(`<dl[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</dl>`, 'i'));
  if (!m) return [];
  const out = [];
  const re = /<div[^>]*class="[^"]*\bd-item\b[^"]*"[^>]*>\s*<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let r;
  while ((r = re.exec(m[1]))) out.push([htmlToText(r[1]), htmlToText(r[2])]);
  return out;
}

const ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Estadísticas tal y como las muestra Wikiloc (posiciones fijas del <dl>, independientes del idioma). */
function extractStats(html) {
  const items = readDl(html, 'data-items');
  const more = readDl(html, 'more-data');
  const st = {};
  // Orden estable de Wikiloc: distancia, tipo, desnivel +, desnivel −, alt. máx., alt. mín., dificultad, TrailRank
  const num = (i) => (items[i] ? parseNumber(items[i][1]) : null);
  st.distanceKm = num(0);
  st.routeType = items[1]?.[1] || null;
  st.ascent = num(2);
  st.descent = num(3);
  st.maxEle = num(4);
  st.minEle = num(5);
  st.difficulty = items[6]?.[1] || null;
  const rank = items[7]?.[1]?.match(/(\d+)\s+(\d+(?:[.,]\d+)?)/);
  if (rank) { st.trailRank = parseInt(rank[1], 10); st.rating = parseNumber(rank[2]); }
  const t = more[0]?.[1];
  if (t) {
    const h = t.match(/(\d+)\s*(?:h|hora|horas|hour|hours|heure|heures|ora|ore|Std|Stunden?)/i);
    const mi = t.match(/(\d+)\s*(?:min|minuto|minutos|minute|minutes|minuti|Minuten?)/i);
    if (h || mi) st.movingTimeS = ((h ? +h[1] : 0) * 60 + (mi ? +mi[1] : 0)) * 60;
    st.timeText = t;
  }
  st.uploadDate = more[2]?.[1] || null;
  st.recordedDate = more[3]?.[1] || null;
  return st;
}

function metaContent(html, prop) {
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return decodeEntities((a || b || [, ''])[1]).trim();
}

export function isWikilocPage(html) {
  return typeof html === 'string' && /"mapData":\[/.test(html) && /"geom":"/.test(html);
}

/**
 * Analiza una página de Wikiloc. Devuelve:
 * { title, description, url, location, author, sourceId, loop, startTime, points:[{lat,lon,ele,time}],
 *   waypoints:[{name,lat,lon,ele,type,time}], wikilocStats:{…} }
 */
export function parseWikilocPage(html) {
  if (!isWikilocPage(html)) throw new Error('El HTML no contiene un track de Wikiloc (¿página de ruta completa y guardada con la ruta cargada?).');

  const tr = jsonArrayAfter(html, 'mapData');
  const trail = tr?.value?.find((t) => t.geom && !t.waypoint) || tr?.value?.[0];
  if (!trail?.geom) throw new Error('No se encontró la geometría de la ruta en la página.');
  const points = decodeTwkb(base64ToBytes(trail.geom));
  if (points.length < 2) throw new Error('La ruta de la página no contiene puntos.');

  const wps = (jsonArrayAfter(html, 'waypoints', tr.end)?.value || [])
    .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon))
    .map((w) => ({
      name: w.name || '', lat: w.lat, lon: w.lon,
      ele: Number.isFinite(w.elevation) ? w.elevation : undefined,
      type: w.pictogramName || '', time: w.timestamp || undefined,
    }));

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = trail.nom ? decodeEntities(trail.nom) : h1 ? htmlToText(h1[1]) : metaContent(html, 'og:title');

  const dm = html.match(/<div[^>]*class="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const description = dm ? htmlToText(dm[1]) : '';

  // "… de Senderismo en Gabas, Aquitaine-Limousin-Poitou-Charentes (France)."
  const og = metaContent(html, 'og:description');
  const loc = og.match(/\ben ([^.]*?\([^)]+\))\./);
  const ownerName = html.match(/userDTOInput:\s*\{[\s\S]*?"name":\s*"([^"]*)"/);
  const url = metaContent(html, 'og:url') || (trail.prettyURL ? `https://www.wikiloc.com${trail.prettyURL}` : '');

  return {
    title, description, url,
    location: loc ? loc[1] : '',
    author: ownerName ? decodeEntities(ownerName[1]) : '',
    sourceId: String(trail.spaId || ''),
    loop: !!trail.loop,
    startTime: trail.trackStartTimestamp || points.find((p) => p.time)?.time || null,
    points, waypoints: wps,
    wikilocStats: extractStats(html),
  };
}
