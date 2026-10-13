import { db } from './db.js';
import { toGPX, toKML, nearestIndex, formatDistance, formatDuration, formatEle } from './gpx.js';
import { drawProfile } from './profile.js';
import { createGps } from './gps.js';
import {
  importFromUrl, routeFromFileText, getSettings, saveSettings, isWikilocUrl,
} from './importer.js';
import {
  planTilesMulti, saveTiles, deleteTiles, offlineSupported, requestPersistence, storageEstimate, MAX_TILES,
} from './offline.js';

const $ = (id) => document.getElementById(id);
const L = window.L;

let routes = [];
let current = null;
let map, baseLayers, labelsLayer, activeBaseName, trackLayer, hoverMarker, profileCtl, poiMarkers = [], gps;
let hasTiles = true;

/* ---------- utilidades ---------- */
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'ruta';

function icon(cls) {
  return L.divIcon({ className: '', html: `<div class="pt-marker ${cls}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

/* ---------- mapa ---------- */
const ESRI = 'Tiles © <a href="https://www.esri.com">Esri</a> — Esri, Maxar, Earthstar Geographics, USGS, NGA, HERE, DeLorme';
const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const BASE_RENAMES = { 'OpenStreetMap': 'Calles (OpenStreetMap)' }; // nombres de versiones anteriores
const BASE_DEFAULT = 'Topográfico (OpenTopoMap)';
const LABELS_NAME = 'Nombres y lugares (sobre satélite)';

function initMap() {
  // maxZoom 20 con maxNativeZoom por capa: más allá del zoom nativo el mapa se amplía (sobrezoom) para ver de muy cerca
  map = L.map('map', { zoomControl: true, maxZoom: 20 }).setView([40.4, -3.7], 5);
  baseLayers = {
    'Calles (OpenStreetMap)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 19, attribution: OSM,
    }),
    'Topográfico (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, maxNativeZoom: 17, subdomains: 'abc',
      attribution: `${OSM}, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    }),
    'Topográfico (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19, attribution: ESRI,
    }),
    'Satélite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 18, attribution: ESRI,
    }),
  };
  labelsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, maxNativeZoom: 18, zIndex: 5, attribution: ESRI,
  });

  const rd = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const wr = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignorar */ } };
  const saved = BASE_RENAMES[rd('wt-base')] || rd('wt-base');
  activeBaseName = baseLayers[saved] ? saved : BASE_DEFAULT;
  baseLayers[activeBaseName].addTo(map);
  if (rd('wt-labels') === '1') labelsLayer.addTo(map);

  // En pantallas anchas el selector de fondos se muestra desplegado; en móvil, plegado
  L.control.layers(baseLayers, { [LABELS_NAME]: labelsLayer }, { position: 'topright', collapsed: window.innerWidth <= 760 }).addTo(map);
  map.on('baselayerchange', (e) => { activeBaseName = e.name; wr('wt-base', e.name); refreshOfflineBox(); });
  map.on('overlayadd', (e) => { if (e.layer === labelsLayer) { wr('wt-labels', '1'); refreshOfflineBox(); } });
  map.on('overlayremove', (e) => { if (e.layer === labelsLayer) { wr('wt-labels', '0'); refreshOfflineBox(); } });
  L.control.scale({ metric: true, imperial: false }).addTo(map);
  // Sin conexión y sin teselas guardadas el fondo queda gris, pero el track se dibuja igual
  for (const l of [...Object.values(baseLayers), labelsLayer]) l.on('tileerror', () => { hasTiles = false; });
}

/** Botones del mapa: ver la ruta completa y acercar a la posición del usuario (GPS). */
function addMapButtons() {
  const Buttons = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar wt-mapbtns');
      const mk = (txt, title, fn) => {
        const a = L.DomUtil.create('a', '', bar);
        a.href = '#'; a.textContent = txt; a.title = title;
        a.setAttribute('role', 'button'); a.setAttribute('aria-label', title);
        L.DomEvent.on(a, 'click', (ev) => { L.DomEvent.preventDefault(ev); L.DomEvent.stopPropagation(ev); fn(); });
        return a;
      };
      mk('⤢', 'Ver la ruta completa', () => { if (current) map.fitBounds(current.stats.bounds, { padding: [30, 30] }); });
      mk('◎', 'Mi posición (GPS): activar y acercar', () => gps.centerOnMe());
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    },
  });
  new Buttons().addTo(map);
}

