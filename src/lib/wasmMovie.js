/**
 * A movie with an alpha channel, encoded in the browser.
 *
 * No browser's own encoder keeps alpha (WebCodecs drops it for HEVC and VP9
 * in Safari and Chrome alike), so the frames go through FFmpeg compiled to
 * WebAssembly, whose ProRes encoder writes a real alpha plane: ProRes 4444
 * in a QuickTime file, which Keynote, Final Cut and Motion take as is.
 *
 * The encoder (about 30 MB) is fetched once from a CDN and cached by the
 * browser; the frames are written as PNGs into its in-memory file system
 * and encoded in one run. Single-threaded, since the multi-threaded build
 * needs cross-origin isolation headers a static host cannot set.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'; // the ESM build: the worker is a module worker under Vite

let ffmpeg = null;
let loading = null;
const logTail = [];

/** The encoder, loaded once. */
export async function loadEncoder(onStatus = () => {}) {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      onStatus('Loading encoder…');
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => { logTail.push(message); if (logTail.length > 40) logTail.shift(); });
      await ff.load({
        coreURL: await toBlobURL(`${CORE_URL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      ffmpeg = ff;
      return ff;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/**
 * Render and encode.
 * @param {object} o
 * @param {(onFrame: (canvas, n, count) => Promise<void>) => Promise<{width:number,height:number,fps:number,count:number}>} o.render
 *        runs the frame renderer, calling onFrame per frame
 * @param {number} o.fps
 * @param {(status: string) => void} [o.onStatus]
 * @returns {Promise<{blob: Blob, info: object}>}
 */
export async function encodeProRes({ render, fps, onStatus = () => {} }) {
  const ff = await loadEncoder(onStatus);
  const toPng = (canvas) => new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('frame encode failed'))), 'image/png'));
  const names = [];
  let info;
  try {
    info = await render(async (canvas, n, count) => {
      const png = await toPng(canvas);
      const name = `f${String(n).padStart(5, '0')}.png`;
      await ff.writeFile(name, new Uint8Array(await png.arrayBuffer()));
      names.push(name);
      onStatus(`Rendering ${n + 1}/${count}`);
    });
    const onProgress = ({ progress }) => onStatus(`Encoding ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`);
    ff.on('progress', onProgress);
    onStatus('Encoding 0%');
    let code;
    try {
      code = await ff.exec([
        '-framerate', String(fps), '-i', 'f%05d.png',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0',
        '-r', String(fps), '-y', 'out.mov',
      ]);
    } finally {
      ff.off('progress', onProgress);
    }
    if (code !== 0) throw new Error(`FFmpeg failed (${code}): ${logTail.slice(-4).join(' / ')}`);
    const data = await ff.readFile('out.mov');
    const blob = new Blob([data.buffer], { type: 'video/quicktime' });
    await ff.deleteFile('out.mov').catch(() => {});
    return { blob, info };
  } finally {
    for (const name of names) await ff.deleteFile(name).catch(() => {});
  }
}
