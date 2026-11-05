// Small canvas drawing kit: no dependencies, DPR-aware, tuned for dark backgrounds.
const Charts = (() => {
  function prep(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function alpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function tracePath(ctx, data, x0, w, yOf, len) {
    const step = w / Math.max(1, len - 1);
    const off = len - data.length;
    data.forEach((v, i) => {
      const x = x0 + (i + off) * step;
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y);
      else {
        // smooth with a midpoint quadratic so lines feel fluid rather than jagged
        const px = x0 + (i - 1 + off) * step;
        const py = yOf(data[i - 1]);
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        if (i === data.length - 1) ctx.lineTo(x, y);
      }
    });
    return { first: x0 + off * step, last: x0 + (len - 1) * step };
  }

  // Line/area history chart. series: [{data, color, fill, width}]
  function area(canvas, series, { max = 100, len = 60, grid = true, fmt = (v) => v + '%', pad = 8, axis = true } = {}) {
    const { ctx, w, h } = prep(canvas);
    const left = axis ? 40 : 0;
    const top = pad, bottom = h - pad;
    const yOf = (v) => bottom - (Math.min(v, max) / max) * (bottom - top);

    if (grid) {
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = '#5c628c';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const v = (max / 4) * i;
        const y = yOf(v);
        ctx.strokeStyle = i === 0 ? '#262c52' : 'rgba(38, 44, 82, 0.5)';
        ctx.setLineDash(i === 0 ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        if (axis) ctx.fillText(fmt(v), left - 6, y);
      }
      ctx.setLineDash([]);
    }

    for (const s of series) {
      if (!s.data.length) continue;
      if (s.fill !== false) {
        ctx.beginPath();
        const { first, last } = tracePath(ctx, s.data, left, w - left, yOf, len);
        ctx.lineTo(last, bottom);
        ctx.lineTo(first, bottom);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, top, 0, bottom);
        g.addColorStop(0, alpha(s.color, 0.35));
        g.addColorStop(1, alpha(s.color, 0));
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.beginPath();
      const { last } = tracePath(ctx, s.data, left, w - left, yOf, len);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 2;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // glowing head dot on the newest sample
      const ly = yOf(s.data[s.data.length - 1]);
      ctx.beginPath();
      ctx.arc(last, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
  }

  // Mirrored chart: `upper` grows up from the midline, `lower` grows down.
  function mirror(canvas, upper, lower, { len = 60, fmt = (v) => v } = {}) {
    const { ctx, w, h } = prep(canvas);
    const left = 64;
    const mid = h / 2;
    const max = Math.max(1024, ...upper.data, ...lower.data) * 1.15;
    const half = mid - 8;

    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#5c628c';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const y = mid - f * half;
      ctx.strokeStyle = f === 0 ? '#262c52' : 'rgba(38, 44, 82, 0.5)';
      ctx.setLineDash(f === 0 ? [] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (f !== 0) ctx.fillText(fmt(Math.abs(f) * max), left - 6, y);
    }
    ctx.setLineDash([]);

    const draw = (s, dir) => {
      if (!s.data.length) return;
      const yOf = (v) => mid - dir * (v / max) * half;
      ctx.beginPath();
      const { first, last } = tracePath(ctx, s.data, left, w - left, yOf, len);
      ctx.lineTo(last, mid);
      ctx.lineTo(first, mid);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, mid - dir * half, 0, mid);
      g.addColorStop(0, alpha(s.color, 0.45));
      g.addColorStop(1, alpha(s.color, 0.02));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      tracePath(ctx, s.data, left, w - left, yOf, len);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    draw(upper, 1);
    draw(lower, -1);
  }

  // Tiny sparkline that sits under a stat card.
  function spark(canvas, series, { max } = {}) {
    const { ctx, w, h } = prep(canvas);
    const peak = max || Math.max(1, ...series.flatMap((s) => s.data)) * 1.1;
    const yOf = (v) => h - (Math.min(v, peak) / peak) * (h - 4);
    for (const s of series) {
      if (s.data.length < 2) continue;
      ctx.beginPath();
      const { first, last } = tracePath(ctx, s.data, 0, w, yOf, 60);
      ctx.lineTo(last, h);
      ctx.lineTo(first, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, alpha(s.color, 0.25));
      g.addColorStop(1, alpha(s.color, 0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      tracePath(ctx, s.data, 0, w, yOf, 60);
      ctx.strokeStyle = alpha(s.color, 0.8);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Ring gauge, value 0..1. Uses fixed canvas attributes (not CSS size) as its logical size.
  function ring(canvas, value, color, { thickness = 8, label = true } = {}) {
    const { ctx, w, h } = prep(canvas);
    const r = Math.min(w, h) / 2 - thickness / 2 - 2;
    const cx = w / 2, cy = h / 2;
    const start = -Math.PI / 2;
    ctx.lineCap = 'round';
    ctx.lineWidth = thickness;
    ctx.strokeStyle = '#1d2244';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    const v = Math.max(0, Math.min(1, value));
    if (v > 0.001) {
      const g = ctx.createConicGradient ? ctx.createConicGradient(start, cx, cy) : null;
      if (g) {
        g.addColorStop(0, alpha(color, 0.5));
        g.addColorStop(Math.max(0.01, v), color);
        g.addColorStop(1, color);
      }
      ctx.strokeStyle = g || color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, start + v * Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (label) {
      ctx.fillStyle = '#e8eaf8';
      ctx.font = `700 ${Math.round(r * 0.55)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(v * 100), cx, cy + 1);
    }
  }

  // Donut with a legend on the right. segments: [{label, value, color}]
  function donut(canvas, segments) {
    const { ctx, w, h } = prep(canvas);
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    const r = h / 2 - 8;
    const cx = r + 8, cy = h / 2;
    let a = -Math.PI / 2;
    ctx.lineWidth = 14;
    for (const s of segments) {
      if (!s.value) continue;
      const span = (s.value / total) * Math.PI * 2;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 7, a + 0.02, a + span - 0.02);
      ctx.stroke();
      a += span;
    }
    ctx.fillStyle = '#e8eaf8';
    ctx.font = '700 18px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(total, cx, cy - 6);
    ctx.fillStyle = '#8b91bd';
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.fillText('procs', cx, cy + 12);

    const lx = cx + r + 22;
    ctx.textAlign = 'left';
    segments.forEach((s, i) => {
      const y = cy - ((segments.length - 1) * 20) / 2 + i * 20;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(lx, y - 5, 10, 10, 3) : ctx.rect(lx, y - 5, 10, 10);
      ctx.fill();
      ctx.fillStyle = '#8b91bd';
      ctx.font = '12px ui-sans-serif, system-ui';
      ctx.fillText(s.label, lx + 18, y);
      ctx.fillStyle = '#e8eaf8';
      ctx.font = '600 12px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(s.value, w - 6, y);
      ctx.textAlign = 'left';
    });
  }

  // Stacked bars, one per bucket (oldest first). Each bucket is an array of counts, one per color.
  function bars(canvas, buckets, colors, { len = buckets.length, unit = '/s' } = {}) {
    const { ctx, w, h } = prep(canvas);
    const left = 34, top = 6, bottom = h - 2;
    const max = Math.max(4, ...buckets.map((b) => b.reduce((a, v) => a + v, 0)));
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#5c628c';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const f of [0, 0.5, 1]) {
      const y = bottom - f * (bottom - top);
      ctx.strokeStyle = f === 0 ? '#262c52' : 'rgba(38, 44, 82, 0.5)';
      ctx.setLineDash(f === 0 ? [] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (f) ctx.fillText(Math.round(max * f) + unit, left - 5, y);
    }
    ctx.setLineDash([]);
    const bw = (w - left) / len;
    const off = len - buckets.length;
    buckets.forEach((b, i) => {
      let y = bottom;
      const x = left + (i + off) * bw;
      b.forEach((v, k) => {
        if (!v) return;
        const bh = (v / max) * (bottom - top);
        ctx.fillStyle = colors[k];
        ctx.fillRect(x + 0.5, y - bh, Math.max(1, bw - 1.5), bh);
        y -= bh;
      });
    });
  }

  // Inline SVG sparkline for table rows (cheap enough to regenerate every tick).
  function svgSpark(data, color, max = 100) {
    if (data.length < 2) return '<svg viewBox="0 0 70 20"></svg>';
    const peak = Math.max(max, ...data) || 1;
    const step = 70 / (30 - 1);
    const off = 30 - data.length;
    const pts = data.map((v, i) => `${((i + off) * step).toFixed(1)},${(19 - (v / peak) * 17).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 70 20" preserveAspectRatio="none"><polyline points="${pts}" stroke="${color}"/></svg>`;
  }

  // Squarified treemap layout. items: [{value, ...}] sorted desc. Returns items with x,y,w,h.
  function squarify(items, x, y, w, h) {
    const total = items.reduce((a, i) => a + i.value, 0);
    if (!total) return [];
    const scale = (w * h) / total;
    const nodes = items.map((i) => ({ ...i, area: i.value * scale }));
    const out = [];
    let rect = { x, y, w, h };

    const worst = (row, side) => {
      const s = row.reduce((a, n) => a + n.area, 0);
      const mx = Math.max(...row.map((n) => n.area));
      const mn = Math.min(...row.map((n) => n.area));
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    };
    const layoutRow = (row) => {
      const s = row.reduce((a, n) => a + n.area, 0);
      if (rect.w >= rect.h) {
        const cw = s / rect.h;
        let cy = rect.y;
        for (const n of row) {
          const nh = n.area / cw;
          out.push({ ...n, x: rect.x, y: cy, w: cw, h: nh });
          cy += nh;
        }
        rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
      } else {
        const ch = s / rect.w;
        let cx = rect.x;
        for (const n of row) {
          const nw = n.area / ch;
          out.push({ ...n, x: cx, y: rect.y, w: nw, h: ch });
          cx += nw;
        }
        rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
      }
    };

    let row = [];
    for (const n of nodes) {
      const side = Math.min(rect.w, rect.h);
      if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
      else {
        layoutRow(row);
        row = [n];
      }
    }
    if (row.length) layoutRow(row);
    return out;
  }

  return { prep, alpha, area, mirror, spark, ring, donut, bars, svgSpark, squarify };
})();
