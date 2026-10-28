import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { RouteRegistry } from '../src/core/routes.js';

const FIXED = 'alice.cn68.ugdocker.link';

function makeEngine({ liveSuffix = null, suffix = FIXED } = {}) {
  const routes = new RouteRegistry({
    routes: [{ host: `app-5006-${FIXED}` }],
  });
  const provider = {
    id: 'mock',
    label: 'Mock',
    suffix,
    liveSuffix: () => liveSuffix,
  };
  return new Engine({ provider, routes, certs: {}, log: () => {} });
}

test('upstreamHostFor keeps the fixed host when no suffix has been discovered', () => {
  const engine = makeEngine({ liveSuffix: null });
  const route = engine.routes.list()[0];
  assert.equal(engine.upstreamHostFor(route), `app-5006-${FIXED}`);
});

test('upstreamHostFor follows the live suffix so bookmarks never change', () => {
  const engine = makeEngine({ liveSuffix: 'alice.cn11.ugdocker.link' });
  const route = engine.routes.list()[0];
  // The name the browser asks for is still the fixed one…
  assert.equal(route.host, `app-5006-${FIXED}`);
  // …while what we dial tracks the gateway's current suffix.
  assert.equal(engine.upstreamHostFor(route), 'app-5006-alice.cn11.ugdocker.link');
});

test('upstreamHostFor leaves an unrelated upstream alone', () => {
  const engine = makeEngine({ liveSuffix: 'alice.cn11.ugdocker.link' });
  const route = engine.routes.add({ host: 'app-9000-plain.example' });
  assert.equal(engine.upstreamHostFor(route), 'app-9000-plain.example');
});

test('upstreamHostFor does not rewrite when the suffix is unchanged', () => {
  const engine = makeEngine({ liveSuffix: FIXED });
  const route = engine.routes.list()[0];
  assert.equal(engine.upstreamHostFor(route), `app-5006-${FIXED}`);
});

test('upstreamHostFor sends a system route to the relay host', () => {
  // :9443 is the UGOS desktop: the docker mapping forwards plain HTTP and IIS there speaks
  // TLS only ("400 The plain HTTP request was sent to HTTPS port"), so the relay serves it.
  const engine = makeEngine({ liveSuffix: 'alice.cn11.ugdocker.link' });
  engine.provider.relayHost = 'alice.cn11.ug.link';
  const route = engine.routes.add({ host: `app-9443-${FIXED}`, kind: 'system' });
  assert.equal(engine.upstreamHostFor(route), 'alice.cn11.ug.link');
});

test('upstreamHostFor falls back for a system route before the relay is known', () => {
  const engine = makeEngine({ liveSuffix: null });
  const route = engine.routes.add({ host: `app-9443-${FIXED}`, kind: 'system' });
  assert.equal(engine.upstreamHostFor(route), `app-9443-${FIXED}`);
});
