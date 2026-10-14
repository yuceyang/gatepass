import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 系统端口转发：127.0.0.1:443 → 127.0.0.1:<proxyPort>。
 * 实际服务监听在非常用端口；443 只做转发，让 https://app-xxx…/ 免端口号可用。
 */
export function portproxyCommand(forwardPort) {
  return {
    command: 'netsh',
    args: [
      'interface', 'portproxy', 'add', 'v4tov4',
      'listenport=443', 'listenaddress=127.0.0.1',
      `connectport=${forwardPort}`, 'connectaddress=127.0.0.1',
    ],
    removeArgs: [
      'interface', 'portproxy', 'delete', 'v4tov4',
      'listenport=443', 'listenaddress=127.0.0.1',
    ],
    forwardPort,
    note: `127.0.0.1:443 → 127.0.0.1:${forwardPort}`,
  };
}

export async function installPortProxy(forwardPort) {
  const cmd = portproxyCommand(forwardPort);
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
  const cmd = portproxyCommand(0);
  try {
    await execFileAsync(cmd.command, cmd.removeArgs, { windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getPortProxyStatus() {
  if (process.platform !== 'win32') return { supported: false, entries: [], installed: false };
  try {
    const { stdout } = await execFileAsync('netsh', ['interface', 'portproxy', 'show', 'all'], { windowsHide: true });
    const entries = stdout.split(/\r?\n/).filter((l) => l.trim());
    const installed = /443/.test(stdout) && /127\.0\.0\.1/.test(stdout);
    return { supported: true, entries, installed };
  } catch {
    return { supported: true, entries: [], installed: false };
  }
}
