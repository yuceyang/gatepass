import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // 代理监听：必须 443，浏览器/扩展默认走标准 HTTPS 端口
  proxy: { host: '127.0.0.1', port: 443, insecureUpstreamTls: true },
  // 鉴权提供者
  provider: {
    id: 'ugos',
    authBase: 'https://yuceyang.cn68.ug.link',
    username: '',
    password: '',
    keepalive: true,
    domainSuffix: 'yuceyang.cn68.ugdocker.link',
  },
  // 路由表
  routes: [],
  // 实时日志缓冲条数
  logBufferSize: 2000,
  // 首次向导是否完成
  onboardingDone: false,
};

/**
 * @param {string} [filePath]
 * @returns {object} 合并了默认值的配置对象
 */
export function loadConfig(filePath = defaultConfigPath()) {
  let raw = {};
  if (fs.existsSync(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`配置文件 JSON 解析失败（${filePath}）: ${e.message}`);
    }
  }
  return mergeDefaults(DEFAULTS, raw);
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

export { DEFAULTS as configDefaults };

// 供 CLI 定位包根
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
