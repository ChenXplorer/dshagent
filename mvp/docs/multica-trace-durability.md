# Multica 官方轨迹可靠性补丁

> **历史/可选实验，不是当前 MVP 默认部署路径。** 目标约束是不修改 Multica 源码；生产默认使用官方未打补丁的 Server/Daemon，通过官方 Task 状态与消息 API、DSH 持久化和沙箱进程核验工作。下面的 `dshtrace1/dshtrace2` 仅记录曾经验证过的可靠性实验，供需要评估上游缺口时参考；选择它就意味着维护自定义 Multica 构建，必须单独审批、回归和回退。

补丁基线：官方 `multica-ai/multica` 提交 `8908fcfbc43d18fc515dec747a100fecccc33556`。轨迹补丁 ID：`dshtrace1`；后续进程清理增量补丁：`dshtrace2`。源代码和官方许可证保留；补丁修改正式 Server/Daemon 的现有事件通路，没有替代框架或另建执行器。

## 问题与修改

官方 `server/internal/daemon/daemon.go` 的 `flush` 在 HTTP 上报前清空 batch，上报失败仅记录日志。官方 `server/pkg/db/queries/task_message.sql` 原注释明确说明失败 batch 不重试、整个批次可能丢失；没有 `(task_id,seq)` 唯一约束，直接添加重试还会导致丢失 HTTP ACK 后重复插入。此外，CLI 内部真实 `CallID` 到 Daemon 后没有继续发送，无法可靠关联并行的同名工具调用。

本补丁包含以下必要变化：

1. 官方 Daemon 将已形成的 batch 先脱敏并持久化到 `MULTICA_WORKSPACES_ROOT/.transcript-outbox/<server-daemon-profile-hash>/`。文件权限 `0600`，目录 `0700`；先写临时文件、同步文件、原子重命名，再同步 Linux 目录。
2. 官方 HTTP 成功后才移除文件。失败文件由 Daemon 内部每两秒重试，重启后扫描恢复。一个任务失败不会阻止其他任务的文件被重试。永久 HTTP 拒绝也保留记录并报告错误，不能当作已交付而丢弃。
3. 迁移 `479` 创建独立的并发唯一索引 `(task_id,seq)`。原批量 SQL 通过 `ON CONFLICT DO NOTHING` 保留首次记录，仍然一个语句原子写入；只广播本次新增的事件，重试不会再次广播旧行。
4. 迁移 `478` 增加 `call_id`。从 CLI `Message.CallID` 到 Daemon、官方 API、数据库和公共任务消息保持同一字段。旧事件缺失此字段仍为未知，不能由工具名称/顺序猜测。
5. Daemon 的现有本地 `/health` 增加 `transcript_pending_by_task`、`transcript_outbox_error`、`active_task_ids` 和 `claims_in_flight`。DSH 完成轨迹同步前应检查目标任务没有未交付批次，再读取最终游标之后的官方消息。任何未完成任务存在时禁止暂停整个个人沙箱。
6. 磁盘持久化失败会取消当前 Agent 并返回明确错误，避免静默宣称完整；后台重试有上下文期限，不无限阻塞任务取消。

`active_task_ids` 表示官方 `handleTask` 的生命周期，不是独立操作系统进程审计。官方底层存在有界排空超时，因此不能仅据该列表断言任何失控子进程均已被清理。真实 Codex/Claude 的取消仍需 Daytona 进程检查及并行任务不受影响的端到端验证。

## 应用与构建

使用干净的官方 Git checkout：

```sh
git checkout --detach 8908fcfbc43d18fc515dec747a100fecccc33556
node mvp/deploy/patches/multica/apply.mjs /path/to/multica --check
node mvp/deploy/patches/multica/apply.mjs /path/to/multica
```

脚本校验基线提交、补丁 SHA-256 和干净工作区；重复应用返回 `already-applied`，不覆盖用户修改。不能把补丁套在其他上游版本上继续运行。

SQL 生成代码已用官方要求的 **sqlc v1.31.1** 重新生成。构建使用 **Go 1.26.6**：

```sh
cd /path/to/multica/server
go build -ldflags '-X main.commit=8908fcfbc43d18fc515dec747a100fecccc33556 -X main.version=dshtrace1' -o multica-server.exe ./cmd/server
go build -o multica-migrate.exe ./cmd/migrate
# Windows PowerShell cross-build: $env:GOOS='linux'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
# Linux shell equivalent:
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags '-X main.commit=8908fcfbc43d18fc515dec747a100fecccc33556 -X main.version=dshtrace1' -o multica-linux-amd64 ./cmd/multica
```

Windows 上运行真实 Server；PostgreSQL 在 Ubuntu Docker 内；Linux `multica` 在真实 Daytona 沙箱内运行。先在专用数据库执行带补丁的 `multica-migrate up`，再启动同版本 Server，最后启动补丁 Daemon。不要让补丁 Daemon 向未迁移的旧 Server 发送重试批次。

