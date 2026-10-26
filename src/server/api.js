import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTermux, termuxIntegrationNotice } from '../system/termux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * 环形缓冲 + WS 广播的实时请求日志。
 */
export class LiveLog {
  constructor(size = 2000) {
    this.size = size;
    this.buf = [];
    this.sockets = new Set();
  }

  push(evt) {
    this.buf.push(evt);
    if (this.buf.length > this.size) this.buf.splice(0, this.buf.length - this.size);
    const data = JSON.stringify({ type: 'log', ...evt });
    for (const ws of this.sockets) {
      try {
        ws.send(data);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  recent(limit = 200) {
    return this.buf.slice(-limit);
  }

  clear() {
    this.buf = [];
  }

  attach(socket) {
    this.sockets.add(socket);
    // 延后发 hello，确保客户端已挂好 data 监听
    setImmediate(() => {
      try {
        socket.send(JSON.stringify({ type: 'hello', count: this.buf.length }));
      } catch {
        /* socket gone */
      }
    });
  }

  detach(socket) {
    this.sockets.delete(socket);
  }
}

/** 极简 WebSocket（RFC6455 文本帧）服务端，足够控制台日志推送 */
function attachWebSocketUpgrade(server, liveLog) {
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const ws = makeWsWrapper(socket);
    liveLog.attach(ws);
    socket.on('close', () => liveLog.detach(ws));
    socket.on('error', () => liveLog.detach(ws));
    socket.on('data', (buf) => {
      // 忽略客户端帧（含 ping/pong 关闭）；收到 close 则断开
      if (buf.length > 1 && (buf[0] & 0x0f) === 0x8) socket.destroy();
    });
  });
}

function makeWsWrapper(socket) {
  return {
    send(text) {
      const payload = Buffer.from(String(text), 'utf8');
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(payload.length, 6);
      }
      try {
        socket.write(Buffer.concat([header, payload]));
      } catch {
        /* socket gone */
      }
    },
  };
}

/**
 * 控制台 HTTP 服务：REST API + 静态前端 + WS 日志。
 *
 * @param {{
 *   provider: any,
 *   routes: any,
 *   live: LiveLog,
 *   config: object,
 *   saveConfig: (cfg:object)=>void,
 *   engine: any,
 *   certs: {caPath:string, certPath:string},
 *   log?: Function,
 * }} deps
 */
