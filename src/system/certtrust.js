import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 生成/返回「把 CA 加入系统信任」的命令。
 * 实际执行需要提权，这里以返回命令 + 可选执行为主。
 *
 * @param {string} caPath ca.crt 路径
 * @returns {{platform:string, command:string, args:string[], note:string}}
 */
export function trustCaCommand(caPath) {
  const abs = path.resolve(caPath);
  switch (process.platform) {
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
export async function tryTrustCa(caPath) {
  const cmd = trustCaCommand(caPath);
  try {
    if (process.platform === 'win32') {
      await execFileAsync(cmd.command, cmd.args, { windowsHide: true });
    } else if (process.platform === 'darwin') {
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
