/** Detect Android's Termux userspace (Node reports Android as Linux). */
export function isTermux(platform = process.platform, env = process.env) {
  if (platform !== 'linux' && platform !== 'android') return false;
  if (env.TERMUX_VERSION) return true;
  return /(?:^|\/)com\.termux\/files\/usr\/?$/.test(env.PREFIX || '');
}

export function termuxIntegrationNotice() {
  return 'Termux 无法修改 Android 系统 DNS/hosts，也不能直接安装系统信任的 CA。请另行配置 Android 兼容的 DNS/VPN 方案；应用是否信任用户 CA 取决于应用本身。';
}

export function termuxAutostartNotice() {
  return 'Termux 不支持桌面环境的开机自启。请手动启动，或单独配置 Termux:Boot。';
}