function clearHover() {
  if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; }
}

function setHover(d, { fromMap = false } = {}) {
  if (d == null || !current) { clearHover(); if (!fromMap) return; profileCtl?.setCursor(null); return; }
  const p = pointAtDistance(current, d);
  if (!hoverMarker) hoverMarker = L.marker([p.lat, p.lon], { icon: icon('pt-hover'), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
  else hoverMarker.setLatLng([p.lat, p.lon]);
  if (fromMap) profileCtl?.setCursor(p.d);
}

function pointAtDistance(route, d) {
  const pts = route.points;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d < d) lo = mid; else hi = mid;
  }
  return Math.abs(pts[lo].d - d) <= Math.abs(pts[hi].d - d) ? pts[lo] : pts[hi];
}

function showOnMap(route) {
  if (trackLayer) trackLayer.remove();
  clearHover();
  poiMarkers = [];
  const latlngs = route.points.map((p) => [p.lat, p.lon]);
  const line = L.polyline(latlngs, { color: '#e8590c', weight: 4, opacity: 0.9, interactive: false });
  // Capa invisible más ancha para que el ratón/dedo acierte fácilmente y sincronice con el perfil
  const hit = L.polyline(latlngs, { color: '#000', weight: 24, opacity: 0, bubblingMouseEvents: false });
  const onMove = (e) => {
    const i = nearestIndex(route.points, e.latlng.lat, e.latlng.lng);
    setHover(route.points[i].d, { fromMap: true });
  };
  hit.on('mousemove', onMove);
  hit.on('click', onMove);
  hit.on('mouseout', () => setHover(null, { fromMap: true }));

  const start = L.marker(latlngs[0], { icon: icon('pt-start'), title: 'Inicio' });
  const end = L.marker(latlngs[latlngs.length - 1], { icon: icon('pt-end'), title: 'Fin' });
  const layers = [line, hit, start, end];

  (route.waypoints || []).forEach((w, i) => {
    const m = L.marker([w.lat, w.lon], { icon: icon('pt-poi'), title: w.name });
    const box = document.createElement('div');
    const b = document.createElement('b'); b.textContent = `${i + 1}. ${w.name || 'Punto'}`;
    box.append(b);
    const lines = [w.type, Number.isFinite(w.ele) ? `${Math.round(w.ele)} m` : '', Number.isFinite(w.d) ? `km ${(w.d / 1000).toFixed(2)}` : '', w.time ? fmtTime(w.time) : ''].filter(Boolean);
    if (lines.length) { const p = document.createElement('div'); p.textContent = lines.join(' · '); box.append(p); }
    m.bindPopup(box);
    m.on('click', () => profileCtl?.setCursor(w.d));
    poiMarkers.push(m);
    layers.push(m);
  });

  trackLayer = L.layerGroup(layers).addTo(map);
  map.fitBounds(route.stats.bounds, { padding: [30, 30] });
}

/* ---------- Google Maps (enlace de direcciones aproximado, sin clave de API) ---------- */
function googleMapsUrl(route) {
  const pts = route.points;
  const f = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const n = 8;
  const way = [];
  for (let i = 1; i <= n; i++) way.push(f(pts[Math.round((i * (pts.length - 1)) / (n + 1))]));
  const q = new URLSearchParams({ api: '1', origin: f(pts[0]), destination: f(pts[pts.length - 1]), travelmode: 'walking' });
  return `https://www.google.com/maps/dir/?${q}&waypoints=${way.map(encodeURIComponent).join('%7C')}`;
}

/* ---------- pantalla «Mis rutas» ---------- */
const newIds = new Set(); // rutas importadas en esta sesión (llevan la etiqueta «Nueva»)
let sortKey = (() => { try { return localStorage.getItem('wt-sort') || 'recent'; } catch { return 'recent'; } })();
let galleryScroll = 0;

