/* GatePass 控制台前端（无构建） */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let ws = null;
let routeEditingId = null;

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
    const p = s.provider || {};
    const sess = p.session || {};
    const cards = [
      { k: '代理监听', v: s.engine?.listening ? `${s.proxy?.host}:${s.proxy?.port}` : '未监听', cls: s.engine?.listening ? 'ok' : 'err' },
      { k: '会话状态', v: sess.ok ? '已登录' : '未登录', cls: sess.ok ? 'ok' : 'err' },
      { k: '路由数', v: `${s.routesEnabled}/${s.routes} 启用`, cls: '' },
      { k: '已代理请求', v: s.engine?.proxied ?? 0, cls: '' },
      { k: '重登次数', v: s.engine?.retries ?? 0, cls: (s.engine?.retries || 0) > 0 ? 'warn' : '' },
      { k: '错误数', v: s.engine?.errors ?? 0, cls: (s.engine?.errors || 0) > 0 ? 'err' : 'ok' },
    ];
    $('#status-cards').innerHTML = cards
      .map((c) => `<div class="card"><div class="k">${c.k}</div><div class="v ${c.cls}">${c.v}</div></div>`)
      .join('');
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
      <td>${esc(r.host)}</td>
      <td>${esc(r.upstreamHost || r.host)}:${esc(r.upstreamPort)}</td>
      <td><span class="badge">${esc(r.providerId)}</span></td>
      <td>${r.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>'}</td>
      <td class="test-cell">—</td>
      <td>
        <button data-act="test">测试</button>
        <button data-act="edit">编辑</button>
        <button data-act="toggle">${r.enabled ? '停用' : '启用'}</button>
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
        } else if (act === 'test') {
          const cell = tr.querySelector('.test-cell');
          cell.textContent = '测试中…';
          const res = await api(`/api/routes/${id}/test`, { method: 'POST' });
          cell.innerHTML = res.ok
            ? `<span class="badge ok">${res.status || 'OK'}</span>`
            : `<span class="badge err">${esc(res.error || res.status || '失败')}</span>`;
        }
      } catch (e) {
        alert(e.message);
      }
    });
  });
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
  $('#route-form-panel').classList.remove('hidden');
}

$('#btn-add-route').addEventListener('click', () => showRouteForm());
$('#btn-cancel-route').addEventListener('click', () => $('#route-form-panel').classList.add('hidden'));

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
  };
  try {
    if (routeEditingId) {
      await api('/api/routes/' + routeEditingId, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/routes', { method: 'POST', body: JSON.stringify(body) });
    }
    $('#route-form-panel').classList.add('hidden');
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
    return `<div class="log-item"><span>${fmtTime(e.ts)}</span><span>${e.method}</span><span class="path">${esc(e.host + e.path)}</span><span class="${statusClass(e.status)}">${e.status}</span><span>${e.durationMs}ms</span></div>`;
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
    tb.appendChild(tr);
    while (tb.children.length > 500) tb.removeChild(tb.firstChild);
  }
  const recent = $('#recent-logs');
  const div = document.createElement('div');
  div.innerHTML = logRow(e, true);
  recent.prepend(div.firstElementChild);
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
  tb.innerHTML = logBuffer
    .filter((e) => !f || (e.host + e.path).toLowerCase().includes(f))
    .slice(-500)
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
  loadAutostart();
}

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
    $('#autostart-hint').textContent = s.installed
      ? `已安装（${s.paths.dir}）`
      : '尚未安装开机自启。点击「安装开机自启」后，每次开机自动运行代理。';
  } catch (e) {
    $('#autostart-hint').textContent = '查询失败: ' + e.message;
  }
}

$('#btn-autostart-on').addEventListener('click', async () => {
  try {
    await api('/api/autostart', { method: 'POST', body: JSON.stringify({ action: 'install' }) });
    alert('已安装开机自启');
    loadAutostart();
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-autostart-off').addEventListener('click', async () => {
  try {
    await api('/api/autostart', { method: 'POST', body: JSON.stringify({ action: 'remove' }) });
    alert('已移除开机自启');
    loadAutostart();
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
    for (const e of list) {
      if (!logBuffer.some((x) => x.ts === e.ts && x.path === e.path)) pushLog(e);
    }
  } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 启动 ----------
loadStatus();
loadRoutes();
loadLogsOnce();
connectWs();
setInterval(loadStatus, 5000);
// WS 未连通时静默轮询日志
setInterval(() => {
  if (!ws || ws.readyState !== 1) loadLogsOnce();
}, 3000);
