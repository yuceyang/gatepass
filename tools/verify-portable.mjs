#!/usr/bin/env node
// Verifies the changed desktop modules parse and the portable config round-trips.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = [
  'src/web/app.js',
  'src/server/api.js',
  'src/core/routes.js',
  'src/core/portable.js',
  'bin/gatepass.js',
];

let failed = false;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed = true;
    console.log(`FAIL ${file}`);
    console.log(r.stderr);
  } else {
    console.log(`ok   ${file}`);
  }
}

// Round-trip a sample through the portable format.
const { toPortable, parsePortable } = await import('../src/core/portable.js');
const sample = {
  provider: {
    id: 'ugos',
    authBase: 'https://nas.example',
    username: 'u',
    password: 'p',
    domainSuffix: 'example.ugdocker.link',
  },
  routes: [{ host: 'app-5006-example.ugdocker.link', enabled: true, httpIngress: true }],
};
const back = parsePortable(JSON.stringify(toPortable(sample)));
const ok = back.provider.username === 'u' && back.routes.length === 1;
console.log(ok ? 'ok   portable round-trip' : 'FAIL portable round-trip');
if (!ok) failed = true;

// The console HTML must expose the new controls and app.js must wire them.
const html = readFileSync('src/web/index.html', 'utf8');
const js = readFileSync('src/web/app.js', 'utf8');
const need = ['btn-export-config', 'btn-export-config-nopass', 'btn-import-config', 'file-import-config'];
for (const id of need) {
  const inHtml = html.includes(`id="${id}"`);
  const inJs = js.includes(`#${id}`);
  if (inHtml && inJs) {
    console.log(`ok   ui ${id}`);
  } else {
    failed = true;
    console.log(`FAIL ui ${id} (html=${inHtml} js=${inJs})`);
  }
}

process.exit(failed ? 1 : 0);