const SORTS = {
  recent: (a, b) => b.createdAt - a.createdAt,
  name: (a, b) => a.name.localeCompare(b.name, 'es'),
  distance: (a, b) => b.stats.distance - a.stats.distance,
  ascent: (a, b) => (b.stats.ascent ?? -1) - (a.stats.ascent ?? -1),
};

/** Miniatura: la forma del recorrido dibujada en SVG (funciona sin conexión y sin cargar mapas). */
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => { const e = document.createElementNS(SVG_NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const thumbCache = new Map();
function thumb(r) {
  const key = `${r.id}|${r.createdAt}`;
  if (!thumbCache.has(key)) {
    const [[south, west], [north, east]] = r.stats.bounds;
    const W = 200, H = 120, P = 12;
    const k = Math.cos((((south + north) / 2) * Math.PI) / 180);
    const dx = Math.max((east - west) * k, 1e-6), dy = Math.max(north - south, 1e-6);
    const sc = Math.min((W - 2 * P) / dx, (H - 2 * P) / dy);
    const ox = (W - dx * sc) / 2, oy = (H - dy * sc) / 2;
    const X = (lon) => (ox + (lon - west) * k * sc).toFixed(1);
    const Y = (lat) => (oy + (north - lat) * sc).toFixed(1);
    const pts = r.points, step = Math.max(1, Math.floor(pts.length / 160));
    let d = '';
    for (let i = 0; i < pts.length; i += step) d += `${i ? 'L' : 'M'}${X(pts[i].lon)} ${Y(pts[i].lat)}`;
    const a = pts[0], z = pts[pts.length - 1];
    d += `L${X(z.lon)} ${Y(z.lat)}`;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Forma del recorrido de ${r.name}` });
    svg.append(
      svgEl('path', { d, class: 't-line' }),
      svgEl('circle', { cx: X(z.lon), cy: Y(z.lat), r: 4.5, class: 't-end' }),
      svgEl('circle', { cx: X(a.lon), cy: Y(a.lat), r: 4.5, class: 't-start' }),
    );
    thumbCache.set(key, svg);
  }
  return thumbCache.get(key).cloneNode(true);
}

function routeCard(r) {
  const info = r.info || {};
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `#${encodeURIComponent(r.id)}`;

  const th = document.createElement('div');
  th.className = 'thumb';
  th.append(thumb(r));
  const badges = document.createElement('div');
  badges.className = 'badges';
  const badge = (txt, cls) => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = txt; badges.append(b); };
  if (newIds.has(r.id)) badge('Nueva', 'new');
  if (r.offline) badge('✓ Mapa guardado', 'ok');
  if (badges.childNodes.length) th.append(badges);

  const body = document.createElement('div');
  body.className = 'c-body';
  const h = document.createElement('h3');
  h.className = 'c-name';
  h.textContent = r.name;
  body.append(h);
  const sub = [info.location, info.author && `por ${info.author}`].filter(Boolean).join(' · ');
  if (sub) { const p = document.createElement('p'); p.className = 'c-sub'; p.textContent = sub; p.title = sub; body.append(p); }

  const s = r.stats;
  const chips = [formatDistance(s.distance)];
  if (s.ascent != null) chips.push(`↑ ${Math.round(s.ascent)} m`);
  if (s.duration) chips.push(formatDuration(s.duration)); else if (info.timeText) chips.push(info.timeText);
  const kind = info.routeType || (info.loop ? 'Circular' : '');
  if (kind) chips.push(kind);
  const ul = document.createElement('ul');
  ul.className = 'chips';
  for (const c of chips) { const c2 = document.createElement('li'); c2.textContent = c; ul.append(c2); }
  body.append(ul);

  a.append(th, body);
  li.append(a);
  return li;
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const shown = routes
    .filter((r) => [r.name, r.info?.location, r.info?.author].filter(Boolean).join(' ').toLowerCase().includes(q))
    .sort(SORTS[sortKey] || SORTS.recent);
  const ul = $('route-list');
  ul.textContent = '';
  ul.hidden = routes.length === 0;
  $('empty').hidden = routes.length > 0;
  $('search').parentElement.hidden = routes.length === 0;
  const n = routes.length;
  $('count').textContent = !n ? '' : q ? `· ${shown.length} de ${n}` : `· ${n} ${n === 1 ? 'ruta' : 'rutas'}`;
  for (const r of shown) ul.append(routeCard(r));
  if (n && !shown.length) {
    const li = document.createElement('li');
    li.className = 'none muted';
    li.textContent = 'Ninguna ruta coincide con la búsqueda.';
    ul.append(li);
  }
}

function statItems(route) {
  const s = route.stats, info = route.info || {};
  const items = [
    ['Distancia', formatDistance(s.distance)],
    ['Tipo de ruta', info.routeType || (info.loop ? 'Circular' : '–')],
    ['Desnivel positivo', s.ascent != null ? formatEle(s.ascent) : '–'],
    ['Desnivel negativo', s.descent != null ? formatEle(s.descent) : '–'],
    ['Altitud máxima', formatEle(s.maxEle)],
    ['Altitud mínima', formatEle(s.minEle)],
  ];
  if (info.difficulty) items.push(['Dificultad', info.difficulty]);
  if (s.duration) items.push(['Tiempo', formatDuration(s.duration)]);
  else if (info.timeText) items.push(['Tiempo', info.timeText]);
  if (info.trailRank != null) items.push(['TrailRank', `${info.trailRank}${info.rating ? ` · ★ ${String(info.rating).replace('.', ',')}` : ''}`]);
  items.push(['Puntos del track', String(s.pointCount)]);
  return items;
}

function renderDetail(route) {
  $('detail').hidden = false;
  $('d-name').textContent = route.name;
  const info = route.info || {};
  $('d-sub').textContent = [info.location, info.author && `por ${info.author}`, info.recordedDate && `realizada ${info.recordedDate}`].filter(Boolean).join(' · ');

  const dl = $('stats');
  dl.textContent = '';
  for (const [k, v] of statItems(route)) {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    div.append(dt, dd);
    dl.appendChild(div);
  }

  $('d-gmaps').href = googleMapsUrl(route);
  const src = $('d-src');
  if (route.sourceUrl && isWikilocUrl(route.sourceUrl)) { src.href = route.sourceUrl; src.removeAttribute('aria-disabled'); }
  else { src.removeAttribute('href'); src.setAttribute('aria-disabled', 'true'); }

  // Puntos de interés
  const wps = route.waypoints || [];
  $('poi-wrap').hidden = wps.length === 0;
  const ol = $('poi-list');
  ol.textContent = '';
  wps.forEach((w, i) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
    const t = document.createElement('span'); t.textContent = w.name || 'Punto';
    const m = document.createElement('span'); m.className = 'm';
    m.textContent = [w.type, Number.isFinite(w.ele) ? `${Math.round(w.ele)} m` : '', Number.isFinite(w.d) ? `km ${(w.d / 1000).toFixed(1)}` : ''].filter(Boolean).join(' · ');
    li.append(n, t, m);
    const go = () => {
      map.setView([w.lat, w.lon], Math.max(map.getZoom(), 15));
      poiMarkers[i]?.openPopup();
      profileCtl?.setCursor(w.d);
    };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    ol.appendChild(li);
  });

  // Descripción del itinerario
  $('desc-wrap').hidden = !route.description;
  $('d-desc').textContent = route.description || '';

  profileCtl?.destroy();
  profileCtl = drawProfile($('profile'), route.profile, {
    waypoints: wps,
    onHover: (d) => setHover(d),
  });
  gps?.refresh();
  refreshOfflineBox();
}

/* ---------- navegación: «Mis rutas» ↔ ruta abierta (con la dirección, así el botón Atrás vuelve a la lista) ---------- */
const hashId = () => {
  let h = '';
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { /* dirección mal formada */ }
  return h === 'importar' ? '' : h;
};

function openRoute(id) {
  const target = `#${encodeURIComponent(id)}`;
  if (location.hash === target) render(); // ya está en esa dirección: solo repintar
  else location.hash = target;             // crea una entrada en el historial; hashchange → render()
}

function goGallery() {
  if (location.hash && location.hash !== '#') location.hash = '';
  else render();
}

function showGallery() {
  if (!$('gallery').hidden === false) { /* ya visible */ }
  document.body.classList.remove('in-route');
  $('gallery').hidden = false;
  $('routeview').hidden = true;
  $('route-nav').hidden = true;
  $('gallery').scrollTop = galleryScroll;
  current = null;
  clearHover();
  gps?.refresh();
  document.title = 'Wikiloc Tracks';
}

async function showRoute(r) {
  if (!$('gallery').hidden) galleryScroll = $('gallery').scrollTop;
  document.body.classList.add('in-route');
  $('gallery').hidden = true;
  $('routeview').hidden = false;
  $('route-nav').hidden = false;
  current = r;
  map.invalidateSize({ animate: false }); // el mapa estaba oculto: recalcular su tamaño antes de encuadrar
  fillJump();
  showOnMap(r);
  renderDetail(r);
  gps?.onRouteChange();
  $('detail').scrollTop = 0;
  document.title = `${r.name} · Wikiloc Tracks`;
  setTimeout(() => map.invalidateSize(), 60);
}

/** Pinta lo que indique la dirección: una ruta guardada o, si no hay, la pantalla «Mis rutas». */
async function render() {
  if (location.hash === '#importar') announceReady();
  const id = hashId();
  const r = id ? routes.find((x) => x.id === id) || (await db.get(id)) : null;
  if (r) await showRoute(r); else showGallery();
}

/** Selector para saltar a otra ruta sin pasar por la lista. */
function fillJump() {
  const sel = $('route-jump');
  sel.textContent = '';
  for (const r of [...routes].sort(SORTS.name)) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.name;
    sel.append(o);
  }
  if (current) sel.value = current.id;
}

