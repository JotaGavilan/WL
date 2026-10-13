// Perfil de elevación dibujado en <canvas>, sin dependencias.
//  - Al pasar el dedo/ratón por el perfil se llama a onHover(distanciaEnMetros | null).
//  - Desde fuera se puede mover el cursor con controller.setCursor(distanciaEnMetros | null) (p. ej. desde el mapa).
//  - Los puntos de interés (waypoints [{d, name, type}]) se marcan sobre la curva.
//  - controller.setGps(distanciaEnMetros | null) marca dónde está el usuario según el GPS.

export function drawProfile(canvas, profile, { onHover, waypoints = [] } = {}) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();

  let cursorD = null; // distancia (m) donde está el cursor
  let gpsD = null;    // distancia (m) a lo largo del track donde está el usuario (GPS)
  let geom = null;

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function nearest(d) {
    let lo = 0, hi = profile.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (profile[mid].d < d) lo = mid; else hi = mid;
    }
    return Math.abs(profile[lo].d - d) <= Math.abs(profile[hi].d - d) ? profile[lo] : profile[hi];
  }

  function render() {
    const { w, h } = layout();
    ctx.clearRect(0, 0, w, h);
    geom = null;
    if (!profile.length) {
      ctx.fillStyle = col('--muted');
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Este track no incluye datos de elevación.', 12, h / 2);
      return;
    }
    const pad = { l: 46, r: 10, t: 10, b: 22 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const maxD = profile[profile.length - 1].d || 1;
    let minE = Math.min(...profile.map((p) => p.ele));
    let maxE = Math.max(...profile.map((p) => p.ele));
    if (maxE - minE < 20) { const mid = (maxE + minE) / 2; minE = mid - 10; maxE = mid + 10; }
    const padE = (maxE - minE) * 0.08;
    minE -= padE; maxE += padE;
    const X = (d) => pad.l + (d / maxD) * iw;
    const Y = (e) => pad.t + ih - ((e - minE) / (maxE - minE)) * ih;
    geom = { pad, iw, maxD, X, Y };

    // rejilla y ejes
    ctx.strokeStyle = col('--grid');
    ctx.fillStyle = col('--muted');
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const e = minE + ((maxE - minE) * i) / 4;
      const y = Y(e);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(`${Math.round(e)} m`, pad.l - 6, y + 4);
    }
    ctx.textAlign = 'center';
    const kmTotal = maxD / 1000;
    const stepKm = kmTotal > 40 ? 10 : kmTotal > 15 ? 5 : kmTotal > 6 ? 2 : kmTotal > 2 ? 1 : 0.5;
    for (let k = 0; k <= kmTotal; k += stepKm) {
      ctx.fillText(`${k % 1 ? k.toFixed(1) : k} km`, X(k * 1000), h - 6);
    }

    // área + línea
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, col('--accent-fill'));
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.moveTo(X(profile[0].d), pad.t + ih);
    profile.forEach((p) => ctx.lineTo(X(p.d), Y(p.ele)));
    ctx.lineTo(X(maxD), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    profile.forEach((p, i) => (i ? ctx.lineTo(X(p.d), Y(p.ele)) : ctx.moveTo(X(p.d), Y(p.ele))));
    ctx.strokeStyle = col('--accent');
    ctx.lineWidth = 2;
    ctx.stroke();

    // puntos de interés
    for (const wp of waypoints) {
      if (!Number.isFinite(wp.d)) continue;
      const e = nearest(wp.d).ele;
      ctx.beginPath();
      ctx.arc(X(wp.d), Y(e), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f5a000';
      ctx.fill();
      ctx.strokeStyle = col('--panel');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // posición GPS del usuario (azul, con línea discontinua)
    if (gpsD != null) {
      const g = nearest(Math.min(maxD, Math.max(0, gpsD)));
      const gx = X(g.d);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#1f6fe0';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx, pad.t); ctx.lineTo(gx, pad.t + ih); ctx.stroke();
      ctx.restore();
      ctx.beginPath(); ctx.arc(gx, Y(g.ele), 6, 0, Math.PI * 2);
      ctx.fillStyle = '#1f6fe0'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = 'bold 11px system-ui, sans-serif';
      const label = `Tú · ${(g.d / 1000).toFixed(1)} km`;
      const tw = ctx.measureText(label).width + 10;
      const tx = Math.min(w - pad.r - tw, Math.max(pad.l, gx - tw / 2));
      ctx.fillStyle = '#1f6fe0';
      ctx.fillRect(tx, pad.t + ih - 18, tw, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(label, tx + 5, pad.t + ih - 6);
    }

    // cursor
    if (cursorD != null) {
      const p = nearest(Math.min(maxD, Math.max(0, cursorD)));
      ctx.strokeStyle = col('--muted');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(p.d), pad.t); ctx.lineTo(X(p.d), pad.t + ih); ctx.stroke();
      ctx.fillStyle = col('--accent');
      ctx.beginPath(); ctx.arc(X(p.d), Y(p.ele), 4, 0, Math.PI * 2); ctx.fill();

      // si el cursor está sobre un punto de interés, mostrar su nombre
      const near = waypoints.find((wp) => Number.isFinite(wp.d) && Math.abs(X(wp.d) - X(p.d)) < 9);
      const label = `${(p.d / 1000).toFixed(2)} km · ${Math.round(p.ele)} m` + (near?.name ? ` · ${near.name}` : '');
      ctx.font = '12px system-ui, sans-serif';
      const tw = ctx.measureText(label).width + 12;
      const tx = Math.min(w - pad.r - tw, Math.max(pad.l, X(p.d) - tw / 2));
      ctx.fillStyle = col('--tooltip-bg');
      ctx.fillRect(tx, pad.t, tw, 20);
      ctx.fillStyle = col('--tooltip-fg');
      ctx.textAlign = 'left';
      ctx.fillText(label, tx + 6, pad.t + 14);
    }
  }

  function dFromEvent(ev) {
    if (!geom) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const { pad, iw, maxD } = geom;
    return Math.min(maxD, Math.max(0, ((x - pad.l) / iw) * maxD));
  }

  function move(ev) {
    const d = dFromEvent(ev);
    if (d == null) return;
    const p = nearest(d);
    cursorD = p.d;
    render();
    if (onHover) onHover(p.d);
  }
  function leave() {
    cursorD = null;
    render();
    if (onHover) onHover(null);
  }

  canvas.onmousemove = move;
  canvas.onmouseleave = leave;
  canvas.ontouchstart = canvas.ontouchmove = move;
  canvas.ontouchend = leave;

  render();
  const ro = new ResizeObserver(render);
  ro.observe(canvas);

  return {
    setCursor(d) { cursorD = d; render(); },
    /** Marca la posición GPS del usuario (distancia en m a lo largo del track) o la quita con null. */
    setGps(d) { gpsD = d; render(); },
    destroy() {
      ro.disconnect();
      canvas.onmousemove = canvas.onmouseleave = canvas.ontouchstart = canvas.ontouchmove = canvas.ontouchend = null;
    },
  };
}
