import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isTermux } from './termux.js';

const execFileAsync = promisify(execFile);

/**
 * 生成/返回「把 CA 加入系统信任」的命令。
 * 实际执行需要提权，这里以返回命令 + 可选执行为主。
 *
 * @param {string} caPath ca.crt 路径
 * @returns {{platform:string, command:string, args:string[], note:string}}
 */
export function trustCaCommand(caPath, options = {}) {
  const abs = path.resolve(caPath);
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (isTermux(platform, env)) {
    return {
      platform: 'android',
      command: null,
      args: [],
      supported: false,
      note: `不能从 Termux 安装 Android 系统 CA。可将 ${abs} 下载/复制到手机，在 Android「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」中手动导入；部分应用不会信任用户 CA。Node.js 客户端可设置 NODE_EXTRA_CA_CERTS=${abs}。`,
    };
  }
  switch (platform) {
    case 'win32':
      return {
        platform: 'win32',
        command: 'certutil',
        args: ['-addstore', '-user', 'Root', abs],
        note: '写入当前用户受信任根证书；系统级请以管理员运行 certutil -addstore Root',
      };
    case 'darwin':
      return {
        platform: 'darwin',
        command: 'security',
        args: ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db'), abs],
        note: '加入登录钥匙串；可能弹出授权框',
      };
    default:
      return {
        platform: 'linux',
        command: 'cp',
        args: [abs, '/usr/local/share/ca-certificates/gatepass-ca.crt'],
        note: '拷贝后需执行 update-ca-certificates；浏览器（NSS）还需 certutil -A -t "C,," -n gatepass -i ca.crt',
      };
  }
}

/** 尝试执行 CA 信任（可能因权限失败，失败不算错误） */
export async function tryTrustCa(caPath, options = {}) {
  const cmd = trustCaCommand(caPath, options);
  if (cmd.supported === false) return { ok: false, supported: false, command: cmd, note: cmd.note };
  const platform = options.platform || process.platform;
  try {
    if (platform === 'win32') {
      await execFileAsync(cmd.command, cmd.args, { windowsHide: true });
    } else if (platform === 'darwin') {
      await execFileAsync(cmd.command, cmd.args);
    } else {
      await execFileAsync('cp', [caPath, '/usr/local/share/ca-certificates/gatepass-ca.crt']);
      await execFileAsync('update-ca-certificates');
    }
    return { ok: true, command: cmd };
  } catch (e) {
    return { ok: false, command: cmd, error: e.message };
  }
}

/** 检测端口是否被占用；返回占用提示 */
export async function checkPortFree(port, host = '127.0.0.1') {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => {
      resolve({ free: false, port, host, error: e.code || e.message });
    });
    srv.once('listening', () => {
      srv.close(() => resolve({ free: true, port, host }));
    });
    srv.listen(port, host);
  });
}

/**
 * 常见服务端口：不应被本程序占用。
 * 80/443 虽是 HTTP(S) 标准端口，但常被 IIS/nginx/系统服务使用，同样列入。
 */
export const COMMON_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 80, 110, 123, 135, 137, 138, 139, 143, 161, 389,
  443, 445, 465, 587, 636, 993, 995, 1080, 1433, 1521, 2049, 2181, 2375,
  2379, 3000, 3306, 3389, 5000, 5432, 5672, 5900, 5984, 6379, 6443, 7001,
  8000, 8008, 8080, 8081, 8443, 8888, 9000, 9090, 9092, 9200, 9300, 9418,
  11211, 15672, 27017, 27018, 28017,
]);

export function isCommonPort(port) {
  return COMMON_PORTS.has(Number(port));
}

/** 供 UI/CLI 展示的提示 */
export function commonPortWarning(port) {
  if (!isCommonPort(port)) return null;
  return `端口 ${port} 是常见服务端口，可能与 IIS/nginx/数据库/远程桌面等冲突，建议改用 1024 以上的非常用端口（如 18443、19099）`;
}