async function refresh() {
  routes = await db.all();
  renderList();
  fillJump();
  updateStorageNote();
}

async function updateStorageNote() {
  const est = await storageEstimate();
  const mb = est ? ` · ${(est.usage / 1048576).toFixed(1)} MB usados` : '';
  $('storage-note').textContent = routes.length ? `Guardado en este dispositivo${mb}. Funciona sin conexión.` : '';
}

/* ---------- uso sin conexión: mapas de la zona ---------- */
function layerSpec(layer) {
  return { template: layer._url, subdomains: layer.options.subdomains, maxZoom: layer.options.maxNativeZoom ?? layer.options.maxZoom };
}

/** Capas que se guardan: la de fondo activa y, si está activada, la de nombres. */
function layersToSave() {
  const withLabels = map.hasLayer(labelsLayer);
  const specs = [layerSpec(baseLayers[activeBaseName]), ...(withLabels ? [layerSpec(labelsLayer)] : [])];
  return { specs, withLabels, label: activeBaseName + (withLabels ? ' + nombres' : '') };
}

function refreshOfflineBox() {
  if (!current) return;
  const o = current.offline;
  const supported = offlineSupported();
  $('off-save').disabled = !supported;
  $('off-del').hidden = !o;
  const base = 'El track, el perfil, las estadísticas y la descripción ya están guardados en el dispositivo y se ven sin conexión.';
  $('off-state').textContent = o
    ? `${base} Mapa de fondo guardado: ${o.layer}, ${o.urls.length} teselas (hasta zoom ${o.zMax}).`
    : `${base} Para ver también el mapa de fondo sin conexión, guarda el de la zona.`;
}

