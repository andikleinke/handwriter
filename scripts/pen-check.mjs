/**
 * Pen model harness: writes words with the model, checks each letter's
 * trajectory against the taught template it came from, and draws a sheet.
 *
 *   node scripts/pen-check.mjs            prints the per-letter fits, writes pen-sheet.svg
 */
import { writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';

/** Render an SVG to PNG with macOS Quick Look (no other renderer is installed); returns the PNG path. */
function toPng(svgFile) {
  const abs = resolve(svgFile);
  const dir = dirname(abs);
  const tmp = resolve(dir, '.ql');
  mkdirSync(tmp, { recursive: true });
  execFileSync('qlmanage', ['-t', '-s', '1400', '-o', tmp, abs], { stdio: 'ignore' });
  const produced = resolve(tmp, basename(abs) + '.png');
  const png = abs.replace(/\.svg$/, '.png');
  if (existsSync(produced)) renameSync(produced, png);
  return png;
}
import { composeWord } from '../src/pen/compose.js';
import { DEFAULT_STYLE, LETTERS, STYLES } from '../src/pen/grammar.js';
import { HAND_WAYPOINTS as HAND_LETTERS } from '../src/pen/hand-letters.js';
import { templateFor, templateFit } from '../src/lib/templates.js';

const args = process.argv.slice(2);
const styleArg = args.find((a) => a.startsWith('--hand='));
let style = { ...(styleArg ? STYLES[styleArg.split('=')[1]] : DEFAULT_STYLE) };
let failures = 0;
const proof = args.find((a) => a.startsWith('--proof'));
const scaleArg = args.find((a) => a.startsWith('--scale='));
const varArg = args.find((a) => a.startsWith('--var='));
if (varArg) style = { ...style, variability: Number(varArg.split('=')[1]) };
const S = scaleArg ? Number(scaleArg.split('=')[1]) : 0.22; // px per font unit on the sheet
const words = args.filter((a) => !a.startsWith('--')).length
  ? args.filter((a) => !a.startsWith('--'))
  : ['abcdefghijklm', 'nopqrstuvwxyz', 'ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ', 'hello minimum', 'quick brown fox', 'jumps over the', 'lazy dog', 'Handwriter', 'Andreas Holger', 'Jazz it up'];

// per-letter fit: the letter's own strokes' trajectory, box-normalised, against its template
function letterFits(result) {
  const fits = [];
  for (const chain of result.chains) {
    if (!chain.letters) continue;
    const cumStroke = []; // arc length where each stroke's target lies (approximate: by time share)
    for (const L of chain.letters) {
      if (L.to <= L.from) continue;
      // samples belonging to the letter: between the onset of its first stroke and the end of its last
      const t0 = chain.strokeTimes?.[L.from]?.t0 ?? 0;
      const t1 = chain.strokeTimes?.[L.to - 1]?.t1 ?? Infinity;
      const pts = chain.pts.filter((_, k) => chain.times[k] >= t0 && chain.times[k] <= t1);
      if (pts.length < 4) continue;
      const tpl = templateFor(L.ch);
      if (!tpl) continue;
      // a mark (a dot, a bar, a second slant) is matched against its own template stroke,
      // and a stroke too short to have a shape is not judged at all
      const ref = tpl[chain.mark ?? 0] ?? tpl[0];
      if (ref.length < 4) continue;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [x, y] of pts) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
      const w = Math.max(x2 - x1, 1e-6), h = Math.max(y2 - y1, 1e-6);
      const norm = pts.map(([x, y]) => [(x - x1) / w, (y - y1) / h]);
      fits.push({ ch: L.ch, fit: templateFit([ref], norm), n: pts.length });
    }
  }
  return fits;
}

