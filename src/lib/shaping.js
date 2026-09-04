/**
 * Text shaping via HarfBuzz (WASM) with outlines from opentype.js.
 *
 * HarfBuzz decides *which* glyphs are used and where they sit - that is what
 * applies `calt`, `liga` and the cursive connections this whole prototype
 * depends on. opentype.js is then asked for the outline of each glyph *by the
 * glyph id HarfBuzz returned*, never by character.
 */

import { Blob, Face, Font, Buffer, shape, versionString } from 'harfbuzzjs';
import opentype from 'opentype.js';

export async function loadFont(arrayBuffer, sourceName = 'font') {
  // opentype.parse detaches nothing but HarfBuzz keeps a view, so hand each
  // one its own copy of the bytes.
  const bytes = new Uint8Array(arrayBuffer.slice(0));
  const blob = new Blob(bytes);
  const face = new Face(blob, 0);
  const hbFont = new Font(face);
  hbFont.setScale(face.upem, face.upem);

  const ot = opentype.parse(arrayBuffer.slice(0));

  const gsubFeatures = ot.tables.gsub
    ? [...new Set(ot.tables.gsub.features.map((f) => f.tag))]
    : [];

  // x-height in font units, measured as the median top of the ascender-less
  // lowercase letters (OS/2 sxHeight is unreliable in script fonts). The
  // handwriting literature quotes speeds in x-heights per second.
  const tops = [];
  for (const ch of 'xzeounvwacmrs') {
    const gi = ot.charToGlyphIndex(ch);
    if (!gi) continue;
    const bb = ot.glyphs.get(gi).getBoundingBox();
    if (Number.isFinite(bb.y2) && bb.y2 > 0) tops.push(bb.y2);
  }
  tops.sort((a, b) => a - b);
  const xHeight = tops.length ? tops[tops.length >> 1] : ot.tables.os2?.sxHeight || face.upem * 0.5;

  return {
    xHeight,
    sourceName,
    face,
    hbFont,
    ot,
    unitsPerEm: face.upem,
    ascender: ot.ascender,
    descender: ot.descender,
    numGlyphs: ot.glyphs.length,
    gsubFeatures,
    harfbuzzVersion: versionString(),
    familyName: ot.names?.fontFamily?.en ?? sourceName,
  };
}

/**
 * @returns {{glyphs: Array, advance: number, naiveGids: number[]}}
 *   glyphs: [{ gid, name, cluster, chars, x, y, xAdvance, path, bbox, isBlank }]
 *   positions are in font units, y-up, origin at the start of the run.
 */
export function shapeText(fontCtx, text) {
  const buf = new Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  shape(fontCtx.hbFont, buf);

  const raw = buf.getGlyphInfosAndPositions();
  const clusters = raw.map((g) => g.cluster);

  let penX = 0;
  let penY = 0;
  const glyphs = raw.map((g, i) => {
    const gid = g.codepoint;
    const otGlyph = fontCtx.ot.glyphs.get(gid);
    const bbox = otGlyph.getBoundingBox();
    const blank =
      !Number.isFinite(bbox.x1) || bbox.x2 - bbox.x1 <= 0 || bbox.y2 - bbox.y1 <= 0;
    const nextCluster = i + 1 < clusters.length ? clusters[i + 1] : text.length;
    const entry = {
      index: i,
      gid,
      name: otGlyph.name || `gid${gid}`,
      cluster: g.cluster,
      chars: text.slice(g.cluster, Math.max(nextCluster, g.cluster + 1)),
      x: penX + g.xOffset,
      y: penY + g.yOffset,
      xAdvance: g.xAdvance,
      path: blank ? '' : otGlyph.getPath(0, 0, fontCtx.unitsPerEm).toPathData(3),
      bbox,
      isBlank: blank,
    };
    penX += g.xAdvance;
    penY += g.yAdvance;
    return entry;
  });

  // Purely for the "shaping actually mattered" readout in the UI.
  const naiveGids = [...text].map((c) => fontCtx.ot.charToGlyphIndex(c));

  return { text, glyphs, advance: penX, naiveGids };
}
