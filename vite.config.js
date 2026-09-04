import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: false },
  // harfbuzzjs is an ESM bundle with a top-level await and a
  // `new URL('harfbuzz.wasm', import.meta.url)` lookup; leaving it
  // unpre-bundled lets Vite emit the wasm as a real asset.
  optimizeDeps: { exclude: ['harfbuzzjs'] },
  build: { target: 'esnext', assetsInlineLimit: 0 },
  assetsInclude: ['**/*.otf', '**/*.ttf'],
});
