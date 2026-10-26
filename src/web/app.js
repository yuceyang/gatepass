/* GatePass 控制台前端（无构建） */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let ws = null;
let routeEditingId = null;
let httpPort = null;

// ---------- 页面切换 ----------
$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.page').forEach((p) => p.classList.remove('active'));
    $('#page-' + btn.dataset.page).classList.add('active');
    if (btn.dataset.page === 'routes') loadRoutes();
    if (btn.dataset.page === 'settings') loadSettings();
    if (btn.dataset.page === 'overview') loadStatus();
  });
});

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- 总览 ----------
async function loadStatus() {
  try {
    const s = await api('/api/status');
    httpPort = s.proxy?.httpPort || null;
    const p = s.provider || {};
    const sess = p.session || {};
    const cards = [
      { k: 'HTTPS 代理', v: s.engine?.listening ? `${s.proxy?.host}:${s.proxy?.port}` : '未监听', cls: s.engine?.listening ? 'ok' : 'err' },
      { k: 'HTTP 代理', v: s.engine?.httpListening ? `${s.proxy?.host}:${s.proxy?.httpPort}` : (s.proxy?.httpPort ? '未监听' : '未开启'), cls: s.engine?.httpListening ? 'ok' : '' },
      { k: '会话状态', v: sess.ok ? '已登录' : '未登录', cls: sess.ok ? 'ok' : 'err' },
      { k: '路由数', v: `${s.routesEnabled}/${s.routes} 启用`, cls: '' },
      { k: 'HTTP 路由', v: `${s.routesHttp ?? 0} 个`, cls: (s.routesHttp || 0) > 0 ? 'ok' : '' },
      { k: '已代理请求', v: s.engine?.proxied ?? 0, cls: '' },
      { k: '重登次数', v: s.engine?.retries ?? 0, cls: (s.engine?.retries || 0) > 0 ? 'warn' : '' },
      { k: '错误数', v: s.engine?.errors ?? 0, cls: (s.engine?.errors || 0) > 0 ? 'err' : 'ok' },
    ];
    $('#status-cards').innerHTML = cards
      .map((c) => `<div class="card"><div class="k">${c.k}</div><div class="v ${c.cls}">${c.v}</div></div>`)
      .join('');

    // A bare "未登录" hides the common cause: credentials never configured.
    const readiness = p.readiness || {};
    if (readiness.ok === false) {
      const hint = document.getElementById('provider-readiness');
      if (hint) {
        hint.textContent = `⚠ ${readiness.reason}`;
        hint.style.display = '';
      }
    } else {
      const hint = document.getElementById('provider-readiness');
      if (hint) hint.style.display = 'none';
    }
    const httpLine = s.proxy?.httpPort
      ? `  |  HTTP http://${s.proxy?.host}:${s.proxy?.httpPort}`
      : '  |  HTTP 未开启（在设置里配置 httpPort）';
    $('#engine-hint').textContent =
      `控制台 http://${s.console?.host}:${s.console?.port}  |  HTTPS https://${s.proxy?.host}:${s.proxy?.port}${httpLine}`;
  } catch (e) {
    $('#status-cards').innerHTML = `<div class="card"><div class="k">错误</div><div class="v err">${e.message}</div></div>`;
  }
}