async function saveOfflineMap() {
  const r = current;
  const { specs, label } = layersToSave();
  const { urls, zMax } = planTilesMulti(r.stats.bounds, specs, { maxZoom: Math.min(15, ...specs.map((x) => x.maxZoom)) });
  if (!urls.length) { $('off-status').textContent = `La zona es demasiado grande para guardar (máximo ${MAX_TILES} teselas).`; return; }
  if (!confirm(`Se descargarán unas ${urls.length} teselas de «${label}» (zoom hasta ${zMax}) alrededor de la ruta. Se hace una sola vez y de forma espaciada, por respeto a los servidores de mapas. ¿Continuar?`)) return;
  $('off-save').disabled = true;
  try {
    const saved = await saveTiles(urls, (d, t) => { $('off-status').textContent = `Guardando mapa… ${d}/${t}`; });
    if (!saved.length) throw new Error('No se pudo descargar ninguna tesela (¿sin conexión?).');
    // Se acumulan los fondos guardados (p. ej. topográfico y satélite) para poder borrarlos todos después
    const prev = r.offline;
    const layers = [...new Set([...(prev?.layers || (prev ? [prev.layer] : [])), label])];
    r.offline = { layer: layers.join(' · '), layers, urls: [...new Set([...(prev?.urls || []), ...saved])], zMax, savedAt: Date.now() };
    await db.put(r);
    $('off-status').textContent = `Listo: ${saved.length} teselas guardadas.`;
    await refresh();
    refreshOfflineBox();
    updateStorageNote();
  } catch (e) {
    $('off-status').textContent = e.message || 'Error al guardar el mapa.';
  } finally {
    $('off-save').disabled = false;
  }
}

