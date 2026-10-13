import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWikilocPage, isWikilocPage, decodeTwkb } from '../js/wikiloc-page.js';
import { routeFromFileText } from '../js/importer.js';
import { toGPX, parseGPX } from '../js/gpx.js';

// Fragmento reducido de una página real de Wikiloc (ruta 14683000, Lac d'Ayous).
const HTML = fs.readFileSync(new URL('./fixtures/wikiloc-ayous.html', import.meta.url), 'utf8');

test('isWikilocPage reconoce la página y rechaza otras', () => {
  assert.ok(isWikilocPage(HTML));
  assert.ok(!isWikilocPage('<html><body>hola</body></html>'));
  assert.ok(!isWikilocPage(null));
});

test('decodifica el track completo: 1967 puntos con lon, lat, altitud y hora', () => {
  const r = parseWikilocPage(HTML);
  assert.equal(r.points.length, 1967);
  assert.deepEqual(r.points[0], { lon: -0.448741, lat: 42.872951, ele: 1303.8, time: 1473226636000 });
  const last = r.points.at(-1);
  assert.equal(last.lat, 42.872916);
  assert.equal(last.lon, -0.448792);
  assert.equal(last.time, 1473250765000);
});

test('extrae título, ubicación, autor, id y tipo circular', () => {
  const r = parseWikilocPage(HTML);
  assert.equal(r.title, 'Lac d´ Ayous (Circular) desde Lac Bious/Artigues,');
  assert.equal(r.location, 'Gabas, Aquitaine-Limousin-Poitou-Charentes (France)');
  assert.equal(r.author, 'jon azkarate');
  assert.equal(r.sourceId, '14683000');
  assert.equal(r.loop, true);
  assert.match(r.url, /lac-d-ayous-circular-desde-lac-bious-artigues-14683000$/);
});

test('extrae las estadísticas tal y como las muestra Wikiloc', () => {
  const s = parseWikilocPage(HTML).wikilocStats;
  assert.equal(s.distanceKm, 17.07);
  assert.equal(s.routeType, 'Circular');
  assert.equal(s.ascent, 796);
  assert.equal(s.descent, 796);
  assert.equal(s.maxEle, 2099); // "2.099 m": el punto es separador de miles
  assert.equal(s.minEle, 1303);
  assert.equal(s.difficulty, 'Fácil');
  assert.equal(s.trailRank, 65);
  assert.equal(s.rating, 4.3);
  assert.equal(s.movingTimeS, (6 * 60 + 42) * 60);
  assert.equal(s.recordedDate, 'septiembre 2016');
});

test('extrae los 6 puntos de interés con altitud y hora', () => {
  const w = parseWikilocPage(HTML).waypoints;
  assert.equal(w.length, 6);
  assert.deepEqual(w.map((x) => x.name), ['Lac Roumassot', 'Lac Gentau', 'Refugio de Ayous', 'Lac Berseau', 'Lac Casterau', 'Panel informativo']);
  assert.equal(w[2].type, 'Refugio de montaña');
  assert.equal(w[3].ele, 2085);
});

test('extrae la descripción del itinerario completa', () => {
  const d = parseWikilocPage(HTML).description;
  assert.ok(d.startsWith('Recorrido circular por el Parque Nacional de los Pirineos'));
  assert.ok(d.endsWith('donde tenemos el coche.'));
  assert.ok(d.length > 1800);
  assert.ok(!/<br|<div/.test(d));
});

test('la ruta guardada coincide con la página: distancia, desnivel, altitudes, duración', () => {
  const r = routeFromFileText(HTML, { fileName: 'pagina.html' });
  assert.equal(r.id, 'wikiloc-14683000');
  assert.equal(Math.round(r.stats.distance / 10) / 100, 17.07); // 17,07 km calculados desde el track
  assert.equal(r.stats.ascent, 796); // se usa la cifra de Wikiloc
  assert.equal(r.stats.calc.ascent > 796, true); // y se conserva la calculada aparte
  assert.equal(r.stats.maxEle, 2099);
  assert.equal(Math.round(r.stats.duration / 60), 6 * 60 + 42);
  assert.equal(r.points.length, 1967);
  assert.ok(r.profile.length > 100 && r.profile.length <= 602);
  assert.equal(r.waypoints.length, 6);
  // cada punto de interés queda ubicado en el track (distancia acumulada)
  assert.ok(r.waypoints.every((w) => w.d >= 0 && w.d <= r.stats.distance));
  assert.ok(r.waypoints[0].d < r.waypoints[5].d);
  assert.equal(r.info.difficulty, 'Fácil');
});

test('reimportar la misma ruta produce el mismo id (sustituye, no duplica)', () => {
  assert.equal(routeFromFileText(HTML).id, routeFromFileText(HTML).id);
});

test('exporta a GPX con puntos de interés y se puede releer', () => {
  const r = routeFromFileText(HTML);
  const g = parseGPX(toGPX(r));
  assert.equal(g.points.length, 1967);
  assert.equal(g.waypoints.length, 6);
  assert.equal(g.waypoints[0].name, 'Lac Roumassot');
  assert.equal(g.points[0].ele, 1303.8);
});

test('decodeTwkb: línea sencilla 2D', () => {
  // LineString, precisión 0, 2 puntos: (1,2) y (+3,+4) → (4,6)
  const bytes = Uint8Array.from([0x02, 0x00, 0x02, 0x02, 0x04, 0x06, 0x08]);
  assert.deepEqual(decodeTwkb(bytes), [{ lon: 1, lat: 2 }, { lon: 4, lat: 6 }]);
});

test('errores claros ante archivos que no son rutas', () => {
  assert.throws(() => parseWikilocPage('<html></html>'), /no contiene un track/);
  assert.throws(() => routeFromFileText('hola'), /No reconozco el archivo/);
});
