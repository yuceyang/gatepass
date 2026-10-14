#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig, saveConfig, defaultConfigPath, defaultConfigDir } from '../src/config.js';
import { start } from '../src/index.js';
import { ensureCerts } from '../src/system/certs.js';
import { writeHostsBlock, flushDns, elevatedWriteCommand, readHostsBlock } from '../src/system/hosts.js';
import { trustCaCommand, checkPortFree } from '../src/system/certtrust.js';
import { isElevated, relaunchElevated } from '../src/system/elevate.js';

const [, , cmd = 'help', ...rest] = process.argv;

const HELP = `GatePass 鈥?鍏嶉噸澶嶇櫥褰曠殑缃戝叧鍙嶅悜浠ｇ悊

鐢ㄦ硶:
  gatepass init             棣栨鍚戝锛堢敓鎴愰厤缃?璇佷功锛屽紩瀵?hosts 涓?CA 淇′换锛?  gatepass start            鍚姩浠ｇ悊 + Web 鎺у埗鍙?  gatepass status           鏌ョ湅閰嶇疆璺緞涓庣鍙?  gatepass sync-hosts       鎸夊綋鍓嶈矾鐢卞悓姝ョ郴缁?hosts
  gatepass print-hosts      鎵撳嵃寰呭啓鍏ョ殑 hosts 鍧?  gatepass trust-ca         鎵撳嵃/灏濊瘯瀵煎叆 CA 璇佷功
  gatepass install-autostart   瀹夎寮€鏈鸿嚜鍚?  gatepass remove-autostart    绉婚櫎寮€鏈鸿嚜鍚?  gatepass help             鏄剧ず鏈府鍔?
鐜鍙橀噺:
  GATEPASS_HOME             瑕嗙洊閰嶇疆鐩綍锛堥粯璁ゅ钩鍙扮敤鎴锋暟鎹洰褰曪級
`;

function log(...a) {
  console.log(...a);
}

