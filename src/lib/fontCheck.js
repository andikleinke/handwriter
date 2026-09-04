/**
 * Invariant checks for the font route. The recovery needs a canvas, so this
 * runs in the page after an analysis (window.__fontCheck in main.js) and
 * reports, per glyph and per join, whether the recovered pen path obeys the
 * pointed-pen rules: shades written downward, strokes started at the top of
 * a shade or on a hairline, and letters joined by a flowing hairline or by
 * a lift where the hairline runs into a shade. Ink widths come from the
 * records themselves (one per point).
 */

const MARK_ROLES = new Set(['dot', 'accent', 'crossbar']);

/**
 * @param {object} analysis  from analyzeWord
 * @returns {{glyphs: Array, joins: Array, failures: string[], ok: boolean}}
 */
export function checkAnalysis(analysis) {
  const glyphs = [];
  const failures = [];
  for (const g of analysis.glyphs) {
    if (g.isBlank || !g.record) continue;
    const label = g.chars?.trim() || g.name;
    const hand = g.record.stats?.hand || { pointed: false };
    const isShade = (wd) => wd != null && hand.pointed && wd >= hand.shade * 0.75;
    const rec = { label, pointed: hand.pointed, strokes: 0, shadeUp: 0, shadeLen: 0, starts: [], lifts: 0 };
    const bodies = g.record.strokes.filter((s) => !MARK_ROLES.has(s.role));
    rec.strokes = bodies.length;
    rec.lifts = Math.max(0, bodies.length - 1);
    const xh = g.record.unitsPerEm * 0.33;
    for (const s of bodies) {
      const pts = s.points, ws = s.widths || null;
      if (pts.length < 2) continue;
      // the start: thick ink heading down is the top of a shade; thin ink a
      // hairline. Read a little way in, past the knot a junction inflates.
      let k = 0, run = 0;
      while (k + 1 < pts.length && run < 0.12 * xh) { run += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]); k++; }
      const w0 = ws ? Math.min(...ws.slice(Math.min(1, k), k + 1)) : null;
      const dy0 = pts[k][1] - pts[0][1]; // y-up: > 0 climbs
      let kind = 'unknown';
      if (w0 != null) {
        if (isShade(w0)) kind = dy0 <= 0.05 * xh ? 'shade-top' : 'shade-foot';
        else kind = 'hairline';
      }
      const bb = g.record.bbox;
      rec.starts.push({
        kind,
        x: round2((pts[0][0] - bb.x1) / Math.max(bb.x2 - bb.x1, 1e-6)),
        y: round2((pts[0][1] - bb.y1) / Math.max(bb.y2 - bb.y1, 1e-6)),
      });
      if (kind === 'shade-foot') failures.push(`${label}: stroke ${s.index} starts at the foot of a shade and climbs it`);
      if (!ws) continue;
      let up = 0;
      for (let i = 1; i < pts.length; i++) {
        const w = Math.min(ws[i - 1], ws[i]);
        if (!isShade(w)) continue;
        const dy = pts[i][1] - pts[i - 1][1];
        const len = Math.hypot(pts[i][0] - pts[i - 1][0], dy);
        rec.shadeLen += len;
        if (dy > 0.3 * len) up += len;
      }
      // running back over a foot just written is not writing it upward
      const retraced = (s.retraces || []).reduce((t, r) => t + (r.lengthFontUnits || 0), 0);
      rec.shadeUp += Math.max(0, up - retraced);
      rec.against = (rec.against || 0) + (s.againstRule || 0);
    }
    rec.shadeUp = Math.round(rec.shadeUp);
    rec.shadeLen = Math.round(rec.shadeLen);
    // the search's own count of ink written against its rules is the test;
    // the raw width measure cannot tell a loop's swell from a shade
    if (hand.pointed && rec.against > 0.06 * g.record.unitsPerEm) {
      failures.push(`${label}: ${Math.round(rec.against)}u of ink written against the pointed-pen rules (raw upward shade ${rec.shadeUp}u of ${rec.shadeLen}u)`);
    }
    glyphs.push(rec);
  }

  // joins: one note per consecutive pair of letters in a word
  const joins = [];
  const notes = analysis.plan?.notes || [];
  const gl = analysis.glyphs;
  for (let i = 1; i < gl.length; i++) {
    const a = gl[i - 1], b = gl[i];
    if (a.isBlank || b.isBlank || !a.record?.strokes?.length || !b.record?.strokes?.length) continue;
    const la = a.chars?.trim() || a.name, lb = b.chars?.trim() || b.name;
    const note = notes.find((n) => n.glyphIndex === i - 1 && ['bridge', 'lift-join', 'lift'].includes(n.code));
    const kind = note ? note.code : 'none';
    joins.push({ pair: `${la}→${lb}`, kind, detail: note?.message?.replace(/^[^:]*: /, '') || '' });
    if (kind === 'lift') failures.push(`${la}→${lb}: the pen lifts although the strokes end and start close together`);
    if (note?.message?.includes('landing mid-stroke')) failures.push(`${la}→${lb}: mid-stroke landing (the pen would write up a stem)`);
  }
  return { glyphs, joins, failures, ok: failures.length === 0 };
}

const round2 = (v) => Math.round(v * 100) / 100;
