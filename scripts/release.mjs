#!/usr/bin/env node
/**
 * Cut a version, or refresh the list the page shows.
 *
 *   node scripts/release.mjs 0.17.0 "what changed"   set the version, commit, tag
 *   node scripts/release.mjs --refresh               rebuild versions.json from the tags
 *
 * Every tag is a point the tree can be put back to (`git checkout v0.17.0`),
 * which is the whole reason for tagging rather than only bumping a number.
 * `versions.json` is what the page reads to list them; it is generated, never
 * edited by hand.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Every tag, newest first, as the page wants it. */
function tagList() {
  const raw = git('tag', '-l', 'v*', '--sort=-creatordate',
    '--format=%(refname:short)\t%(creatordate:short)\t%(contents:subject)');
  return raw
    ? raw.split('\n').map((line) => {
      const [tag, date, ...rest] = line.split('\t');
      return { version: tag.replace(/^v/, ''), tag, date, note: rest.join('\t') || '' };
    })
    : [];
}

function writeVersions() {
  const versions = tagList();
  writeFileSync(new URL('versions.json', root), `${JSON.stringify(versions, null, 2)}\n`);
  return versions;
}

const [arg, note] = process.argv.slice(2);

if (!arg || arg === '--refresh') {
  const v = writeVersions();
  console.log(`versions.json: ${v.length} version(s)`);
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+$/.test(arg)) {
  console.error('usage: release.mjs <x.y.z> ["note"]  |  release.mjs --refresh');
  process.exit(1);
}

const pkgUrl = new URL('package.json', root);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
pkg.version = arg;
writeFileSync(pkgUrl, `${JSON.stringify(pkg, null, 2)}\n`);

// tag first with the version already written, so the tagged tree names itself
const subject = note ? `v${arg} — ${note}` : `v${arg}`;
git('add', '-A');
git('commit', '-m', subject);
git('tag', '-a', `v${arg}`, '-m', subject);
// the new tag has to appear in the list the page reads
const versions = writeVersions();
git('add', 'versions.json');
git('commit', '--amend', '--no-edit');
git('tag', '-f', '-a', `v${arg}`, '-m', subject);
console.log(`${subject}\n${versions.length} version(s) in versions.json`);
