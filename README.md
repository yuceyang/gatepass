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
- **一键系统配置**：证书生成、CA 信任、hosts 写入（支持 UAC 提权）、开机自启
- **可观测**：每条请求的方法/路径/状态码/耗时，实时推送 + 历史查询
- **可扩展**：AuthProvider 可插拔（内置 `ugos`、`generic-header`）

---

## 安装教程

### 环境要求

| 项 | 要求 |
|----|------|
| Node.js | ≥ 18（推荐 20 LTS） |
| 权限 | 写系统 hosts、绑 443 端口需要管理员 |
| 浏览器 | Chrome / Edge / Firefox（需导入 CA 证书） |

检查 Node：

```bash
node -v     # 应显示 v18.x 或更高
```

### 方式一：从源码安装（推荐）

```bash
git clone https://github.com/<you>/gatepass.git
cd gatepass
npm install
npm install -g .        # 全局安装，提供 gatepass 命令
```

验证：

```bash
gatepass help
```

### 方式二：直接源码运行（不装全局）

```bash
cd gatepass
npm install
npm start               # 等价于 gatepass start
```

---

## 使用教程

### 第 1 步：初始化配置

```bash
gatepass init
```

按提示填：

1. **NAS 登录地址**（如 `https://xxx.cn68.ug.link`）
2. **用户名 / 密码**
3. **代理域名后缀**（如 `yuceyang.cn68.ugdocker.link`）
4. **首个路由主机名**（如 `app-5006-yuceyang.cn68.ugdocker.link`，可留空稍后在控制台加）
5. 代理端口（默认 443）、控制台端口（默认 9099）

配置写入用户数据目录：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\gatepass\config.json` |
| macOS | `~/Library/Application Support/gatepass/config.json` |
| Linux | `~/.config/gatepass/config.json` |

设置环境变量 `GATEPASS_HOME` 可覆盖配置目录（方便多配置/迁移）。

### 第 2 步：信任 CA 证书

代理对 HTTPS 做本地终结，必须信任自签 CA，否则浏览器/扩展会报 TLS 错误：

```bash
gatepass trust-ca        # 打印导入命令与证书路径
```

**Windows**（当前用户，一般够用）：

```powershell
certutil -addstore -user Root "C:\Users\<你>\AppData\Roaming\gatepass\certs\ca.crt"
```

**macOS**：

```bash
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db \
  ~/Library/Application\ Support/gatepass/certs/ca.crt
```

**Linux**：

```bash
sudo cp ~/.config/gatepass/certs/ca.crt /usr/local/share/ca-certificates/gatepass-ca.crt
sudo update-ca-certificates
# Firefox（NSS）另行：
# certutil -A -t "C,," -n gatepass -i ~/.config/gatepass/certs/ca.crt -d sql:~/.pki/nssdb
```

> 导入后**完全退出浏览器再打开**，扩展进程才会读到新证书。

也可以在控制台「设置 → 系统集成 → 下载 CA 证书」双击导入。

### 第 3 步：配置 hosts

把应用域名指向本机（127.0.0.1），需要管理员权限：

```powershell
# Windows：管理员 PowerShell
gatepass sync-hosts
```

```bash
# macOS / Linux
sudo gatepass sync-hosts
```

或在控制台点 **「以管理员同步 hosts」**（弹 UAC，确认即可）。

失败时 `gatepass print-hosts` 打印内容手动追加到：

- Windows：`C:\Windows\System32\drivers\etc\hosts`
- macOS / Linux：`/etc/hosts`

### 第 4 步：启动服务

```bash
gatepass start
```

看到类似输出即成功：

```
[engine] HTTPS 监听 127.0.0.1:443
[gatepass] 控制台 http://127.0.0.1:9099
[gatepass] 代理   https://127.0.0.1:443  →  *.yuceyang.cn68.ugdocker.link
[gatepass] 会话: OK
```

> 绑定 443 需要管理员权限。改用 `config.json` 里 `proxy.port` 可换非特权端口。

### 第 5 步：浏览器使用

1. 打开控制台 **http://127.0.0.1:9099**
2. 「路由」页 → **添加路由** → 填主机名（端口会自动从 `app-5006-…` 推断）
3. 直接访问应用：

```
https://app-5006-你的域名后缀/
https://app16601-你的域名后缀/
https://app-9090-你的域名后缀/ui/
```

无需再登录——GatePass 自动带上 NAS 会话、网关 token、Basic Auth。

### 第 6 步（可选）：开机自启

控制台「设置 → 开机自启 → 安装开机自启」，或：

```bash
gatepass install-autostart
gatepass remove-autostart     # 移除
```

| 平台 | 实现 |
|------|------|
| Windows | 启动文件夹 `gatepass-start.bat` |
| macOS | `~/Library/LaunchAgents/com.gatepass.agent.plist` |
| Linux | `~/.config/autostart/gatepass.desktop` |

---

## 控制台说明

| 页面 | 功能 |
|------|------|
| **总览** | 代理监听、会话状态、路由数、请求/错误统计、最近请求 |
| **路由** | 添加/编辑/删除/启用停用/测试连通；测试会真实探测网关 |
| **实时日志** | 每条请求的方法/主机/路径/状态码/耗时，可过滤；WS 推送 + 自动轮询兜底 |
| **设置** | 账号密码（脱敏）、hosts 同步（含 UAC 提权）、CA 下载、开机自启 |

## 命令行

```
gatepass init                 首次向导
gatepass start                启动代理 + Web 控制台
gatepass status               查看配置路径与端口
gatepass sync-hosts           同步系统 hosts（需管理员）
gatepass print-hosts          打印 hosts 块
gatepass trust-ca             CA 信任指引
gatepass install-autostart    安装开机自启
gatepass remove-autostart     移除开机自启
gatepass help
```

## 配置文件示例

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
      "upstreamPort": "5006",          // 网关后的应用端口（用于换 token）
      "upstreamConnectPort": "443",    // TCP 上游端口（默认 443，可省略）
      "providerId": "ugos",
      "enabled": true
    }
  ]
}
```

## 迁移到新电脑

1. 把配置目录（`%APPDATA%\gatepass` 等）整个拷过去
2. 新机器上 `npm install -g .`（或克隆源码安装）
3. 重新导入 CA、同步 hosts（每台机器都要）

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
    autostart.js       开机自启 / UAC 提权写 hosts
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
