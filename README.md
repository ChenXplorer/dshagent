# DSH Agent

DSH 基座 + Multica Runtime 插件：用官方 Multica Server/Daemon 调度 Codex / Claude CLI，替换默认 `dsh-agent-loop`。

- 技术方案：[docs/architecture.md](docs/architecture.md)
- 插件入口：`dsh-multica-runtime/`（Cordis `setFactory`）
- 官方控制面客户端：`src/multica/official.ts`
- 原生 DSH Agent：`src/plugin/dsh-native.ts`
- 预览网关：`scripts/dsh-gateway.mjs`（iframe 认证、`ownsHost`、插件 URL 缩短）

## 安装

```bash
# 官方 DSH web profile
dsh plugin --profile web add "$(pwd)/dsh-multica-runtime"
```

`cordis.patch.yml` 会禁用 `agent-loop` 并插入 `multica-runtime`。

需要的环境变量：

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，供 Codex/Claude CLI 使用 |
| `MULTICA_OFFICIAL_URL` | 官方 Multica Server，例如 `http://127.0.0.1:18080` |
| `MULTICA_TOKEN` | Multica PAT |
| `MULTICA_WORKSPACE_ID` | Multica workspace id |

## 运行

1. 启动官方 Multica Server + Daemon（Postgres + CLI runtime）。
2. 配置上述环境变量。
3. `dsh web` 加载 web profile；插件接管 turn，把用户消息交给 Multica task。

本地预览端口分工：

| 进程 | 端口 | 说明 |
| --- | --- | --- |
| Multica Server | `127.0.0.1:18080` | 控制面，只绑回环 |
| DSH web | `127.0.0.1:3080` | 官方 Harness，loopback |
| Preview gateway | `0.0.0.0:8080` | 代发 launch token、注入 cookie / `ownsHost` |

```bash
npm test
npx esbuild dsh-multica-runtime/entry.ts \
  --bundle --platform=node --format=esm --packages=external \
  --outfile=dsh-multica-runtime/dist/index.js
```

## 状态

已实现：

- 官方 Multica 控制面客户端（agent / session / task / SSE）
- DSH native factory，替换 `dsh-agent-loop`
- 已有会话走 `persistence.open` 恢复，不再误调 `create`（避免 `SessionAlreadyExistsError`）
- `user/message` / `assistant/message` 带 `surfaceOp: "append"`
- 预览网关：token 兑换、SameSite=None、`__DSH_TRANSPORT__.ownsHost`、超长 `/plugins/??` URL 缩短
- 远程浏览器不再弹出「选择 server」

仍需：

- 企业侧统一登录 / 多用户沙箱生命周期（见架构文档）
- Trajectory / Langfuse 事件接入
