import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 是否已具备管理员/root 权限 */
export function isElevated() {
  if (process.platform === 'win32') {
    try {
      const probe = path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp', `gp-elevate-probe-${process.pid}`);
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * 用 UAC 重新拉起当前进程（Windows）。
 * @returns {{ok:boolean, note:string}}
 */
export function relaunchElevated(args = []) {
  if (process.platform !== 'win32') {
    return { ok: false, note: '请用 sudo 重新运行' };
  }
  const exe = process.argv0;
  const scriptArgs = process.argv.slice(1);
  const allArgs = [...scriptArgs, ...args];
  const argList = allArgs.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = `Start-Process -FilePath '${exe}' -Verb RunAs -ArgumentList ${argList} -WorkingDirectory '${process.cwd()}'`;
  spawn('powershell', ['-NoProfile', '-Command', ps], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  return { ok: true, note: '已请求管理员权限，UAC 确认后以管理员身份重新启动' };
}

/**
 * 以管理员执行一段 PowerShell（弹 UAC）。
 */
export function runElevatedPowerShell(scriptBody) {
  const tmp = path.join(os.tmpdir(), `gatepass-elevate-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, scriptBody, 'utf8');
  const ps = `Start-Process -FilePath powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp}' -WindowStyle Hidden`;
  spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { ok: true, script: tmp, note: '已请求管理员权限，若弹出 UAC 请点“是”' };
}
