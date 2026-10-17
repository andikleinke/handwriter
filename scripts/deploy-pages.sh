#!/bin/sh
# Build the site and publish dist/ to the gh-pages branch, which GitHub Pages
# serves at https://andikleinke.github.io/handwriter/.
#
#   npm run deploy
#
# Normally unnecessary: .github/workflows/pages.yml builds and deploys the
# site on every push to main. This is the manual fallback (it publishes to the
# gh-pages branch; switch Pages back to that branch to use it).
set -e
cd "$(dirname "$0")/.."
npm run build
rm -rf .gh-pages
git worktree add -q --detach .gh-pages
cd .gh-pages
git checkout -q --orphan gh-pages
git rm -q -rf . >/dev/null 2>&1 || true
cp -R ../dist/. .
touch .nojekyll
git add -A
git commit -q -m "site $(git -C .. describe --tags --always)"
git push -q -f origin gh-pages
cd ..
git worktree remove -f .gh-pages
echo "published https://andikleinke.github.io/handwriter/"
