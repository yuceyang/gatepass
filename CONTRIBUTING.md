# Contributing

感谢关注 GatePass。

## 开发环境

- Node.js ≥ 18（推荐 20 LTS）
- `npm install && npm test`

## 提交规范

- 小步提交，提交信息说明「为什么」而不是「改了什么」
- 新增行为先补测试（`test/*.test.js`，`node:test`）
- 改动 `AuthProvider` 契约时同步更新 README 与 `src/core/provider.js` 注释

## 架构约定

- 鉴权差异全部收敛在 `src/core/providers/`，引擎不感知具体厂商
- 系统级操作（hosts / 证书 / 提权）放在 `src/system/`，能力缺失时降级为打印手动命令，不要抛致命错误
- 控制台 API 与代理流量隔离（不同端口），控制台故障不影响代理

## 行为准则

理性、友善、对事不对人。
