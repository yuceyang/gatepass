---
feature: gatepass
status: delivered
updated: 2026-10-14
branch: feature/web-console
commits: 0000000..pending
---

# GatePass — 免重复登录的网关反向代理

## Report

**What was built** — GatePass 是一个通用定位（MIT）的本地反向代理：把受登录网关保护的
应用域名经 hosts 指到本机，由代理自动完成鉴权并注入 Cookie/Header/Query 后转发，使
浏览器扩展、命令行、任意程序免重复登录。核心引擎为 Node.js HTTPS 反向代理，鉴权做成
AuthProvider 可插拔（内置 UGOS 三段式与 generic-header）。内置 Web 控制台
（`http://127.0.0.1:9099`）提供总览、路由 CRUD、实时请求日志（WebSocket 环形缓冲）、
设置；`gatepass init` 首次向导覆盖配置、证书、hosts、CA 信任指引，能力缺失时降级为
打印手动命令。跨平台配置目录（Win/macOS/Linux）可整目录迁移，CI 矩阵 yml 已就绪。

**Verification** —
- `node --test test/*.test.js` → 12 pass / 0 fail（config、routes、RSA、Provider 注入、
  certs SAN 覆盖连字符主机名、hosts 命令、engine 转发+302 重登、421/OPTIONS）
- CLI 冒烟：`gatepass start` 于临时 `GATEPASS_HOME` 起 18443/19099，`/api/status`
  与 `/api/routes` 返回符合契约；hosts 无权限时 EPERM 优雅降级不崩溃
- 安全自查：`/../../../config.json` 等穿越请求返回 SPA 兜底页，配置密码未泄露；
  `/api/settings` 密码脱敏为 `••••••`
- 评审：子代理两次 APIError 未能启动，改由人工按 spec 逐条核对（见 Journey log）

**Journey log** —
1. 证书通配符 `*.parent` 盖不住 `app-5006-…`（连字符拼接非子域），SAN 必须含具体主机名与 `*.parent`。
2. `ShuQian.xbel.lock` 被 WebDAV 客户端建成目录会导致 PUT 404——网关应用侧的隐性坑，代理无法代偿。
3. PowerShell `$home` 是只读变量指向用户主目录；冒烟脚本误用导致误删事故（详见会话记录）。变量命名须避开 PowerShell 自动变量。
4. Node 引擎上游默认 https，mock 上游须同协议；`node --test test/` 需写成 `test/*.test.js`。
5. 子代理评审通道 APIError 两次，compose-next 的 Review 环节降级为人工核对；待通道恢复后可补一轮独立评审。

## [S1] Problem

企业/家庭 NAS（如绿联 UGOS）把 Docker 应用暴露在 `app-<port>-<user>.<domain>` 这类网关域名后，
未带鉴别信息的请求会被 302 到登录页。浏览器里手动登录一次后，浏览器扩展（书签同步 Floccus）、
命令行工具、其它程序仍拿不到会话，各自再登录一次。

手工脚本代理（ugdocker-proxy 原型）已验证可自动完成
「NAS 登录 → 网关 token → Basic Auth 注入」，但它是 Windows 向的 CLI：

- 看不到代理了哪些路由、请求是否成功、会话是否还有效；
- 新增链接/端口要改 hosts + 配置文件，跨机器移植要重做证书和信任；
- 只在 Windows 验证过，macOS/Linux/ARM 未覆盖。

需要一个可开源分发、跨平台、可管理、可观测的网关反向代理。

## [S2] Design

### 产品形态

- **本地 Web 控制台**：代理进程内嵌 HTTP 服务（默认 `http://127.0.0.1:9099`），浏览器打开即管理界面。
- **核心引擎不变**：本地 HTTPS 反向代理（默认 443），hosts 把目标域名指到 127.0.0.1，
  自动注入鉴权后转发到真实网关。
- **MIT 许可**，通用定位（不绑定绿联），鉴权做成 Provider 可插拔。

