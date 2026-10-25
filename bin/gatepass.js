#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig, saveConfig, defaultConfigPath, defaultConfigDir, defaultProxyPort } from '../src/config.js';
import { start } from '../src/index.js';
import { ensureCerts } from '../src/system/certs.js';
import { writeHostsBlock, flushDns, elevatedWriteCommand, readHostsBlock } from '../src/system/hosts.js';
import { trustCaCommand, checkPortFree } from '../src/system/certtrust.js';
import { isElevated, relaunchElevated } from '../src/system/elevate.js';
import { isTermux, termuxIntegrationNotice } from '../src/system/termux.js';

const [, , cmd = 'help', ...rest] = process.argv;

const HELP = `GatePass — 免重复登录的网关反向代理

用法:
  gatepass init             首次向导（生成配置/证书；Termux 默认使用高位端口）
  gatepass start            启动代理 + Web 控制台
  gatepass status           查看配置路径与端口
  gatepass export [文件]    导出可移植配置（PC / Android / iOS 通用）
  gatepass import <文件>    从可移植配置导入（覆盖账号与路由）
  gatepass sync-hosts       按当前路由同步系统 hosts（Termux 不支持）
  gatepass print-hosts      打印待写入的 hosts 块
  gatepass trust-ca         打印/尝试导入 CA 证书
  gatepass install-autostart   安装开机自启
  gatepass remove-autostart    移除开机自启
  gatepass help             显示本帮助

环境变量:
  GATEPASS_HOME             覆盖配置目录（默认平台用户数据目录）
`;

function log(...a) {
  console.log(...a);
}

async function init() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = '') => rl.question(q + (def ? ` [${def}]` : '') + ': ').then((a) => a.trim() || def);

  log('\n=== GatePass 首次向导 ===\n');
  const authBase = await ask('NAS 登录地址（如 https://xxx.cn68.ug.link）');
  const username = await ask('用户名');
  const password = await ask('密码');
  const domainSuffix = await ask('代理域名后缀（如 yuceyang.cn68.ugdocker.link）');
  const routeHost = await ask('首个路由主机名（如 app-5006-yuceyang.cn68.ugdocker.link，可留空稍后在控制台添加）');
  const proxyPort = await ask(`代理端口（默认 ${defaultProxyPort()}）`, String(defaultProxyPort()));
  const consolePort = await ask('控制台端口（建议非常用端口，如 19099）', '19099');

  const configPath = defaultConfigPath();
  const config = loadConfig(configPath);
  config.provider = {
    ...config.provider,
    id: 'ugos',
    authBase,
    username,
    password,
    domainSuffix,
  };
  config.proxy = { ...config.proxy, port: Number(proxyPort) || defaultProxyPort() };
  config.console = { ...config.console, port: Number(consolePort) || 19099 };
  // 常见端口提醒
  const { isCommonPort, commonPortWarning } = await import('../src/system/certtrust.js');
  for (const p of [config.proxy.port, config.console.port]) {
    const w = commonPortWarning(p);
    if (w) log(`  警告: ${w}`);
  }
  config.onboardingDone = true;

  if (routeHost) {
    const { RouteRegistry } = await import('../src/core/routes.js');
    const rr = new RouteRegistry({ routes: config.routes });
    try {
      const r = rr.add({ host: routeHost });
      config.routes = [r];
    } catch (e) {
      log(`  路由添加跳过: ${e.message}`);
    }
  }

  saveConfig(config, configPath);
  log(`\n[1/5] 配置已保存: ${configPath}`);

  // 端口检测
  const p443 = await checkPortFree(config.proxy.port, config.proxy.host);
  log(`[2/5] 端口 ${config.proxy.port}: ${p443.free ? '可用' : '被占用（' + (p443.error || '') + '）'}`);
  const pCons = await checkPortFree(config.console.port, config.console.host);
  log(`      控制台 ${config.console.port}: ${pCons.free ? '可用' : '被占用'}`);

  // 证书
  const certDir = path.join(path.dirname(configPath), 'certs');
  const hosts = config.routes.map((r) => r.host);
  const certs = ensureCerts({
    domainSuffix: domainSuffix || 'example.local',
    hosts,
    certDir,
    force: false,
  });
  log(`[3/5] 证书: ${certs.certPath}`);
  const trust = trustCaCommand(certs.caPath);
  if (trust.supported === false) {
    log(`      ${trust.note}`);
  } else {
    log(`      导入 CA（${trust.note}）:`);
    log(`      ${trust.command} ${trust.args.join(' ')}`);
  }

  // hosts
  const entries = config.routes.filter((r) => r.enabled !== false).map((r) => ({ ip: '127.0.0.1', host: r.host, comment: 'gatepass' }));
  log('[4/5] hosts:');
  if (entries.length === 0) {
    log('      （无路由，跳过）');
  } else {
    try {
      const r = writeHostsBlock(entries);
      if (r.supported === false) {
        log(`      未同步: ${r.reason}`);
        for (const entry of entries) log(`      ${entry.ip}\t${entry.host}`);
      } else {
        await flushDns();
        log(`      已写入 ${r.path}`);
      }
    } catch (e) {
      log(`      写入失败: ${e.message}`);
      if (process.platform === 'win32') {
        const { runElevatedPowerShell } = await import('../src/system/elevate.js');
        const { elevatedWriteCommand } = await import('../src/system/hosts.js');
        const cmdObj = elevatedWriteCommand(entries);
        const r2 = runElevatedPowerShell(cmdObj.script);
        log(`      ${r2.note}`);
      } else {
        const cmd2 = elevatedWriteCommand(entries);
        log(`      请手动执行（${cmd2.note}）:`);
        log(`      ${cmd2.command} ${cmd2.args.join(' ')}`);
      }
    }
  }

  // 默认安装开机自启，免得二次开机找不到入口
  log('[5/5] 开机自启:');
  try {
    const { installAutostart } = await import('../src/system/autostart.js');
    const ar = await installAutostart();
    if (ar.supported === false) {
      log(`      ${ar.note}`);
    } else {
      log(`      已安装: ${ar.path}`);
      log('      （可在控制台「设置 → 开机自启」随时关闭）');
    }
  } catch (e) {
    log(`      安装失败: ${e.message}`);
    log('      也可稍后在控制台「设置」一键安装');
  }

  rl.close();
  log('\n完成。运行 `gatepass start` 启动。\n');
}

