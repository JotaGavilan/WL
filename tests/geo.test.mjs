import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOnTrack, progress, distance } from '../js/geo.js';

// Track recto hacia el norte a lo largo del meridiano 3°E: 0,01° de latitud ≈ 1111,95 m.
const M = 1111.95;
const pts = [0, 1, 2, 3].map((i) => ({ lat: 42 + i * 0.01, lon: 3, d: i * M, ele: 100 + i * 10 }));

test('un punto sobre un vértice da la distancia acumulada de ese vértice', () => {
  const p = projectOnTrack(pts, 42.02, 3);
  assert.ok(Math.abs(p.d - 2 * M) < 0.5, `d=${p.d}`);
  assert.ok(p.offTrack < 0.5);
  assert.ok(Math.abs(p.ele - 120) < 0.01);
});

test('un punto a mitad de segmento interpola distancia y altitud', () => {
  const p = projectOnTrack(pts, 42.015, 3);
  assert.ok(Math.abs(p.d - 1.5 * M) < 0.5, `d=${p.d}`);
  assert.ok(Math.abs(p.ele - 115) < 0.01);
  assert.equal(p.idx, 1);
});

test('mide la distancia lateral al track', () => {
  // 0,001° de longitud a 42° N ≈ 82,6 m
  const p = projectOnTrack(pts, 42.015, 3.001);
  assert.ok(Math.abs(p.offTrack - 82.6) < 1.5, `off=${p.offTrack}`);
  assert.ok(Math.abs(p.d - 1.5 * M) < 1);
});

test('antes del inicio y tras el final se ajusta a los extremos', () => {
  assert.ok(projectOnTrack(pts, 41.99, 3).d < 0.5);
  const end = projectOnTrack(pts, 42.04, 3);
  assert.ok(Math.abs(end.d - 3 * M) < 0.5);
  assert.ok(Math.abs(end.offTrack - M) < 2);
});

test('en un circuito elige el tramo más cercano, no el primero', () => {
  // ida hacia el norte y vuelta por el este, de modo que inicio y fin coinciden
  const loop = [
    { lat: 42.00, lon: 3.00, d: 0 },
    { lat: 42.01, lon: 3.00, d: M },
    { lat: 42.01, lon: 3.01, d: M + 826 },
    { lat: 42.00, lon: 3.01, d: 2 * M + 826 },
    { lat: 42.00, lon: 3.00, d: 2 * M + 1652 },
  ];
  const p = projectOnTrack(loop, 42.005, 3.01); // en el tramo de vuelta
  assert.equal(p.idx, 2);
  assert.ok(p.d > M + 826 && p.d < 2 * M + 826);
});

test('devuelve null si el track no tiene al menos 2 puntos', () => {
  assert.equal(projectOnTrack([], 1, 1), null);
  assert.equal(projectOnTrack([pts[0]], 1, 1), null);
});

test('progress: recorrido, restante y porcentaje', () => {
  const total = 3 * M;
  const g = progress(projectOnTrack(pts, 42.015, 3), total, 5);
  assert.ok(Math.abs(g.done - 1.5 * M) < 1);
  assert.ok(Math.abs(g.left - 1.5 * M) < 1);
  assert.ok(Math.abs(g.pct - 50) < 0.1);
  assert.equal(g.isOff, false);
});

test('progress: avisa de fuera de ruta con margen según la precisión del GPS', () => {
  const total = 3 * M;
  const lateral = projectOnTrack(pts, 42.015, 3.001); // ≈ 83 m
  assert.equal(progress(lateral, total, 5).isOff, true); // margen 50 m
  assert.equal(progress(lateral, total, 60).isOff, false); // GPS impreciso: margen 120 m
});

test('distance coincide con la distancia entre vértices', () => {
  assert.ok(Math.abs(distance(pts[0], pts[1]) - M) < 0.5);
});