### 架构

```
gatepass/
  package.json
  LICENSE                     MIT
  README.md
  src/
    index.js                  入口：加载配置 → 启动引擎 + 控制台
    config.js                 配置读写（JSON，路径可迁移）
    core/
      provider.js             AuthProvider 接口定义
      providers/
        ugos.js               UGOS 实现（NAS RSA 登录 + gateway token + Basic）
        generic-header.js     通用 Header/Cookie 注入 Provider（同文件）
      engine.js               反向代理引擎（HTTPS 终结、转发、WS 升级、重试）
      routes.js               路由注册表（内存 + 持久化，热更新）
    system/
      hosts.js                跨平台 hosts 读写（Win/macOS/Linux）
      certtrust.js            跨平台 CA 信任命令 + 端口检测
      certs.js                自签证书生成（SAN 覆盖连字符域名形态）
    server/
      api.js                  REST API + WebSocket 实时日志（LiveLog 环形缓冲）
    web/                      控制台前端（静态单页，无构建）
  bin/gatepass.js             CLI：init / start / status / sync-hosts / print-hosts / trust-ca
  test/                       node:test 单元与引擎测试
```

### AuthProvider 接口（可插拔鉴权）

```js
class AuthProvider {
  id, label
  async ensureSession(force)         // 登录/刷新，返回 { ok, expiresAt, detail }
  async applyToRequest(req, route)   // 注入 Cookie/Header/Query
  isAuthRedirect(status, location)   // 判断是否未登录跳转
  async renewGatewayToken(host)      // 可选：按主机换一次性 token
  describe()                         // 返回给 UI 的字段说明（脱敏）
}
```

UGOS Provider 承载已验证的三段式鉴权（`verify/check` 取 RSA 公钥 → `verify/login` →
`gateway/proxy/dockerToken` 换 `ugreen-proxy-token`，外加 HTTP Basic）。
`generic-header` Provider 支持静态 Cookie/Header 注入，覆盖其它网关。

### 路由管理

- 路由条目：`{ id, host, upstreamHost, upstreamPort, providerId, enabled, note }`。
- **控制台手动添加**，写入 `config.json` 的 `routes[]`，进程内热生效（无需重启）。
- 添加/删除路由时同步更新系统 hosts（标记 `# gatepass begin/end` 块，幂等）。
- 从主机名自动解析目标端口（`app-5006-…` → 5006），可人工覆盖。

### 控制台界面（单页）

- **总览**：代理监听状态、会话状态、路由数、请求数、最近错误。
- **路由页**：列表（主机、上游、Provider、启用开关）；添加/编辑/删除/测试连通。
- **实时日志**：方法、路径、状态码、耗时；WebSocket 推送 + 环形缓冲（默认 2000 条）；可按路由过滤。
- **设置**：账号密码（脱敏显示）、监听端口、CA 导出、hosts 同步、向导入口。

### 首次启导向（跨平台一键系统配置）

1. 检测 Node 版本、代理/控制台端口占用；
2. 填 NAS 地址、账号密码、域名后缀；
3. 生成证书 → 打印/引导导入 CA（Windows certutil、macOS security、Linux ca-certificates+NSS）；
4. 写 hosts（失败则打印待执行命令与块内容）；
5. `gatepass status` / 控制台健康检查。

### 可靠性与并发

- 上游连接复用（`https.Agent` keepAlive, maxSockets 128）；
- 会话刷新**单飞**（in-flight promise 去重），失败退避由调用方重试；
- 网关 302→登录页时自动重登并重试一次，失败返回 502 带原因；
- WebSocket/SSE/文件流透传，不缓冲整个响应体；
- 控制台 API 与代理流量隔离（不同端口），控制台打不开不影响代理。

### 可移植性