**SQL 文件没有嵌入二进制。** 迁移工具和 Server readiness 都调用官方 `internal/migrations.ResolveDir`：从工作目录与可执行文件目录向上查找 `migrations/` 或 `server/migrations/`。部署必须把补丁后的完整 `server/migrations/` 复制到二进制旁的 `migrations/`；也可以明确以官方源码 `server/` 为工作目录。仅复制 exe 后从任意目录运行会报 `migrations directory not found`。当前本地构建包 `dshagent-upstream/build/multica/` 已同时包含完整迁移目录。

已有数据库若有重复 `(task_id,seq)`，唯一索引迁移会失败，不能自动删除真实历史。需先报告重复记录并审核处理；新部署的空数据库没有这个遗留问题。迁移回滚会移除 call_id 列，属于数据变更，不能作为自动失败恢复策略。

## 验证命令与结果边界

```sh
cd /path/to/multica/server
go test ./internal/daemon/transcriptoutbox -count=1 -v
go test ./internal/daemon -run 'TestTranscript|TestHealthHandler|TestExecuteAndDrain_(FlushesTranscriptBeforeReturningResult|ContextCancelled_FlushesPendingTranscript|ReportsPerEventTimestamps|SeqContinuesAcrossRetry)' -count=1 -v

# 仅针对本项目专用、完成迁移的测试数据库设置 DATABASE_URL。
go test ./internal/handler -run 'TestReportTaskMessagesRetryIsIdempotentAndPreservesCallID|TestReportTaskMessagesPersistsWholeBatch|TestReportTaskMessagesPublishesInSeqOrder|TestCreateTaskMessagesBatchIsAtomic' -count=1 -v
```

已通过：4 个实际 Go outbox 测试（ACK 丢失与重启补传、并发独立任务、幂等持久化、写失败/损坏记录）；3 个官方 Daemon 集成单元测试（HTTP 503 后重放与真实 call_id、生产 Daemon 装配 outbox、健康状态暴露）；受影响的已有排空、顺序与健康检查回归。Windows Server/迁移工具及 Linux amd64 Daemon 已实际编译成功。

随后在 Ubuntu Docker 的真实 PostgreSQL 17 专用 `multica_test` 数据库执行官方迁移至 479，上述 4 个数据库测试已逐项 PASS，包括重复上报只插入一次、真实 call_id 保留、批次原子写入与发布顺序。测试数据库通过 Windows SSH 本地端口访问；凭据只从私有配置加载，未写入代码或测试输出。真实 CLI 与 DSH 的断线补传集成验收结果另见下节，不能以数据库测试代替。

## 保证范围

- 成功 `Persist` 后的批次，在保留沙箱持久化磁盘的情况下可以重放。Windows 工具测试跳过目录 fsync；正式 Daemon 运行在 Linux 并同步目录。
- CLI 已产生但还在原有约 500ms 聚合缓冲区、尚未形成并持久化 batch 的内容，进程突然崩溃仍可能丢失。补丁没有宣称任意进程崩溃下零丢失。
- 任务执行完成和轨迹交付完成是两个事实。Server 不因等待离线 Daemon 而伪造完成事件；DSH 必须在有 pending/outbox error 时继续显示同步待完成。
- Outbox 不存账号凭据，消息使用官方脱敏器处理，但仍包含任务内容；不得把 spool 目录加入 Git 或普通部署产物。
- 不自动清理未 ACK 的记录。持续离线时需要监控磁盘余量；删除用户沙箱前必须确认没有未交付轨迹。
- 补丁持久化的是 task message 批次，**不包含官方终态 CompleteTask/FailTask 报告**。固定版本 `daemon.go` 的 `reportTaskResult` 在成功结果的瞬态上报重试耗尽后，明确保留 Server task 为 running；不能据 CLI 文件或 outbox 已清空推断 completed。长期断线期间恰好完成的任务仍需正面的终态对账，当前不能宣称完整终态恢复。

## 真实断线验收

`mvp/tests/run-outbox-replay-acceptance.ts` 于 2026-09-14 通过真实验收。它只在既有个人沙箱无其他活动任务时，提交一个真实 Codex 请求，要求两次独立无害工具调用：第一段结果在专用 Windows Multica Server 停止期间产生；第二段保持最终屏障。必须观察同一任务 `transcript_pending_by_task > 0`、实际第二段启动标记及活动任务事实，然后恢复 Server，确认 outbox 补传清空，最后才释放结束屏障。

脚本使用 `mvp/deploy/windows/control-acceptance-service.ps1` 操作已经登记的本项目进程。停止前验证 PID 文件、真实可执行文件路径和监听端口；DSH 还验证启动脚本路径，拒绝操作其他同名 Node 进程。恢复观察通过重启原生 DSH Host，再向 Gateway 提交**相同 requestId、相同 prompt**，触发官方原生激活和幂等对账；不是新任务请求，不能触发第二次 Multica message POST。前后使用官方消息对账确认唯一 messageId/taskId 不变，最终验证官方事件连续、DSH 游标追平、原生 JSONL 投影无重复与真实工具调用配对。

