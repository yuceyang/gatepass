import crypto from 'node:crypto';

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** 从主机名推断上游端口 */
export function inferPortFromHost(host) {
  const h = String(host).split('.')[0];
  const m = h.match(/app-?(\d+)/i);
  return m ? m[1] : '';
}

/**
 * 路由注册表：内存 + 持久化回调，热更新。
 */
export class RouteRegistry {
  /**
   * @param {{routes?: Array<object>, onChange?: (routes:Array<object>) => void}} opts
   */
  constructor(opts = {}) {
    /** @type {Map<string, object>} */
    this.byId = new Map();
    this.onChange = opts.onChange || (() => {});
    for (const r of opts.routes || []) {
      this._insert(this.normalize(r), { silent: true });
    }
  }

  normalize(input) {
    // 去掉协议、路径、端口，只留主机名
    const cleanHost = (h) =>
      String(h || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');
    // `system` marks a NAS system service (the UGOS desktop on :9443). Those are served by the
    // relay host, not by the docker port mapping — see Engine.upstreamHostFor.
    const kind = input.kind === 'system' ? 'system' : 'app';
    const host = cleanHost(input.host);
    if (!host || !HOST_RE.test(host)) {
      throw new Error(`非法主机名: ${input.host}`);
    }
    const upstreamPort = String(input.upstreamPort || inferPortFromHost(host) || '');
    if (!upstreamPort || !/^\d+$/.test(upstreamPort)) {
      throw new Error(`无法确定上游端口: ${host}`);
    }
    const upstreamHost = input.upstreamHost ? cleanHost(input.upstreamHost) : host;
    if (!upstreamHost || !HOST_RE.test(upstreamHost)) {
      throw new Error(`非法上游主机名: ${input.upstreamHost}`);
    }
    // 正向代理（如 Mihomo/Clash）：本机开一个专用端口，转发 CONNECT/绝对 URL 请求
    const proxy = input.proxy === true;
    return {
      id: input.id || crypto.randomUUID(),
      host,
      kind,
      // upstreamPort：网关后的应用端口（dockerToken 用）；TCP 上游端口见 upstreamConnectPort（默认 443）
      upstreamHost,
      upstreamPort,
      upstreamConnectPort: input.upstreamConnectPort || '',
      providerId: input.providerId || 'ugos',
      enabled: input.enabled !== false,
      // http：是否允许走纯 HTTP 监听（默认 false，仅 HTTPS 可访问）
      http: input.http === true,
      proxy,
      proxyPort: proxy
        ? String(input.proxyPort || '').trim() || String(18000 + Number(upstreamPort))
        : '',
      note: input.note || '',
    };
  }

  _insert(route, { silent = false } = {}) {
    this.byId.set(route.id, route);
    if (!silent) this.onChange(this.list());
    return route;
  }

  list() {
    return [...this.byId.values()];
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  add(input) {
    const route = this.normalize(input);
    if ([...this.byId.values()].some((r) => r.host === route.host)) {
      throw new Error(`主机已存在: ${route.host}`);
    }
    return this._insert(route);
  }

  update(id, patch) {
    const cur = this.byId.get(id);
    if (!cur) throw new Error(`路由不存在: ${id}`);
    const next = this.normalize({ ...cur, ...patch, id });
    // 主机冲突检查（排除自身）
    for (const r of this.byId.values()) {
      if (r.id !== id && r.host === next.host) throw new Error(`主机已存在: ${next.host}`);
    }
    this.byId.set(id, next);
    this.onChange(this.list());
    return next;
  }

  remove(id) {
    const ok = this.byId.delete(id);
    if (ok) this.onChange(this.list());
    return ok;
  }

  /**
   * Replaces the whole table in one go (used by config import).
   * Entries are normalised, so upstreamPort is inferred the same way as for a manual add.
   * @returns {{added:Array<object>, skipped:Array<{host:string, reason:string}>}}
   */
  replaceAll(inputs = []) {
    const next = new Map();
    const added = [];
    const skipped = [];
    for (const input of inputs) {
      try {
        const route = this.normalize(input);
        if ([...next.values()].some((r) => r.host === route.host)) {
          skipped.push({ host: route.host, reason: '主机重复' });
          continue;
        }
        next.set(route.id, route);
        added.push(route);
      } catch (e) {
        skipped.push({ host: input?.host, reason: e.message });
      }
    }
    this.byId = next;
    this.onChange(this.list());
    return { added, skipped };
  }

  /**
   * Rewrites every route to a new gateway suffix.
   *
   * UGOS hands out a suffix like `yuceyang.cn68.ugdocker.link` that changes when the device
   * re-registers, which invalidates every hostname at once. Only the stable tail after the
   * account label is replaced, so `app-5006-<old>` becomes `app-5006-<new>`.
   *
   * @param {string} oldSuffix e.g. yuceyang.cn68.ugdocker.link
   * @param {string} newSuffix e.g. yuceyang.cn11.ugdocker.link
   * @returns {Array<{from:string, to:string}>} routes that changed
   */
  remapSuffix(oldSuffix, newSuffix) {
    const from = String(oldSuffix || '').toLowerCase();
    const to = String(newSuffix || '').toLowerCase();
    if (!from || !to || from === to) return [];
    const changed = [];
    for (const route of this.byId.values()) {
      const at = route.host.indexOf(from);
      if (at < 0 || at + from.length !== route.host.length) continue;
      const nextHost = route.host.slice(0, at) + to;
      const up = route.upstreamHost || route.host;
      const upAt = up.indexOf(from);
      const nextUpstream = upAt >= 0 && upAt + from.length === up.length ? up.slice(0, upAt) + to : route.upstreamHost;
      const next = this.normalize({ ...route, host: nextHost, upstreamHost: nextUpstream });
      this.byId.set(route.id, next);
      changed.push({ from: route.host, to: next.host });
    }
    if (changed.length) this.onChange(this.list());
    return changed;
  }

  /**
   * Points every route's upstream at a new gateway suffix while leaving `host` untouched.
   *
   * This is what keeps existing bookmarks and app configs working: browsers keep asking for the
   * hostname they always used (`host`), and GatePass dials the gateway's current name
   * (`upstreamHost`). Ports are read from the `app-<port>` prefix, so the suffix is irrelevant
   * to authentication.
   *
   * @param {string} oldSuffix e.g. yuceyang.cn68.ugdocker.link
   * @param {string} newSuffix e.g. yuceyang.cn11.ugdocker.link
   * @returns {Array<{host:string, from:string, to:string}>} routes whose upstream changed
   */
  remapUpstreamSuffix(oldSuffix, newSuffix) {
    const from = String(oldSuffix || '').toLowerCase();
    const to = String(newSuffix || '').toLowerCase();
    if (!from || !to || from === to) return [];
    const changed = [];
    for (const route of this.byId.values()) {
      // The account label is joined with a hyphen (`app-5006-yuceyang.cn68...`), so match on the
      // raw suffix rather than on `.<suffix>`.
      const upstream = route.upstreamHost || route.host;
      const at = upstream.indexOf(from);
      if (at < 0 || at + from.length !== upstream.length) continue;
      const nextUpstream = upstream.slice(0, at) + to;
      const next = this.normalize({ ...route, upstreamHost: nextUpstream });
      this.byId.set(route.id, next);
      changed.push({ host: route.host, from: upstream, to: nextUpstream });
    }
    if (changed.length) this.onChange(this.list());
    return changed;
  }

  setEnabled(id, enabled) {
    return this.update(id, { enabled: !!enabled });
  }

  /** 按主机名匹配启用中的路由 */
  matchHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    for (const r of this.byId.values()) {
      if (r.enabled && r.host === h) return r;
    }
    return null;
  }

  /** 需要写进 hosts 的主机名列表 */
  hostsEntries(ip = '127.0.0.1') {
    return this.list()
      .filter((r) => r.enabled)
      .map((r) => ({ ip, host: r.host, comment: r.note || 'gatepass' }));
  }
}
