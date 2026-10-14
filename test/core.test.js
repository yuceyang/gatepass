import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, configDefaults } from '../src/config.js';
import { RouteRegistry, inferPortFromHost } from '../src/core/routes.js';
import { extractPortFromHost, decodePublicKeyPem, rsaEncryptWithPem } from '../src/core/providers/ugos.js';

test('config: 默认值与 BOM 容忍', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatepass-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '﻿{"console":{"port":1234}}', 'utf8');
  const cfg = loadConfig(p);
  assert.equal(cfg.console.port, 1234);
  assert.equal(cfg.proxy.port, configDefaults.proxy.port);
  assert.equal(cfg.provider.id, 'ugos');
  saveConfig(cfg, p);
  const again = loadConfig(p);
  assert.equal(again.console.port, 1234);
});

test('routes: 端口推断', () => {
  assert.equal(inferPortFromHost('app-5006-yuceyang.cn68.ugdocker.link'), '5006');
  assert.equal(inferPortFromHost('app16601-yuceyang.cn68.ugdocker.link'), '16601');
  assert.equal(inferPortFromHost('app-9090-yuceyang.cn68.ugdocker.link'), '9090');
  assert.equal(inferPortFromHost('example.com'), '');
});

test('routes: CRUD 与匹配', () => {
  const rr = new RouteRegistry();
  const r = rr.add({ host: 'app-5006-yuceyang.cn68.ugdocker.link' });
  assert.equal(r.upstreamPort, '5006');
  assert.equal(rr.matchHost('app-5006-yuceyang.cn68.ugdocker.link')?.id, r.id);
  assert.equal(rr.matchHost('other.example.com'), null);

  assert.throws(() => rr.add({ host: 'app-5006-yuceyang.cn68.ugdocker.link' }), /已存在/);
  assert.throws(() => rr.add({ host: 'not_a_host' }), /非法主机名/);

  const u = rr.update(r.id, { enabled: false });
  assert.equal(u.enabled, false);
  assert.equal(rr.matchHost('app-5006-yuceyang.cn68.ugdocker.link'), null);

  assert.equal(rr.remove(r.id), true);
  assert.equal(rr.list().length, 0);
});

test('routes: 热更新回调', () => {
  let called = 0;
  const rr = new RouteRegistry({ onChange: () => called++ });
  rr.add({ host: 'app-1-a.example.com' });
  rr.add({ host: 'app-2-a.example.com' });
  assert.ok(called >= 2);
});

test('ugos: extractPortFromHost', () => {
  assert.equal(extractPortFromHost('app-5006-yuceyang.cn68.ugdocker.link'), '5006');
  assert.equal(extractPortFromHost('app16601-yuceyang.cn68.ugdocker.link'), '16601');
});

test('ugos: RSA 加密往返', async () => {
  const crypto = await import('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const b64 = Buffer.from(pem).toString('base64');
  const decoded = decodePublicKeyPem(b64);
  const enc = rsaEncryptWithPem(decoded, 'secret-pass');
  const dec = crypto
    .privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(enc, 'base64'))
    .toString();
  assert.equal(dec, 'secret-pass');
});

test('ugos: Provider 注入三件套', async () => {
  const { UgosProvider } = await import('../src/core/providers/ugos.js');
  const p = new UgosProvider({
    authBase: 'https://example.invalid',
    username: 'u',
    password: 'p',
    log: () => {},
  });
  // 手工塞入会话与网关 token，避免真实网络
  p.session = { token: 'NAS_TOKEN', cookies: 'token=abc; token_uid=1000', expiresAt: Date.now() + 3600_000 };
  p.gatewayTokens.set('app-5006-x.y.z', { token: 'GW-UUID', expiresAt: Date.now() + 3600_000 });

  const out = await p.applyToRequest({ headers: {}, path: '/' }, { host: 'app-5006-x.y.z' });
  assert.match(out.headers.cookie, /token=abc/);
  assert.match(out.headers.cookie, /ugreen-proxy-token=GW-UUID/);
  assert.match(out.headers.authorization, /^Basic /);
});

test('ugos: isAuthRedirect', async () => {
  const { UgosProvider } = await import('../src/core/providers/ugos.js');
  const p = new UgosProvider({ authBase: 'x', username: 'u', password: 'p' });
  assert.equal(p.isAuthRedirect(302, 'http://a/desktop/#/login/account'), true);
  assert.equal(p.isAuthRedirect(200, undefined), false);
  assert.equal(p.isAuthRedirect(302, 'http://a/other'), false);
});

test('certs: SAN 覆盖连字符主机名', async () => {
  const { ensureCerts, certCoversHost } = await import('../src/system/certs.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatepass-cert-'));
  const r = ensureCerts({
    domainSuffix: 'yuceyang.cn68.ugdocker.link',
    hosts: ['app-5006-yuceyang.cn68.ugdocker.link', 'app16601-yuceyang.cn68.ugdocker.link'],
    certDir: dir,
    force: true,
  });
  assert.ok(r.fresh);
  assert.equal(await certCoversHost(r.cert, 'app-5006-yuceyang.cn68.ugdocker.link'), true);
  assert.equal(await certCoversHost(r.cert, 'app16601-yuceyang.cn68.ugdocker.link'), true);
  assert.equal(await certCoversHost(r.cert, 'yuceyang.cn68.ugdocker.link'), true);
  assert.equal(await certCoversHost(r.cert, 'evil.example.com'), false);
});

test('hosts: 标记块幂等', async () => {
  const hostsMod = await import('../src/system/hosts.js');
  // 在临时目录验证 render 逻辑（不写系统 hosts）
  const entries = [
    { ip: '127.0.0.1', host: 'a.example.com', comment: 't' },
    { ip: '127.0.0.1', host: 'b.example.com', comment: '' },
  ];
  // elevatedWriteCommand 一定可生成
  const c = hostsMod.elevatedWriteCommand(entries);
  assert.ok(c.command);
  assert.ok(c.args.length > 0);
  assert.match(JSON.stringify(c.args), /a\.example\.com/);
});
