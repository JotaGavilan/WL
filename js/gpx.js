// Parser GPX y cálculo de estadísticas. Sin dependencias: funciona en navegador y en Node.

const R = 6371008.8; // radio medio de la Tierra (m)

export function haversine(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? parseFloat(m[1]) : NaN;
}

function parsePoints(xml, tagName) {
  const pts = [];
  const re = new RegExp(`<${tagName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tagName}>)`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const body = m[2] || '';
    const eleM = body.match(/<ele>\s*([-+0-9.eE]+)\s*<\/ele>/);
    const timeM = body.match(/<time>\s*([^<\s]+)\s*<\/time>/);
    const p = { lat, lon };
    if (eleM) {
      const e = parseFloat(eleM[1]);
      if (Number.isFinite(e)) p.ele = e;
    }
    if (timeM) {
      const t = Date.parse(timeM[1]);
      if (Number.isFinite(t)) p.time = t;
    }
    pts.push(p);
  }
  return pts;
}

/** Devuelve { name, points, waypoints }. Lanza Error si no hay puntos. */
export function parseGPX(xml) {
  if (typeof xml !== 'string' || !/<gpx\b/i.test(xml)) {
    throw new Error('El archivo no parece un GPX válido.');
  }
  let points = parsePoints(xml, 'trkpt');
  if (points.length < 2) points = parsePoints(xml, 'rtept');
  if (points.length < 2) throw new Error('El GPX no contiene un track con puntos.');

  // Nombre: primero el del track/ruta, luego el de metadata
  let name = '';
  const trk = xml.match(/<trk\b[\s\S]*?<name>([\s\S]*?)<\/name>/) || xml.match(/<rte\b[\s\S]*?<name>([\s\S]*?)<\/name>/);
  const meta = xml.match(/<metadata\b[\s\S]*?<name>([\s\S]*?)<\/name>/);
  if (trk) name = decodeXml(trk[1]);
  else if (meta) name = decodeXml(meta[1]);

  const waypoints = [];
  const wre = /<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/g;
  let wm;
  while ((wm = wre.exec(xml))) {
    const lat = attr(wm[1], 'lat'), lon = attr(wm[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const body = wm[2] || '';
    const w = { lat, lon };
    const nm = body.match(/<name>([\s\S]*?)<\/name>/);
    if (nm) w.name = decodeXml(nm[1]);
    const el = body.match(/<ele>\s*([-+0-9.eE]+)\s*<\/ele>/);
    if (el && Number.isFinite(parseFloat(el[1]))) w.ele = parseFloat(el[1]);
    const tm = body.match(/<time>\s*([^<\s]+)\s*<\/time>/);
    if (tm && Number.isFinite(Date.parse(tm[1]))) w.time = Date.parse(tm[1]);
    waypoints.push(w);
  }
  return { name, points, waypoints };
}

/**
 * Calcula distancia acumulada por punto y estadísticas.
 * Desnivel con umbral de histéresis (por defecto 3 m) para filtrar ruido del GPS/barómetro.
 */
export function computeStats(points, { threshold = 3 } = {}) {
  let dist = 0;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    dist += haversine(points[i - 1], points[i]);
    cum.push(dist);
  }

  const eles = points.map((p) => p.ele).filter((e) => Number.isFinite(e));
  const hasEle = eles.length >= 2;
  let ascent = 0, descent = 0, minEle = null, maxEle = null;
  if (hasEle) {
    minEle = Math.min(...eles);
    maxEle = Math.max(...eles);
    let ref = eles[0];
    for (const e of eles) {
      if (e - ref >= threshold) { ascent += e - ref; ref = e; }
      else if (ref - e >= threshold) { descent += ref - e; ref = e; }
    }
  }

  const t0 = points.find((p) => p.time)?.time;
  const t1 = [...points].reverse().find((p) => p.time)?.time;
  const duration = t0 && t1 && t1 > t0 ? (t1 - t0) / 1000 : null;

  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const bounds = [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];

  return {
    distance: dist, // m
    ascent: hasEle ? ascent : null,
    descent: hasEle ? descent : null,
    minEle,
    maxEle,
    duration, // s
    pointCount: points.length,
    bounds,
    startTime: t0 || null,
    cumDistances: cum,
  };
}

/** Perfil de elevación reducido: [{d (m), ele (m)}] con como máximo `max` puntos. */
export function buildProfile(points, cum, max = 600) {
  const out = [];
  const withEle = points.map((p, i) => ({ d: cum[i], ele: p.ele })).filter((p) => Number.isFinite(p.ele));
  if (withEle.length === 0) return out;
  const step = Math.max(1, Math.ceil(withEle.length / max));
  for (let i = 0; i < withEle.length; i += step) out.push(withEle[i]);
  const last = withEle[withEle.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Índice del punto del track más cercano a (lat, lon). Aproximación equirectangular: suficiente para elegir punto. */
export function nearestIndex(points, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = 0, bd = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dy = points[i].lat - lat, dx = (points[i].lon - lon) * k;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function toGPX(route) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wpts = (route.waypoints || [])
    .map((w) =>
      `  <wpt lat="${w.lat}" lon="${w.lon}">` +
      (Number.isFinite(w.ele) ? `<ele>${w.ele}</ele>` : '') +
      (w.time ? `<time>${new Date(w.time).toISOString()}</time>` : '') +
      `<name>${esc(w.name)}</name>` +
      (w.type ? `<type>${esc(w.type)}</type>` : '') +
      '</wpt>')
    .join('\n');
  const pts = route.points
    .map((p) => {
      let s = `      <trkpt lat="${p.lat}" lon="${p.lon}">`;
      if (Number.isFinite(p.ele)) s += `<ele>${p.ele}</ele>`;
      if (p.time) s += `<time>${new Date(p.time).toISOString()}</time>`;
      return s + '</trkpt>';
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wikiloc Tracks" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(route.name)}</name></metadata>
${wpts ? wpts + '\n' : ''}  <trk>
    <name>${esc(route.name)}</name>${route.description ? `\n    <desc>${esc(route.description)}</desc>` : ''}
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function toKML(route) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const marks = (route.waypoints || [])
    .map((w) => `    <Placemark><name>${esc(w.name)}</name><Point><coordinates>${w.lon},${w.lat},${Number.isFinite(w.ele) ? w.ele : 0}</coordinates></Point></Placemark>`)
    .join('\n');
  const coords = route.points.map((p) => `${p.lon},${p.lat},${Number.isFinite(p.ele) ? p.ele : 0}`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(route.name)}</name>
${marks ? marks + '\n' : ''}    <Placemark>
      <name>${esc(route.name)}</name>${route.description ? `\n      <description>${esc(route.description)}</description>` : ''}
      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
    </Placemark>
  </Document>
</kml>
`;
}

const NF = (min, max) => new Intl.NumberFormat('es-ES', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: 'always' });
const nf0 = NF(0, 0), nf2 = NF(2, 2);

export function formatDistance(m) {
  if (!Number.isFinite(m)) return '–';
  return m >= 1000 ? `${nf2.format(m / 1000)} km` : `${nf0.format(Math.round(m))} m`;
}

export function formatDuration(s) {
  if (!Number.isFinite(s)) return '–';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function formatEle(m) {
  return Number.isFinite(m) ? `${nf0.format(Math.round(m))} m` : '–';
}