async function removeOfflineMap() {
  const r = current;
  if (!r.offline) return;
  const others = new Set(routes.filter((x) => x.id !== r.id && x.offline).flatMap((x) => x.offline.urls));
  await deleteTiles(r.offline.urls.filter((u) => !others.has(u)));
  delete r.offline;
  await db.put(r);
  $('off-status').textContent = 'Mapa guardado eliminado.';
  await refresh();
  refreshOfflineBox();
  updateStorageNote();
}

/* ---------- importación ---------- */
function setStatus(msg, err = false) {
  const el = $('add-status');
  el.textContent = msg;
  el.classList.toggle('err', err);
}

async function readFiles(files, { sourceUrl } = {}) {
  const ok = [], errors = [];
  let i = 0;
  for (const f of files) {
    setStatus(files.length > 1 ? `Leyendo ${++i}/${files.length}: ${f.name}…` : 'Leyendo archivo…');
    try {
      ok.push(routeFromFileText(await f.text(), { fileName: f.name, sourceUrl: files.length === 1 ? sourceUrl : undefined }));
    } catch (e) {
      errors.push({ name: f.name, message: e.message || 'No se pudo leer el archivo.' });
    }
  }
  return { ok, errors };
}

/** Guarda varias rutas. Si el mismo lote repite una ruta, queda la última; si ya existía, se actualiza (conservando su mapa guardado). */
async function storeRoutes(list) {
  const added = [], updated = [];
  const byId = new Map();
  list.forEach((r) => byId.set(r.id, r));
  for (const route of byId.values()) {
    const prev = routes.find((x) => x.id === route.id);
    if (prev?.offline) route.offline = prev.offline;
    await db.put(route);
    (prev ? updated : added).push(route);
    newIds.add(route.id);
  }
  await requestPersistence();
  await refresh();
  return { added, updated };
}

