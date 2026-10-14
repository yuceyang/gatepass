#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig, saveConfig, defaultConfigPath, defaultConfigDir } from '../src/config.js';
import { start } from '../src/index.js';
import { ensureCerts } from '../src/system/certs.js';
import { writeHostsBlock, flushDns, elevatedWriteCommand, readHostsBlock } from '../src/system/hosts.js';
import { trustCaCommand, checkPortFree } from '../src/system/certtrust.js';

const [, , cmd = 'help', ...rest] = process.argv;

const HELP = `GatePass — 免重复登录的网关反向代理

用法:
  gatepass init             首次向导（生成配置/证书，引导 hosts 与 CA 信任）
  gatepass start            启动代理 + Web 控制台
  gatepass status           查看配置路径与端口
  gatepass sync-hosts       按当前路由同步系统 hosts
  gatepass print-hosts      打印待写入的 hosts 块
  gatepass trust-ca         打印/尝试导入 CA 证书
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
  const proxyPort = await ask('代理端口', '443');
  const consolePort = await ask('控制台端口', '9099');

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
  config.proxy = { ...config.proxy, port: Number(proxyPort) || 443 };
  config.console = { ...config.console, port: Number(consolePort) || 9099 };
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
  log(`\n[1/4] 配置已保存: ${configPath}`);

  // 端口检测
  const p443 = await checkPortFree(config.proxy.port, config.proxy.host);
  log(`[2/4] 端口 ${config.proxy.port}: ${p443.free ? '可用' : '被占用（' + (p443.error || '') + '）'}`);
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
  log(`[3/4] 证书: ${certs.certPath}`);
  const trust = trustCaCommand(certs.caPath);
  log(`      导入 CA（${trust.note}）:`);
  log(`      ${trust.command} ${trust.args.join(' ')}`);

  // hosts
  const entries = config.routes.filter((r) => r.enabled !== false).map((r) => ({ ip: '127.0.0.1', host: r.host, comment: 'gatepass' }));
  log('[4/4] hosts:');
  if (entries.length === 0) {
    log('      （无路由，跳过）');
  } else {
    try {
      const r = writeHostsBlock(entries);
      await flushDns();
      log(`      已写入 ${r.path}`);
    } catch (e) {
      log(`      写入失败: ${e.message}`);
      const cmd2 = elevatedWriteCommand(entries);
      log(`      请手动执行（${cmd2.note}）:`);
      log(`      ${cmd2.command} ${cmd2.args.join(' ')}`);
    }
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
  log('hosts 标记块:', block ? '已写入' : '未写入');
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
  try {
    const r = writeHostsBlock(entries);
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
  log('# 将以下内容追加到系统 hosts（' + c.note + '）:');
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
  log('导入命令（' + t.note + '）:');
  log(t.command, t.args.join(' '));
}

async function main() {
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
    case 'sync-hosts':
      await cmdSyncHosts();
      break;
    case 'print-hosts':
      cmdPrintHosts();
      break;
    case 'trust-ca':
      cmdTrustCa();
      break;
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
