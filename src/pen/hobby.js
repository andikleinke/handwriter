/**
 * Hobby's algorithm (METAFONT's `make_choices`): a cubic Bézier spline through
 * a sequence of points with near-continuous curvature, the curve type designers
 * draw with. Ported from hobby-curve 0.2.1 by arnoson (ISC licence,
 * https://github.com/arnoson/hobby-curve), kept as it was published apart
 * from formatting; `tension` 1 is METAFONT's default, ends have curl 1.
 *
 * Copyright (c) arnoson. Permission to use, copy, modify, and/or distribute
 * this software for any purpose with or without fee is hereby granted,
 * provided that the above copyright notice and this permission notice appear
 * in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE.
 */

const curlRatio = function (t, e, l) { const a = 1 / e, n = 1 / l; return Math.min(4, ((3 - a) * a ** 2 * t + n ** 3) / (a ** 3 * t + (3 - n) * n ** 2)); };
const velocity = (t, e, l, a, n) => Math.min(4, (2 + Math.sqrt(2) * (t - l / 16) * (l - t / 16) * (e - a)) / (1.5 * n * (2 + (Math.sqrt(5) - 1) * e + (3 - Math.sqrt(5)) * a)));
const setControls = (t, l) => {
  const a = Math.sin(t.theta), n = Math.cos(t.theta), h = Math.sin(l.phi), r = Math.cos(l.phi), o = l.leftY, s = t.rightY, i = velocity(a, n, h, r, o), Y = velocity(h, r, a, n, s);
  t.rightX = t.x + (t.deltaX * n - t.deltaY * a) * i; t.rightY = t.y + (t.deltaY * n + t.deltaX * a) * i;
  l.leftX = l.x - (t.deltaX * r + t.deltaY * h) * Y; l.leftY = l.y - (t.deltaY * r - t.deltaX * h) * Y;
};
const makeChoices = (e, a = 1, n = false) => {
  var h, r;
  const o = e.map(({ x: t, y: e }) => ((t, e, l) => ({ x: t, y: e, leftY: l, rightY: l, leftX: l, rightX: l, deltaX: 0, deltaY: 0, delta: 0, theta: 0, phi: 0, psi: 0 }))(t, e, a));
  const s = o[0], i = o[o.length - 1];
  for (let t = 0; t < o.length; t++) { o[t].next = null != (h = o[t + 1]) ? h : s; o[t].prev = null != (r = o[t - 1]) ? r : i; }
  if (((t, e) => { var l; const a = e ? t.length : t.length - 1; for (let e = 0; e < a; e++) { const a = t[e], n = null != (l = t[e + 1]) ? l : t[0]; a.deltaX = n.x - a.x; a.deltaY = n.y - a.y; a.delta = Math.hypot(a.deltaX, a.deltaY); } })(o, n), 2 === e.length && !n) {
    return ((t, e) => { let l = 1 / (3 * t.rightY); t.rightX = t.x + t.deltaX * l; t.rightY = t.y + t.deltaY * l; l = 1 / (3 * e.leftY); e.leftX = e.x - t.deltaX * l; e.leftY = e.y - t.deltaY * l; })(s, i), o;
  }
  ((t, e) => { const [l, a] = e ? [0, t.length] : [1, t.length - 1]; for (let e = l; e < a; e++) { const l = t[e], a = l.prev, n = a.deltaY / a.delta, h = a.deltaX / a.delta; l.psi = Math.atan2(l.deltaY * h - l.deltaX * n, l.deltaX * h + l.deltaY * n); } })(o, n);
  (function (e, l) {
    var a;
    const n = [], h = [], r = [], o = e[0], s = e[1], i = e[e.length - 1], Y = l ? e.length + 1 : e.length;
    if (l) { n[0] = 0; r[0] = 0; h[0] = 1; } else {
      const e = o.next, l = o.rightX, a = Math.abs(e.leftY), i = Math.abs(o.rightY);
      n[0] = curlRatio(l, i, a); r[0] = -s.psi * n[0]; h[0] = 0;
    }
    for (let s = 1; s < Y; s++) {
      const c = null != (a = e[s]) ? a : o, d = c.next, f = c.prev, g = s === Y - 1;
      if (!l && g) {
        const e = c.leftX, l = Math.abs(c.leftY), a = Math.abs(f.rightY), h = curlRatio(e, l, a);
        i.theta = -r[Y - 2] * h / (1 - h * n[Y - 2]);
        break;
      }
      {
        let t = 1 / (3 * Math.abs(f.rightY) - 1), e = c.delta * (3 - 1 / Math.abs(f.rightY)), a = 1 / (3 * Math.abs(d.leftY) - 1), i = f.delta * (3 - 1 / Math.abs(d.leftY));
        const x = 1 - n[s - 1] * t;
        e *= x;
        const M = Math.abs(c.leftY), X = Math.abs(c.rightY);
        M < X ? (e *= (M / X) ** 2) : (i *= (X / M) ** 2);
        let p = i / (i + e);
        n[s] = p * a;
        let y = -d.psi * n[s];
        if ((p = (1 - p) / x), (y -= c.psi * p), (p *= t), (r[s] = y - r[s - 1] * p), (h[s] = -h[s - 1] * p), l && g) {
          let t = 0, e = 1;
          for (let l = s - 1; l >= 0; l--) { const a = 0 === l ? Y - 1 : l; t = r[a] - t * n[a]; e = h[a] - e * n[a]; }
          t /= 1 - e; o.theta = t; r[0] = t;
          for (let e = 1; e < Y - 1; e++) r[e] = r[e] + t * h[e];
          break;
        }
      }
    }
    for (let t = Y - 2; t >= 0; t -= 1) e[t].theta = r[t] - e[t].next.theta * n[t];
  })(o, n);
  ((t) => { for (let e = 0; e < t.length; e++) { const l = t[e]; l.phi = -l.psi - l.theta; } })(o);
  const Y = n ? o.length : o.length - 1;
  for (let t = 0; t < Y; t++) setControls(o[t], o[t].next);
  return o;
};

/**
 * @param {{x:number,y:number}[]} points
 * @param {{tension?:number, cyclic?:boolean}} [opts]
 * @returns {Array<{startControl:{x,y}, endControl:{x,y}, point:{x,y}}>} one cubic per segment
 */
export const createHobbyBezier = (t, { tension: e = 1, cyclic: l = false } = {}) => {
  const n = makeChoices(t, e, l), h = [], r = l ? n.length : n.length - 1;
  for (let t = 0; t < r; t++) { const e = n[t]; h.push({ startControl: { x: e.rightX, y: e.rightY }, endControl: { x: e.next.leftX, y: e.next.leftY }, point: { x: e.next.x, y: e.next.y } }); }
  return h;
};