async function importFiles(files, opts = {}) {
  const { ok, errors } = await readFiles(files, opts);
  if (!ok.length) return { added: [], updated: [], errors };
  return { ...(await storeRoutes(ok)), errors };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function showReport({ added, updated, errors }) {
  const box = $('report-text');
  box.textContent = '';
  const line = (txt, cls) => { const p = document.createElement('p'); if (cls) p.className = cls; p.textContent = txt; box.append(p); };
  const parts = [];
  if (added.length) parts.push(plural(added.length, 'ruta guardada', 'rutas guardadas'));
  if (updated.length) parts.push(plural(updated.length, 'actualizada', 'actualizadas'));
  if (parts.length) line(`✓ ${parts.join(', ')}. Ya disponibles sin conexión.`);
  for (const e of errors) line(`✗ «${e.name}»: ${e.message}`, 'err');
  $('import-report').hidden = false;
}

/** Tras importar: con una sola ruta se abre; con varias (o errores) se muestra la lista con un resumen. */
function finishImport({ added, updated, errors }) {
  const all = [...added, ...updated];
  if (all.length === 1 && !errors.length) {
    const r = all[0];
    const wp = r.waypoints?.length ? `, ${r.waypoints.length} puntos de interés` : '';
    openRoute(r.id);
    toast(`${updated.length ? 'Ruta actualizada' : 'Ruta guardada'}: ${formatDistance(r.stats.distance)}${wp}. Ya disponible sin conexión.`);
    return;
  }
  showReport({ added, updated, errors });
  goGallery();
  $('gallery').scrollTop = 0; galleryScroll = 0;
  toast(all.length ? `${plural(all.length, 'ruta importada', 'rutas importadas')}${errors.length ? `, ${errors.length} con error` : ''}.` : 'No se pudo importar ningún archivo.');
}

function openAdd() {
  setStatus('');
  $('bookmarklet').href = bookmarkletHref();
  $('dlg-add').showModal();
}

async function doImport(ev) {
  ev.preventDefault();
  const url = $('in-url').value.trim();
  const files = [...$('in-file').files];
  if (!url && !files.length) { setStatus('Elige uno o varios archivos (.html guardado o .gpx) o indica una URL.', true); return; }
  $('add-go').disabled = true;
  try {
    let res;
    if (files.length) {
      res = await importFiles(files, { sourceUrl: url || undefined });
    } else {
      setStatus('Consultando Wikiloc…');
      const u = await importFromUrl(url);
      if (u.needFile) {
        setStatus(`${u.message} Guarda la página de la ruta (Ctrl+S → Página web completa) y súbela aquí.`, true);
        return;
      }
      res = { ...(await storeRoutes([u.route])), errors: [] };
    }
    if (!res.added.length && !res.updated.length) {
      // no se importó nada: el diálogo sigue abierto con el motivo de cada archivo
      setStatus(res.errors.map((e) => `«${e.name}»: ${e.message}`).join('\n'), true);
      return;
    }
    $('dlg-add').close();
    $('form-add').reset();
    setStatus('');
    finishImport(res);
  } catch (e) {
    setStatus(e.message || 'Error al importar.', true);
    if (e.code === 'NO_PROXY') $('in-proxy').value = getSettings().proxyUrl;
  } finally {
    $('add-go').disabled = false;
  }
}

/* Arrastrar y soltar archivos en cualquier parte de la app */
function initDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('dropzone').hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) $('dropzone').hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('dropzone').hidden = true;
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if ($('dlg-add').open) $('dlg-add').close();
    finishImport(await importFiles(files));
  });
}

/* Marcador del navegador: la página de Wikiloc nos envía su HTML por postMessage */
function bookmarkletHref() {
  const app = location.origin + location.pathname;
  const code =
    `(function(){var A=${JSON.stringify(app)},h=document.documentElement.outerHTML,w=window.open(A+'#importar','wt_app');` +
    `if(!w){alert('Permite las ventanas emergentes para importar la ruta.');return;}` +
    `var T=${JSON.stringify(location.origin)},N=Date.now()+'.'+Math.random(),sent=0,send=function(){try{w.postMessage({type:'wt-import',id:N,html:h,url:location.href},T);}catch(x){}};` +
    // Se envía al avisar la app ("wt-ready") y, por si la app ya estaba abierta en otra pestaña
    // (entonces no hay aviso), también unas cuantas veces seguidas. La app ignora los repetidos.
    `window.addEventListener('message',function(e){if(e.source===w&&e.data==='wt-ready')send();});` +
    `var iv=setInterval(function(){send();if(++sent>=12)clearInterval(iv);},1000);})();`;
  return 'javascript:' + encodeURIComponent(code);
}

function announceReady() {
  try { if (window.opener && !window.opener.closed) window.opener.postMessage('wt-ready', '*'); } catch { /* ignorar */ }
}

function listenForImports() {
  let lastKey = '';
  window.addEventListener('message', async (e) => {
    let host = '';
    try { host = new URL(e.origin).hostname; } catch { return; }
    if (!/(^|\.)wikiloc\.com$/i.test(host)) return; // solo páginas de Wikiloc
    const d = e.data;
    if (!d || d.type !== 'wt-import' || typeof d.html !== 'string' || d.html.length > 30e6) return;
    // Cada pulsación del marcador lleva un id y reenvía el mensaje varias veces: se procesa una sola vez por pulsación
    const key = typeof d.id === 'string' ? d.id : `${d.url}|${d.html.length}`;
    if (key === lastKey) return;
    lastKey = key;
    try {
      const route = routeFromFileText(d.html, { fileName: '', sourceUrl: typeof d.url === 'string' ? d.url : undefined });
      finishImport({ ...(await storeRoutes([route])), errors: [] });
    } catch (err) {
      toast(err.message || 'No se pudo importar la ruta de Wikiloc.', 7000);
    }
  });
  announceReady();
}