export function createConsoleServer(deps) {
  const { provider, routes, live, config, saveConfig, engine, certs, log = () => {} } = deps;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    // CORS（本地控制台）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (p === '/api/status' && req.method === 'GET') {
        return json(res, 200, {
          engine: {
            ...engine?.stats,
            listening: !!engine?.httpsServer?.listening,
            httpListening: !!engine?.httpServer?.listening,
            proxyPorts: [...(engine?.proxyServers?.keys() || [])],
          },
          provider: provider.describe(),
          routes: routes.list().length,
          routesEnabled: routes.list().filter((r) => r.enabled).length,
          routesHttp: routes.list().filter((r) => r.enabled && r.http).length,
          liveBuffered: live.recent(100000).length,
          console: config.console,
          proxy: config.proxy,
          platform: {
            termux: isTermux(),
            hostsSupported: !isTermux(),
            systemCaSupported: !isTermux(),
            autostartSupported: !isTermux(),
            integrationNotice: isTermux() ? termuxIntegrationNotice() : null,
          },
          onboardingDone: !!config.onboardingDone,
        });
      }

      if (p === '/api/routes' && req.method === 'GET') {
        return json(res, 200, routes.list());
      }

      if (p === '/api/routes' && req.method === 'POST') {
        const body = await readJson(req);
        const r = routes.add(body);
        persistRoutes();
        await engine.syncProxyListeners();
        const hs = await syncHostsAfterChange(routes);
        return json(res, 201, { ...r, _hosts: hs });
      }

      const m = p.match(/^\/api\/routes\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const r = routes.get(m[1]);
        return r ? json(res, 200, r) : json(res, 404, { error: 'not found' });
      }
      if (m && (req.method === 'PUT' || req.method === 'PATCH')) {
        const body = await readJson(req);
        const r = routes.update(m[1], body);
        persistRoutes();
        await engine.syncProxyListeners();
        const hs = await syncHostsAfterChange(routes);
        return json(res, 200, { ...r, _hosts: hs });
      }
      if (m && req.method === 'DELETE') {
        const ok = routes.remove(m[1]);
        persistRoutes();
        await engine.syncProxyListeners();
        const hs = await syncHostsAfterChange(routes);
        return json(res, ok ? 200 : 404, { ok, _hosts: hs });
      }

      const m2 = p.match(/^\/api\/routes\/([^/]+)\/test$/);
      if (m2 && req.method === 'POST') {
        const r = routes.get(m2[1]);
        if (!r) return json(res, 404, { error: 'not found' });
        const result = await testRoute(r, provider);
        return json(res, 200, result);
      }

      if (p === '/api/logs' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 200);
        return json(res, 200, live.recent(limit));
      }
      if (p === '/api/logs' && req.method === 'DELETE') {
        live.clear();
        return json(res, 200, { ok: true });
      }

      if (p === '/api/settings' && req.method === 'GET') {
        return json(res, 200, {
          provider: { ...config.provider, password: config.provider?.password ? '••••••' : '' },
          proxy: config.proxy,
          console: config.console,
          onboardingDone: !!config.onboardingDone,
        });
      }
      if (p === '/api/settings' && req.method === 'PUT') {
        const body = await readJson(req);
        if (body.provider) {
          // 密码留空表示不改
          if (body.provider.password === '••••••' || body.provider.password === undefined) {
            delete body.provider.password;
          }
          Object.assign(config.provider, body.provider);
        }
        if (body.proxy) Object.assign(config.proxy, body.proxy);
        if (body.onboardingDone !== undefined) config.onboardingDone = !!body.onboardingDone;
        saveConfig(config);
        // Push the edit into the running provider, otherwise it keeps the credentials it was
        // constructed with and every request fails until the process restarts.
        provider.applyConfig?.(config.provider);
        return json(res, 200, { ok: true });
      }

      // 可移植配置：与 Android / iOS 客户端共用的 JSON
      if (p === '/api/config/export' && req.method === 'GET') {
        const { toPortable } = await import('../core/portable.js');
        const includePassword = url.searchParams.get('password') !== '0';
        const portable = toPortable(
          { provider: config.provider, routes: routes.list() },
          { includePassword },
        );
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="gatepass-config${includePassword ? '' : '-nopass'}.json"`,
        });
        res.end(JSON.stringify(portable, null, 2) + '\n');
        return;
      }
      if (p === '/api/config/import' && req.method === 'POST') {
        const body = await readJson(req);
        const { parsePortable } = await import('../core/portable.js');
        // Accept either a JSON document or the raw text of one.
        const parsed = parsePortable(typeof body === 'string' ? body : JSON.stringify(body.portable ?? body));
        // A password-less export (or one from another device) must not wipe the password
        // already stored here — that would silently break the session.
        const incoming = { ...parsed.provider };
        if (!parsed.hasPassword) delete incoming.password;
        Object.assign(config.provider, incoming);
        // Rebuild through the registry so upstreamPort is inferred consistently.
        const result = routes.replaceAll(parsed.routes);
        config.routes = routes.list();
        saveConfig(config);
        provider.applyConfig?.(config.provider);
        return json(res, 200, {
          ok: true,
          routes: config.routes.length,
          skipped: result.skipped,
        });
      }

      if (p === '/api/hosts' && req.method === 'GET') {
        const hostsMod = await import('../system/hosts.js');
        return json(res, 200, { block: hostsMod.readHostsBlock() });
      }
      if (p === '/api/hosts/sync' && req.method === 'POST') {
        const hostsMod = await import('../system/hosts.js');
        const entries = routes.hostsEntries();
        const result = hostsMod.writeHostsBlock(entries);
        if (result.supported === false) return json(res, 409, { ...result, error: result.reason, hostsSynced: false, hostsHint: result.reason });
        await hostsMod.flushDns();
        return json(res, 200, result);
      }
      if (p === '/api/hosts/sync-elevated' && req.method === 'POST') {
        const hostsMod = await import('../system/hosts.js');
        const autostartMod = await import('../system/autostart.js');
        const entries = routes.hostsEntries();
        const cmd = hostsMod.elevatedWriteCommand(entries);
        if (cmd.supported === false) return json(res, 409, { ok: false, supported: false, error: cmd.note, note: cmd.note });
        const blockText = cmd.script || '';
        const wrap = await autostartMod.tryElevatedHostsWrite(blockText.match(/# gatepass begin[\s\S]*?# gatepass end/)?.[0] || '');
        if (wrap.ok && process.platform === 'win32') {
          autostartMod.launchElevatedHostsScript(wrap.script);
        }
        return json(res, 200, { ...wrap, manualCommand: `${cmd.command} ${cmd.args.join(' ')}`, manualNote: cmd.note });
      }

      if (p === '/api/engine/restart' && req.method === 'POST') {
        await engine.restart();
        return json(res, 200, {
          ok: true,
          listening: !!engine.httpsServer?.listening,
          httpListening: !!engine.httpServer?.listening,
        });
      }
      if (p === '/api/engine/stop' && req.method === 'POST') {
        await engine.stop();
        return json(res, 200, { ok: true, listening: false, httpListening: false });
      }

      if (p === '/api/hosts/restore' && req.method === 'POST') {
        const hostsMod = await import('../system/hosts.js');
        const result = hostsMod.removeHostsBlock();
        if (result.supported === false) return json(res, 409, { ...result, ok: false, error: result.reason });
        await hostsMod.flushDns().catch(() => {});
        return json(res, 200, { ok: true, ...result });
      }

      if (p === '/api/autostart' && req.method === 'GET') {
        const mod = await import('../system/autostart.js');
        return json(res, 200, {
          installed: mod.isAutostartInstalled(),
          supported: !isTermux(),
          note: isTermux() ? mod.autostartPaths().note : null,
          paths: mod.autostartPaths(),
          platform: isTermux() ? 'android-termux' : process.platform,
        });
      }
      if (p === '/api/autostart' && req.method === 'POST') {
        const mod = await import('../system/autostart.js');
        const body = await readJson(req);
        const r = body.action === 'remove' ? await mod.removeAutostart() : await mod.installAutostart();
        return json(res, 200, r);
      }

      // 可选：443 → 本程序端口 的系统转发（透明访问，会占用 443）
      if (p === '/api/portproxy' && req.method === 'GET') {
        const mod = await import('../system/portproxy.js');
        const { commonPortWarning } = await import('../system/certtrust.js');
        return json(res, 200, {
          ...(await mod.getPortProxyStatus()),
          proxyPort: config.proxy.port,
          warning: commonPortWarning(443) || '启用后 https://app-… 可不带端口访问，但会占用 443',
        });
      }
      if (p === '/api/portproxy' && req.method === 'POST') {
        if (isTermux()) {
          return json(res, 409, { supported: false, error: 'Termux 不支持 Windows netsh 端口转发。' });
        }
        const mod = await import('../system/portproxy.js');
        const body = await readJson(req);
        const r = body.action === 'remove'
          ? await mod.removePortProxy()
          : await mod.installPortProxy(config.proxy.port);
        return json(res, 200, r);
      }

      if (p === '/api/ca' && req.method === 'GET') {
        // 提供 CA 下载
        const buf = fs.readFileSync(certs.caPath);
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="gatepass-ca.crt"',
        });
        res.end(buf);
        return;
      }

      // 静态前端
      return serveStatic(res, p);
    } catch (e) {
      log(`[console] ${req.method} ${p} 错误: ${e.message}`);
      return json(res, 400, { error: e.message });
    }
  });

  function persistRoutes() {
    config.routes = routes.list();
    saveConfig(config);
  }

  attachWebSocketUpgrade(server, live);
  return server;
}

async function testRoute(route, provider) {
  try {
    await provider.ensureSession();
    await provider.renewGatewayToken(route.host).catch(() => null);
    const https = await import('node:https');
    const dns = await import('node:dns/promises');
    const addrs = await dns.resolve4(route.upstreamHost || route.host).catch(() => []);
    const ip = addrs[0];
    if (!ip) return { ok: false, error: 'DNS 解析失败' };
    // 与代理一致：注入鉴权后再探测，否则网关 302
    const injected = await provider.applyToRequest(
      { headers: { host: route.host }, path: '/' },
      route
    );
    const headers = { ...injected.headers, host: route.upstreamHost || route.host };
    return await new Promise((resolve) => {
      const req = https.request(
        {
          host: ip,
          servername: route.upstreamHost || route.host,
          // TCP 上游连网关 443；upstreamPort 是网关后的应用端口
          port: Number(route.upstreamConnectPort || 443),
          path: '/',
          method: 'GET',
          rejectUnauthorized: false,
          headers,
        },
        (res) => {
          res.resume();
          const loc = res.headers.location || null;
          const authRedirect = provider.isAuthRedirect(res.statusCode, loc);
          resolve({
            ok: res.statusCode < 400 || res.statusCode === 401 || res.statusCode === 404,
            status: res.statusCode,
            location: loc,
            authRedirect,
            note: authRedirect ? '仍被重定向到登录页，鉴权可能未生效' : undefined,
          });
        }
      );
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
      req.end();
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 路由变更后同步 hosts，未提权则自动弹 UAC；UAC 失败走任务计划兜底 */
async function syncHostsAfterChange(routes) {
  const entries = routes.hostsEntries();
  if (!entries.length) return { hostsSynced: true, hostsChanged: false };
  try {
    const hostsMod = await import('../system/hosts.js');
    const result = hostsMod.writeHostsBlock(entries);
    if (result.supported === false) {
      return { hostsSynced: false, hostsHint: result.reason };
    }
    await hostsMod.flushDns().catch(() => {});
    return { hostsSynced: true, hostsChanged: result.changed, hostsPath: result.path };
  } catch (e1) {
    if (process.platform === 'win32') {
      const { runElevatedPowerShell, runViaScheduledTask } = await import('../system/elevate.js');
      const hostsMod = await import('../system/hosts.js');
      const cmdObj = hostsMod.elevatedWriteCommand(entries);
      const r1 = runElevatedPowerShell(cmdObj.script);
      // 任务计划兜底（UAC 静默失败时仍可能写入）
      let r2 = null;
      try {
        r2 = await runViaScheduledTask(cmdObj.script);
      } catch {
        r2 = null;
      }
      return {
        hostsSynced: false,
        hostsElevating: true,
        hostsHint:
          (r1.note || '') +
          (r2?.ok ? '；已同时通过任务计划尝试写入。' : '') +
          ' 若 UAC 未弹出且稍后 hosts 未生效，请点「复制命令」用管理员 PowerShell 执行。',
        manualCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File "${r1.script}"`,
      };
    }
    return {
      hostsSynced: false,
      hostsError: e1.message,
      hostsHint: 'hosts 需要管理员权限，请用 sudo 运行 gatepass sync-hosts',
    };
  }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, p) {
  let rel = p === '/' ? '/index.html' : p;
  rel = rel.replace(/\.\./g, '');
  const file = path.join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    const idx = path.join(WEB_ROOT, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(idx));
      return;
    }
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}
