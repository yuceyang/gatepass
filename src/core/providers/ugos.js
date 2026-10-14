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

  async _login() {
    if (!this.username || !this.password) throw new Error('未配置账号密码');
    this.stats.logins++;

    const checkRes = await fetch(`${this.authBase}/ugreen/v1/verify/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'UG-Agent': 'PC/WEB', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ username: this.username }),
    });
    const publicKeyPem = decodePublicKeyPem(checkRes.headers.get('x-rsa-token'));
    const encPassword = rsaEncryptWithPem(publicKeyPem, this.password);

    const loginRes = await fetch(`${this.authBase}/ugreen/v1/verify/login`, {
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
    const url = `${this.authBase}/ugreen/v1/gateway/proxy/dockerToken?port=${encodeURIComponent(port)}&token=${encodeURIComponent(this.session.token)}`;
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
        authBase: p.authBase,
        username: p.username,
        password: p.password,
        keepalive: p.keepalive,
      });
  }
}