- 纯 Node.js ≥18，唯一依赖 `selfsigned`（证书生成）；
- 三平台 hosts/证书/提权各一份逻辑，能力缺失降级为「打印手动步骤」；
- 配置与证书放用户数据目录（Windows `%APPDATA%`、macOS `~/Library/Application Support`、
  Linux `$XDG_CONFIG_HOME`），`GATEPASS_HOME` 可覆盖；可整目录拷贝迁移；
- CI 矩阵 yml：Windows / macOS / Linux × Node 18/20。

## [S3] Out of Scope

- 不做浏览器扩展、不接管系统代理/PAC；
- 不做自动发现 NAS 上的 Docker 应用列表（v1 路由全手动）；
- 不做流量统计图表/指标导出（Prometheus 等），只做实时日志与状态；
- 不做多 NAS 账号多配置并存（v1 单配置文件，结构预留）；
- 不做 GUI 安装包（Electron/Tauri），分发形态是 npm/源码 + 浏览器控制台；
- 不破解/绕过网关自身的安全策略，只复用用户本人的合法凭据。

## Tasks

- [x] T1: 仓库骨架与配置层 — package.json/LICENSE(MIT)/README、`src/config.js`（读写 JSON、BOM 容忍、路径解析到用户数据目录）。acceptance: 配置可保存并回读一致，BOM 容忍有测试覆盖。 (covers: S2)
- [x] T2: AuthProvider 接口 + UGOS Provider — `provider.js` 契约与 `providers/ugos.js`（RSA 登录、dockerToken、ugreen-proxy-token、Basic 注入），单飞刷新。acceptance: mock 会话下 applyToRequest 注入三件套、isAuthRedirect 判定、RSA 往返有单测。 (covers: S2)
- [x] T3: 反向代理引擎 — `core/engine.js`：HTTPS 终结、上游转发（keepAlive）、请求体透传、WS 升级、CORS/OPTIONS、鉴权 302 重试一次。acceptance: 本地引擎 + 假上游，GET 透传、注入验证、302 触发单次重登有测试。 (covers: S2)
- [x] T4: 路由注册表 — `core/routes.js`：增删改查、主机名→端口推断、热更新、持久化回调。acceptance: CRUD/冲突/非法主机名/端口推断 app-5006→5006、app16601→16601 有单测。 (covers: S2)
- [x] T5: 跨平台系统集成 — `system/hosts.js` / `certtrust.js`，幂等 hosts 标记块、CA 信任命令、端口检测；能力缺失降级输出手动命令。acceptance: hosts 命令拼装、elevatedWriteCommand 可生成有单测；无权限时运行时优雅降级（冒烟验证）。 (covers: S2)
- [x] T6: 证书模块 — SAN 覆盖 `*.parent` + 具体主机（含连字符形态），可重生成、可导出 CA。acceptance: `certCoversHost` 对 app-5006-x/app16601-x 均 MATCH、evil.example.com 不 MATCH。 (covers: S2)
- [x] T7: 控制台 API + 实时日志 — `server/api.js`（路由 CRUD、会话状态、日志查询）+ LiveLog 环形缓冲 + 极简 WS。acceptance: 冒烟 /api/status 与 /api/routes 契约正确；密码脱敏。 (covers: S2)
- [x] T8: Web 控制台前端 — 总览/路由/日志/设置四页，路由表单、测试连通、脱敏凭据。acceptance: 无构建直接托管，手工冒烟可访问 /api 与静态页。 (covers: S2)
- [x] T9: 首次启导向 — `gatepass init` 引导配置→证书→CA 信任→hosts。acceptance: CLI help/init 路径可用；跳过步骤有手动指引。 (covers: S2)
- [x] T10: 端到端与回归 — 原型 UGOS 三段式鉴权单元化、engine 转发/重登回归。acceptance: `npm test` 12/12 全绿。 (covers: S2)
- [x] T11: 开源就绪 — README/CONTRIBUTING/CI 矩阵 yml/MIT。acceptance: 干净目录 npm install && npm test 可跑；CI yml 就位。 (covers: S2)
