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
 * 兼容旧 ugdocker-proxy 标记块（一并替换，避免双块并存）。
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
  // 同时清理历史遗留的 ugdocker-proxy 块
  const reNew = new RegExp(`${BEGIN}[\\s\\S]*?${END}`, 'g');
  const reLegacy = /# ===== ugdocker-proxy BEGIN =====[\s\S]*?# ===== ugdocker-proxy END =====/g;
  let next = content.replace(reNew, block);
  if (next === content && reLegacy.test(content)) {
    reLegacy.lastIndex = 0;
    next = content.replace(reLegacy, block);
  }
  if (next === content) {
    next = content.replace(/\s*$/, '') + '\n\n' + block + '\n';
  }

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
 * @returns {{command:string, args:string[], shell:string, script:string, note:string}}
 */
export function elevatedWriteCommand(entries) {
  const block = renderBlock(entries);
  const p = hostsPath();
  const nl = String.fromCharCode(13, 10);
  // 可直接作为 .ps1 执行的脚本体：替换/清理标记块后写入
  const script = [
    `$p='${p}'`,
    `$c=@'`,
    block,
    `'@`,
    `$t=[System.IO.File]::ReadAllText($p)`,
    `$t=[regex]::Replace($t,'(?s)# gatepass begin[\\s\\S]*?# gatepass end','')`,
    `$t=[regex]::Replace($t,'(?s)# ===== ugdocker-proxy BEGIN =====[\\s\\S]*?# ===== ugdocker-proxy END =====','')`,
    `$t=$t.TrimEnd()+"${nl}${nl}"+$c.Trim()+"${nl}"`,
    `$enc=New-Object System.Text.UTF8Encoding($false)`,
    `[System.IO.File]::WriteAllText($p,$t,$enc)`,
    `ipconfig /flushdns`,
    '',
  ].join('\n');

  if (process.platform === 'win32') {
    return {
      shell: 'powershell',
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script.replace(/\r?\n/g, '; ')],
      script,
      note: '需以管理员身份运行',
    };
  }
  return {
    shell: 'sh',
    command: 'sh',
    args: ['-c', `printf '\\n%s\\n' ${JSON.stringify(block)} >> ${JSON.stringify(p)}`],
    script,
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
