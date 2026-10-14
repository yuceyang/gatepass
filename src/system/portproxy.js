import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 可选：系统端口转发 443 → 本程序端口（netsh interface portproxy）。
 * 启用后浏览器可用 https://app-xxx…/ 不带端口号；
 * 这会占用 443，属于「透明访问」增强，默认关闭，由用户显式开启。
 */
export function portproxyCommand(listenPort, forwardPort) {
  return {
    command: 'netsh',
    args: [
      'interface', 'portproxy', 'add', 'v4tov4',
      `listenport=443`, `listenaddress=127.0.0.1`,
      `connectport=${forwardPort}`, `connectaddress=127.0.0.1`,
    ],
    note: `把 127.0.0.1:443 转发到 127.0.0.1:${forwardPort}（需管理员，会占用 443）`,
    removeArgs: ['interface', 'portproxy', 'delete', 'v4tov4', 'listenport=443', 'listenaddress=127.0.0.1'],
    listenPort: Number(listenPort) || 443,
    forwardPort,
  };
}

export async function installPortProxy(forwardPort) {
  const cmd = portproxyCommand(443, forwardPort);
  try {
    await execFileAsync(cmd.command, cmd.args, { windowsHide: true });
    return { ok: true, note: cmd.note, command: `${cmd.command} ${cmd.args.join(' ')}` };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      command: `${cmd.command} ${cmd.args.join(' ')}`,
      note: '需要管理员权限执行 netsh portproxy',
    };
  }
}

export async function removePortProxy() {
  const cmd = portproxyCommand(443, 0);
  try {
    await execFileAsync(cmd.command, cmd.removeArgs, { windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getPortProxyStatus() {
  if (process.platform !== 'win32') return { supported: false, entries: [] };
  try {
    const { stdout } = await execFileAsync('netsh', ['interface', 'portproxy', 'show', 'all'], { windowsHide: true });
    return { supported: true, entries: stdout.split(/\r?\n/).filter((l) => l.trim()) };
  } catch {
    return { supported: true, entries: [] };
  }
}