/* ---------- copia de seguridad ---------- */
async function backup() {
  const all = await db.all();
  if (!all.length) { toast('No hay rutas que guardar.'); return; }
  // Las teselas no van en la copia: solo la lista de URLs se descarta para no inflar el archivo
  const slim = all.map(({ offline, ...r }) => r);
  download(`wikiloc-tracks-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 2, routes: slim }), 'application/json');
}

async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.routes)) throw new Error();
    let n = 0;
    for (const r of data.routes) {
      if (r && r.id && Array.isArray(r.points) && r.stats) { await db.put(r); n++; }
    }
    await refresh();
    toast(`${n} ruta(s) restauradas.`);
  } catch {
    toast('El archivo no es una copia de seguridad válida.');
  }
}

/* ---------- arranque ---------- */
function bind() {
  $('btn-add').onclick = openAdd;
  $('empty-add').onclick = openAdd;
  $('report-close').onclick = () => { $('import-report').hidden = true; };
  $('sort').value = SORTS[sortKey] ? sortKey : 'recent';
  $('sort').onchange = (e) => { sortKey = e.target.value; try { localStorage.setItem('wt-sort', sortKey); } catch { /* ignorar */ } renderList(); };
  $('route-jump').onchange = (e) => openRoute(e.target.value);
  $('bookmarklet').addEventListener('click', (e) => { e.preventDefault(); toast('Arrastra este botón a la barra de marcadores, no lo pulses aquí.'); });
  $('add-cancel').onclick = () => $('dlg-add').close();
  $('form-add').addEventListener('submit', doImport);
  $('btn-settings').onclick = () => { $('in-proxy').value = getSettings().proxyUrl; $('dlg-settings').showModal(); };
  $('set-cancel').onclick = () => $('dlg-settings').close();
  $('form-settings').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings({ proxyUrl: $('in-proxy').value.trim() });
    $('dlg-settings').close();
    toast('Ajustes guardados.');
  });
  $('search').addEventListener('input', renderList);
  $('btn-backup').onclick = backup;
  $('btn-restore').onclick = () => $('file-restore').click();
  $('file-restore').onchange = (e) => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; };
  $('off-save').onclick = saveOfflineMap;
  $('off-del').onclick = removeOfflineMap;

  $('d-gpx').onclick = () => download(`${slug(current.name)}.gpx`, toGPX(current), 'application/gpx+xml');
  $('d-kml').onclick = () => download(`${slug(current.name)}.kml`, toKML(current), 'application/vnd.google-earth.kml+xml');
  $('d-rename').onclick = async () => {
    const n = prompt('Nuevo nombre de la ruta:', current.name);
    if (n && n.trim()) { current.name = n.trim(); await db.put(current); await refresh(); renderDetail(current); document.title = `${current.name} · Wikiloc Tracks`; }
  };
  $('d-del').onclick = async () => {
    if (!confirm(`¿Borrar «${current.name}»? No se puede deshacer.`)) return;
    if (current.offline) await removeOfflineMap();
    await db.remove(current.id);
    newIds.delete(current.id);
    current = null;
    profileCtl?.destroy(); profileCtl = null;
    if (trackLayer) { trackLayer.remove(); trackLayer = null; }
    clearHover();
    await refresh();
    goGallery();
  };

  let deferred;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('btn-install').hidden = false;
  });
  $('btn-install').onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('btn-install').hidden = true;
  };
}

async function main() {
  initMap();
  gps = createGps({ L, map, getRoute: () => current, getProfile: () => profileCtl, toast });
  addMapButtons();
  bind();
  initDrop();
  listenForImports();
  await refresh();
  window.addEventListener('hashchange', render);
  await render();
  requestPersistence();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin SW (p. ej. file://) */ });
  }
}

main();
