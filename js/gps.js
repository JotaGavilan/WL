// Posición GPS del usuario sobre el mapa y sobre el perfil de la ruta.
//
// El GPS del dispositivo no necesita internet: con la ruta y el mapa guardados, funciona sin conexión.
// (El navegador pide permiso de ubicación la primera vez. En iPhone/Android la página debe servirse por HTTPS.)

import { projectOnTrack, progress } from './geo.js';
import { formatDistance } from './gpx.js';

export function createGps({ L, map, getRoute, getProfile, toast }) {
  let watchId = null;
  let marker = null, circle = null;
  let fix = null;          // última lectura { lat, lon, acc, alt }
  let follow = true;
  let wake = null;
  let panelEl = null;
  const el = {};

  /* ---------- panel sobre el mapa ---------- */
  const PanelControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      panelEl = L.DomUtil.create('div', 'gps-panel');
      panelEl.hidden = true;
      panelEl.setAttribute('role', 'status');
      panelEl.setAttribute('aria-live', 'polite');
      el.main = L.DomUtil.create('div', 'g-main', panelEl);
      el.sub = L.DomUtil.create('div', 'g-sub', panelEl);
      el.warn = L.DomUtil.create('div', 'g-warn', panelEl);
      el.warn.hidden = true;
      const row = L.DomUtil.create('div', 'g-actions', panelEl);
      el.follow = L.DomUtil.create('button', '', row);
      el.follow.type = 'button';
      el.follow.onclick = () => setFollow(!follow, true);
      el.stop = L.DomUtil.create('button', '', row);
      el.stop.type = 'button';
      el.stop.textContent = 'Parar GPS';
      el.stop.onclick = stop;
      L.DomEvent.disableClickPropagation(panelEl);
      L.DomEvent.disableScrollPropagation(panelEl);
      return panelEl;
    },
  });
  new PanelControl().addTo(map);
  paintFollow();

  function paintFollow() {
    el.follow.textContent = follow ? 'Siguiéndote' : 'Seguirme';
    el.follow.setAttribute('aria-pressed', String(follow));
  }

  function setFollow(on, recenter = false) {
    follow = on;
    paintFollow();
    if (on && recenter && fix) map.panTo([fix.lat, fix.lon]);
  }
  // Si el usuario arrastra el mapa, deja de seguirlo para no pelearse con él
  map.on('dragstart', () => { if (follow) setFollow(false); });

  /* ---------- lecturas del GPS ---------- */
  function onFix(pos) {
    const c = pos.coords;
    const first = !fix;
    fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: Number.isFinite(c.altitude) ? c.altitude : null };
    const ll = [fix.lat, fix.lon];

    if (!marker) {
      circle = L.circle(ll, { radius: fix.acc || 10, color: '#1f6fe0', weight: 1, fillColor: '#1f6fe0', fillOpacity: 0.12, interactive: false }).addTo(map);
      marker = L.marker(ll, {
        icon: L.divIcon({ className: '', html: '<div class="gps-dot" aria-hidden="true"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
        interactive: false, keyboard: false, zIndexOffset: 2000,
      }).addTo(map);
    } else {
      marker.setLatLng(ll);
      circle.setLatLng(ll).setRadius(fix.acc || 10);
    }

    if (first) map.setView(ll, Math.max(map.getZoom(), 16));
    else if (follow) map.panTo(ll);
    refresh();
  }

  function onError(err) {
    const msgs = {
      1: 'Permiso de ubicación denegado. Actívalo para este sitio en los ajustes del navegador.',
      2: 'No se pudo obtener la posición. ¿Tienes el GPS activado?',
      3: 'Buscando señal GPS… (mejora al aire libre)',
    };
    const text = msgs[err.code] || 'Error del GPS.';
    if (err.code === 1) { toast(text, 7000); stop(); return; }
    if (!fix) show(text); // si ya había posición, se mantiene la última
  }

  /* ---------- panel / perfil ---------- */
  function show(mainText, subText = '', warn = '') {
    panelEl.hidden = false;
    el.main.textContent = mainText;
    el.sub.textContent = subText;
    el.warn.textContent = warn;
    el.warn.hidden = !warn;
  }

  /** Vuelve a calcular la posición sobre la ruta actual (al llegar una lectura nueva o al cambiar de ruta). */
  function refresh() {
    if (watchId === null) return;
    const profile = getProfile();
    if (!fix) { show('Buscando señal GPS…'); profile?.setGps(null); return; }
    const route = getRoute();
    const acc = Number.isFinite(fix.acc) ? `±${Math.round(fix.acc)} m` : '';
    const alt = fix.alt != null ? `Altitud GPS ${Math.round(fix.alt)} m` : '';
    const sub = [alt, acc && `precisión ${acc}`].filter(Boolean).join(' · ');
    if (!route) { show(`${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`, sub); return; }

    const proj = projectOnTrack(route.points, fix.lat, fix.lon);
    if (!proj) { show(`${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`, sub); return; }
    const g = progress(proj, route.stats.distance, fix.acc);
    profile?.setGps(proj.d);
    show(
      `Llevas ${formatDistance(g.done)} · faltan ${formatDistance(g.left)} (${Math.round(g.pct)} %)`,
      sub,
      g.isOff ? `Estás a ${formatDistance(g.offTrack)} del track` : '',
    );
  }

  /* ---------- pantalla encendida mientras se usa el GPS ---------- */
  async function lockScreen() {
    try { wake = (await navigator.wakeLock?.request('screen')) || null; } catch { wake = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && watchId !== null) lockScreen();
  });

  /* ---------- API ---------- */
  function start() {
    if (watchId !== null) return;
    if (!('geolocation' in navigator)) { toast('Este dispositivo o navegador no ofrece GPS.', 6000); return; }
    fix = null;
    follow = true;
    paintFollow();
    show('Buscando señal GPS…');
    watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    lockScreen();
  }

  function stop() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    fix = null;
    marker?.remove(); circle?.remove();
    marker = circle = null;
    getProfile()?.setGps(null);
    panelEl.hidden = true;
    try { wake?.release(); } catch { /* ignorar */ }
    wake = null;
  }

  /** Centra el mapa en la posición y acerca (zoom ≥ 17). Si el GPS no estaba activo, lo activa. */
  function centerOnMe() {
    if (watchId === null) { start(); return; }
    if (!fix) { toast('Esperando la señal GPS…'); return; }
    setFollow(true);
    map.setView([fix.lat, fix.lon], Math.max(map.getZoom(), 17));
  }

  return {
    start, stop, centerOnMe, refresh,
    isOn: () => watchId !== null,
    /** Al cambiar de ruta: deja de seguir (se muestra la ruta entera) y recalcula. */
    onRouteChange() { follow = false; paintFollow(); refresh(); },
  };
}
