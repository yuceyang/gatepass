#!/usr/bin/env node
// Exercises the console's portable-config endpoints against the running service.
const BASE = 'http://127.0.0.1:19099';

const get = async (path) => {
  const r = await fetch(BASE + path);
  return { status: r.status, text: await r.text(), headers: r.headers };
};

const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

// 1. Export without the password.
const exp = await get('/api/config/export?password=0');
check('export returns 200', exp.status === 200, `status=${exp.status}`);
const portable = JSON.parse(exp.text);
check('export has schema', portable.$schema === 'gatepass-portable/v1');
check('export omits password', portable.provider.password === '');
check('export carries routes', Array.isArray(portable.routes) && portable.routes.length > 0,
  `${portable.routes.length} 条`);
check('export sets download filename',
  /attachment; filename="gatepass-config-nopass\.json"/.test(exp.headers.get('content-disposition') || ''),
  exp.headers.get('content-disposition'));

// 2. Round-trip that same document back in; route count must be preserved.
const before = portable.routes.length;
const back = await post('/api/config/import', portable);
check('import returns 200', back.status === 200, `status=${back.status}`);
const backJson = JSON.parse(back.text);
check('import keeps every route', backJson.routes === before, `${backJson.routes} vs ${before}`);
check('import reports no skips', (backJson.skipped || []).length === 0,
  JSON.stringify(backJson.skipped || []));

// 3. Export again and confirm nothing was lost by the round trip.
const again = JSON.parse((await get('/api/config/export?password=0')).text);
check('round-trip preserves host list',
  JSON.stringify(again.routes.map((r) => r.host)) === JSON.stringify(portable.routes.map((r) => r.host)));

// 4. A bad document must be rejected with a clear error, not a crash.
const bad = await post('/api/config/import', { version: 999, provider: {}, routes: [] });
check('import rejects unknown version', bad.status === 400, `status=${bad.status} ${bad.text.slice(0, 80)}`);

process.exit(failed ? 1 : 0);
