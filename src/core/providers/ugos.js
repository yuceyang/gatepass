import crypto from 'node:crypto';

/** 从 x-rsa-token 头解出 PEM 公钥 */
export function decodePublicKeyPem(xRsaTokenHeader) {
  if (!xRsaTokenHeader) throw new Error('缺少 x-rsa-token 响应头，无法获取 RSA 公钥');
  const pem = Buffer.from(xRsaTokenHeader, 'base64').toString('utf8');
  if (!pem.includes('BEGIN')) throw new Error('x-rsa-token 解码后不是 PEM 公钥');
  return pem.includes('BEGIN RSA PUBLIC KEY')
    ? pem.replace(/BEGIN RSA PUBLIC KEY/g, 'BEGIN PUBLIC KEY').replace(/END RSA PUBLIC KEY/g, 'END PUBLIC KEY')
    : pem;
}

/** RSA/ECB/PKCS1Padding → base64 */
export function rsaEncryptWithPem(publicKeyPem, plaintext) {
  const key = crypto.createPublicKey(publicKeyPem);
  return crypto
    .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(plaintext), 'utf8'))
    .toString('base64');
}

/** 从主机名推端口：app-5006-x… → 5006；app16601-x… → 16601 */
export function extractPortFromHost(hostName) {
  const h = String(hostName).split('.')[0];
  const m = h.match(/app-?(\d+)/i);
  return m ? m[1] : '';
}

function parseSetCookie(raw) {
  if (!raw) return null;
  const [pair] = String(raw).split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
}

function collectSetCookies(headers) {
  const out = [];
  if (typeof headers.getSetCookie === 'function') {
    for (const raw of headers.getSetCookie()) {
      const p = parseSetCookie(raw);
      if (p) out.push(p);
    }
    return out;
  }
  const single = headers.get('set-cookie');
  if (single) {
    const p = parseSetCookie(single);
    if (p) out.push(p);
  }
  return out;
}

/**
 * 绕过 hosts（域名可能指向本地代理），直连真实 IP 取 auth 页 HTML。
 */
