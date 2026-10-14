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
    return {
      id: input.id || crypto.randomUUID(),
      host,
      // upstreamPort：网关后的应用端口（dockerToken 用）；TCP 上游端口见 upstreamConnectPort（默认 443）
      upstreamHost,
      upstreamPort,
      upstreamConnectPort: input.upstreamConnectPort || '',
      providerId: input.providerId || 'ugos',
      enabled: input.enabled !== false,
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
