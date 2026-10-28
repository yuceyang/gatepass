import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { URL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods':
    'GET, POST, PUT, PATCH, DELETE, HEAD, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
};

/**
 * 反向代理引擎。
 * - HTTPS 终结后按路由转发到真实网关（真实 DNS，避开 hosts 自指）
 * - Provider 注入鉴权；上游 302 登录页时重登并重试一次
 * - WebSocket / 流式透传
 */
export class Engine {
  /**
   * @param {{
   *   provider: import('./provider.js').AuthProvider,
   *   routes: import('./routes.js').RouteRegistry,
   *   certs: {key: Buffer|string, cert: Buffer|string},
   *   proxy?: {host?:string, port?:number, insecureUpstreamTls?:boolean},
   *   log?: Function,
   *   onEvent?: (evt:{type:string, [k:string]:any}) => void,
   * }} opts
   */
  constructor(opts) {
    this.provider = opts.provider;
    this.routes = opts.routes;
    this.certs = opts.certs;
    this.proxy = opts.proxy || {};
    this.log = opts.log || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.insecureUpstreamTls = this.proxy.insecureUpstreamTls !== false;

    this.dnsCache = new Map();
    this.upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 128 });

    this.stats = {
      proxied: 0,
      retries: 0,
      authInjected: 0,
      errors: 0,
      bytesIn: 0,
      bytesOut: 0,
      startedAt: Date.now(),
    };

    this.httpsServer = null;
    this.httpServer = null;
    /** @type {Map<string, import('node:http').Server>} proxyPort → 正向代理监听 */
    this.proxyServers = new Map();
  }

  async resolveUpstream(hostname) {
    if (this.dnsCache.has(hostname)) return this.dnsCache.get(hostname);
    const addrs = await dns.resolve4(hostname).catch(() => dns.resolve(hostname));
    const ip = Array.isArray(addrs) ? addrs[0] : addrs;
    this.dnsCache.set(hostname, ip);
    return ip;
  }

  /**
   * The hostname to actually dial for [route].
   *
   * `route.host` is the fixed local name (bookmarks), while the gateway's real suffix moves
   * (cn68 → cn11). When the provider has resolved a live suffix, rewrite the route's upstream
   * to that suffix so the fixed name keeps working without any manual bookkeeping.
   */
  upstreamHostFor(route) {
    // System services (the UGOS desktop on :9443) are not behind the docker port mapping:
    // that mapping forwards plain HTTP, and IIS there speaks TLS only, so it answers
    // "400 The plain HTTP request was sent to HTTPS port". The relay host serves them instead.
    if (route.kind === 'system') {
      const relay = this.provider?.relayHost;
      if (relay) return relay;
    }
    const base = route.upstreamHost || route.host;
    const live = this.provider?.liveSuffix?.();
    const fixed = this.provider?.suffix;
    if (!live || !fixed || live === fixed) return base;
    const at = base.indexOf(fixed);
    if (at < 0 || at + fixed.length !== base.length) return base;
    return base.slice(0, at) + live;
  }

  /** 启动 HTTPS 监听，返回 server */
  async listen(port, host = '127.0.0.1') {
    this.httpsServer = https.createServer({ key: this.certs.key, cert: this.certs.cert }, (req, res) =>
      this.handle(req, res, false)
    );
    this.httpsServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.httpsServer.on('clientError', (err, socket) => {
      this.stats.errors++;
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      void err;
    });
    await new Promise((resolve, reject) => {
      this.httpsServer.once('error', reject);
      this.httpsServer.listen(port, host, resolve);
    });
    this.log(`[engine] HTTPS 监听 ${host}:${port}`);
    return this.httpsServer;
  }

  /** 启动纯 HTTP 监听（不接受自签证书的客户端走这里），返回 server */
  async listenHttp(port, host = '127.0.0.1') {
    this.httpServer = http.createServer((req, res) => this.handle(req, res, true));
    this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.httpServer.on('clientError', (err, socket) => {
      this.stats.errors++;
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      void err;
    });
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, resolve);
    });
    this.log(`[engine] HTTP 监听 ${host}:${port}`);
    return this.httpServer;
  }

  /** 停止所有代理监听（HTTPS + HTTP + 正向代理），控制台不受影响 */
  async stop() {
    if (this.httpsServer) {
      await new Promise((r) => this.httpsServer.close(r));
      this.httpsServer = null;
    }
    if (this.httpServer) {
      await new Promise((r) => this.httpServer.close(r));
      this.httpServer = null;
    }
    for (const [port, server] of this.proxyServers) {
      await new Promise((r) => server.close(r));
      this.proxyServers.delete(port);
    }
    this.log('[engine] 代理监听已停止');
  }

  /** 用当前配置重新监听（应用 httpPort / port 等改动） */
  async restart() {
    await this.stop();
    await this.listen(this.proxy.port, this.proxy.host);
    if (this.proxy.httpPort) {
      await this.listenHttp(this.proxy.httpPort, this.proxy.host);
    }
    await this.syncProxyListeners();
  }

  async close() {
    await this.stop();
    this.upstreamAgent.destroy();
  }

  async handle(req, res, isHttp = false) {
    req._gpIsHttp = isHttp;
    const t0 = Date.now();
    const hostHeader = String(req.headers.host || '');
    const hostname = hostHeader.split(':')[0].toLowerCase();
    const route = this.routes.matchHost(hostname);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      this.emitRequest(req, res, t0, route, 204);
      return;
    }

    if (!route || (isHttp && !route.http)) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        !route
          ? `GatePass: no route for host ${hostname}`
          : `GatePass: HTTP 未启用 for host ${hostname}`
      );
      this.emitRequest(req, res, t0, null, 421);
      return;
    }

    try {
      await this.forward(req, res, route, true, t0);
    } catch (e) {
      this.stats.errors++;
      this.log(`[engine] 转发异常 ${hostname}${req.url}: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(`上游转发失败: ${e.message}`);
      this.emitRequest(req, res, t0, route, 502);
    }
  }

  async forward(req, res, route, allowRetry, t0) {
    const hostname = route.host;
    // upstreamPort 是网关后的应用端口（用于 dockerToken 等），TCP 上游默认连网关 443
    const upstreamConnectPort = Number(route.upstreamConnectPort || 443);

    // Provider 注入鉴权（可能带 query token）。This also resolves the live gateway suffix,
    // so the upstream host must be computed *after* it — otherwise the first request after
    // startup would still dial the stale fixed suffix.
    const injected = await this.provider.applyToRequest(
      { headers: { ...req.headers }, path: req.url },
      route
    );
    const upstreamHost = this.upstreamHostFor(route);
    const realIp = await this.resolveUpstream(upstreamHost);
    const headers = { ...injected.headers };
    headers.host = upstreamHost;
    if (headers.cookie?.includes('ugreen-proxy-token') || headers.authorization) this.stats.authInjected++;
    for (const h of HOP_BY_HOP) delete headers[h];

    const opts = {
      hostname: realIp,
      port: upstreamConnectPort,
      method: req.method,
      path: injected.path || req.url,
      headers,
      agent: this.upstreamAgent,
      servername: upstreamHost,
      rejectUnauthorized: !this.insecureUpstreamTls,
    };

    const upstreamReq = https.request(opts, (upstreamRes) => {
      const loc = upstreamRes.headers.location;
      if (allowRetry && this.provider.isAuthRedirect(upstreamRes.statusCode, loc) && !req._gpRetried) {
        this.stats.retries++;
        this.log(`[engine] 上游 ${upstreamRes.statusCode} 登录跳转，刷新会话重试: ${req.url}`);
        upstreamRes.resume();
        req._gpRetried = true;
        this.provider
          .ensureSession(true)
          .then(() => this.provider.renewGatewayToken(route.host, { force: true }))
          .then(() => this.forward(req, res, route, false, t0))
          .catch((e) => {
            this.log(`[engine] 重登失败: ${e.message}`);
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`重登失败: ${e.message}`);
            this.emitRequest(req, res, t0, route, 502);
          });
        return;
      }

      this.stats.proxied++;
      const outHeaders = { ...upstreamRes.headers, ...CORS_HEADERS };
      // 上游已有更具体的 CORS 时保留其值
      for (const k of Object.keys(CORS_HEADERS)) {
        if (upstreamRes.headers[k]) outHeaders[k] = upstreamRes.headers[k];
      }
      res.writeHead(upstreamRes.statusCode, outHeaders);
      upstreamRes.on('data', (c) => {
        this.stats.bytesOut += c.length;
      });
      upstreamRes.pipe(res);
      res.on('finish', () => this.emitRequest(req, res, t0, route, upstreamRes.statusCode));
    });

    upstreamReq.on('error', (e) => {
      this.stats.errors++;
      this.log(`[engine] 上游错误 ${hostname}: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(`上游错误: ${e.message}`);
      this.emitRequest(req, res, t0, route, 502);
    });

    req.on('data', (c) => {
      this.stats.bytesIn += c.length;
    });
    req.pipe(upstreamReq);
  }

  /** WebSocket 升级透传 */
  async handleUpgrade(req, clientSocket, head) {
    const hostHeader = String(req.headers.host || '');
    const hostname = hostHeader.split(':')[0].toLowerCase();
    const route = this.routes.matchHost(hostname);
    if (!route) {
      clientSocket.destroy();
      return;
    }
    try {
      await this.provider.ensureSession();
      const injected = await this.provider.applyToRequest({ headers: { ...req.headers }, path: req.url }, route);
      const headers = { ...injected.headers };
      const upstreamHost = this.upstreamHostFor(route);
      headers.host = upstreamHost;
      for (const h of HOP_BY_HOP) delete headers[h];

      const realIp = await this.resolveUpstream(upstreamHost);
      const upstream = tls.connect(
        {
          host: realIp,
          port: Number(route.upstreamConnectPort || 443),
          servername: upstreamHost,
          rejectUnauthorized: !this.insecureUpstreamTls,
          agent: this.upstreamAgent,
        },
        () => {
          const lines = [
            `${req.method} ${injected.path || req.url} HTTP/1.1`,
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            '',
            '',
          ].join('\r\n');
          upstream.write(lines);
          if (head?.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        }
      );
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    } catch {
      clientSocket.destroy();
    }
  }

  /** 正向代理：绝对 URL 请求（HTTP 代理），复用 forward 转发到上游代理 */
  forwardProxy(req, res, route) {
    req._gpIsHttp = true;
    this.forward(req, res, route, true, Date.now());
  }

  /** 正向代理：CONNECT 隧道（HTTPS 代理） */
  async handleConnect(req, clientSocket, head, route) {
    req._gpIsHttp = true;
    const t0 = Date.now();
    const hostname = route.host;
    const target = String(req.url || '');
    try {
      await this.provider.ensureSession();
      const injected = await this.provider.applyToRequest(
        { headers: { ...req.headers }, path: req.url },
        route
      );
      const headers = { ...injected.headers };
      const upstreamHost = this.upstreamHostFor(route);
      headers.host = upstreamHost;
      for (const h of HOP_BY_HOP) delete headers[h];

      const realIp = await this.resolveUpstream(upstreamHost);
      const upstream = tls.connect(
        {
          host: realIp,
          port: Number(route.upstreamConnectPort || 443),
          servername: upstreamHost,
          rejectUnauthorized: !this.insecureUpstreamTls,
        },
        () => {
          if (head?.length) clientSocket.unshift(head);
          const lines = [
            `CONNECT ${target} HTTP/1.1`,
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            '',
            '',
          ].join('\r\n');
          upstream.write(lines);

          let buf = Buffer.alloc(0);
          const onData = (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) return;
            upstream.off('data', onData);
            const headText = buf.slice(0, idx).toString('utf8');
            const ok = /^HTTP\/1\.[01]\s+200\b/i.test(headText);
            if (!ok) {
              const code = Number(headText.match(/ (\d{3}) /)?.[1]) || 502;
              clientSocket.write(headText + '\r\n\r\n');
              clientSocket.end();
              upstream.destroy();
              this.emitRequest(req, clientSocket, t0, route, code);
              return;
            }
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const rest = buf.slice(idx + 4);
            if (rest.length) clientSocket.write(rest);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
            this.emitRequest(req, clientSocket, t0, route, 200);
          };
          upstream.on('data', onData);
          upstream.on('error', (e) => {
            this.log(`[engine] CONNECT 上游错误 ${target}: ${e.message}`);
            clientSocket.destroy();
          });
          upstream.on('close', () => {
            this.log(`[engine] CONNECT 上游关闭 ${target}`);
            clientSocket.destroy();
          });
          clientSocket.on('error', (e) => {
            this.log(`[engine] CONNECT 客户端错误 ${target}: ${e.message}`);
            upstream.destroy();
          });
          clientSocket.on('close', () => {
            this.log(`[engine] CONNECT 客户端关闭 ${target}`);
            upstream.destroy();
          });
          this.log(`[engine] CONNECT 隧道建立 ${target}`);
        }
      );
      upstream.on('error', () => clientSocket.destroy());
    } catch (e) {
      this.stats.errors++;
      this.log(`[engine] CONNECT ${target} 失败: ${e.message}`);
      if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      this.emitRequest(req, clientSocket, t0, route, 502);
    }
  }

  /** 按当前路由表同步正向代理监听（代理路由增删改后调用） */
  async syncProxyListeners() {
    const host = this.proxy.host || '127.0.0.1';
    const wanted = new Map();
    for (const r of this.routes.list()) {
      if (r.enabled && r.proxy && r.proxyPort) wanted.set(String(r.proxyPort), r);
    }
    // 关闭不再需要的
    for (const [port, server] of this.proxyServers) {
      if (!wanted.has(port)) {
        await new Promise((res) => server.close(res));
        this.proxyServers.delete(port);
        this.log(`[engine] 关闭正向代理监听 ${host}:${port}`);
      }
    }
    // 打开新增的
    for (const [port, route] of wanted) {
      if (this.proxyServers.has(port)) continue;
      const server = http.createServer((req, res) => this.forwardProxy(req, res, route));
      server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head, route));
      server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        void err;
      });
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(Number(port), host, resolve);
        });
        this.proxyServers.set(port, server);
        this.log(`[engine] 正向代理监听 http://${host}:${port} → ${route.host}`);
      } catch (e) {
        this.log(`[engine] 正向代理 ${host}:${port} 监听失败: ${e.message}`);
      }
    }
  }

  emitRequest(req, res, t0, route, status) {
    const durationMs = Date.now() - t0;
    const hostHeader = String(req.headers.host || '');
    const host = hostHeader.split(':')[0];
    const proto = req._gpIsHttp ? 'http' : 'https';
    const url =
      req.method === 'CONNECT'
        ? `${proto}://${hostHeader}` // CONNECT 的目标就是 host:port
        : `${proto}://${hostHeader}${req.url}`;
    this.onEvent({
      type: 'request',
      ts: Date.now(),
      method: req.method,
      path: req.url,
      host,
      url,
      proto,
      routeId: route?.id || null,
      status,
      durationMs,
    });
    void res;
  }
}