// ---------- 路由 ----------
async function loadRoutes() {
  const list = await api('/api/routes');
  const tb = $('#route-table tbody');
  tb.innerHTML = list
    .map(
      (r) => `
    <tr data-id="${r.id}">
      <td>${esc(r.host)}${r.proxy ? `<div class="hint" style="margin-top:2px">代理 http://127.0.0.1:${esc(r.proxyPort)}</div>` : ''}</td>
      <td>${esc(r.upstreamHost || r.host)}:${esc(r.upstreamPort)}</td>
      <td><span class="badge">${esc(r.providerId)}</span></td>
      <td>${r.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>'}</td>
      <td>${r.http ? `<span class="badge ok" title="http://${esc(r.host)}:${httpPort || '?'}">纯HTTP</span>` : '<span class="badge">—</span>'}</td>
      <td class="test-cell">—</td>
      <td>
        <button data-act="test">测试</button>
        <button data-act="edit">编辑</button>
        <button data-act="toggle">${r.enabled ? '停用' : '启用'}</button>
        <button data-act="http">${r.http ? '关HTTP' : '开HTTP'}</button>
        <button data-act="del" class="danger">删除</button>
      </td>
    </tr>`
    )
    .join('');

  tb.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async () => {
      const tr = b.closest('tr');
      const id = tr.dataset.id;
      const act = b.dataset.act;
      try {
        if (act === 'edit') {
          const r = await api('/api/routes/' + id);
          showRouteForm(r);
        } else if (act === 'del') {
          if (confirm('删除该路由？')) {
            await api('/api/routes/' + id, { method: 'DELETE' });
            loadRoutes();
          }
        } else if (act === 'toggle') {
          const r = list.find((x) => x.id === id);
          await api('/api/routes/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) });
          loadRoutes();
        } else if (act === 'http') {
          const r = list.find((x) => x.id === id);
          await api('/api/routes/' + id, { method: 'PATCH', body: JSON.stringify({ http: !r.http }) });
          loadRoutes();
        } else if (act === 'test') {
          const cell = tr.querySelector('.test-cell');
          cell.textContent = '测试中…';
          const res = await api(`/api/routes/${id}/test`, { method: 'POST' });
          cell.innerHTML = testBadge(res);
          if (res.authRedirect) {
            alert('测试返回登录跳转：鉴权未生效（会话可能过期）。请在设置里检查账号，或点总览看会话状态。');
          }
        }
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

function updateProxyWarn() {
  const warn = $('#proxy-warn');
  if (!warn) return;
  warn.style.display = $('#route-form').proxy?.checked ? '' : 'none';
}

function showRouteForm(r = null) {
  routeEditingId = r?.id || null;
  $('#route-form-title').textContent = r ? '编辑路由' : '添加路由';
  const f = $('#route-form');
  f.host.value = r?.host || '';
  f.upstreamPort.value = r?.upstreamPort || '';
  f.upstreamHost.value = r?.upstreamHost || '';
  f.providerId.value = r?.providerId || 'ugos';
  f.note.value = r?.note || '';
  f.enabled.checked = r?.enabled !== false;
  f.http.checked = r?.http === true;
  f.proxy.checked = r?.proxy === true;
  f.proxyPort.value = r?.proxyPort || '';
  updateProxyWarn();
  $('#route-form-panel').classList.remove('hidden');
}

$('#btn-add-route').addEventListener('click', () => showRouteForm());
$('#btn-cancel-route').addEventListener('click', () => $('#route-form-panel').classList.add('hidden'));
$('#route-form [name=proxy]')?.addEventListener('change', updateProxyWarn);

$('#route-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    host: f.host.value.trim(),
    upstreamPort: f.upstreamPort.value.trim() || undefined,
    upstreamHost: f.upstreamHost.value.trim() || undefined,
    providerId: f.providerId.value,
    note: f.note.value.trim(),
    enabled: f.enabled.checked,
    http: f.http.checked,
    proxy: f.proxy.checked,
    proxyPort: f.proxyPort.value.trim() || undefined,
  };
  try {
    let saved;
    if (routeEditingId) {
      saved = await api('/api/routes/' + routeEditingId, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      saved = await api('/api/routes', { method: 'POST', body: JSON.stringify(body) });
    }
    $('#route-form-panel').classList.add('hidden');
    if (saved && saved._hosts && saved._hosts.hostsElevating) {
      const msg = (saved._hosts.hostsHint || '正在请求管理员权限写入 hosts。') +
        (saved._hosts.manualCommand ? '\n\n若 UAC 未弹出，复制下面命令用管理员 PowerShell 执行：\n' + saved._hosts.manualCommand : '');
      alert(msg);
    } else if (saved && saved._hosts && saved._hosts.hostsSynced === false) {
      alert('路由已保存，但 hosts 同步失败：' + (saved._hosts.hostsError || saved._hosts.hostsHint || ''));
    }
    loadRoutes();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 日志 ----------
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}
function statusClass(s) {
  if (s >= 500) return 's5xx';
  if (s >= 400) return 's4xx';
  if (s >= 300) return 's3xx';
  return 's2xx';
}
function logRow(e, small = false) {
  if (small) {
    const url = e.url || `${e.proto || 'https'}://${e.host}${e.path}`;
    return `<tr><td>${fmtTime(e.ts)}</td><td>${e.method}</td><td class="url" title="${esc(url)}">${esc(url)}</td><td class="${statusClass(e.status)}">${e.status}</td><td>${e.durationMs}ms</td></tr>`;
  }
  return `<tr><td>${fmtTime(e.ts)}</td><td>${e.method}</td><td>${esc(e.host)}</td><td>${esc(e.path)}</td><td class="${statusClass(e.status)}">${e.status}</td><td>${e.durationMs}ms</td></tr>`;
}

const logBuffer = [];
function pushLog(e) {
  logBuffer.push(e);
  if (logBuffer.length > 2000) logBuffer.splice(0, logBuffer.length - 2000);
  const f = $('#log-filter').value.trim().toLowerCase();
  const tb = $('#log-table tbody');
  const row = document.createElement('tbody');
  row.innerHTML = logRow(e);
  const tr = row.firstElementChild;
  if (!f || (e.host + e.path).toLowerCase().includes(f)) {
    // 最新在最上面
    tb.prepend(tr);
    while (tb.children.length > 500) tb.removeChild(tb.lastChild);
  }
  const recent = $('#recent-logs');
  const rbody = document.createElement('tbody');
  rbody.innerHTML = logRow(e, true);
  recent.prepend(rbody.firstElementChild);
  while (recent.children.length > 50) recent.removeChild(recent.lastChild);
}

$('#btn-clear-logs').addEventListener('click', async () => {
  await api('/api/logs', { method: 'DELETE' });
  logBuffer.length = 0;
  $('#log-table tbody').innerHTML = '';
  $('#recent-logs').innerHTML = '';
});

$('#log-filter').addEventListener('input', () => {
  const f = $('#log-filter').value.trim().toLowerCase();
  const tb = $('#log-table tbody');
  // 倒序：最新在最上面
  tb.innerHTML = logBuffer
    .filter((e) => !f || (e.host + e.path).toLowerCase().includes(f))
    .slice(-500)
    .reverse()
    .map((e) => logRow(e))
    .join('');
});

// ---------- 设置 ----------
async function loadSettings() {
  const s = await api('/api/settings');
  const f = $('#settings-form');
  f.providerId.value = s.provider?.id || 'ugos';
  f.authBase.value = s.provider?.authBase || '';
  f.username.value = s.provider?.username || '';
  f.password.value = '';
  f.domainSuffix.value = s.provider?.domainSuffix || '';
  const hosts = await api('/api/hosts');
  $('#hosts-block').textContent = hosts.block || '(尚未同步)';
  const status = await api('/api/status');
  if (status.platform?.termux) {
    $('#hosts-hint').textContent = status.platform.integrationNotice;
    $('#btn-sync-hosts').disabled = true;
    $('#btn-sync-hosts-admin').disabled = true;
    $('#btn-restore-hosts').disabled = true;
  }
  loadAutostart();
  loadPortProxy();
}

// ---------- 多终端配置 ----------
function downloadConfig(includePassword) {
  const url = `/api/config/export${includePassword ? '' : '?password=0'}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = includePassword ? 'gatepass-config.json' : 'gatepass-config-nopass.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('#btn-export-config').addEventListener('click', () => downloadConfig(true));
$('#btn-export-config-nopass').addEventListener('click', () => downloadConfig(false));

$('#btn-import-config').addEventListener('click', () => $('#file-import-config').click());

$('#file-import-config').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new Error('文件不是合法 JSON');
    }
    const r = await api('/api/config/import', { method: 'POST', body: JSON.stringify(payload) });
    const skipped = r.skipped && r.skipped.length ? `，跳过 ${r.skipped.length} 条` : '';
    alert(`已导入 ${r.routes} 条路由${skipped}`);
    location.reload();
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.value = '';
  }
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const provider = {
    id: f.providerId.value,
    authBase: f.authBase.value.trim(),
    username: f.username.value.trim(),
    domainSuffix: f.domainSuffix.value.trim(),
  };
  if (f.password.value) provider.password = f.password.value;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ provider }) });
    alert('已保存');
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-sync-hosts').addEventListener('click', async () => {
  try {
    const r = await api('/api/hosts/sync', { method: 'POST' });
    $('#hosts-block').textContent = r.content?.match(/# gatepass begin[\s\S]*?# gatepass end/)?.[0] || '已同步';
    alert(r.changed ? 'hosts 已更新' : 'hosts 无变化');
    loadSettings();
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-sync-hosts-admin').addEventListener('click', async () => {
  try {
    const r = await api('/api/hosts/sync-elevated', { method: 'POST' });
    if (r.ok) {
      alert(r.note || '已请求管理员权限，请在弹出的 UAC 对话框点“是”');
    } else {
      const cmd = r.manualCommand || '';
      prompt('自动提权失败，请复制以下命令，用管理员 PowerShell 执行：', cmd);
    }
    setTimeout(loadSettings, 2000);
  } catch (err) {
    alert(err.message);
  }
});

async function loadAutostart() {
  try {
    const s = await api('/api/autostart');
    $('#btn-autostart-on').disabled = s.supported === false;
    $('#btn-autostart-off').disabled = s.supported === false;
    if (s.supported === false) {
      $('#autostart-hint').textContent = s.note || '当前平台不支持开机自启。';
      return;
    }
    $('#autostart-hint').textContent = s.installed
      ? `已启用开机自启（${s.paths.dir}）。下次开机会自动运行代理。`
      : '当前未启用开机自启。init 默认已装，如被移除可点「安装开机自启」。';
  } catch (e) {
    $('#autostart-hint').textContent = '查询失败: ' + e.message;
  }
}

$('#btn-autostart-on').addEventListener('click', async () => {
  try {
    const r = await api('/api/autostart', { method: 'POST', body: JSON.stringify({ action: 'install' }) });
    alert(r.ok ? '已安装开机自启' : (r.note || '安装开机自启失败'));
    loadAutostart();
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-autostart-off').addEventListener('click', async () => {
  try {
    const r = await api('/api/autostart', { method: 'POST', body: JSON.stringify({ action: 'remove' }) });
    alert(r.supported === false ? (r.note || '当前平台不支持开机自启。') : (r.removed ? '已移除开机自启' : '未安装开机自启'));
    loadAutostart();
  } catch (err) {
    alert(err.message);
  }
});

async function loadPortProxy() {
  try {
    const s = await api('/api/portproxy');
    $('#btn-proxy-on').disabled = s.supported === false;
    $('#btn-proxy-off').disabled = s.supported === false;
    const lines = (s.entries || []).join('\n') || '(未配置)';
    const st = s.installed ? '已启用' : '未启用';
    $('#portproxy-hint').textContent =
      `代理端口 ${s.proxyPort}，443 转发：${st}。\n规则：\n${lines}`;
  } catch (e) {
    $('#portproxy-hint').textContent = '查询失败: ' + e.message;
  }
}

$('#btn-proxy-on').addEventListener('click', async () => {
  try {
    const r = await api('/api/portproxy', { method: 'POST', body: JSON.stringify({ action: 'install' }) });
    if (r.ok) alert('已启用 443 转发');
    else if (r.note) alert(r.note + (r.command ? '\n\n命令: ' + r.command : ''));
    loadPortProxy();
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-proxy-off').addEventListener('click', async () => {
  try {
    const r = await api('/api/portproxy', { method: 'POST', body: JSON.stringify({ action: 'remove' }) });
    alert(r.ok ? '已关闭端口转发' : ('关闭失败: ' + (r.error || '')));
    loadPortProxy();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 代理控制（重启 / 停止 / 恢复 hosts） ----------
$('#btn-engine-restart').addEventListener('click', async () => {
  try {
    await api('/api/engine/restart', { method: 'POST' });
    alert('代理已重启');
    loadStatus();
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-engine-stop').addEventListener('click', async () => {
  if (!confirm('确定停止代理？停止后需点「重启代理」恢复，控制台仍可用。')) return;
  try {
    await api('/api/engine/stop', { method: 'POST' });
    alert('代理已停止');
    loadStatus();
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-restore-hosts').addEventListener('click', async () => {
  if (!confirm('确定移除 GatePass 写入的 hosts 标记块？移除后应用域名将不再指向本机代理。')) return;
  try {
    const r = await api('/api/hosts/restore', { method: 'POST' });
    alert(r.changed ? 'hosts 标记块已移除' : 'hosts 无 GatePass 标记块');
    loadSettings();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- WebSocket（带轮询兜底） ----------
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch (e) {
    setTimeout(connectWs, 3000);
    return;
  }
  ws.onopen = () => {
    $('#conn').textContent = '● 已连接';
    $('#conn').className = 'conn on';
  };
  ws.onclose = () => {
    $('#conn').textContent = '● 已断开，重连中…';
    $('#conn').className = 'conn off';
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === 'log') pushLog(d);
    } catch {}
  };
}

/** WS 不可用时轮询兜底；页面加载也先拉一次历史 */
async function loadLogsOnce() {
  try {
    const list = await api('/api/logs?limit=200');
    // 历史按时间正序返回，pushLog 逐条 prepend，最终展示为最新在上
    for (const e of list) {
      if (!logBuffer.some((x) => x.ts === e.ts && x.path === e.path)) pushLog(e);
    }
  } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 路由测试结果徽章：区分「代理已生效」与「鉴权/网络失败」 */
function testBadge(res) {
  if (res.error) {
    return `<span class="badge err" title="${esc(res.error)}">失败: ${esc(res.error)}</span>`;
  }
  const s = res.status;
  if (res.authRedirect) {
    return `<span class="badge warn" title="网关把请求重定向到登录页，鉴权未注入成功">302 未鉴权</span>`;
  }
  // 2xx/3xx/4xx 都表示请求已到达目标服务（代理链路正常）
  if (s >= 200 && s < 500) {
    const note = s === 200 ? '代理已生效' : '代理已生效，应用返回 ' + s;
    return `<span class="badge ok" title="${note}">${s}</span>`;
  }
  return `<span class="badge err" title="上游错误">${s || '?'}</span>`;
}

// ---------- 可拖动调节列宽 ----------
function makeResizableTable(table) {
  if (!table) return;
  const cols = table.querySelectorAll('colgroup col');
  const ths = table.querySelectorAll('thead th');
  ths.forEach((th, i) => {
    th.classList.add('resizable');
    const handle = document.createElement('div');
    handle.className = 'resizer';
    th.appendChild(handle);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const col = cols[i];
      const startX = e.clientX;
      const startW = col ? col.getBoundingClientRect().width : th.getBoundingClientRect().width;
      const onMove = (ev) => {
        const w = Math.max(40, startW + (ev.clientX - startX));
        if (col) col.style.width = w + 'px';
        else th.style.width = w + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
  });
}

// ---------- 启动 ----------
makeResizableTable($('#log-table'));
makeResizableTable($('#recent-table'));
loadStatus();
loadRoutes();
loadLogsOnce();
connectWs();
setInterval(loadStatus, 5000);
// 日志固定轮询（2s），不依赖 WS 是否连通，保证页面自动刷新
setInterval(loadLogsOnce, 2000);
