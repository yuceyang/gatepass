# GatePass

**私有云 NAS 全局免登录代理** —— 提前完成身份鉴别，让应用访问不再跳转官方认证页。

## 背景

部分私有云 NAS（如绿联 UGOS）把 Docker 应用放在官方全局代理之后，地址形如
`app-<端口>-<用户>.<域名>`。直接访问时，请求会被拦截并跳转到官方登录页完成身份认证；
登录一次之后，浏览器扩展、命令行工具、其它程序仍然拿不到会话，各自还要再登录一次。

GatePass 的做法是：**在本机提前完成身份鉴别**（登录 NAS、换取网关令牌、注入 Cookie/Header），
对后端应用而言请求已经是「已认证」的，用户只需要关心真实服务/业务的访问，不再被官方认证打断。

## 原理

```
浏览器 / 扩展 / 命令行
        │  请求 https://app-xxxx-<域名>/…
        ▼
   GatePass（本机反向代理）          ── hosts 把域名指到 127.0.0.1
        │  ① 自动登录 NAS（账号密码 RSA 加密）
        │  ② 换取网关一次性令牌
        │  ③ 注入 Cookie / Token / HTTP Basic
        ▼
   官方全局代理网关（鉴权已带）──► 后端应用（不再跳转登录页）
```

三层鉴别信息：

| 层 | 手段 | 用途 |
|----|------|------|
| NAS 会话 | `verify/check`（RSA 公钥）→ `verify/login` | 账号密码换 token |
| 网关令牌 | `gateway/proxy/dockerToken` → 一次性 Cookie | 通过官方全局代理 |
| 应用鉴权 | HTTP Basic（部分应用要求） | 进入具体服务 |

## 特性

- **本地 Web 控制台**：总览 / 路由管理 / 实时请求日志 / 设置
- **提前鉴权**：配置账号密码后自动完成登录与令牌刷新，对上层程序透明
- **路由热更新**：控制台加主机名即生效，自动同步系统 hosts（只改自己的标记块）
- **跨平台**：Windows / macOS / Linux，x64 / arm64，Node.js ≥ 18
- **一键系统配置**：自动 UAC 提权写 hosts、CA 证书导入、默认开机自启
- **可观测**：每条请求的方法/路径/状态码/耗时，页面自动刷新

---

## 安装

### 环境要求

| 项 | 要求 |
|----|------|
| Node.js | ≥ 18（推荐 20 LTS） |
| 权限 | 写系统 hosts、绑定 443 需管理员；程序会自动弹 UAC |
| 浏览器 | Chrome / Edge / Firefox（需导入 CA 证书） |

```bash
node -v     # v18.x 或更高
```

### 从源码安装

```bash
git clone https://github.com/yuceyang/gatepass.git
cd gatepass
npm install
npm install -g .        # 全局安装，提供 gatepass 命令
gatepass help
```

或直接源码运行：

```bash
npm install && npm start
```

---

## 使用

### 1. 初始化

```bash
gatepass init
```

按提示填：

1. NAS 登录地址
2. 用户名 / 密码
3. 代理域名后缀（应用地址的公共后缀）
4. 首个路由主机名（可留空，稍后在控制台添加）
5. 端口（代理默认 443，控制台默认 19099）

完成后会**自动安装开机自启**（可在控制台关闭）。自启为**后台静默运行**，不弹命令行窗口：

| 平台 | 实现 | 位置 |
|------|------|------|
| Windows | `gatepass-start.vbs`（WScript 隐藏启动） | 启动文件夹 |
| macOS | `com.gatepass.agent.plist` | `~/Library/LaunchAgents/` |
| Linux | `gatepass.desktop` | `~/.config/autostart/` |

配置位置（可整目录拷贝到新机器）：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\gatepass\config.json` |
| macOS | `~/Library/Application Support/gatepass/config.json` |
| Linux | `~/.config/gatepass/config.json` |

`GATEPASS_HOME` 环境变量可覆盖配置目录。

### 2. 信任 CA 证书

代理对 HTTPS 做本地终结，浏览器/扩展必须信任自签 CA，否则报 TLS 错误：

```bash
gatepass trust-ca
```

Windows（当前用户）：

```powershell
certutil -addstore -user Root "C:\Users\<你>\AppData\Roaming\gatepass\certs\ca.crt"
```

macOS：

```bash
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db \
  ~/Library/Application\ Support/gatepass/certs/ca.crt
