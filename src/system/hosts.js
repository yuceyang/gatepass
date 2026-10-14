import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BEGIN = '# gatepass begin';
const END = '# gatepass end';

export function hostsPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

function renderBlock(entries) {
  const lines = [BEGIN, '# managed by gatepass — do not edit between markers'];
  for (const e of entries) {
    lines.push(`${e.ip}\t${e.host}${e.comment ? `\t# ${e.comment}` : ''}`);
  }
  lines.push(END);
  return lines.join('\n');
}

/**
 * 幂等写入/替换 hosts 标记块。
 * @param {Array<{ip:string,host:string,comment?:string}>} entries
 * @returns {{path:string, content:string, changed:boolean}}
 */
export function writeHostsBlock(entries) {
  const p = hostsPath();
  let content = '';
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch {
    content = '';
  }
  const block = renderBlock(entries);
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`, 'g');
  const next = re.test(content)
    ? content.replace(re, block)
    : content.replace(/\s*$/, '') + '\n\n' + block + '\n';

  const changed = next !== content;
  if (changed) {
    // 共享读写，规避被占用
    const fd = fs.openSync(p, 'r+');
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, next, 0, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  return { path: p, content: next, changed };
}

/** 移除标记块 */
export function removeHostsBlock() {
  const p = hostsPath();
  let content = '';
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch {
    return { path: p, changed: false };
  }
  const re = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, 'g');
  const next = content.replace(re, '\n');
  const changed = next !== content;
  if (changed) {
    const fd = fs.openSync(p, 'r+');
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, next, 0, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  return { path: p, changed };
}

/** 当前标记块内容（调试/展示用） */
export function readHostsBlock() {
  try {
    const content = fs.readFileSync(hostsPath(), 'utf8');
    const m = content.match(new RegExp(`${BEGIN}[\\s\\S]*?${END}`));
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

/**
 * 平台提权写 hosts 的命令（能力缺失时降级输出）。
 * @returns {{command:string, args:string[], shell:string}|null}
 */
export function elevatedWriteCommand(entries) {
  const block = renderBlock(entries);
  const p = hostsPath();
  if (process.platform === 'win32') {
    return {
      shell: 'powershell',
      command: 'powershell',
      args: [
        '-NoProfile',
        '-Command',
        `Add-Content -Path '${p}' -Value @'\n${block}\n'@ -Encoding ASCII`,
      ],
      note: '需以管理员身份运行',
    };
  }
  return {
    shell: 'sh',
    command: 'sh',
    args: ['-c', `printf '\\n%s\\n' ${JSON.stringify(block)} >> ${JSON.stringify(p)}`],
    note: '需要 sudo',
  };
}

export async function flushDns() {
  try {
    if (process.platform === 'win32') await execFileAsync('ipconfig', ['/flushdns']);
    else if (process.platform === 'darwin') await execFileAsync('dscacheutil', ['-flushcache']);
    else {
      // Linux: systemd-resolved 或 nscd，失败忽略
      await execFileAsync('resolvectl', ['flush-caches']).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

export function platformHome() {
  return os.homedir();
}
