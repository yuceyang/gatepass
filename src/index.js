import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, saveConfig, defaultConfigPath, defaultConfigDir } from './config.js';
import { createProvider } from './core/providers/ugos.js';
import { RouteRegistry } from './core/routes.js';
import { Engine } from './core/engine.js';
import { LiveLog, createConsoleServer } from './server/api.js';
import { ensureCerts } from './system/certs.js';
import { writeHostsBlock, flushDns } from './system/hosts.js';

/**
 * 启动 GatePass（代理引擎 + 控制台）。
 * @param {{configPath?:string, log?:Function}} [opts]
 */
export async function start(opts = {}) {
  const log = opts.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a));
  const configPath = opts.configPath || defaultConfigPath();
  const config = loadConfig(configPath);
  const configDir = path.dirname(configPath);

  const provider = createProvider(config);
  const routes = new RouteRegistry({
    routes: config.routes,
    onChange: (list) => {
      config.routes = list;
      saveConfig(config, configPath);
    },
  });

  const certDir = path.join(configDir, 'certs');
  const routeHosts = routes.list().filter((r) => r.enabled).map((r) => r.host);
  const certs = ensureCerts({
    domainSuffix: config.provider?.domainSuffix || 'example.local',
    hosts: routeHosts,
    certDir,
    force: false,
  });

  const live = new LiveLog(config.logBufferSize || 2000);

  const engine = new Engine({
    provider,
    routes,
    certs,
    proxy: config.proxy,
    log,
    onEvent: (evt) => live.push(evt),
  });

  // 代理 HTTPS
  try {
    await engine.listen(config.proxy.port, config.proxy.host);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EADDRINUSE') {
      throw new Error(`代理端口 ${config.proxy.port} 无法监听（${e.code}）。请用管理员权限运行，或修改 config.proxy.port`);
    }
    throw e;
  }

  // 控制台 HTTP
  const consoleServer = createConsoleServer({
    provider,
    routes,
    live,
    config,
    saveConfig: (c) => saveConfig(c, configPath),
    engine,
    certs,
    log,
  });
  await new Promise((resolve, reject) => {
    consoleServer.once('error', reject);
    consoleServer.listen(config.console.port, config.console.host, resolve);
  });
  log(`[gatepass] 控制台 http://${config.console.host}:${config.console.port}`);
  log(`[gatepass] 代理   https://${config.proxy.host}:${config.proxy.port}  →  *.${config.provider?.domainSuffix}`);

  // 启动预登录（失败不退出）
  provider.ensureSession().then(
    (s) => log(`[gatepass] 会话: ${s.ok ? 'OK' : s.detail}`),
    (e) => log(`[gatepass] 预登录失败: ${e.message}`)
  );

  // 同步 hosts（失败仅提示）
  try {
    const entries = routes.hostsEntries();
    if (entries.length) {
      const r = writeHostsBlock(entries);
      await flushDns();
      log(`[gatepass] hosts ${r.changed ? '已更新' : '无变化'}（${entries.length} 条）`);
    }
  } catch (e) {
    log(`[gatepass] hosts 写入失败（需管理员）: ${e.message}`);
    log(`[gatepass] 可在控制台「设置 → 系统集成」查看待写入内容`);
  }

  return {
    engine,
    consoleServer,
    provider,
    routes,
    config,
    configPath,
    async close() {
      await engine.close();
      await new Promise((r) => consoleServer.close(r));
    },
  };
}

export { loadConfig, saveConfig, defaultConfigPath, defaultConfigDir };
