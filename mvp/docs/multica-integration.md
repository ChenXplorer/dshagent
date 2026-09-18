# 官方 Multica 接入依据与当前边界

核对日期：2026-09-14。固定源码提交：`8908fcfbc43d18fc515dec747a100fecccc33556`。上游仓库为 [multica-ai/multica](https://github.com/multica-ai/multica/tree/8908fcfbc43d18fc515dec747a100fecccc33556)。本地克隆在项目同级 `dshagent-upstream/multica`，不作为本项目运行时依赖。

本次新增 `packages/multica-client` 直接使用官方 REST API。没有复制调度器、Daemon、数据库、CLI 循环，也不依赖旧的 `bck/legacy-prototype/src/sim` 或自建 control-plane。上游 `packages/core/api/client.ts` 是面向其前端的完整业务客户端，不是独立服务端 SDK；这里只封装实际需要的 API，并验证关键响应字段。

**当前默认部署不修改 Multica 源码。** Server、Daemon 和 CLI 使用官方发布/固定提交的未打补丁版本；本项目通过官方 REST、Task 状态/消息 API 和 DSH 侧的进程核验完成执行与轨迹同步。仓库中的 `dshtrace1/dshtrace2` 仅是可选的历史可靠性实验，不能作为默认安装步骤，也不能把其验收结果当作未修改上游的保证。

## API 与身份

业务请求携带 `Authorization: Bearer <token>` 和 `X-Workspace-ID: <workspace-id>`。服务端固定用户必须使用有权调用对应私有 Agent 的身份。token 放在部署环境/凭据文件中，不进入 Git、普通日志或 DSH 轨迹。

| 能力 | 官方 API | 本项目使用方式 |
| --- | --- | --- |
| 查执行节点 | `GET /api/runtimes` | 严格匹配 `daemon_id`、`provider` 与可选 `runtimeId`，要求 `status=online` 和新鲜 `last_seen_at`；不按名称选第一个 CLI |
| 创建执行 Agent | `POST /api/agents` | 绑定准确 `runtime_id`，明确 `max_concurrent_tasks>=2`；不发送 `model`、`custom_env`、`custom_args` 覆盖 CLI 原生模型配置 |
| 固定工作目录 | `POST /api/projects` | 原子创建带 `local_directory` resource 的项目，`resource_ref={local_path,daemon_id,execution_mode:"in_place"}` |
| 创建 DSH 会话载体 | `POST /api/chat/sessions` | 每个 DSH 会话只创建一次，发送稳定 Agent、Project 和 `title`；返回的是 Multica Chat ID，**不是 CLI 内部 session ID** |
| 切换执行 Runtime | `PUT /api/agents/{id}` | 只发送 `runtime_id`，让同一个 Multica Agent 改绑到 Daemon 上已注册的 Codex/Claude runtime；不创建新 Chat、不传上下文 |
| 发任务 | `POST /api/chat/sessions/{id}/messages` | 官方只支持 `content`、`attachment_ids`；返回 `message_id`、`task_id`、`queued` |
| 提交对账 | `GET /api/chat/sessions/{id}/messages` | 用户消息带 `task_id`；用持久化发送意图的完整内容与关联标记精确匹配 |
| 查询执行状态/用量 | `GET /api/agents/{id}/tasks?include_usage=true` | 查对应 task，校验 agent、chat、runtime 绑定；缺失不当作已完成 |
| 轨迹补传 | `GET /api/tasks/{id}/messages?since=<seq>` | 官方返回 `seq > since` 的持久化事件；保留未知 type、工具输入/结果和截断标记 |
| 单任务取消 | `POST /api/tasks/{id}/cancel` | 先核对任务绑定，只取消该 task；不调用 Agent 全量取消接口 |

以上依据：[router.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/cmd/server/router.go)、[runtime.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/handler/runtime.go)、[agent.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/handler/agent.go)、[chat.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/handler/chat.go)、[project.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/handler/project.go)。

## 当前使用的是 Chat 入口，不是 Work/Issue 入口

Multica 的官方模型是“直接对话（Chat）”和“正式任务（Issue）”两种触发方式。当前 MVP 使用 `POST /api/chat/sessions/{id}/messages`，因此属于 Chat 入口；我们没有调用 Issue 创建、任务分配或评论触发 API。

Chat 消息到达服务端后，Multica 仍会为每条消息创建一个内部 Task/Run，用于排队、执行、状态和 transcript。这是 Chat 的执行记录，不等于看板里的正式 Issue。当前链路是：

```text
Chat Session C1
  ├── message M1 → internal Task T1 → Runtime/Daemon
  ├── message M2 → internal Task T2 → Runtime/Daemon
  └── message M3 → internal Task T3 → Runtime/Daemon
```

因此，简单问答、需求讨论、临时小修改已经可以直接使用当前 Chat 路径；不需要额外创建 Work/Issue。只有需要负责人、状态、优先级、审核和团队协作记录时，才需要新增 Issue/Work 适配。Project 的 `in_place`/`worktree` 是目录执行模式，和 Chat/Issue 不是同一层概念。

## 并行、文件连续性与 Runtime 切换

官方 Daemon 有全局任务并发额度，`--max-concurrent-tasks` 默认 20；Agent 自身默认并发为 6，允许 1–50。MVP 配置按机器资源降低额度，但至少为 2。两个 DSH 会话可共用同一 daemon/runtime/agent，但每个 DSH 会话各自绑定一个 Multica Chat 和对应的 CLI 执行状态；没有每种 Runtime 只能执行一个任务的限制。依据：[并发常量](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/agentconfig/concurrency.go)、[Daemon](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/daemon/daemon.go)。这只是源码能力证明，实际执行时间重叠仍需端到端验收。

推荐通过 Daytona 官方进程/文件 API 为每个 DSH 会话先准备独立的稳定目录或 Git worktree，然后为该目录创建 `in_place` 项目资源。一个 DSH 会话创建一个 Multica Agent、Project 和 Chat；Runtime 切换只更新 Agent 的 `runtime_id`，复用原 Chat、Project 与目录。每次消息只提交当前 prompt，Multica/Daemon 负责历史读取和 provider 原生 session 的恢复或新建。

**不能假设官方目录锁保护聊天任务。** 当前 `localDirectoryLockExempt` 明确将 chat task 排除在 in-place 目录互斥之外。独立会话应分配独立目录；确需共用目录时，平台必须只针对这个写入目录做协调。不能用全沙箱串行替代并行目标。官方 `worktree` 项目资源也可用于任务隔离，但其任务结束会提交并移除临时 worktree，不宜直接当作 Runtime 切换后仍存续的同一目录。依据：[local_directory.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/daemon/local_directory.go)、[execenv/local_worktree.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/daemon/execenv/local_worktree.go)。

## 提交不明确与轨迹可靠性

`prepareSubmission` 为 `(chatSessionId, requestId)` 生成稳定 SHA-256 HTML 注释标记，附在官方消息内容后。该标记会进入 Multica/CLI 上下文，用于没有原生 idempotency 字段时的最小关联。调用者必须先持久化完整 intent，并通过数据库保证同一 intent 只有一个首次发送者。HTTP transport、5xx 或返回体损坏时返回 `unknown`，**不自动重发**。重启后 GET 消息对账；暂未观察到、多个匹配或对账失败均保持待对账，不据此宣称没有执行。

事件稳定标识为 `multica:{taskId}:message:{seq}`，由 DSH 适配器持久化去重。只有 DSH 写入成功才提交同步游标。缺少的 seq 形成明确 gap，适配器不把游标推进过 gap；未知事件保留原始类型，不能改装成普通文本。工具的 `output_truncated` 缺失表示未知，不解释为完整。网络错误必须让上层进入断连/待恢复状态。

**官方未修改版本的可靠性边界：** `?since` 只能读取已经写入 Server 的消息；上游没有提供任务级 outbox 状态，长时间断线或 Daemon 崩溃时，平台必须保持“待对账/未知”，不能仅凭最终文本宣称轨迹完整。DSH 适配器会保存发送意图、同步游标，并在任务终态后读取完官方消息；没有增强健康字段时，再用沙箱进程核验作为保守收尾证据。可选的 `dshtrace1/dshtrace2` 历史实验及其额外保证见 [轨迹补丁说明](multica-trace-durability.md)，不属于默认路径。

取消接口先将 Server task 标为 cancelled，Daemon 随后中断目标 CLI 并调用内部 `cancel-ack`。用户 API 没有等价的进程结束确认字段。因此本适配器明确返回 `executionStopped: "unverified"`。在沙箱暂停/后续同目录写入/切换前，还要从真实 Daemon 或 Daytona 进程事实验证结束，不能只看到 cancelled 就认为子进程退出。实际停止一个 Codex 时另一 Codex 继续执行仍是必做验收。

## 原生配置与部署

源码要求 Go **1.26.6**。官方自托管数据库为 PostgreSQL 17，需要 `pgcrypto`，搜索回退使用 `pg_trgm`，不要求 pgvector。当前部署布局为 Windows 原生 Server、Ubuntu Docker PostgreSQL、Daytona 内 Linux Daemon。按固定官方提交构建即可；只有选择历史可靠性实验时才参考 [轨迹补丁说明](multica-trace-durability.md)。服务启动示例（先加载私有配置，并以官方 `server/` 为工作目录）：

```sh
# 在固定官方提交源码目录；默认不应用本项目 Multica 补丁。
cd server
# DATABASE_URL/JWT_SECRET/PORT 等由权限受限环境文件加载，不在命令中写真实凭据。
multica-migrate.exe up
multica-server.exe
```

服务端健康接口为 `GET /health`。数据库应为本项目专用实例/目录，不能借用未经授权的其他实验服务数据库。

部署验收还须请求 `GET /readyz`，确认数据库和全部 SQL 迁移可用；只验证进程存活不足以证明服务可接任务。

### 本地身份初始化

可使用官方开发邮件模式初始化本地用户，不需要外部邮箱：启动 Server 时确保其进程环境没有 `SMTP_HOST`、`RESEND_API_KEY`，设置 `ALLOW_SIGNUP=true`、`DISABLE_WORKSPACE_CREATION=false`。此时官方 `EmailService.SendVerificationCode` 仅将验证码写到 Server stdout，不向外发信。日志保存于私有运行目录。

1. `POST /auth/send-code`，JSON 为 `{"email":"dsh-mvp@example.invalid"}`。
2. 从私有 Server 日志取得实际六位验证码，再 `POST /auth/verify-code`，JSON 为 `{"email":"dsh-mvp@example.invalid","code":"<private-code>"}`。响应包含 `token` 和 `user`。
3. 使用响应 JWT 的 `Authorization: Bearer ...` 请求 `GET /api/workspaces/`，按 `slug` 对账；不存在时 `POST /api/workspaces/`，JSON 为 `{"name":"DSH MVP","slug":"dsh-mvp"}`。保存返回的 workspace ID。
4. `POST /api/tokens/`，JSON 为 `{"name":"dsh-mvp-daemon","expires_in_days":90}`。仅首次响应包含完整 PAT；直接写入私有配置，不能写入仓库或输出给终端。重复部署应复用已有私有凭据，不重复创建 token。

官方还支持非 production 的 `MULTICA_DEV_VERIFICATION_CODE` 六位固定码，但仍必须先调用 send-code 创建有效 DB 记录。优先使用实际随机验证码与私有日志，避免长期固定码。以上路由和行为依据固定版本 `server/cmd/server/router.go`、`internal/handler/auth.go`、`workspace.go`、`personal_access_token.go` 和 `internal/service/email.go`，没有绕过官方身份 API 或直接插入用户表。

本项目的 `mvp/deploy/multica/bootstrap-local.mjs` 已封装这些官方请求。从项目根目录执行 `node mvp/deploy/multica/bootstrap-local.mjs`，默认读取私有 `.runtime/multica/server.stdout.log` 并写入 `.runtime/multica/auth.json`；可通过 `--base-url`、`--log`、`--output` 调整。脚本只接受 loopback Server，先检查 `/readyz` 和最新日志中的 DEV 邮件模式，不输出验证码/JWT/PAT。重复执行先验证并复用现有身份。首次创建前持久化 intent；若中途失败，禁止盲目重试，使用已保存的私有 login 响应对账官方资源。Windows 文件权限依赖私有运行目录 ACL，Linux 文件创建权限为 `0600`。

把同版本官方 `multica` 二进制及真实 Codex、Claude CLI 放进 Daytona 模板。以下步骤都在**沙箱内**完成：

1. 用 `multica config set server_url` / `app_url` 指向控制面可达地址。
2. 通过官方 `multica login` 或 `multica login --token` 登记凭据与 workspace。自动部署也可按官方 `CLIConfig` schema 写入权限为 `0600` 的 `~/.multica/config.json`；token 不打印到构建日志。
3. 设置固定、持久化的 `MULTICA_DAEMON_ID`，关联用户个人 sandbox ID；不同沙箱实例不能复用仍在线旧实例的身份。
4. 设置 `MULTICA_WORKSPACES_ROOT` 指向持久化沙箱数据；Codex 原生源配置放 `CODEX_HOME` 或 `~/.codex`，Claude 原生配置放其配置目录。
5. 用 `multica daemon start --foreground --no-auto-reload --max-concurrent-tasks 2 --daemon-id <persisted-daemon-id>` 启动正式官方 Daemon；不要把 daemon 启在 Ubuntu 控制面宿主机代替沙箱。
6. 等待 `/api/runtimes` 出现对应 daemon 下两个在线 provider，再创建 Agent。注册、心跳、任务 claim 均由官方 Daemon 自己执行，不由本项目伪造注册。

**Daemon 认证读取持久化 CLI config token，不读取 `MULTICA_TOKEN` 环境变量。** `MULTICA_TOKEN` 还有任务级身份用途，不能拿它替代 daemon 登录。官方注册/心跳入口是 `/api/daemon/register`、`/api/daemon/heartbeat`，由官方二进制管理。依据：[CLI config](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/cli/config.go)、[daemon CLI](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/cmd/multica/cmd_daemon.go)。

官方 Daemon 自己为 Codex 创建隔离的任务 `CODEX_HOME`，从源 home 复制 `config.toml`，共享必要 auth，避免并行会话混用可变状态。Agent `custom_env.CODEX_HOME` 被官方阻止，不能依赖该旧方案。不要设置 Multica model override；Claude/Codex 原生配置及 DeepSeek 协议兼容验证由 CLI 配置模块完成。依据：[codex_home.go](https://github.com/multica-ai/multica/blob/8908fcfbc43d18fc515dec747a100fecccc33556/server/internal/daemon/execenv/codex_home.go)。

## 当前验证

已实现官方 REST 薄适配与 15 个契约单元测试：精确 daemon 路由、并发参数、目录绑定、未知提交恢复、认证失败、异常响应、事件重放/缺口、未知事件、按任务取消、绑定校验以及只读资源对账。运行：

```sh
node --experimental-strip-types --test mvp/packages/multica-client/client.test.ts
```

这些 HTTP fixture 测试**不证明真实框架已部署、CLI 可调用 DeepSeek、取消已杀死进程或两任务真实并行**。实际部署和端到端验收应分别记录证据；历史补丁及真实数据库测试结果见可靠性文档。
