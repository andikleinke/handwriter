#!/bin/sh
# Build the site and publish dist/ to the gh-pages branch, which GitHub Pages
# serves at https://andikleinke.github.io/handwriter/.
#
#   npm run deploy
#
# (An Actions workflow would do this on every push, but pushing one needs a
# token with the `workflow` scope: `gh auth refresh -h github.com -s workflow`.)
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
