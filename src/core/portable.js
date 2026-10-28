/**
 * Portable configuration — the single file shared across desktop, Android and (later) iOS.
 *
 * Design rules:
 *  - Only platform-neutral data lives here: NAS endpoint/credentials and the route list.
 *  - Anything that differs per platform (listen ports, autostart, hosts, CA trust) is NOT
 *    stored, so the same file applies everywhere without per-device edits.
 *  - `version` is a plain integer; readers must reject unknown future versions rather than
 *    silently dropping fields they do not understand.
 */

export const PORTABLE_VERSION = 1;
export const PORTABLE_SCHEMA = 'gatepass-portable/v1';

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Builds the portable object from a desktop config. */
export function toPortable(config, { includePassword = true } = {}) {
  const p = config?.provider || {};
  return {
    $schema: PORTABLE_SCHEMA,
    version: PORTABLE_VERSION,
    provider: {
      id: p.id || 'ugos',
      // The alias is the portable identity. `authBase` is only a manual override now, so it is
      // normally empty — the live address is looked up at runtime and changes on re-register.
      alias: p.alias || '',
      authBase: p.authBase || '',
      username: p.username || '',
      password: includePassword ? p.password || '' : '',
      domainSuffix: p.domainSuffix || '',
    },
    routes: (config?.routes || []).map((r) => ({
      host: r.host,
      enabled: r.enabled !== false,
      // Kept so an Android export round-trips through the desktop and back unchanged.
      httpIngress: r.httpIngress !== false,
      // 'system' routes (the UGOS desktop on :9443) go through the relay host, not the port map.
      kind: r.kind === 'system' ? 'system' : 'app',
    })),
  };
}

/**
 * Validates a portable object and converts it into desktop config fields.
 * @returns {{provider: object, routes: Array<object>, hasPassword: boolean}}
 */
export function fromPortable(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('配置文件不是合法的 JSON 对象');
  if (raw.version !== PORTABLE_VERSION) {
    throw new Error(`不支持的配置版本 ${raw.version}（本程序支持 ${PORTABLE_VERSION}）`);
  }
  const p = raw.provider || {};
  const alias = String(p.alias || '').trim();
  const authBase = String(p.authBase || '').trim().replace(/\/+$/, '');
  // Either an alias (the normal case) or a manual address must be present; an alias-only file is
  // valid because the login host is resolved from UGREENlink at runtime.
  if (!alias && !authBase) {
    throw new Error('provider 需要 UGREENlink 别名（alias）或 NAS 地址（authBase）');
  }
  if (authBase && !/^https?:\/\//i.test(authBase)) {
    throw new Error('provider.authBase 必须是 http(s) 地址');
  }
  if (alias && !/^[a-z0-9][a-z0-9-]*$/i.test(alias)) {
    throw new Error(`非法的 UGREENlink 别名: ${alias}`);
  }

  const provider = {
    id: p.id || 'ugos',
    alias,
    authBase,
    username: String(p.username || '').trim(),
    password: String(p.password || ''),
    keepalive: true,
    domainSuffix: String(p.domainSuffix || '').trim(),
  };

  const seen = new Set();
  const routes = [];
  for (const item of Array.isArray(raw.routes) ? raw.routes : []) {
    const host = String(item?.host || '').trim().toLowerCase();
    if (!host || !HOST_RE.test(host)) throw new Error(`非法主机名: ${item?.host}`);
    if (seen.has(host)) continue;
    seen.add(host);
    routes.push({
      host,
      enabled: item.enabled !== false,
      httpIngress: item.httpIngress !== false,
      kind: item.kind === 'system' ? 'system' : 'app',
    });
  }
  return { provider, routes, hasPassword: String(p.password || '').length > 0 };
}

/** Parses a portable config from JSON text. */
export function parsePortable(text) {
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON: ${e.message}`);
  }
  return fromPortable(raw);
}
