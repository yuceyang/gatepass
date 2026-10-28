import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTermux } from './system/termux.js';

const APP_NAME = 'gatepass';

/** 平台默认配置目录（可整目录拷贝迁移） */
export function defaultConfigDir() {
  const override = process.env.GATEPASS_HOME;
  if (override) return override;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
  }
}

export function defaultConfigPath() {
  return path.join(defaultConfigDir(), 'config.json');
}

const DEFAULTS = {
  version: 1,
  // 控制台监听
  console: { host: '127.0.0.1', port: 19099 },
  // 代理监听：桌面平台默认 443；Termux 普通用户默认使用 18443
  // httpPort：额外开启一个纯 HTTP 监听（默认 null 关闭），供不接受自签证书的客户端使用
  proxy: { host: '127.0.0.1', port: 443, insecureUpstreamTls: true, httpPort: null },
  // 鉴权提供者
  provider: {
    id: 'ugos',
    // UGREENlink 别名（ug.link/<alias>）。远程访问的后缀会随设备重新注册而变化，
    // 所以只记别名，实际登录地址在运行时向 UGREENlink 查询。
    alias: '',
    // 手动指定的登录地址（可选）。留空则按别名自动解析；
    // 填写后只在 alias 查询失败时作为兜底。
    authBase: '',
    username: '',
    password: '',
    keepalive: true,
    // 代理域名后缀 —— 决定本机 hosts / 证书覆盖哪些主机名，是固定值，不随远程后缀变化。
    domainSuffix: 'yuceyang.cn68.ugdocker.link',
  },
  // 路由表
  routes: [],
  // 实时日志缓冲条数
  logBufferSize: 2000,
  // 首次向导是否完成
  onboardingDone: false,
};

export function defaultProxyPort(platform = process.platform, env = process.env) {
  return isTermux(platform, env) ? 18443 : DEFAULTS.proxy.port;
}

/**
 * @param {string} [filePath]
 * @param {{platform?:string,env?:object}} [options]
 * @returns {object} 合并了默认值的配置对象
 */
export function loadConfig(filePath = defaultConfigPath(), options = {}) {
  let raw = {};
  if (fs.existsSync(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`配置文件 JSON 解析失败（${filePath}）: ${e.message}`);
    }
  }
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const defaults = isTermux(platform, env)
    ? { ...DEFAULTS, proxy: { ...DEFAULTS.proxy, port: defaultProxyPort(platform, env) } }
    : DEFAULTS;
  return mergeDefaults(defaults, raw);
}

/**
 * @param {object} cfg
 * @param {string} [filePath]
 */
export function saveConfig(cfg, filePath = defaultConfigPath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = JSON.stringify(cfg, null, 2) + '\n';
  // 无 BOM UTF-8
  fs.writeFileSync(filePath, text, { encoding: 'utf8' });
  return filePath;
}

function mergeDefaults(defaults, raw) {
  if (Array.isArray(defaults) || typeof defaults !== 'object' || defaults === null) {
    return raw !== undefined ? raw : defaults;
  }
  const out = { ...defaults };
  for (const [k, v] of Object.entries(raw || {})) {
    out[k] =
      typeof v === 'object' && v !== null && !Array.isArray(v) && typeof defaults[k] === 'object' && defaults[k] !== null && !Array.isArray(defaults[k])
        ? mergeDefaults(defaults[k], v)
        : v;
  }
  return out;
}

export const configDefaults = {
  ...DEFAULTS,
  proxy: { ...DEFAULTS.proxy, port: defaultProxyPort() },
};

// 供 CLI 定位包根
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
