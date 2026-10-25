import test from 'node:test';
import assert from 'node:assert/strict';
import { toPortable, fromPortable, parsePortable, PORTABLE_VERSION } from '../src/core/portable.js';

const desktopConfig = {
  console: { host: '127.0.0.1', port: 19099 },
  proxy: { host: '127.0.0.1', port: 443 },
  provider: {
    id: 'ugos',
    authBase: 'https://nas.example/',
    username: 'alice',
    password: 'secret',
    domainSuffix: 'example.ugdocker.link',
  },
  routes: [
    { host: 'app-5006-example.ugdocker.link', enabled: true, httpIngress: true },
    { host: 'app-8080-example.ugdocker.link', enabled: false, httpIngress: false },
  ],
};

test('portable: 导出不含平台相关字段', () => {
  const p = toPortable(desktopConfig);
  assert.equal(p.version, PORTABLE_VERSION);
  assert.equal(p.console, undefined, '不应包含控制台端口');
  assert.equal(p.proxy, undefined, '不应包含代理端口');
  assert.equal(p.provider.authBase, 'https://nas.example/');
  assert.equal(p.routes.length, 2);
});

test('portable: 可选剔除密码', () => {
  const p = toPortable(desktopConfig, { includePassword: false });
  assert.equal(p.provider.password, '');
  assert.equal(toPortable(desktopConfig).provider.password, 'secret');
});

test('portable: 往返保持一致', () => {
  const out = fromPortable(toPortable(desktopConfig));
  assert.equal(out.provider.authBase, 'https://nas.example');
  assert.equal(out.provider.username, 'alice');
  assert.equal(out.routes.length, 2);
  assert.equal(out.routes[0].host, 'app-5006-example.ugdocker.link');
  assert.equal(out.routes[1].enabled, false);
});

test('portable: 拒绝未来版本', () => {
  assert.throws(() => fromPortable({ version: 999, provider: {} }), /不支持的配置版本/);
});

test('portable: 拒绝非法主机名与地址', () => {
  assert.throws(
    () => fromPortable({ version: 1, provider: { authBase: 'https://ok.example' }, routes: [{ host: 'bad_host!' }] }),
    /非法主机名/,
  );
  assert.throws(() => fromPortable({ version: 1, provider: { authBase: 'ftp://x' }, routes: [] }), /http/);
});

test('portable: 去重并规范化主机名', () => {
  const out = fromPortable({
    version: 1,
    provider: { authBase: 'https://nas.example' },
    routes: [
      { host: 'APP-5006-Example.COM' },
      { host: 'app-5006-example.com' },
    ],
  });
  assert.equal(out.routes.length, 1);
  assert.equal(out.routes[0].host, 'app-5006-example.com');
});

test('portable: 解析带 BOM 的 JSON', () => {
  const text = '﻿' + JSON.stringify(toPortable(desktopConfig));
  assert.equal(parsePortable(text).provider.username, 'alice');
});

test('portable: 非法 JSON 给出清晰错误', () => {
  assert.throws(() => parsePortable('{not json'), /不是合法 JSON/);
});
