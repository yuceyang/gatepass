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
 * 注意：必须用可见的 powershell 父进程触发，detached/hidden 的后台进程
 * 无法弹出 UAC 同意框（会静默失败）。
 */
export function runElevatedPowerShell(scriptBody) {
  const tmp = path.join(os.tmpdir(), `gatepass-elevate-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, scriptBody, 'utf8');

  // 用一个可见的小 PowerShell 去 Start-Process -Verb RunAs，UAC 才能弹到用户桌面
  const launcher = [
    'Start-Process',
    '-FilePath', `'powershell'`,
    '-Verb', 'RunAs',
    '-ArgumentList', `'-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp}'`,
    '-WindowStyle', 'Hidden',
  ].join(' ');

  try {
    // 不用 detached / windowsHide：让 UAC 提示可见
    const child = spawn('powershell', ['-NoProfile', '-Command', launcher], {
      stdio: 'ignore',
      windowsHide: false,
      detached: false,
    });
    child.unref();
    return {
      ok: true,
      script: tmp,
      note: '已请求管理员权限，若弹出 UAC 请点「是」',
    };
  } catch (e) {
    return {
      ok: false,
      script: tmp,
      error: e.message,
      command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      note: '自动提权失败，请用管理员 PowerShell 执行 manualCommand',
    };
  }
}

/**
 * 兜底：用任务计划程序以最高权限执行一次（需当前用户可建任务）。
 * 成功时立即运行一次并删除任务。
 */
export function runViaScheduledTask(scriptBody) {
  const tmp = path.join(os.tmpdir(), `gatepass-elevate-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, scriptBody, 'utf8');
  const taskName = `GatePassHostsWrite-${Date.now()}`;
  const tr = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`;
  // /rl highest：以最高权限运行（非管理员创建任务时可能失败，失败则上层走手动指引）
  return execFileAsync('schtasks', [
    '/create', '/tn', taskName, '/tr', tr, '/sc', 'once', '/st', '00:00',
    '/rl', 'highest', '/f',
  ]).then(
    async () => {
      await execFileAsync('schtasks', ['/run', '/tn', taskName]).catch(() => {});
      // 清理任务
      setTimeout(() => {
        execFileAsync('schtasks', ['/delete', '/tn', taskName, '/f']).catch(() => {});
      }, 15000);
      return { ok: true, script: tmp, note: '已通过任务计划执行' };
    },
    (e) => ({
      ok: false,
      script: tmp,
      error: e.message,
      command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
    })
  );
}
