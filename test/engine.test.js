import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { RouteRegistry } from '../src/core/routes.js';
import { ensureCerts } from '../src/system/certs.js';

/** 极简 mock Provider：注入固定 cookie */
class MockProvider {
  id = 'mock';
  label = 'Mock';
  constructor() {
    this.logins = 0;
    this.token = 'MOCK-TOKEN';
    this.cookies = 'mock=1';
    this.shouldRedirectFirst = false;
    this.redirected = false;
  }
  async ensureSession(force) {
    if (force) this.logins++;
    return { ok: true, detail: 'mock' };
  }
  async applyToRequest(req) {
    return {
      ...req,
      headers: {
        ...req.headers,
        cookie: this.cookies,
        authorization: 'Basic dTpw',
      },
    };
  }
  isAuthRedirect(status, location) {
    return status === 302 && !!location && /login/i.test(location);
  }
  async renewGatewayToken() {
    return this.token;
  }
}

function startUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function requestVia(host, port, pathName, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        servername: host,
        path: pathName,
        method: opts.method || 'GET',
        rejectUnauthorized: false,
        headers: { host, ...(opts.headers || {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('engine: 转发 + 鉴权注入 + 302 重登重试', async () => {
  // 上游必须是 HTTPS（引擎默认 https 上游）
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatepass-eng-'));
  const certs = ensureCerts({
    domainSuffix: 'yuceyang.cn68.ugdocker.link',
    hosts: ['app-5006-yuceyang.cn68.ugdocker.link'],
    certDir,
    force: true,
  });

  let hit = 0;
  let sawAuth = null;
  const upstream = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
    hit++;
    sawAuth = { cookie: req.headers.cookie, authorization: req.headers.authorization };
    if (hit === 1) {
      res.writeHead(302, { location: 'http://x/login/account' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok:' + req.url);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const provider = new MockProvider();
  const routes = new RouteRegistry();
  routes.add({
    host: 'app-5006-yuceyang.cn68.ugdocker.link',
    upstreamHost: '127.0.0.1',
    upstreamPort: String(upPort),
  });

  const engine = new Engine({
    provider,
    routes,
    certs,
    proxy: { insecureUpstreamTls: true },
    log: () => {},
    onEvent: () => {},
  });
  engine.dnsCache.set('app-5006-yuceyang.cn68.ugdocker.link', '127.0.0.1');
  engine.dnsCache.set('127.0.0.1', '127.0.0.1');

  await engine.listen(0, '127.0.0.1');
  const proxyPort = engine.httpsServer.address().port;

  try {
    const res = await requestVia('app-5006-yuceyang.cn68.ugdocker.link', proxyPort, '/hello');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok:/hello');
    assert.ok(sawAuth.cookie.includes('mock=1'));
    assert.ok(sawAuth.authorization.startsWith('Basic '));
    assert.equal(provider.logins, 1);
    assert.equal(engine.stats.retries, 1);
  } finally {
    await engine.close();
    await new Promise((r) => upstream.close(r));
  }
});

test('engine: 未匹配主机返回 421；OPTIONS 预检 204', async () => {
  const provider = new MockProvider();
  const routes = new RouteRegistry();
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatepass-eng2-'));
  const certs = ensureCerts({ domainSuffix: 'example.local', hosts: ['app-1.example.local'], certDir, force: true });
  const engine = new Engine({ provider, routes, certs, log: () => {}, onEvent: () => {} });
  await engine.listen(0, '127.0.0.1');
  const port = engine.httpsServer.address().port;

  const r1 = await requestVia('unknown.example.com', port, '/');
  assert.equal(r1.status, 421);

  routes.add({ host: 'app-1.example.local', upstreamHost: '127.0.0.1', upstreamPort: '1' });
  const r2 = await requestVia('app-1.example.local', port, '/', { method: 'OPTIONS' });
  assert.equal(r2.status, 204);
  assert.equal(r2.headers['access-control-allow-origin'], '*');

  await engine.close();
});
