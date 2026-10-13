import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGPX, computeStats, buildProfile, toGPX, toKML, haversine } from '../js/gpx.js';
import { buildRoute, routeFromGpxText, isWikilocUrl } from '../js/importer.js';

// Track sintético: 0,01° de latitud ≈ 1111,95 m. Sube 10 m, baja 4 m, sube 2 m (ruido < umbral).
const SAMPLE = `<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Meta &amp; nombre</name></metadata>
  <trk><name>Ruta de prueba</name><trkseg>
    <trkpt lat="42.000" lon="3.000"><ele>100</ele><time>2026-01-01T08:00:00Z</time></trkpt>
    <trkpt lat="42.010" lon="3.000"><ele>110</ele><time>2026-01-01T08:10:00Z</time></trkpt>
    <trkpt lat="42.020" lon="3.000"><ele>106</ele><time>2026-01-01T08:20:00Z</time></trkpt>
    <trkpt lat="42.030" lon="3.000"><ele>108</ele><time>2026-01-01T08:30:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

test('haversine: 0,01° de latitud ≈ 1112 m', () => {
  const d = haversine({ lat: 42, lon: 3 }, { lat: 42.01, lon: 3 });
  assert.ok(Math.abs(d - 1111.95) < 2, `d=${d}`);
});

test('parseGPX lee nombre, puntos, elevación y hora', () => {
  const g = parseGPX(SAMPLE);
  assert.equal(g.name, 'Ruta de prueba');
  assert.equal(g.points.length, 4);
  assert.equal(g.points[1].ele, 110);
  assert.equal(g.points[0].time, Date.parse('2026-01-01T08:00:00Z'));
});

test('parseGPX acepta atributos en otro orden y rtept', () => {
  const g = parseGPX('<gpx><rte><name>R</name><rtept lon="3.1" lat="42.1"><ele>5</ele></rtept><rtept lat="42.2" lon="3.2"/></rte></gpx>');
  assert.equal(g.points.length, 2);
  assert.equal(g.points[0].lat, 42.1);
  assert.equal(g.points[0].lon, 3.1);
});

test('parseGPX rechaza archivos no GPX o sin puntos', () => {
  assert.throws(() => parseGPX('<html></html>'));
  assert.throws(() => parseGPX('<gpx><trk><trkseg></trkseg></trk></gpx>'));
});

test('computeStats: distancia, desnivel con umbral, duración', () => {
  const { points } = parseGPX(SAMPLE);
  const s = computeStats(points);
  assert.ok(Math.abs(s.distance - 3335.85) < 6, `distance=${s.distance}`);
  assert.equal(s.maxEle, 110);
  assert.equal(s.minEle, 100);
  assert.equal(s.ascent, 10); // +10; el +2 final es ruido (<3 m)
  assert.equal(s.descent, 4);
  assert.equal(s.duration, 1800);
  assert.equal(s.cumDistances.length, 4);
});

test('computeStats sin elevación devuelve null en desnivel', () => {
  const s = computeStats([{ lat: 42, lon: 3 }, { lat: 42.01, lon: 3 }]);
  assert.equal(s.ascent, null);
  assert.equal(s.minEle, null);
});

test('buildProfile limita puntos y conserva el último', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({ lat: 42 + i * 1e-4, lon: 3, ele: 100 + (i % 50) }));
  const s = computeStats(pts);
  const prof = buildProfile(pts, s.cumDistances, 600);
  assert.ok(prof.length <= 602);
  assert.equal(prof[prof.length - 1].d, s.cumDistances[4999]);
});

test('toGPX → parseGPX conserva el track', () => {
  const { points } = parseGPX(SAMPLE);
  const again = parseGPX(toGPX({ name: 'A <b> & c', points }));
  assert.equal(again.name, 'A <b> & c');
  assert.equal(again.points.length, points.length);
  assert.equal(again.points[2].ele, 106);
});

test('toKML incluye coordenadas lon,lat,ele', () => {
  const { points } = parseGPX(SAMPLE);
  assert.match(toKML({ name: 'x', points }), /3,42,100 3,42\.01,110/);
});

test('buildRoute guarda ruta, perfil y distancia acumulada por punto', async () => {
  const r = await routeFromGpxText(SAMPLE, { sourceUrl: 'https://www.wikiloc.com/senderismo/x-123' });
  assert.equal(r.name, 'Ruta de prueba');
  assert.equal(r.points.length, 4);
  assert.equal(r.points[0].d, 0);
  assert.ok(r.points[3].d > 3300);
  assert.ok(r.profile.length > 0);
  assert.ok(!('cumDistances' in r.stats));
  assert.ok(r.id);
});

test('isWikilocUrl', () => {
  assert.ok(isWikilocUrl('https://www.wikiloc.com/hiking-trails/ruta-bonita-12345678'));
  assert.ok(isWikilocUrl('https://es.wikiloc.com/rutas-senderismo/ruta-12345678?foo=1'));
  assert.ok(!isWikilocUrl('https://example.com/ruta-12345'));
  assert.ok(!isWikilocUrl('https://www.wikiloc.com/'));
  assert.ok(!isWikilocUrl('no es una url'));
});

import { formatDistance, formatEle } from '../js/gpx.js';
test('formato español de distancia y altitud (como Wikiloc)', () => {
  assert.equal(formatDistance(17070).replace(/ /g, ' '), '17,07 km');
  assert.equal(formatEle(2099), '2.099 m');
  assert.equal(formatEle(796), '796 m');
  assert.equal(formatDistance(850), '850 m');
});
