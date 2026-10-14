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
 * 鍚姩 GatePass锛堜唬鐞嗗紩鎿?+ 鎺у埗鍙帮級銆? * @param {{configPath?:string, log?:Function}} [opts]
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

  // 浠ｇ悊 HTTPS
  try {
    await engine.listen(config.proxy.port, config.proxy.host);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EADDRINUSE') {
      // 缁戜笉涓?443锛氳嚜鍔ㄨ姹傜鐞嗗憳閲嶅惎锛堢敤鎴峰彧鐐逛竴娆?UAC锛?      const { isElevated, relaunchElevated } = await import('./system/elevate.js');
      if (!isElevated() && process.platform === 'win32') {
        log(`[gatepass] 绔彛 ${config.proxy.port} 闇€瑕佺鐞嗗憳锛屾鍦ㄨ姹傛彁鏉冣€);
        const r = relaunchElevated();
        log(`[gatepass] ${r.note}`);
        return { relaunchedElevated: true, async close() {} };
      }
      throw new Error(`浠ｇ悊绔彛 ${config.proxy.port} 鏃犳硶鐩戝惉锛?{e.code}锛夈€傝鐢ㄧ鐞嗗憳鏉冮檺杩愯锛屾垨淇敼 config.proxy.port`);
    }
    throw e;
  }

  // 鎺у埗鍙?HTTP
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
  log(`[gatepass] 鎺у埗鍙?http://${config.console.host}:${config.console.port}`);
  log(`[gatepass] 浠ｇ悊   https://${config.proxy.host}:${config.proxy.port}  鈫? *.${config.provider?.domainSuffix}`);

  // 鍚姩棰勭櫥褰曪紙澶辫触涓嶉€€鍑猴級
  provider.ensureSession().then(
    (s) => log(`[gatepass] 浼氳瘽: ${s.ok ? 'OK' : s.detail}`),
    (e) => log(`[gatepass] 棰勭櫥褰曞け璐? ${e.message}`)
  );

  // 鍚屾 hosts锛堝け璐ヤ粎鎻愮ず锛涙湭鎻愭潈鍒欒嚜鍔ㄨ姹?UAC锛?  try {
    const entries = routes.hostsEntries();
    if (entries.length) {
      const r = writeHostsBlock(entries);
      await flushDns();
      log(`[gatepass] hosts ${r.changed ? '宸叉洿鏂? : '鏃犲彉鍖?}锛?{entries.length} 鏉★級`);
    }
  } catch (e) {
    log(`[gatepass] hosts 鍐欏叆澶辫触: ${e.message}`);
    if (process.platform === 'win32') {
      const { runElevatedPowerShell } = await import('./system/elevate.js');
      const { elevatedWriteCommand } = await import('./system/hosts.js');
      const cmdObj = elevatedWriteCommand(routes.hostsEntries());
      const r2 = runElevatedPowerShell(cmdObj.script);
      log(`[gatepass] ${r2.note}`);
    } else {
      log(`[gatepass] 鍙湪鎺у埗鍙般€岃缃?鈫?绯荤粺闆嗘垚銆嶆煡鐪嬪緟鍐欏叆鍐呭`);
    }
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
