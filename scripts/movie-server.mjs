/**
 * Movie export, the server half: a Vite plugin that takes the frames the page
 * renders and encodes them into a QuickTime movie with an alpha channel.
 *
 * A browser cannot write video with alpha that Keynote or an editor will
 * play, so the page renders each frame on a fixed clock with a transparent
 * background, posts it here as a PNG, and asks for the movie when it is done.
 * The encoding is AVFoundation, through scripts/encode-movie.swift, compiled
 * once into node_modules/.cache and rebuilt whenever the source changes.
 *
 *   POST /__movie/start   {fps, codec}   -> {id}
 *   POST /__movie/frame?id=&n=   PNG bytes
 *   POST /__movie/finish?id=     -> the .mov
 *
 * Only the dev server (and `vite preview`) serves this; it is local by
 * construction and validates everything it is handed.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SOURCE = join(ROOT, 'scripts', 'encode-movie.swift');
const BINARY = join(ROOT, 'node_modules', '.cache', 'handwriter', 'encode-movie');

const CODECS = new Set(['prores4444', 'hevc-alpha']);
const MAX_FRAMES = 36000;           // ten minutes at 60 fps
const MAX_FRAME_BYTES = 64 << 20;   // a 4K PNG with room to spare
const STALE_MS = 30 * 60 * 1000;    // an abandoned export is cleared after half an hour

/** id -> { dir, fps, codec, frames, touched } */
const jobs = new Map();

async function ensureEncoder() {
  const [src, bin] = await Promise.all([stat(SOURCE), stat(BINARY).catch(() => null)]);
  if (bin && bin.mtimeMs >= src.mtimeMs) return BINARY;
  await mkdir(join(ROOT, 'node_modules', '.cache', 'handwriter'), { recursive: true });
  await run('swiftc', ['-O', SOURCE, '-o', BINARY], { timeout: 300000 });
  return BINARY;
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function sweepStale() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.touched < STALE_MS) continue;
    jobs.delete(id);
    await rm(job.dir, { recursive: true, force: true });
  }
}

async function handle(req, res, url) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

  if (url.pathname === '/__movie/start') {
    await sweepStale();
    const opts = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    const fps = Number(opts.fps);
    if (!Number.isInteger(fps) || fps < 1 || fps > 120) return send(res, 400, { error: 'fps must be 1-120' });
    if (!CODECS.has(opts.codec)) return send(res, 400, { error: 'codec must be prores4444 or hevc-alpha' });
    const id = randomBytes(8).toString('hex');
    const dir = await mkdtemp(join(tmpdir(), 'handwriter-movie-'));
    jobs.set(id, { dir, fps, codec: opts.codec, frames: 0, touched: Date.now() });
    return send(res, 200, { id });
  }

  const id = url.searchParams.get('id') || '';
  const job = /^[0-9a-f]{16}$/.test(id) ? jobs.get(id) : null;
  if (!job) return send(res, 404, { error: 'no such export' });
  job.touched = Date.now();

  if (url.pathname === '/__movie/frame') {
    const n = Number(url.searchParams.get('n'));
    if (!Number.isInteger(n) || n < 0 || n >= MAX_FRAMES) return send(res, 400, { error: 'bad frame number' });
    const png = await readBody(req, MAX_FRAME_BYTES);
    // a PNG and nothing else: the encoder trusts what is in the folder
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return send(res, 400, { error: 'not a PNG' });
    await writeFile(join(job.dir, `frame_${String(n).padStart(6, '0')}.png`), png);
    job.frames = Math.max(job.frames, n + 1);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/__movie/finish') {
    jobs.delete(id);
    try {
      const count = (await readdir(job.dir)).filter((f) => f.endsWith('.png')).length;
      if (!count) return send(res, 400, { error: 'no frames' });
      const encoder = await ensureEncoder();
      const out = join(job.dir, 'movie.mov');
      await run(encoder, [job.dir, out, String(job.fps), job.codec], { timeout: 15 * 60 * 1000 });
      const movie = await readFile(out);
      res.setHeader('X-Frames', String(count));
      return send(res, 200, movie, 'video/quicktime');
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }

  return send(res, 404, { error: 'unknown endpoint' });
}

function middleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/__movie/')) return next();
  handle(req, res, url).catch((err) => {
    // the encoder's own message is the useful part of a failure
    const detail = err.stderr?.toString().trim() || err.message;
    if (!res.headersSent) send(res, 500, { error: detail });
  });
}

export default function movieExport() {
  return {
    name: 'handwriter-movie-export',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