async function cmdStatus() {
  const configPath = defaultConfigPath();
  const exists = fs.existsSync(configPath);
  log('配置路径:', configPath, exists ? '(已存在)' : '(未初始化，先跑 gatepass init)');
  if (exists) {
    const cfg = loadConfig(configPath);
    log('代理端口:', `${cfg.proxy.host}:${cfg.proxy.port}`);
    log('控制台端口:', `${cfg.console.host}:${cfg.console.port}`);
    log('域名后缀:', cfg.provider?.domainSuffix || '(未设置)');
    log('路由数:', cfg.routes?.length || 0);
  }
  log('CA/证书目录:', path.join(path.dirname(configPath), 'certs'));
  const block = readHostsBlock();
  log('hosts 标记块:', isTermux() ? 'Termux 不支持系统 hosts' : (block ? '已写入' : '未写入'));
  if (isTermux()) log('系统集成限制:', termuxIntegrationNotice());
}

async function cmdSyncHosts() {
  const cfg = loadConfig();
  const { RouteRegistry } = await import('../src/core/routes.js');
  const rr = new RouteRegistry({ routes: cfg.routes });
  const entries = rr.hostsEntries();
  if (!entries.length) {
    log('无路由，跳过');
    return;
  }
  if (!isElevated() && process.platform === 'win32') {
    log('需要管理员权限写 hosts，正在请求提权…');
    const { runElevatedPowerShell } = await import('../src/system/elevate.js');
    const { elevatedWriteCommand } = await import('../src/system/hosts.js');
    const cmdObj = elevatedWriteCommand(entries);
    const r = runElevatedPowerShell(cmdObj.script);
    log(r.note);
    log('稍后在控制台点「同步 hosts」或重新运行 gatepass sync-hosts 验证。');
    return;
  }
  try {
    const r = writeHostsBlock(entries);
    if (r.supported === false) {
      log('hosts 未同步:', r.reason);
      return;
    }
    await flushDns();
    log(r.changed ? 'hosts 已更新' : 'hosts 无变化');
  } catch (e) {
    log('写入失败:', e.message);
    const c = elevatedWriteCommand(entries);
    log('请手动执行（' + c.note + '）:');
    log(c.command, c.args.join(' '));
  }
}

function cmdPrintHosts() {
  const cfg = loadConfig();
  const entries = (cfg.routes || []).filter((r) => r.enabled !== false).map((r) => ({ ip: '127.0.0.1', host: r.host, comment: 'gatepass' }));
  const c = elevatedWriteCommand(entries);
  log(isTermux()
    ? '# 仅输出路由主机名；Termux 无法改 Android 系统 hosts。'
    : '# 将以下内容追加到系统 hosts（' + c.note + '）:');
  log('');
  for (const e of entries) log(`${e.ip}\t${e.host}`);
}

