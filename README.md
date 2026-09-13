# DSH Agent

DSH 基座 + Multica Runtime 插件：用官方 Multica Server/Daemon 调度 Codex / Claude CLI，替换默认 `dsh-agent-loop`。

- 技术方案：[docs/architecture.md](docs/architecture.md)
- 插件入口：`dsh-multica-runtime/`（Cordis `setFactory`）
- 官方控制面客户端：`src/multica/official.ts`
- 原生 DSH Agent：`src/plugin/dsh-native.ts`

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

## 状态

已实现：官方 Multica 控制面、DSH native factory、`user/message` / `assistant/message` 的 `surfaceOp`、会话走通。

仍需：把 Multica Server 绑到本机回环，避免和 DSH web 抢预览入口。