async function init() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = '') => rl.question(q + (def ? ` [${def}]` : '') + ': ').then((a) => a.trim() || def);

  log('\n=== GatePass 棣栨鍚戝 ===\n');
  const authBase = await ask('NAS 鐧诲綍鍦板潃锛堝 https://xxx.cn68.ug.link锛?);
  const username = await ask('鐢ㄦ埛鍚?);
  const password = await ask('瀵嗙爜');
  const domainSuffix = await ask('浠ｇ悊鍩熷悕鍚庣紑锛堝 yuceyang.cn68.ugdocker.link锛?);
  const routeHost = await ask('棣栦釜璺敱涓绘満鍚嶏紙濡?app-5006-yuceyang.cn68.ugdocker.link锛屽彲鐣欑┖绋嶅悗鍦ㄦ帶鍒跺彴娣诲姞锛?);
  const proxyPort = await ask('浠ｇ悊绔彛', '443');
  const consolePort = await ask('鎺у埗鍙扮鍙?, '9099');

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
      log(`  璺敱娣诲姞璺宠繃: ${e.message}`);
    }
  }

  saveConfig(config, configPath);
  log(`\n[1/4] 閰嶇疆宸蹭繚瀛? ${configPath}`);

  // 绔彛妫€娴?  const p443 = await checkPortFree(config.proxy.port, config.proxy.host);
  log(`[2/4] 绔彛 ${config.proxy.port}: ${p443.free ? '鍙敤' : '琚崰鐢紙' + (p443.error || '') + '锛?}`);
  const pCons = await checkPortFree(config.console.port, config.console.host);
  log(`      鎺у埗鍙?${config.console.port}: ${pCons.free ? '鍙敤' : '琚崰鐢?}`);

  // 璇佷功
  const certDir = path.join(path.dirname(configPath), 'certs');
  const hosts = config.routes.map((r) => r.host);
  const certs = ensureCerts({
    domainSuffix: domainSuffix || 'example.local',
    hosts,
    certDir,
    force: false,
  });
  log(`[3/4] 璇佷功: ${certs.certPath}`);
  const trust = trustCaCommand(certs.caPath);
  log(`      瀵煎叆 CA锛?{trust.note}锛?`);
  log(`      ${trust.command} ${trust.args.join(' ')}`);

  // hosts
  const entries = config.routes.filter((r) => r.enabled !== false).map((r) => ({ ip: '127.0.0.1', host: r.host, comment: 'gatepass' }));
  log('[4/4] hosts:');
  if (entries.length === 0) {
    log('      锛堟棤璺敱锛岃烦杩囷級');
  } else {
    try {
      const r = writeHostsBlock(entries);
      await flushDns();
      log(`      宸插啓鍏?${r.path}`);
    } catch (e) {
      log(`      鍐欏叆澶辫触: ${e.message}`);
      if (process.platform === 'win32') {
        const { runElevatedPowerShell } = await import('../src/system/elevate.js');
        const { elevatedWriteCommand } = await import('../src/system/hosts.js');
        const cmdObj = elevatedWriteCommand(entries);
        const r2 = runElevatedPowerShell(cmdObj.script);
        log(`      ${r2.note}`);
      } else {
        const cmd2 = elevatedWriteCommand(entries);
        log(`      璇锋墜鍔ㄦ墽琛岋紙${cmd2.note}锛?`);
        log(`      ${cmd2.command} ${cmd2.args.join(' ')}`);
      }
    }
  }

  rl.close();
  log('\n瀹屾垚銆傝繍琛?`gatepass start` 鍚姩銆俓n');
}

async function cmdStatus() {
  const configPath = defaultConfigPath();
  const exists = fs.existsSync(configPath);
  log('閰嶇疆璺緞:', configPath, exists ? '(宸插瓨鍦?' : '(鏈垵濮嬪寲锛屽厛璺?gatepass init)');
  if (exists) {
    const cfg = loadConfig(configPath);
    log('浠ｇ悊绔彛:', `${cfg.proxy.host}:${cfg.proxy.port}`);
    log('鎺у埗鍙扮鍙?', `${cfg.console.host}:${cfg.console.port}`);
    log('鍩熷悕鍚庣紑:', cfg.provider?.domainSuffix || '(鏈缃?');
    log('璺敱鏁?', cfg.routes?.length || 0);
  }
  log('CA/璇佷功鐩綍:', path.join(path.dirname(configPath), 'certs'));
  const block = readHostsBlock();
  log('hosts 鏍囪鍧?', block ? '宸插啓鍏? : '鏈啓鍏?);
}

async function cmdSyncHosts() {
  const cfg = loadConfig();
  const { RouteRegistry } = await import('../src/core/routes.js');
  const rr = new RouteRegistry({ routes: cfg.routes });
  const entries = rr.hostsEntries();
  if (!entries.length) {
    log('鏃犺矾鐢憋紝璺宠繃');
    return;
  }
  if (!isElevated() && process.platform === 'win32') {
    log('闇€瑕佺鐞嗗憳鏉冮檺鍐?hosts锛屾鍦ㄨ姹傛彁鏉冣€?);
    const { runElevatedPowerShell } = await import('../src/system/elevate.js');
    const { elevatedWriteCommand } = await import('../src/system/hosts.js');
    const cmdObj = elevatedWriteCommand(entries);
    const r = runElevatedPowerShell(cmdObj.script);
    log(r.note);
    log('绋嶅悗鍦ㄦ帶鍒跺彴鐐广€屽悓姝?hosts銆嶆垨閲嶆柊杩愯 gatepass sync-hosts 楠岃瘉銆?);
    return;
  }
  try {
    const r = writeHostsBlock(entries);
    await flushDns();
    log(r.changed ? 'hosts 宸叉洿鏂? : 'hosts 鏃犲彉鍖?);
  } catch (e) {
    log('鍐欏叆澶辫触:', e.message);
    const c = elevatedWriteCommand(entries);
    log('璇锋墜鍔ㄦ墽琛岋紙' + c.note + '锛?');
    log(c.command, c.args.join(' '));
  }
}

function cmdPrintHosts() {
  const cfg = loadConfig();
  const entries = (cfg.routes || []).filter((r) => r.enabled !== false).map((r) => ({ ip: '127.0.0.1', host: r.host, comment: 'gatepass' }));
  const c = elevatedWriteCommand(entries);
  log('# 灏嗕互涓嬪唴瀹硅拷鍔犲埌绯荤粺 hosts锛? + c.note + '锛?');
  log('');
  for (const e of entries) log(`${e.ip}\t${e.host}`);
}

function cmdTrustCa() {
  const certDir = path.join(defaultConfigDir(), 'certs');
  const caPath = path.join(certDir, 'ca.crt');
  if (!fs.existsSync(caPath)) {
    log('CA 涓嶅瓨鍦?', caPath, '鈥?鍏堣繍琛?gatepass init 鎴?gatepass start');
    return;
  }
  const t = trustCaCommand(caPath);
  log('CA 璺緞:', caPath);
  log('瀵煎叆鍛戒护锛? + t.note + '锛?');
  log(t.command, t.args.join(' '));
}

async function main() {
  // start / sync-hosts / init 闇€瑕佺鐞嗗憳锛?43 绔彛銆佸啓绯荤粺 hosts锛夈€?  // 鏈彁鏉冩椂鑷姩浠ョ鐞嗗憳閲嶆柊鎷夎捣锛岀敤鎴峰彧闇€鐐逛竴娆?UAC銆屾槸銆嶃€?  const needsAdmin = cmd === 'start' || cmd === 'sync-hosts';
  if (needsAdmin && !isElevated() && process.platform === 'win32') {
    log('闇€瑕佺鐞嗗憳鏉冮檺锛屾鍦ㄨ姹傛彁鏉冣€?);
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
      log('寮€鏈鸿嚜鍚凡瀹夎:', r.path);
      break;
    }
    case 'remove-autostart': {
      const mod = await import('../src/system/autostart.js');
      const r = await mod.removeAutostart();
      log(r.removed ? '寮€鏈鸿嚜鍚凡绉婚櫎' : '鏈畨瑁呭紑鏈鸿嚜鍚?, r.path);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      log(HELP);
      break;
    default:
      log(`鏈煡鍛戒护: ${cmd}\n`);
      log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('閿欒:', e.message);
  process.exit(1);
});
