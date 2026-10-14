import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * 鐜舰缂撳啿 + WS 骞挎挱鐨勫疄鏃惰姹傛棩蹇椼€? */
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
    // 寤跺悗鍙?hello锛岀‘淇濆鎴风宸叉寕濂?data 鐩戝惉
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

/** 鏋佺畝 WebSocket锛圧FC6455 鏂囨湰甯э級鏈嶅姟绔紝瓒冲鎺у埗鍙版棩蹇楁帹閫?*/
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
      // 蹇界暐瀹㈡埛绔抚锛堝惈 ping/pong 鍏抽棴锛夛紱鏀跺埌 close 鍒欐柇寮€
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
 * 鎺у埗鍙?HTTP 鏈嶅姟锛歊EST API + 闈欐€佸墠绔?+ WS 鏃ュ織銆? *
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

    // CORS锛堟湰鍦版帶鍒跺彴锛?    res.setHeader('Access-Control-Allow-Origin', '*');
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
          engine: { ...engine?.stats, listening: !!engine?.httpsServer?.listening },
          provider: provider.describe(),
          routes: routes.list().length,
          routesEnabled: routes.list().filter((r) => r.enabled).length,
          liveBuffered: live.recent(100000).length,
          console: config.console,
          proxy: config.proxy,
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
        const hs = await syncHostsAfterChange(routes);
        return json(res, 200, { ...r, _hosts: hs });
      }
      if (m && req.method === 'DELETE') {
        const ok = routes.remove(m[1]);
        persistRoutes();
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
          provider: { ...config.provider, password: config.provider?.password ? '鈥⑩€⑩€⑩€⑩€⑩€? : '' },
          proxy: config.proxy,
          console: config.console,
          onboardingDone: !!config.onboardingDone,
        });
      }
      if (p === '/api/settings' && req.method === 'PUT') {
        const body = await readJson(req);
        if (body.provider) {
          // 瀵嗙爜鐣欑┖琛ㄧず涓嶆敼
          if (body.provider.password === '鈥⑩€⑩€⑩€⑩€⑩€? || body.provider.password === undefined) {
            delete body.provider.password;
          }
          Object.assign(config.provider, body.provider);
        }
        if (body.proxy) Object.assign(config.proxy, body.proxy);
        if (body.onboardingDone !== undefined) config.onboardingDone = !!body.onboardingDone;
        saveConfig(config);
        return json(res, 200, { ok: true });
      }

      if (p === '/api/hosts' && req.method === 'GET') {
        const hostsMod = await import('../system/hosts.js');
        return json(res, 200, { block: hostsMod.readHostsBlock() });
      }
      if (p === '/api/hosts/sync' && req.method === 'POST') {
        const hostsMod = await import('../system/hosts.js');
        const entries = routes.hostsEntries();
        const result = hostsMod.writeHostsBlock(entries);
        await hostsMod.flushDns();
        return json(res, 200, result);
      }
      if (p === '/api/hosts/sync-elevated' && req.method === 'POST') {
        const hostsMod = await import('../system/hosts.js');
        const autostartMod = await import('../system/autostart.js');
        const entries = routes.hostsEntries();
        const cmd = hostsMod.elevatedWriteCommand(entries);
        const blockText = cmd.script || '';
        const wrap = await autostartMod.tryElevatedHostsWrite(blockText.match(/# gatepass begin[\s\S]*?# gatepass end/)?.[0] || '');
        if (wrap.ok && process.platform === 'win32') {
          autostartMod.launchElevatedHostsScript(wrap.script);
        }
        return json(res, 200, { ...wrap, manualCommand: `${cmd.command} ${cmd.args.join(' ')}`, manualNote: cmd.note });
      }

      if (p === '/api/autostart' && req.method === 'GET') {
        const mod = await import('../system/autostart.js');
        return json(res, 200, {
          installed: mod.isAutostartInstalled(),
          paths: mod.autostartPaths(),
          platform: process.platform,
        });
      }
      if (p === '/api/autostart' && req.method === 'POST') {
        const mod = await import('../system/autostart.js');
        const body = await readJson(req);
        const r = body.action === 'remove' ? await mod.removeAutostart() : await mod.installAutostart();
        return json(res, 200, r);
      }

      if (p === '/api/ca' && req.method === 'GET') {
        // 鎻愪緵 CA 涓嬭浇
        const buf = fs.readFileSync(certs.caPath);
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="gatepass-ca.crt"',
        });
        res.end(buf);
        return;
      }

      // 闈欐€佸墠绔?      return serveStatic(res, p);
    } catch (e) {
      log(`[console] ${req.method} ${p} 閿欒: ${e.message}`);
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
    if (!ip) return { ok: false, error: 'DNS 瑙ｆ瀽澶辫触' };
    // 涓庝唬鐞嗕竴鑷达細娉ㄥ叆閴存潈鍚庡啀鎺㈡祴锛屽惁鍒欑綉鍏?302
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
          // TCP 涓婃父杩炵綉鍏?443锛泆pstreamPort 鏄綉鍏冲悗鐨勫簲鐢ㄧ鍙?          port: Number(route.upstreamConnectPort || 443),
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
            note: authRedirect ? '浠嶈閲嶅畾鍚戝埌鐧诲綍椤碉紝閴存潈鍙兘鏈敓鏁? : undefined,
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

/** 璺敱鍙樻洿鍚庡悓姝?hosts锛屾湭鎻愭潈鍒欒嚜鍔ㄥ脊 UAC */
async function syncHostsAfterChange(routes) {
  const entries = routes.hostsEntries();
  if (!entries.length) return { hostsSynced: true, hostsChanged: false };
  try {
    const hostsMod = await import('../system/hosts.js');
    const result = hostsMod.writeHostsBlock(entries);
    await hostsMod.flushDns().catch(() => {});
    return { hostsSynced: true, hostsChanged: result.changed, hostsPath: result.path };
  } catch {
    // 鏃犳潈闄愶細鑷姩璇锋眰 UAC 鍐欏叆锛岀敤鎴峰彧鐐广€屾槸銆?    if (process.platform === 'win32') {
      const { runElevatedPowerShell } = await import('../system/elevate.js');
      const hostsMod = await import('../system/hosts.js');
      const cmdObj = hostsMod.elevatedWriteCommand(entries);
      const r = runElevatedPowerShell(cmdObj.script);
      return {
        hostsSynced: false,
        hostsElevating: true,
        hostsHint: r.note + '銆傚畬鎴愬悗鍒锋柊椤甸潰鍗冲彲銆?,
      };
    }
    return {
      hostsSynced: false,
      hostsHint: 'hosts 闇€瑕佺鐞嗗憳鏉冮檺锛岃鐢?sudo 杩愯 gatepass sync-hosts',
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
        reject(new Error('JSON 瑙ｆ瀽澶辫触'));
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