短断线测试不覆盖上一节的长期终态上报缺口。任何断线、超时、原生恢复失败或证据缺失都保持未完成/未知，不能写入完成结论。该脚本需要与其他真实验收串行协调后显式运行。

本次实际结果：Server 停止期间捕获到 pending=1 且同一任务仍 active，恢复后 pending=0；DSH 冷恢复使用原 requestId，官方唯一 messageId 与 taskId 前后完全一致。轨迹游标从 1 追至 8，官方事件连续且全部进入原生 DSH 投影，无重复。原生最终 32 个事件、2 对真实工具调用、最终 OUTBOX 标记齐全，原用户请求与 turn 各一次，turn 已关闭。原生诊断保留实际 `ECONNREFUSED`，随后同任务恢复 completed。验收脚本退出码 0，私有 `outbox-replay.json` 为 `complete:true`；独立原生与 Gateway 证据为 `outbox-settled.json`、`outbox-gateway-proof.json`。两项服务均已恢复。

服务启动的 PowerShell 子命令回收在本次两次启动中各延迟约 60 秒，实际服务更早已监听；这延长了验收耗时，但原最终屏障保持且没有重复启动或重复提交。补传成功不表示长时间离线下的终态报告也已持久化。

## dshtrace2：Codex 正常退出后的后台进程清理

真实三任务队列验收确认了两槽执行、第三任务排队及释放后执行，但第一次收尾超时：Codex 自动下载 `openai/plugins.git` 的 4 个 Git 子进程在主 CLI 退出后仍运行，带有该任务的 `MULTICA_TASK_ID`，已经成为孤儿进程。DSH 正确保持待收尾。保留失败证据后，以 pidfd、任务环境标记、PPID、进程组和启动时间逐一核验并清理了这 4 个进程；原 DSH 观察器自然完成，无重启、重发或伪造终态。原始 `queue-acceptance.json` 保持 `complete:false`，恢复后的原生轨迹和 Gateway 证明单独保存。

增量补丁仅修改官方 `server/pkg/agent/codex.go` 的 `drainAndWait`：主进程 `Wait` 返回后，调用现有 `signalProcessGroup(SIGKILL)` 清理该次启动的剩余进程，再调用原有 `waitProcessGroupGone`。不改变 CLI 配置或禁止插件。Unix 每次启动已有独立进程组，Windows 使用已有 Job Object；其他任务不在该组内。主动脱离进程组的后代不在这一修复的保证内，平台仍通过真实任务进程审计保持保守收尾。

先应用 `dshtrace1`，再执行：

```sh
node mvp/deploy/patches/multica/apply-process-cleanup.mjs /path/to/official-multica --check
node mvp/deploy/patches/multica/apply-process-cleanup.mjs /path/to/official-multica
cd /path/to/official-multica/server
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags '-X main.commit=8908fcfbc43d18fc515dec747a100fecccc33556 -X main.version=dshtrace2' -o multica-linux-amd64-dshtrace2 ./cmd/multica
```

应用器核验固定提交、两个补丁校验和、已应用的 `dshtrace1`、原始 Codex 文件校验和，并拒绝覆盖已有测试文件；在独立检验工作树上完成 applicable → applied → already-applied 验证。`dshtrace2.manifest.json` 保存补丁和二进制 SHA256。原 `dshtrace1` 二进制与 Daytona 快照不覆盖；现有沙箱可在所有任务收尾后使用不同文件名的运行时升级，版本必须由真实健康检查确认。

通过官方 SDK 将交叉编译的 Go 测试二进制放入同一 Linux 沙箱 `/tmp`，真实运行以下回归，无模型调用：新增两个分支验证正常退出/中断后后台子进程消失且另一独立 runtime 进程存活；已有并发启动、取消及用量保留、初始化取消/超时的敏感信息保护共 4 项回归均 PASS。同一新增测试在原 `dshtrace1` 上两个分支均 FAIL，明确复现孤儿进程，并由测试自身清理其进程组。证据分别为私有 `dshtrace2-regression.log`、`dshtrace2-existing-regression.log` 与 `dshtrace1-negative-regression.log`。

随后升级同一真实个人沙箱 Daemon 至 `dshtrace2`，于 2026-09-14 执行第二次真实 CLI 队列验收：`queue-dshtrace2.json` 为 `complete:true`，验收进程退出码 0。三个不同 DSH 会话均使用 Codex 与原生 DeepSeek 配置；A/B 实际命令并行时 C 保持官方 queued、尚无启动标记；释放 A 后 C 开始执行且 B 仍在运行，实际时间区间没有三任务重叠。三个任务最终均为官方 completed、平台 completed、Daemon 活动列表为空，完全自动完成进程清理和 DSH 收尾，没有人工清理、服务重启或请求重放。首次失败与精确清理记录保留，不覆盖为成功。
