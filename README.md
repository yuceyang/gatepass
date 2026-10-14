# GatePass

**免重复登录的网关反向代理** —— 登录一次，浏览器扩展、命令行、任意程序都能直接访问受保护的应用网关。

适用于把应用藏在登录网关之后的场景（NAS 远程访问、内网穿透平台等）。
未带凭据的请求会被 302 到登录页；GatePass 在本机自动完成登录并把鉴别信息注入每个请求。

```
程序/浏览器 ──► GatePass(本机) ──自动登录+注入──► 真实网关 ──► 应用
                │
                └── Web 控制台：路由、实时日志、会话状态
```

## 特性

- **本地 Web 控制台**：总览 / 路由管理 / 实时请求日志 / 设置，浏览器打开即管理
- **自动登录**：配置账号密码后自动完成 NAS 登录（RSA）、网关 token、Basic Auth 注入
- **路由热更新**：控制台添加主机名即生效，自动同步系统 hosts
- **跨平台**：Windows / macOS / Linux，x64 / arm64，纯 Node.js ≥ 18
- **一键系统配置**：首次向导生成证书、引导导入 CA、写 hosts（无权限时打印手动命令）
- **可观测**：每条请求的方法/路径/状态码/耗时，WS 实时推送
- **可扩展**：AuthProvider 可插拔（内置 `ugos`、`generic-header`）

## 快速开始

```bash
npm install -g .        # 或 npx / 从源码运行
gatepass init           # 首次向导：账号、域名、证书、hosts
gatepass start          # 启动代理 + 控制台
```

浏览器打开 `http://127.0.0.1:9099`，在「路由」页添加应用主机名即可。

### 从源码运行

```bash
npm install
npm start               # 等价于 gatepass start
npm test                # 单元测试
```

## 配置

配置文件默认位于平台用户数据目录（可整目录拷贝到新机器迁移）：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\gatepass\config.json` |
| macOS | `~/Library/Application Support/gatepass/config.json` |
| Linux | `$XDG_CONFIG_HOME/gatepass/config.json` 或 `~/.config/gatepass/config.json` |

设置环境变量 `GATEPASS_HOME` 可覆盖配置目录。

```jsonc
{
  "console": { "host": "127.0.0.1", "port": 9099 },
  "proxy":   { "host": "127.0.0.1", "port": 443, "insecureUpstreamTls": true },
  "provider": {
    "id": "ugos",
    "authBase": "https://your-nas.example",
    "username": "you",
    "password": "••••",
    "domainSuffix": "your.domain.example"
  },
  "routes": [
    {
      "host": "app-5006-your.domain.example",
      "upstreamPort": "5006",
      "providerId": "ugos",
      "enabled": true
    }
  ]
}
```

## 平台说明

### hosts 映射

GatePass 把路由里的主机名映射到 `127.0.0.1`。写系统 hosts 需要管理员权限：

- **Windows**：以管理员运行 `gatepass sync-hosts`，或控制台「设置 → 同步 hosts」
- **macOS / Linux**：`sudo gatepass sync-hosts`

失败时可用 `gatepass print-hosts` 打印待追加内容手动写入。

### CA 证书

代理对 HTTPS 做本地终结，需信任自签 CA：

```bash
gatepass trust-ca        # 打印导入命令
```

| 平台 | 说明 |
|------|------|
| Windows | `certutil -addstore -user Root gatepass-ca.crt` |
| macOS | `security add-trusted-cert …`（可能弹授权框） |
| Linux | 系统证书 + 浏览器 NSS，详见命令输出 |

证书生成时会覆盖 `*.parent` 与具体主机名（含 `app-5006-xxx` 这类连字符拼接形态）。

### 端口

默认代理 443（需要管理员/特权端口）。可在 `config.proxy.port` 改为 8443 等，
此时客户端访问需带端口号，或在系统做端口转发。

## 命令

```
gatepass init             首次向导
gatepass start            启动代理 + Web 控制台
gatepass status           查看配置路径与端口
gatepass sync-hosts       同步系统 hosts
gatepass print-hosts      打印 hosts 块
gatepass trust-ca         CA 信任指引
gatepass help
```

## 架构

```
src/
  config.js            配置读写（BOM 容忍、用户数据目录）
  index.js             启动编排
  core/
    provider.js        AuthProvider 契约
    providers/ugos.js  UGOS 三段式鉴权 + generic-header
    engine.js          HTTPS 反向代理引擎（转发、WS、重登重试）
    routes.js          路由注册表（热更新、端口推断）
  system/
    hosts.js           跨平台 hosts 块管理
    certtrust.js       CA 信任命令 / 端口检测
    certs.js           自签证书（SAN 覆盖连字符域名）
  server/api.js        控制台 REST + WebSocket 实时日志
  web/                 控制台前端（无构建）
```

### 鉴权 Provider

`AuthProvider` 契约：`ensureSession` / `applyToRequest` / `isAuthRedirect` / `renewGatewayToken`。
内置：

- **ugos**：`verify/check`（RSA 公钥）→ `verify/login` → `gateway/proxy/dockerToken`（`ugreen-proxy-token`）+ HTTP Basic
- **generic-header**：静态 Cookie/Header 注入

## 开发

```bash
npm test               # node:test 单元测试
npm run check          # 语法检查
```

CI 目标矩阵：Windows / macOS / Linux × x64 / arm64，Node 18 / 20。

## License

[MIT](./LICENSE)