function cmdTrustCa() {
  const certDir = path.join(defaultConfigDir(), 'certs');
  const caPath = path.join(certDir, 'ca.crt');
  if (!fs.existsSync(caPath)) {
    log('CA 不存在:', caPath, '— 先运行 gatepass init 或 gatepass start');
    return;
  }
  const t = trustCaCommand(caPath);
  log('CA 路径:', caPath);
  if (t.supported === false) {
    log(t.note);
  } else {
    log('导入命令（' + t.note + '）:');
    log(t.command, t.args.join(' '));
  }
}

async function cmdExport() {
  const { toPortable } = await import('../src/core/portable.js');
  const cfg = loadConfig();
  const portable = toPortable(cfg);
  const target = rest[0] || path.join(process.cwd(), 'gatepass-config.json');
  fs.writeFileSync(target, JSON.stringify(portable, null, 2) + '\n', 'utf8');
  log(`已导出可移植配置: ${target}`);
  log(`  账号: ${portable.provider.username || '(未设置)'} @ ${portable.provider.authBase || '(未设置)'}`);
  log(`  路由: ${portable.routes.length} 条`);
  if (portable.provider.password) {
    log('  注意: 文件包含明文密码，请妥善保管，不要提交到仓库或公开分享。');
  }
  log('  可在 Android / iOS 客户端的「导入配置」中直接使用。');
}

async function cmdImport() {
  const { parsePortable } = await import('../src/core/portable.js');
  const source = rest[0];
  if (!source) {
    log('用法: gatepass import <配置文件路径>');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(source)) {
    log(`文件不存在: ${source}`);
    process.exitCode = 1;
    return;
  }
  const { provider, routes } = parsePortable(fs.readFileSync(source, 'utf8'));
  const configPath = defaultConfigPath();
  const cfg = loadConfig(configPath);
  cfg.provider = { ...cfg.provider, ...provider };
  // Rebuild routes through the registry so upstreamPort is inferred and defaults are applied,
  // instead of writing half-empty route objects straight from the portable file.
  const { RouteRegistry } = await import('../src/core/routes.js');
  const registry = new RouteRegistry();
  for (const r of routes) {
    try {
      registry.add({
        host: r.host,
        enabled: r.enabled,
        http: r.httpIngress === true,
        providerId: provider.id,
      });
    } catch (e) {
      log(`  跳过 ${r.host}: ${e.message}`);
    }
  }
  cfg.routes = registry.list();
  saveConfig(cfg, configPath);
  log(`已导入: ${configPath}`);
  log(`  账号: ${provider.username || '(未设置)'} @ ${provider.authBase}`);
  log(`  路由: ${routes.length} 条`);
  log('  如代理正在运行，请重启 gatepass start 使新配置生效。');
}

async function main() {
  // start / sync-hosts / init 需要管理员（443 端口、写系统 hosts）。
  // 未提权时自动以管理员重新拉起，用户只需点一次 UAC「是」。
  const needsAdmin = cmd === 'start' || cmd === 'sync-hosts';
  if (needsAdmin && !isElevated() && process.platform === 'win32') {
    log('需要管理员权限，正在请求提权…');
    const r = relaunchElevated();
    log(r.note);
    if (r.ok) return;
  }

  switch (cmd) {
    case 'init':
      await init();
      break;
    case 'start':
      await start();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'export':
      await cmdExport();
      break;
    case 'import':
      await cmdImport();
      break;
    case 'sync-hosts':
      await cmdSyncHosts();
      break;
    case 'print-hosts':
      cmdPrintHosts();
      break;
    case 'trust-ca':
      cmdTrustCa();
      break;
    case 'install-autostart': {
      const mod = await import('../src/system/autostart.js');
      const r = await mod.installAutostart();
      log(r.supported === false ? r.note : `开机自启已安装: ${r.path}`);
      break;
    }
    case 'remove-autostart': {
      const mod = await import('../src/system/autostart.js');
      const r = await mod.removeAutostart();
      log(r.supported === false ? r.note : (r.removed ? '开机自启已移除' : '未安装开机自启'), r.path || '');
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      log(HELP);
      break;
    default:
      log(`未知命令: ${cmd}\n`);
      log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('错误:', e.message);
  process.exit(1);
});
