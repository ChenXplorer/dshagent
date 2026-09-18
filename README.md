# DSH Agent

- [完整实现与跨机器部署手册](mvp/docs/deployment-handbook.md)

当前可测试实现位于 **`mvp/`**：目标部署由统一多租户 Gateway 接入，按需启动每用户 DSH Host；Windows/服务器运行 DSH 与 Multica 控制面，Daytona Sandbox 内运行每用户的官方 Multica Daemon 和两种原生 CLI。多租户边界与 DSH Hub 定位见 [目标说明](mvp/docs/multi-tenant-target.md)。

- [同一会话 Codex ↔ Claude Code 试用说明](mvp/docs/try-mvp.md)
- [真实验收结果与已知边界](mvp/docs/acceptance-results.md)
- [两机部署与启动说明](mvp/docs/windows-ubuntu-deployment.md)
- [MVP 目标与已完成验收清单](docs/mvp-goals.md)
- [新实现模块目录](mvp/README.md)
- [MVP 文档索引](mvp/docs/README.md)

## 旧版原型说明（历史参考）

以下目录与命令保留供参考，不作为本次真实 MVP 的部署入口；请优先使用上面的 `mvp/` 文档。

DSH 基座 + Multica Runtime 插件：用官方 Multica Server/Daemon 调度 Codex / Claude CLI，替换默认 `dsh-agent-loop`。

- 技术方案：[docs/architecture.md](docs/architecture.md)
- 本次 MVP 目标与验收标准：[docs/mvp-goals.md](docs/mvp-goals.md)
- MVP 新实现目录与模块边界：[mvp/README.md](mvp/README.md)
- 插件入口：`bck/legacy-prototype/dsh-multica-runtime/`（Cordis `setFactory`）
- 官方控制面客户端：`bck/legacy-prototype/src/multica/official.ts`
- 原生 DSH Agent：`bck/legacy-prototype/src/plugin/dsh-native.ts`
- 预览网关：`bck/legacy-prototype/scripts/dsh-gateway.mjs`（iframe 认证、`ownsHost`、插件 URL 缩短）

## 安装

```bash
# 官方 DSH web profile
dsh plugin --profile web add "$(pwd)/bck/legacy-prototype/dsh-multica-runtime"
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
npm --prefix bck/legacy-prototype test
npx esbuild bck/legacy-prototype/dsh-multica-runtime/entry.ts \
  --bundle --platform=node --format=esm --packages=external \
  --outfile=bck/legacy-prototype/dsh-multica-runtime/dist/index.js
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