async function fetchTextDirect(absoluteUrl) {
  const https = await import('node:https');
  const dns = await import('node:dns/promises');
  const u = new URL(absoluteUrl);
  const hostName = u.hostname;
  const addrs = await dns.resolve4(hostName).catch(() => dns.resolve(hostName));
  const realIp = Array.isArray(addrs) ? addrs[0] : addrs;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: realIp,
        servername: hostName,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        rejectUnauthorized: false,
        headers: { host: hostName },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * UGOS Provider：NAS RSA 登录 + 网关 ugreen-proxy-token + HTTP Basic。
 */
export class UgosProvider {
  id = 'ugos';
  label = 'UGOS / 绿联 NAS';

  /**
   * @param {{authBase:string, username:string, password:string, keepalive?:boolean, log?:Function}} opts
   */
  constructor(opts) {
    this.alias = String(opts.alias || '').trim();
    this.authBase = String(opts.authBase || '').replace(/\/$/, '');
    this.username = opts.username || '';
    this.password = opts.password || '';
    this.keepalive = opts.keepalive !== false;
    this.log = opts.log || (() => {});
    /** @type {{token?:string, cookies:string, expiresAt:number}|null} */
    this.session = null;
    this._loginPromise = null;
    /** @type {Map<string,{token:string, expiresAt:number}>} */
    this.gatewayTokens = new Map();
    this.stats = { logins: 0, loginFailures: 0, gatewayTokens: 0 };
    /** Suffix reported by UGREENlink for the last successful lookup. */
    this.discoveredSuffix = '';
    /** Relay host (`<alias>.<relayDomain>`) — the NAS system UI lives here, not on a mapped port. */
    this.relayHost = '';
    /** The user's fixed suffix (hosts / certificates / bookmarks are built from this). */
    this.suffix = String(opts.domainSuffix || '').replace(/^\./, '');
    /** Resolved gateway host + when it was resolved, so we do not re-query on every request. */
    this._resolvedBase = '';
    this._resolvedAt = 0;
  }

  /**
   * The gateway suffix that is live *right now* — the part that moves when the NAS
   * re-registers (cn68 → cn11). `null` until a lookup has told us, so callers keep
   * using the route's own upstream host (which is what the fixed suffix yields).
   *
   * @returns {string|null}
   */
  liveSuffix() {
    return this.discoveredSuffix || null;
  }

  /**
   * Applies edited credentials at runtime so the console does not need a restart.
   *
   * The constructor copies its fields, so mutating the config object alone left this provider
   * holding stale (often empty) credentials — which is why a freshly imported password kept
   * failing with "未配置账号密码" until the process was restarted.
   *
   * @returns {boolean} true when anything changed, meaning the cached session is now stale.
   */
  applyConfig(opts = {}) {
    const next = {
      alias: String(opts.alias ?? this.alias).trim(),
      authBase: String(opts.authBase ?? this.authBase).replace(/\/$/, ''),
      username: opts.username ?? this.username,
      password: opts.password ?? this.password,
      suffix: String(opts.domainSuffix ?? this.suffix).replace(/^\./, ''),
    };
    const changed =
      next.alias !== this.alias ||
      next.authBase !== this.authBase ||
      next.username !== this.username ||
      next.password !== this.password;
    const suffixChanged = next.suffix !== this.suffix;
    Object.assign(this, next);
    if (changed) {
      // Credentials or target changed: drop everything derived from the old ones.
      this.session = null;
      this._loginPromise = null;
      this.gatewayTokens.clear();
      this.stats.loginFailures = 0;
      this._resolvedBase = '';
      this._resolvedAt = 0;
      this.discoveredSuffix = '';
    } else if (suffixChanged) {
      // A new fixed suffix means the routes were rewritten too, so the old answer is stale.
      this.discoveredSuffix = '';
    }
    return changed;
  }

  async ensureSession(force = false) {
    if (!force && this.session?.token && Date.now() < (this.session.expiresAt || 0)) {
      return { ok: true, expiresAt: this.session.expiresAt, detail: '已登录' };
    }
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._login()
      .then((s) => ({ ok: true, expiresAt: s.expiresAt, detail: '登录成功' }))
      .catch((e) => {
        this.stats.loginFailures++;
        return { ok: false, detail: e.message };
      })
      .finally(() => {
        this._loginPromise = null;
      });
    return this._loginPromise;
  }

  isAuthRedirect(status, location) {
    return (
      [301, 302, 307, 308].includes(status) &&
      !!location &&
      /login|account|signin|sign-in|auth/i.test(location)
    );
  }

  /**
   * Probes one base URL. Returns the response only when the gateway answered with a usable
   * RSA header — a 200 carrying {"code":407} (device timeout) or an error page is a miss.
   */
  async _check(base) {
    const res = await fetch(`${base}/ugreen/v1/verify/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'UG-Agent': 'PC/WEB', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ username: this.username }),
    });
    if (!res.headers.get('x-rsa-token')) {
      throw new Error(`NAS 未返回 RSA 公钥（HTTP ${res.status}）`);
    }
    return res;
  }

  /**
   * Finds the currently valid remote-access base for this NAS.
   *
   * UGOS assigns a suffix like `yuceyang.cn68.ug.link` that changes when the device re-registers
   * (a reboot can move it from cn68 to cn11). We keep the stable parts — the account label and
   * the `.ug.link` domain — and probe the small set of plausible suffixes in parallel.
   */
  /**
   * Returns the gateway host to talk to right now.
   *
   * With an alias configured this asks UGREENlink (cached for [RESOLVE_TTL_MS]), which is the
   * authoritative answer and survives the suffix changing after a device re-register. The
   * manually entered authBase is only a fallback for when that lookup is unavailable.
   */
  async resolveBase({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._resolvedBase && now - this._resolvedAt < RESOLVE_TTL_MS) {
      return this._resolvedBase;
    }

    if (this.alias) {
      const hit = await this.lookupByAlias(this.alias).catch(() => null);
      if (hit?.authBase) {
        const ok = await this._check(hit.authBase).then(() => true).catch(() => false);
        if (ok) {
          if (this._resolvedBase && this._resolvedBase !== hit.authBase) {
            this.log(`[ugos] 登录地址变化: ${this._resolvedBase} → ${hit.authBase}`);
          }
          this.discoveredSuffix = hit.domainSuffix;
          this.relayHost = hit.relayHost || '';
          this._resolvedBase = hit.authBase;
          this._resolvedAt = now;
          return hit.authBase;
        }
      }
      this.log(`[ugos] 未能通过别名 ${this.alias} 解析到可用地址`);
    }

    if (this.authBase) {
      // Manual address: verify it is alive, otherwise fall back to the scan.
      const alive = await this._check(this.authBase).then(() => true).catch(() => false);
      if (alive) {
        this._resolvedBase = this.authBase;
        this._resolvedAt = now;
        return this.authBase;
      }
      const discovered = await this.discoverAuthBase().catch(() => null);
      if (discovered) {
        this._resolvedBase = discovered;
        this._resolvedAt = now;
        return discovered;
      }
    }
    return this.authBase;
  }

  /**
   * Asks UGREENlink for the device behind an alias. This is the same lookup the web app at
   * ug.link/<alias> performs, and it returns the current suffix directly:
   *
   *   POST https://api.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias {"alias":"yuceyang"}
   *   → { data: { appDomain: "cn11.ugapp.link", dockerDomain: "cn11.ugdocker.link",
   *               relayDomain: "cn11.ug.link", ... } }
   *
   * @returns {Promise<{authBase:string, domainSuffix:string, dockerDomain:string, relayHost:string}|null>}
   */
  async lookupByAlias(alias) {
    if (!alias) return null;
    const res = await fetch('https://api.ugnas.com/api/p2p/v2/ta/nodeInfo/byAlias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ alias }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    if (!body || body.code !== 200 || !body.data) return null;
    const d = body.data;
    const relay = String(d.relayDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const docker = String(d.dockerDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!relay) return null;
    // relayDomain comes back without the alias (`cn11.ug.link`); the gateway host is
    // `<alias>.<relayDomain>`.
    const relayHost = relay.includes(alias) ? relay : `${alias}.${relay}`;
    return {
      authBase: `https://${relayHost}`,
      domainSuffix: docker ? `${alias}.${docker}` : '',
      dockerDomain: docker,
      relayHost,
    };
  }

  /**
   * Finds the currently valid remote-access base for this NAS.
   *
   * Preferred path: ask UGREENlink by alias (one request, exact answer). Falls back to probing
   * the neighbouring cnN hosts when that service is unreachable, so a network that blocks
   * api.ugnas.com still works.
   */
  async discoverAuthBase() {
    const known = String(this.authBase || '');
    const aliasMatch = known.match(/^https?:\/\/([^.]+)\.cn\d+\.ug\.link/i);
    // The configured alias is authoritative; parsing authBase is only a fallback for older
    // configs that predate the alias field (and where authBase is a bare cnN URL).
    const alias = this.alias || (aliasMatch ? aliasMatch[1] : '');

    if (alias) {
      const byAlias = await this.lookupByAlias(alias).catch(() => null);
      if (byAlias) {
        // Confirm the gateway really answers there before adopting it.
        try {
          await this._check(byAlias.authBase);
          this.log(`[ugos] UGREENlink 查询到 ${alias} 当前地址: ${byAlias.authBase}`);
          this.discoveredSuffix = byAlias.domainSuffix;
          return byAlias.authBase;
        } catch {
          this.log(`[ugos] ${byAlias.authBase} 暂时不可用，回退到扫描`);
        }
      }
    }

    let parsed;
    try {
      parsed = new URL(this.authBase);
    } catch {
      return null;
    }
    const host = parsed.hostname;
    const m = host.match(/^(.+?)\.cn(\d+)\.ug\.link$/i);
    if (!m) return null;
    const [, label] = m;
    const proto = parsed.protocol || 'https:';

    const candidates = [];
    for (let i = 1; i <= 40; i++) candidates.push(`${proto}//${label}.cn${i}.ug.link`);
    const hits = await Promise.all(
      candidates.map(async (base) => {
        try {
          await this._check(base);
          return base;
        } catch {
          return null;
        }
      }),
    );
    const found = hits.filter(Boolean);
    if (!found.length) return null;
    this.discoveredSuffix = `yuceyang.${host.replace(/^[^.]+\./, '')}`;
    return found[0];
  }

  async _login() {
    if (!this.username || !this.password) throw new Error('未配置账号密码');
    this.stats.logins++;

    // Always start from the address UGREENlink currently reports; the stored one may be stale.
    let base = await this.resolveBase({ force: true }).catch(() => this.authBase);
    let checkRes;
    try {
      checkRes = await this._check(base);
    } catch (e) {
      const discovered = await this.discoverAuthBase().catch(() => null);
      if (!discovered) throw e;
      this.log(`[ugos] 登录地址已失效，自动切换到 ${discovered}`);
      base = discovered;
      this._resolvedBase = discovered;
      this._resolvedAt = Date.now();
      checkRes = await this._check(base);
    }
    const publicKeyPem = decodePublicKeyPem(checkRes.headers.get('x-rsa-token'));
    const encPassword = rsaEncryptWithPem(publicKeyPem, this.password);

    const loginRes = await fetch(`${base}/ugreen/v1/verify/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'UG-Agent': 'PC/WEB', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({
        username: this.username,
        password: encPassword,
        keepalive: !!this.keepalive,
        otp: true,
        is_simple: false,
        login_event: null,
      }),
    });

    const setCookies = collectSetCookies(loginRes.headers);
    let body = null;
    try {
      body = await loginRes.json();
    } catch {
      const text = await loginRes.text().catch(() => '');
      throw new Error(`登录响应不是 JSON（HTTP ${loginRes.status}）${text ? `: ${text.slice(0, 120)}` : ''}`);
    }

    if (loginRes.status >= 400 || body?.code !== 200) {
      const msg = body?.msg || `code=${body?.code}`;
      throw new Error(`登录失败 HTTP=${loginRes.status} ${msg}`);
    }
    if (body?.needOtp) throw new Error('账号开启 OTP 二次验证，暂不支持自动登录');

    const token = body?.data?.token || body?.token || null;
    const cookies = setCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    this.session = { token, cookies, expiresAt: Date.now() + 12 * 3600 * 1000 };
    this.gatewayTokens.clear();
    this.log(`[ugos] 登录成功 token=${token ? token.slice(0, 12) + '…' : '(空)'}`);
    return this.session;
  }

  /**
   * 网关一次性 token：dockerToken 接口 → auth 页 → 解析 ugreen-proxy-token。
   */
  async renewGatewayToken(host, { force = false } = {}) {
    const cached = this.gatewayTokens.get(host);
    if (!force && cached && Date.now() < cached.expiresAt) return cached.token;

    await this.ensureSession();
    if (!this.session?.token) throw new Error('NAS 会话不可用');

    const port = extractPortFromHost(host);
    const base = await this.resolveBase().catch(() => this.authBase);
    const url = `${base}/ugreen/v1/gateway/proxy/dockerToken?port=${encodeURIComponent(port)}&token=${encodeURIComponent(this.session.token)}`;
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (body?.code !== 200 || !body?.data?.redirect_url) {
      throw new Error(`获取网关 token 失败 port=${port} code=${body?.code} msg=${body?.msg || res.status}`);
    }

    const html = await fetchTextDirect(body.data.redirect_url);
    const m = html.match(/ugreen-proxy-token=([0-9a-fA-F-]{36})/);
    if (!m) throw new Error(`auth 页未找到 ugreen-proxy-token（host=${host}）`);

    const gwToken = m[1];
    this.gatewayTokens.set(host, { token: gwToken, expiresAt: Date.now() + 2 * 3600 * 1000 });
    this.stats.gatewayTokens++;
    this.log(`[ugos] ${host} → ugreen-proxy-token=${gwToken.slice(0, 8)}…`);
    return gwToken;
  }

  /**
   * 注入：NAS Cookie + 网关 ugreen-proxy-token + HTTP Basic。
   */
  async applyToRequest(req, route) {
    const host = route?.host || '';
    const headers = { ...req.headers };
    const parts = [];
    if (this.session?.cookies) parts.push(this.session.cookies);
    // A system route is served by the relay host, which authenticates from the NAS session
    // cookie — a dockerToken for :9443 would only yield the "not a mapped port" error page.
    if (route?.kind === 'system') {
      if (parts.length) {
        headers.cookie = headers.cookie ? `${headers.cookie}; ${parts.join('; ')}` : parts.join('; ');
      }
      return { ...req, headers };
    }
    try {
      const gw = await this.renewGatewayToken(host);
      if (gw) parts.push(`ugreen-proxy-token=${gw}`);
    } catch (e) {
      this.log(`[ugos] 网关 token 获取失败（${host}）: ${e.message}`);
    }
    if (parts.length) {
      headers.cookie = headers.cookie ? `${headers.cookie}; ${parts.join('; ')}` : parts.join('; ');
    }
    if (!headers.authorization && this.username) {
      headers.authorization = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    }
    return { ...req, headers };
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      fields: [
        { key: 'authBase', label: 'NAS 地址', value: this.authBase },
        { key: 'username', label: '用户名', value: this.username },
        { key: 'password', label: '密码', value: this.password ? '••••••' : '(未设置)' },
      ],
      session: this.session
        ? { ok: true, expiresAt: this.session.expiresAt, hasToken: !!this.session.token }
        : { ok: false },
      // Surface *why* login is failing instead of leaving a bare stats counter.
      readiness: !this.username || !this.password
        ? { ok: false, reason: '未配置账号密码，请在设置中填写后保存' }
        : { ok: true },
      gatewayTokens: [...this.gatewayTokens.entries()].map(([host, v]) => ({
        host,
        expiresAt: v.expiresAt,
      })),
      stats: this.stats,
    };
  }
}

/**
 * 通用 Provider：静态 Cookie/Header/Query 注入。
 */
export class GenericHeaderProvider {
  id = 'generic-header';
  label = '通用 Header/Cookie';

  constructor(opts = {}) {
    this.cookies = opts.cookies || '';
    this.headers = opts.headers || {};
    this.query = opts.query || {};
  }

  async ensureSession() {
    return { ok: true, detail: '静态注入' };
  }

  async renewGatewayToken() {
    return null;
  }

  async applyToRequest(req) {
    const headers = { ...req.headers, ...this.headers };
    if (this.cookies) {
      headers.cookie = headers.cookie ? `${headers.cookie}; ${this.cookies}` : this.cookies;
    }
    return { ...req, headers };
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      fields: [
        { key: 'cookies', label: 'Cookie', value: this.cookies ? '••••' : '(空)' },
        { key: 'headers', label: 'Headers', value: Object.keys(this.headers).join(',') || '(空)' },
      ],
      session: { ok: true },
    };
  }
}

/** 工厂 */
export function createProvider(cfg) {
  const p = cfg?.provider || {};
  switch (p.id) {
    case 'generic-header':
      return new GenericHeaderProvider(p);
    case 'ugos':
    default:
      return new UgosProvider({
        alias: p.alias,
        authBase: p.authBase,
        username: p.username,
        password: p.password,
        domainSuffix: p.domainSuffix,
        keepalive: p.keepalive,
      });
  }
}

/** How long a UGREENlink-resolved gateway address is trusted before re-checking. */
const RESOLVE_TTL_MS = 10 * 60 * 1000;
