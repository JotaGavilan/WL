// Proxy para Cloudflare Workers: lee una ruta pública de Wikiloc y devuelve JSON al navegador.
// El navegador no puede leer wikiloc.com directamente por CORS, por eso hace falta este intermediario.
//
// GET /?url=https://www.wikiloc.com/...-12345678
//   → { ok, html?: "<página de la ruta>", gpx?: "<gpx…>", meta, source, error? }
//   El navegador procesa el HTML con js/wikiloc-page.js (el mismo extractor que usa con la página guardada).
//
// Variables opcionales (wrangler secret put …):
//   ALLOWED_ORIGIN   Origen que puede llamar al proxy, p. ej. https://tuusuario.github.io  (por defecto: *)
//   WIKILOC_COOKIE   Cookie de TU sesión de Wikiloc para poder descargar el GPX de tus rutas.
//                    Es un secreto: nunca lo pongas en el código ni en el repositorio.
//
// IMPORTANTE: la estructura de Wikiloc puede cambiar y el sitio puede bloquear peticiones de servidores.
// Esto es un intento "best effort": si falla, la app te pide la página guardada o el GPX.

import { isWikilocPage } from '../js/wikiloc-page.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cors(env, extra = {}) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  };
}

const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors(env) });

function parseWikilocUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!/(^|\.)wikiloc\.com$/i.test(u.hostname)) return null;
  const m = (u.pathname + u.search).match(/-(\d+)(?:[/?#]|$)/) || u.search.match(/[?&]id=(\d+)/);
  if (!m) return null;
  u.protocol = 'https:';
  return { url: u.toString(), id: m[1] };
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function metaTag(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re) || html.match(re2);
  return m ? decodeHtml(m[1]) : '';
}

function extractMeta(html) {
  const meta = {
    title: metaTag(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim(),
    description: metaTag(html, 'og:description') || metaTag(html, 'description'),
    image: metaTag(html, 'og:image'),
  };
  meta.title = decodeHtml(meta.title).replace(/\s*[-|–]\s*Wikiloc.*$/i, '');
  return meta;
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es,en;q=0.8', ...headers }, redirect: 'follow' });
  const finalHost = new URL(res.url).hostname;
  if (!/(^|\.)wikiloc\.com$/i.test(finalHost)) throw new Error('Redirección a un dominio no permitido.');
  return { status: res.status, text: await res.text(), ok: res.ok };
}

async function tryDownloadGpx(env, html, id, pageUrl) {
  if (!env.WIKILOC_COOKIE) return null;
  const candidates = [];
  const re = /href=["']([^"']*download[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try { candidates.push(new URL(decodeHtml(m[1]), pageUrl).toString()); } catch { /* ignorar */ }
  }
  candidates.push(`https://www.wikiloc.com/wikiloc/download.do?id=${id}`);
  for (const c of [...new Set(candidates)].slice(0, 5)) {
    if (!/(^|\.)wikiloc\.com$/i.test(new URL(c).hostname)) continue;
    try {
      const r = await fetchText(c, { Cookie: env.WIKILOC_COOKIE, Referer: pageUrl });
      if (r.ok && /<gpx\b/i.test(r.text)) return r.text;
    } catch { /* probar el siguiente */ }
  }
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== 'GET') return json(env, { ok: false, error: 'Método no permitido.' }, 405);

    const target = new URL(request.url).searchParams.get('url');
    const parsed = target && parseWikilocUrl(target);
    if (!parsed) return json(env, { ok: false, error: 'URL de Wikiloc no válida.' }, 400);

    let page;
    try {
      page = await fetchText(parsed.url, env.WIKILOC_COOKIE ? { Cookie: env.WIKILOC_COOKIE } : {});
    } catch (e) {
      return json(env, { ok: false, error: `No se pudo leer Wikiloc: ${e.message}` }, 502);
    }
    if (!page.ok) {
      return json(env, { ok: false, meta: {}, error: `Wikiloc respondió HTTP ${page.status} (puede estar bloqueando el acceso automático).` }, 200);
    }

    const meta = extractMeta(page.text);

    if (isWikilocPage(page.text)) return json(env, { ok: true, meta, html: page.text, source: 'page' });

    const gpx = await tryDownloadGpx(env, page.text, parsed.id, parsed.url);
    if (gpx) return json(env, { ok: true, meta, gpx, source: 'gpx-download' });

    return json(env, {
      ok: false,
      meta,
      source: 'meta-only',
      error: 'La página no incluye el track (puede que Wikiloc haya cambiado su formato o exija iniciar sesión).',
    });
  },
};
