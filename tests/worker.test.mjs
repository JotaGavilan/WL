import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const realFetch = globalThis.fetch;
const call = (url, env = {}) => worker.fetch(new Request(`https://proxy.test/?url=${encodeURIComponent(url)}`), env).then((r) => r.json());
const page = (body) => `<html><head><meta property="og:title" content="Ruta &amp; cima - Wikiloc"><meta property="og:description" content="Bonita"></head><body>${body}</body></html>`;

function stub(handler) {
  globalThis.fetch = async (url, opts) => {
    const { status = 200, body = '' } = handler(String(url), opts || {});
    const res = new Response(body, { status });
    Object.defineProperty(res, 'url', { value: String(url) });
    return res;
  };
}
test.afterEach(() => { globalThis.fetch = realFetch; });

test('rechaza URLs que no son de Wikiloc', async () => {
  const r = await call('https://example.com/ruta-123');
  assert.equal(r.ok, false);
});

test('devuelve solo metadatos si no hay track', async () => {
  stub(() => ({ body: page('<p>sin datos</p>') }));
  const r = await call('https://www.wikiloc.com/hiking-trails/x-123');
  assert.equal(r.ok, false);
  assert.equal(r.source, 'meta-only');
  assert.equal(r.meta.title, 'Ruta & cima');
});

test('devuelve la página cuando contiene el track (para que la app la procese)', async () => {
  const fixture = (await import('node:fs')).readFileSync(new URL('./fixtures/wikiloc-ayous.html', import.meta.url), 'utf8');
  stub(() => ({ body: fixture }));
  const r = await call('https://www.wikiloc.com/hiking-trails/x-123');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'page');
  assert.ok(r.html.includes('"mapData":['));
});

test('con cookie descarga el GPX y la cookie solo va a wikiloc.com', async () => {
  const seen = [];
  stub((url, opts) => {
    seen.push({ url, cookie: opts.headers?.Cookie });
    if (url.includes('download')) return { body: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2"/></trkseg></trk></gpx>' };
    return { body: page('<a href="/wikiloc/download.do?id=123">GPX</a>') };
  });
  const r = await call('https://www.wikiloc.com/hiking-trails/x-123', { WIKILOC_COOKIE: 'sid=abc' });
  assert.equal(r.source, 'gpx-download');
  assert.match(r.gpx, /<gpx/);
  assert.ok(seen.every((s) => new URL(s.url).hostname.endsWith('wikiloc.com')));
});

test('informa del error HTTP de Wikiloc', async () => {
  stub(() => ({ status: 403, body: 'blocked' }));
  const r = await call('https://www.wikiloc.com/hiking-trails/x-123');
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
});
