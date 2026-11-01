# Handwriter

A browser prototype (plain JS + Vite, no framework) that animates text being handwritten: a script font is
shaped with HarfBuzz, rasterised, skeletonised, the pen's stroke order is recovered per letter, and the strokes are
drawn as vector ribbons at the font's ink width. Letter Studio lets the user correct stroke paths by hand; a hand
file for Autography is bundled. Hosted at https://andikleinke.github.io/handwriter/ (deploys from `main` through
GitHub Pages). See README.md for the engine and docs/STATUS.md for the state.

## Build and run

    npm install
    npm run dev       # Vite dev server on :5173 (also .claude/launch.json "handwriter")
    npm test          # node --check on the main modules
    npm run build     # dist/
    node scripts/release.mjs <x.y.z> "note"   # bumps package.json, commits, tags, regenerates versions.json

Export movie with alpha needs the dev server on a Mac (AVFoundation encoder) or the in-browser ProRes route.

## Conventions

- Two-Mac workflow: commit and push before walking away, pull before starting work. Never leave work uncommitted
  at the end of a session.
- Update docs/STATUS.md at the end of every session.
- Releases go through scripts/release.mjs; the page title shows package.json's version, so bump it per release.
- Bump RECORD_VERSION in src/lib/strokeRecovery.js whenever recovery output changes (it is the cache key).
- Keep element ids stable (scripts/inspect.js and tests click them); terse capitalised labels in the UI.
- The pen model was retired in v0.23.0 (recoverable at tag v0.22.0); do not reintroduce it.
