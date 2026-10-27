import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isTermux, termuxAutostartNotice } from './termux.js';

const execFileAsync = promisify(execFile);

/**
 * 开机自启：按平台安装/卸载。
 * Windows —— 启动文件夹 gatepass-start.vbs（WScript.Shell.Run window=0，完全隐藏）
 * macOS   —— ~/Library/LaunchAgents/com.gatepass.agent.plist
 * Linux   —— ~/.config/autostart/gatepass.desktop（桌面会话）或提示 systemd
 */
export function autostartPaths(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (isTermux(platform, env)) {
    return { kind: 'unsupported', dir: null, file: null, note: termuxAutostartNotice() };
  }
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return {
        kind: 'vbs',
        dir: path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
          'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
        file: 'gatepass-start.vbs',
      };
    case 'darwin':
      return {
        kind: 'plist',
        dir: path.join(home, 'Library', 'LaunchAgents'),
        file: 'com.gatepass.agent.plist',
      };
    default:
      return {
        kind: 'desktop',
        dir: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart'),
        file: 'gatepass.desktop',
      };
  }
}

function gatepassExe() {
  // 优先 npm 全局 bin，其次用当前 node + 包内 bin
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const localBin = path.join(pkgRoot, 'bin', 'gatepass.js');
  if (process.platform === 'win32') {
    const cmd = path.join(process.env.APPDATA || '', 'npm', 'gatepass.cmd');
    if (fs.existsSync(cmd)) return { file: cmd, args: ['start'], shell: true };
    return { file: process.execPath, args: [`"${localBin}"`, 'start'], shell: true };
  }
  const cmd = '/usr/local/bin/gatepass';
  if (fs.existsSync(cmd)) return { file: cmd, args: ['start'], shell: false };
  return { file: process.execPath, args: [localBin, 'start'], shell: false };
}

export function isAutostartInstalled(options = {}) {
  if (isTermux(options.platform || process.platform, options.env || process.env)) return false;
  const p = autostartPaths(options);
  return fs.existsSync(path.join(p.dir, p.file));
}

export async function installAutostart(options = {}) {
  if (isTermux(options.platform || process.platform, options.env || process.env)) {
    return { ok: false, supported: false, installed: false, note: termuxAutostartNotice() };
  }
  const p = autostartPaths(options);
  fs.mkdirSync(p.dir, { recursive: true });
  const target = path.join(p.dir, p.file);
  const exe = gatepassExe();

  if (process.platform === 'win32') {
    // 隐藏启动的代价是没有输出，失败时无从排查。拆成两个文件：
    //   gatepass-start.cmd —— 真正运行，把输出重定向到日志
    //   gatepass-start.vbs —— 以 window style 0 静默调用上面的 cmd，不留窗口
    const logPath = path.join(p.dir, 'gatepass-start.log');
    const cmdPath = path.join(p.dir, 'gatepass-start.cmd');
    const runLine = `"${exe.file}" ${exe.args.join(' ')}`;
    const cmdBody = [
      '@echo off',
      'chcp 65001 >nul 2>&1',
      `echo [%date% %time%] starting gatepass >> "${logPath}"`,
      `${runLine} >> "${logPath}" 2>&1`,
      `echo [%date% %time%] exited with %ERRORLEVEL% >> "${logPath}"`,
      '',
    ].join('\r\n');
    fs.writeFileSync(cmdPath, cmdBody, 'utf8');

    const vbsBody =
      'Set sh = CreateObject("WScript.Shell")\r\n' +
      `sh.Run """${cmdPath}""", 0, False\r\n`;
    fs.writeFileSync(target, vbsBody, 'utf8');
    // 清理旧的 bat 自启文件
    const legacy = path.join(p.dir, 'gatepass-start.bat');
    if (fs.existsSync(legacy)) {
      try { fs.unlinkSync(legacy); } catch { /* ignore */ }
    }
  } else if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gatepass.agent</string>
  <key>ProgramArguments</key><array>
    <string>${exe.file}</string>${exe.args.map((a) => `\n    <string>${a}</string>`).join('')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), 'Library', 'Logs', 'gatepass.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), 'Library', 'Logs', 'gatepass.err')}</string>
</dict></plist>
`;
    fs.writeFileSync(target, plist, 'utf8');
    await execFileAsync('launchctl', ['load', '-w', target]).catch(() => {});
  } else {
    const desktop = `[Desktop Entry]
Type=Application
Name=GatePass
Exec=${exe.file} ${exe.args.join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
    fs.writeFileSync(target, desktop, 'utf8');
  }
  return { ok: true, path: target };
}

export async function removeAutostart(options = {}) {
  if (isTermux(options.platform || process.platform, options.env || process.env)) {
    return { ok: false, supported: false, removed: false, note: termuxAutostartNotice() };
  }
  const p = autostartPaths(options);
  const target = path.join(p.dir, p.file);
  if (!fs.existsSync(target)) return { ok: true, removed: false, path: target };
  if (process.platform === 'darwin') {
    await execFileAsync('launchctl', ['unload', '-w', target]).catch(() => {});
  }
  fs.unlinkSync(target);
  return { ok: true, removed: true, path: target };
}

/**
 * 尝试提权写 hosts（Windows 用 RunAs 拉起一次性脚本）。
 * 失败时返回待手动执行的命令，不抛致命错误。
 */
export async function tryElevatedHostsWrite(blockContent) {
  const tmp = path.join(os.tmpdir(), 'gatepass-hosts-write.ps1');
  const hostsPath = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts';
  const nl = String.fromCharCode(13, 10);
  const script = [
    `$p='${hostsPath}'`,
    `$c=@'`,
    blockContent,
    `'@`,
    `$t=[System.IO.File]::ReadAllText($p)`,
    // 只改写 gatepass 标记块
    `if ($t -match '# gatepass begin') { $t=[regex]::Replace($t,'(?s)# gatepass begin[\\s\\S]*?# gatepass end', $c.Trim()) }`,
    `else { $t=$t.TrimEnd()+"${nl}${nl}"+$c.Trim()+"${nl}" }`,
    `$enc=New-Object System.Text.UTF8Encoding($false)`,
    `[System.IO.File]::WriteAllText($p,$t,$enc)`,
    `ipconfig /flushdns`,
    '',
  ].join('\n');
  fs.writeFileSync(tmp, script, 'utf8');

  if (process.platform === 'win32') {
    try {
      // 拉起 UAC 提权窗口执行；返回即代表已请求，结果用「稍后刷新 hosts 状态」验证
      spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        // Verb RunAs 需要 shell:true 的 start；Node spawn 不支持 Verb，
        // 改用 powershell Start-Process -Verb RunAs
      }).unref();
      return { ok: true, mode: 'elevated-requested', note: '已请求管理员权限，若弹出 UAC 请点“是”', script: tmp };
    } catch (e) {
      return { ok: false, error: e.message, script: tmp, command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"` };
    }
  }
  return {
    ok: false,
    command: `sudo cp ${tmp} /tmp/gp.sh && sudo sh /tmp/gp.sh`,
    script: tmp,
    note: '需要 sudo',
  };
}

/** Windows 真正的提权启动：Start-Process -Verb RunAs */
export function launchElevatedHostsScript(scriptPath) {
  const ps = `Start-Process -FilePath powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath}' -WindowStyle Hidden`;
  spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { ok: true, note: '已弹出 UAC，确认后 hosts 会更新' };
}
