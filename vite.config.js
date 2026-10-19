import { defineConfig } from 'vite';
import movieExport from './scripts/movie-server.mjs';

export default defineConfig(({ command }) => ({
  // The built site is served from GitHub Pages under the repository's name
  // (https://andikleinke.github.io/handwriter/); the dev server stays at /.
  base: command === 'build' ? '/handwriter/' : '/',
  // Export movie: the page renders frames, the dev server encodes them with
  // AVFoundation into a .mov that keeps the alpha channel
  plugins: [movieExport()],
  server: { port: 5173, open: false },
  // harfbuzzjs is an ESM bundle with a top-level await and a
  // `new URL('harfbuzz.wasm', import.meta.url)` lookup; leaving it
  // unpre-bundled lets Vite emit the wasm as a real asset.
  optimizeDeps: { exclude: ['harfbuzzjs'] },
  build: { target: 'esnext', assetsInlineLimit: 0 },
  // the alphabet check's worker is a module (harfbuzzjs has a top-level await)
  worker: { format: 'es' },
  assetsInclude: ['**/*.otf', '**/*.ttf'],
}));
