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
  assert.throws(() => fromPortable({ version: 1, provider: {}, routes: [] }), /别名/);
});

test('portable: 别名为唯一身份，authBase 可留空', () => {
  // This is the shape the desktop now exports: the login host is resolved from UGREENlink at
  // runtime, so shipping an authBase would pin a suffix that moves on every re-register.
  const out = fromPortable({
    version: 1,
    provider: { alias: 'yuceyang', authBase: '', username: 'alice', domainSuffix: 'yuceyang.cn68.ugdocker.link' },
    routes: [],
  });
  assert.equal(out.provider.alias, 'yuceyang');
  assert.equal(out.provider.authBase, '');
});

test('portable: 别名与中继地址往返保持一致', () => {
  const withAlias = {
    ...desktopConfig,
    provider: { ...desktopConfig.provider, alias: 'alice', authBase: '' },
    routes: [{ host: 'app-9443-example.ugdocker.link', enabled: true, httpIngress: false, kind: 'system' }],
  };
  const p = toPortable(withAlias);
  assert.equal(p.provider.alias, 'alice');
  assert.equal(p.routes[0].kind, 'system');
  const back = fromPortable(p);
  assert.equal(back.provider.alias, 'alice');
  assert.equal(back.routes[0].kind, 'system');
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

test('routes: remapUpstreamSuffix 只改上游，保留本地主机名', async () => {
  const { RouteRegistry } = await import('../src/core/routes.js');
  const rr = new RouteRegistry();
  rr.add({ host: 'app-5006-yuceyang.cn68.ugdocker.link' });
  const changed = rr.remapUpstreamSuffix(
    'yuceyang.cn68.ugdocker.link',
    'yuceyang.cn11.ugdocker.link',
  );
  assert.equal(changed.length, 1);
  const r = rr.list()[0];
  assert.equal(r.host, 'app-5006-yuceyang.cn68.ugdocker.link', '本地主机名必须保持不变');
  assert.equal(r.upstreamHost, 'app-5006-yuceyang.cn11.ugdocker.link');
  assert.equal(r.upstreamPort, '5006');
});

test('routes: remapUpstreamSuffix 忽略不匹配的路由', async () => {
  const { RouteRegistry } = await import('../src/core/routes.js');
  const rr = new RouteRegistry();
  rr.add({ host: 'app-8080-other.example.com' });
  const changed = rr.remapUpstreamSuffix('a.cn68.ugdocker.link', 'a.cn11.ugdocker.link');
  assert.equal(changed.length, 0);
  assert.equal(rr.list()[0].upstreamHost, 'app-8080-other.example.com');
});

test('routes: remapUpstreamSuffix 同后缀时不做改动', async () => {
  const { RouteRegistry } = await import('../src/core/routes.js');
  const rr = new RouteRegistry();
  rr.add({ host: 'app-5006-yuceyang.cn68.ugdocker.link' });
  assert.deepEqual(rr.remapUpstreamSuffix('same.link', 'same.link'), []);
});

test('ugos: lookupByAlias 解析 UGREENlink 返回的后缀', async () => {
  const { UgosProvider } = await import('../src/core/providers/ugos.js');
  const p = new UgosProvider({ authBase: 'https://yuceyang.cn68.ug.link', username: 'u', password: 'p' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({
      code: 200,
      data: { relayDomain: 'cn11.ug.link', dockerDomain: 'cn11.ugdocker.link', appDomain: 'cn11.ugapp.link' },
    }),
  });
  try {
    const r = await p.lookupByAlias('yuceyang');
    assert.equal(r.authBase, 'https://yuceyang.cn11.ug.link', 'relayDomain 缺少别名时要补上');
    assert.equal(r.domainSuffix, 'yuceyang.cn11.ugdocker.link');
  } finally {
    globalThis.fetch = original;
  }
});

test('ugos: lookupByAlias 在服务异常时返回 null', async () => {
  const { UgosProvider } = await import('../src/core/providers/ugos.js');
  const p = new UgosProvider({ authBase: 'https://yuceyang.cn68.ug.link', username: 'u', password: 'p' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 500, msg: 'Internal Server Error' }) });
  try {
    assert.equal(await p.lookupByAlias('yuceyang'), null);
  } finally {
    globalThis.fetch = original;
  }
});