if (proof) {
  // every letter on its own, large, with its targets: the sheet to tune against
  const lettersArg = args.find((a) => a.startsWith('--letters='));
  const set = lettersArg ? lettersArg.split('=')[1] : proof === '--proof=upper' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : 'abcdefghijklmnopqrstuvwxyz';
  const S = 0.3, cols = 3, cw = 3.4 * style.xHeight * S, chh = 3.6 * style.xHeight * S;
  const W = cols * cw + 20, H = Math.ceil(set.length / cols) * chh + 20;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#fbfaf7">`;
  [...set].forEach((ch, i) => {
    const r = composeWord(ch, style);
    const ox = 10 + (i % cols) * cw + 0.4 * style.xHeight * S, oy = 10 + Math.floor(i / cols) * chh + 2.4 * style.xHeight * S; // baseline
    const X = (x) => ox + x * S, Y = (y) => oy - y * S;
    svg += `<line x1="${ox}" y1="${Y(0)}" x2="${ox + cw - 20}" y2="${Y(0)}" stroke="#ccc" stroke-dasharray="3 3"/>`;
    svg += `<line x1="${ox}" y1="${Y(style.xHeight)}" x2="${ox + cw - 20}" y2="${Y(style.xHeight)}" stroke="#ddd" stroke-dasharray="3 3"/>`;
    svg += `<text x="${ox - 0.3 * style.xHeight * S}" y="${oy - 2.2 * style.xHeight * S}" font-family="sans-serif" font-size="13" fill="#999">${ch}</text>`;
    for (const c of r.chains) {
      const n = c.pts.length, left = [], right = [];
      for (let k = 0; k < n; k++) {
        const a = c.pts[Math.max(0, k - 1)], b = c.pts[Math.min(n - 1, k + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l, ny = dx / l, hw = c.widths[k] / 2;
        left.push([c.pts[k][0] + nx * hw, c.pts[k][1] + ny * hw]); right.push([c.pts[k][0] - nx * hw, c.pts[k][1] - ny * hw]);
      }
      svg += `<polygon points="${left.concat(right.reverse()).map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ')}" fill="#16191f"/>`;
      c.targets.forEach((t, k) => { svg += `<circle cx="${X(t[0]).toFixed(1)}" cy="${Y(t[1]).toFixed(1)}" r="2.4" fill="#fff" stroke="#e0562d" stroke-width="0.9"/>`; });
    }
  });
  svg += '</svg>';
  const outArg = args.find((a) => a.startsWith('--out='));
  const file = outArg ? outArg.split('=')[1] : proof === '--proof=upper' ? 'pen-proof-upper.svg' : 'pen-proof.svg';
  writeFileSync(file, svg);
  console.log(`proof sheet written to ${file} (${Math.round(W)}x${Math.round(H)}), hand: ${style.name}`);
  if (args.includes('--png')) console.log(toPng(file));
  process.exit(0);
}

const rows = [];
const sheet = [];
let sy = 0;
for (const w of words) {
  const r = composeWord(w, style);
  for (const n of r.notes) rows.push(`  ${w}: ${n.message}`);
  const fits = letterFits(r);
  // legibility smoke test: finite geometry, every chain lands on its last target, no letter far off its template
  for (const c of r.chains) {
    const last = c.pts[c.pts.length - 1], want = c.targets[c.targets.length - 1];
    if (c.pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) { rows.push(`  !! ${w}: non-finite trajectory`); failures++; }
    else if (Math.hypot(last[0] - want[0], last[1] - want[1]) > 0.05 * r.xHeight && !c.dot) { rows.push(`  !! ${w}: chain ${c.id} misses its last target`); failures++; }
  }
  // a letter written in several pen-downs is normalised per pen-down here, so its
  // fit is only informative; a one-stroke letter far off its template is a failure
  // a letter refined by hand deliberately departs from the taught waypoints: its fit is informative only
  for (const f of fits) if (!style.letters && f.fit < 0.3 && f.n > 20 && (templateFor(f.ch) || []).length === 1 && !HAND_LETTERS[f.ch]) { rows.push(`  !! ${w}: “${f.ch}” far from its template (fit ${f.fit.toFixed(2)})`); failures++; }
  rows.push(`${w.padEnd(16)} chains ${r.chains.length}  ${r.total.toFixed(2)} s  ` + fits.map((f) => `${f.ch}:${f.fit.toFixed(2)}`).join(' '));
  sheet.push({ word: w, r, y: sy });
  sy += r.bounds.h + 60;
}
console.log(rows.join('\n'));

// the sheet: ink ribbons per chain, targets as small circles
const W = Math.max(...sheet.map((s) => s.r.bounds.w)) * S + 40;
const H = sy * S + 40;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#fbfaf7">`;
for (const { r, y } of sheet) {
  const ox = 20 - r.bounds.x1 * S, oy = 20 + (y + r.bounds.h - (-r.bounds.y1)) * S; // baseline y for this row
  const X = (x) => ox + x * S, Y = (yy) => oy - yy * S;
  svg += `<line x1="${X(r.bounds.x1)}" y1="${Y(0)}" x2="${X(r.bounds.x2)}" y2="${Y(0)}" stroke="#ccc" stroke-dasharray="4 4"/>`;
  svg += `<line x1="${X(r.bounds.x1)}" y1="${Y(r.xHeight)}" x2="${X(r.bounds.x2)}" y2="${Y(r.xHeight)}" stroke="#ddd" stroke-dasharray="4 4"/>`;
  for (const c of r.chains) {
    const n = c.pts.length;
    const left = [], right = [];
    for (let k = 0; k < n; k++) {
      const a = c.pts[Math.max(0, k - 1)], b = c.pts[Math.min(n - 1, k + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, ny = dx / l, hw = c.widths[k] / 2;
      left.push([c.pts[k][0] + nx * hw, c.pts[k][1] + ny * hw]);
      right.push([c.pts[k][0] - nx * hw, c.pts[k][1] - ny * hw]);
    }
    const poly = left.concat(right.reverse()).map(([x, yy]) => `${X(x).toFixed(1)},${Y(yy).toFixed(1)}`).join(' ');
    svg += `<polygon points="${poly}" fill="#16191f"/>`;
    for (const t of c.targets) svg += `<circle cx="${X(t[0]).toFixed(1)}" cy="${Y(t[1]).toFixed(1)}" r="2.2" fill="none" stroke="#e0562d" stroke-width="0.8"/>`;
  }
}
svg += '</svg>';
const sheetOut = args.find((a) => a.startsWith('--out='));
const sheetFile = sheetOut ? sheetOut.split('=')[1] : 'pen-sheet.svg';
writeFileSync(sheetFile, svg);
console.log(`\nletters known: ${Object.keys(LETTERS).length}; hand: ${style.name}; sheet written to ${sheetFile} (${Math.round(W)}x${Math.round(H)})`);
if (args.includes('--png')) console.log(toPng(sheetFile));
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
