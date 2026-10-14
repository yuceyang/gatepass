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
  }

  async resolveUpstream(hostname) {
    if (this.dnsCache.has(hostname)) return this.dnsCache.get(hostname);
    const addrs = await dns.resolve4(hostname).catch(() => dns.resolve(hostname));
    const ip = Array.isArray(addrs) ? addrs[0] : addrs;
    this.dnsCache.set(hostname, ip);
    return ip;
  }

  /** 启动 HTTPS 监听，返回 server */
  async listen(port, host = '127.0.0.1') {
    this.httpsServer = https.createServer({ key: this.certs.key, cert: this.certs.cert }, (req, res) =>
      this.handle(req, res)
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

  async close() {
    if (this.httpsServer) await new Promise((r) => this.httpsServer.close(r));
    this.upstreamAgent.destroy();
  }

  async handle(req, res) {
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

    if (!route) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`GatePass: no route for host ${hostname}`);
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
    const realIp = await this.resolveUpstream(route.upstreamHost || hostname);
    // upstreamPort 是网关后的应用端口（用于 dockerToken 等），TCP 上游默认连网关 443
    const upstreamConnectPort = Number(route.upstreamConnectPort || 443);

    // Provider 注入鉴权（可能带 query token）
    const injected = await this.provider.applyToRequest(
      { headers: { ...req.headers }, path: req.url },
      route
    );
    const headers = { ...injected.headers };
    headers.host = route.upstreamHost || hostname;
    if (headers.cookie?.includes('ugreen-proxy-token') || headers.authorization) this.stats.authInjected++;
    for (const h of HOP_BY_HOP) delete headers[h];

    const opts = {
      hostname: realIp,
      port: upstreamConnectPort,
      method: req.method,
      path: injected.path || req.url,
      headers,
      agent: this.upstreamAgent,
      servername: route.upstreamHost || hostname,
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
      headers.host = route.upstreamHost || hostname;
      for (const h of HOP_BY_HOP) delete headers[h];

      const realIp = await this.resolveUpstream(route.upstreamHost || hostname);
      const upstream = tls.connect(
        {
          host: realIp,
          port: Number(route.upstreamConnectPort || 443),
          servername: route.upstreamHost || hostname,
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

  emitRequest(req, res, t0, route, status) {
    const durationMs = Date.now() - t0;
    const host = String(req.headers.host || '').split(':')[0];
    this.onEvent({
      type: 'request',
      ts: Date.now(),
      method: req.method,
      path: req.url,
      host,
      routeId: route?.id || null,
      status,
      durationMs,
    });
    void res;
  }
}