```

Linux：

```bash
sudo cp ~/.config/gatepass/certs/ca.crt /usr/local/share/ca-certificates/gatepass-ca.crt
sudo update-ca-certificates
```

导入后**完全退出浏览器再打开**。也可在控制台「设置 → 下载 CA 证书」双击导入。

### 3. 启动

```bash
gatepass start
```

非管理员时会自动弹 UAC 提权（点「是」即可）。开机自启已装则无需手动运行。

### 4. 浏览器使用

1. 打开控制台 `http://127.0.0.1:19099`
2. 「路由」页添加应用主机名（端口自动从 `app-<端口>-…` 推断）
3. 直接访问应用，例如：

```
https://app-8080-<你的域名>/
https://app-9000-<你的域名>/admin/
```

不会再跳官方登录页。

---

## 端口说明

| 用途 | 默认端口 | 说明 |
|------|----------|------|
| 代理 | **443** | 浏览器/扩展默认走标准 HTTPS 端口 |
| 控制台 | **19099** | Web 管理界面（可改配置） |

> 443 是 HTTPS 标准端口，各类客户端默认走它。绑定 443 需要管理员权限，
> 程序启动时自动请求 UAC。若 443 已被其它 Web 服务占用，请先停用或换机器。

## 控制台

| 页面 | 功能 |
|------|------|
| **总览** | 代理监听、会话状态、路由数、请求/错误统计、最近请求（自动刷新） |
| **路由** | 添加/编辑/删除/启停/测试连通；状态码 200–499 均表示**代理已生效**（401/404 是应用自身响应） |
| **实时日志** | 每条请求的方法/主机/路径/状态码/耗时，最新在最上，自动刷新 |
| **设置** | 账号密码（脱敏）、hosts 同步（自动 UAC）、CA 下载、开机自启开关 |

## 命令

```
gatepass init                 初始化向导（默认装开机自启）
gatepass start                启动代理 + 控制台（自动提权）
gatepass status               查看配置与端口
gatepass sync-hosts           同步系统 hosts（自动提权）
gatepass print-hosts          打印 hosts 块
gatepass trust-ca             CA 信任指引
gatepass install-autostart    安装开机自启
gatepass remove-autostart     关闭开机自启
gatepass help
```

## 配置示例

```jsonc
{
  "console": { "host": "127.0.0.1", "port": 19099 },
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
      "host": "app-8080-your.domain.example",
      "upstreamPort": "8080",          // 网关后的应用端口（换 token 用）
      "upstreamConnectPort": "443",    // TCP 上游端口（网关是 443，只是目标，不是监听）
      "providerId": "ugos",
      "enabled": true
    }
  ]
}
```

## 迁移到新电脑

1. 拷贝配置目录到新机器
2. `npm install -g .`
3. 新机器上 `gatepass trust-ca` 与 `gatepass sync-hosts`（各机一次）

## 架构

```
src/
  config.js              配置读写（BOM 容忍、用户数据目录）
  index.js               启动编排、端口绑定失败自动提权
  core/
    provider.js          AuthProvider 契约
    providers/ugos.js    NAS 三段式鉴权 + generic-header
    engine.js            HTTPS 反向代理（转发、WS、302 重登）
    routes.js            路由注册表（去端口/协议、端口推断）
  system/
    hosts.js             hosts 标记块读写（只改 gatepass 块）
    certtrust.js         CA 信任命令 / 端口检测
    certs.js             自签证书（SAN 覆盖连字符域名）
    elevate.js           UAC 提权 / 任务计划兜底
    autostart.js         开机自启
    portproxy.js         可选 443 转发（非 443 监听时用）
  server/api.js          控制台 REST + 实时日志
  web/                   控制台前端（无构建）
```

### 鉴权 Provider

`AuthProvider`：`ensureSession` / `applyToRequest` / `isAuthRedirect` / `renewGatewayToken`。

- **ugos**：`verify/check`（RSA 公钥）→ `verify/login` → `gateway/proxy/dockerToken` + HTTP Basic
- **generic-header**：静态 Cookie/Header 注入

## 开发

```bash
npm test               # node:test 单元测试
npm run check          # 语法检查
```

CI 矩阵：Windows / macOS / Linux × Node 18/20。

## License

[MIT](./LICENSE)
