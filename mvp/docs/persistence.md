# 跨框架关联持久化

实现入口：`packages/persistence/index.ts`。使用 [Node.js 22.20 原生 SQLite API](https://nodejs.org/download/release/v22.20.0/docs/api/sqlite.html)，不增加数据库服务或 ORM。正式环境传入 Windows 本地服务的绝对持久文件路径，不能使用 `:memory:`。数据库父目录由装配程序创建，目录权限由部署负责限制。当前 schema version 5，支持从 0、1、2、3、4 迁移；v5 允许同一 DSH 会话的多个本地执行段绑定同一个 Multica Chat Session，并拒绝跨用户/跨 DSH 会话复用。

## 保存范围

| 记录 | 内容 |
| --- | --- |
| `sandbox_bindings` | userId、创建请求 ID、Daytona ID、生命周期状态 |
| `execution_segments` | DSH Session 引用、执行段序号、Runtime、共享 Multica Chat 引用；本地执行段不是新的 Chat Session |
| `task_intents` | 消息请求 ID、所属用户和执行段、提交摘要、沙箱引用、Multica Task 引用、已观察状态 |
| `submission_rejections` | 明确拒绝提交的外部证据引用 |
| `segment_provisioning` | 官方资源准备意图及 Daemon、Agent、Runtime、Project、Chat、工作目录引用 |
| `task_submissions` | 一次性出站 API 消息与稳定 marker，用于断线后精确对账 |
| `task_sync_positions` | DSH 已完成持久化的上游消息序号 |
| `runtime_selections` | DSH 会话下一次执行的用户 Runtime 选择，与活跃任务切换保护 |
| `sandbox_replacements` | 明确授权删除空失败沙箱后的旧创建 ID、已删除沙箱 ID、官方 404 证据引用 |

不复制 DSH 会话历史、工具输出或轨迹，不保存模型凭据。`task_submissions` 仅保留当前用户 prompt 加幂等 marker 的不可变出站 API 消息，使进程重启后可以对账同一个已发送请求；不会保存 DSH 自己拼出的上下文 handoff。DSH 继续作为平台会话和统一轨迹的接收端；Multica 继续作为 Chat 历史、实际执行和队列状态的权威来源。本模块没有调度队列，也不会启动、重试或取消远程任务。

## 沙箱创建约定

```ts
const repository = new CorrelationRepository('C:/Users/zcxu/Documents/dshagent/.runtime/driver/correlations.sqlite');
const reservation = repository.reserveSandbox(userId, creationRequestId);
```

只有 `created: true` 的调用者可以发送一次 Daytona 创建请求。`reserveSandbox` 先提交 `creating` 状态，用唯一 userId 和 SQLite 写事务保证不同数据库连接同时请求时只有一个成功者。既有记录返回 `created: false`，包括重启后留下的 `creating`；不能据此再次创建。

收到确定结果后调用 `completeSandboxCreation(userId, creationRequestId, sandboxId)`。创建 ID 不符或已经绑定时返回 `false`，不会覆盖现有绑定。请求超时可调用 `markSandboxCreationUnknown`；恢复后必须以保存的用户/请求标识查询上游。查询暂未找到不等于创建从未发生。当前没有自动过期、抢占或重试创建接口，避免把不明确状态变成重复个人沙箱。

## 任务提交约定

先用 `putExecutionSegment` 保存不可变执行段引用，再调用：

```ts
repository.reserveTask({ requestId, userId, segmentId, inputDigest });
```

`inputDigest` 为逻辑命令的 SHA256，应涵盖消息内容及影响执行的参数。相同请求 ID 只能引用相同用户、执行段和摘要；不一致会报冲突。新意图先写入 `reserved`。只有本次 `created: true` 的调用者发送一次 Multica 请求；其他调用者先查询或对账，不盲目重发。`reserved` 也可能是“远程已收、本地未写回”的状态，不能当作未提交。

`completeTaskSubmission(requestId, externalTaskId)` 以比较并更新方式绑定上游 Task；已有绑定不能被替换。`markTaskSubmissionUnknown` 保留不明确状态。明确拒绝可以通过 `confirmTaskSubmissionRejected` 保存外部证据引用并终结意图；超时、断连或列表暂缺不构成拒绝证据。即使已经失败，重复请求也不会循环使用原幂等键再次执行。

任务状态使用 `updateTaskState(requestId, expectedState, nextState)` 比较并更新，旧事件不能覆盖已改变状态。终态不重新变成运行态。`cancel_requested` 仍算活跃，只有上游确认结束后才释放暂停条件；取消一个任务不修改其他任务。

## 暂停与恢复

`beginSandboxPause(userId)` 在一个 `BEGIN IMMEDIATE` 事务中检查该用户的全部活跃任务并把沙箱改为 `pausing`。`reserveTask` 也通过写事务检查 `ready`，因此其他连接不能在暂停检查和任务准入之间穿插创建意图。`reserved`、`submission_unknown`、已提交、排队、运行和取消待确认都阻止暂停；不会因为任务尚无上游 ID 而漏算。

提交暂停请求前先调用 `beginSandboxPause`；确定暂停后调用 `completeSandboxPause`。恢复先 `beginSandboxResume`，确认上游沙箱、Daemon、CLI 配置和目录全部就绪后再 `completeSandboxResume`。暂停请求失败后只有正向就绪证据才能调用 `reconcileSandboxReady(userId,sandboxId)`。状态不明确时保持禁止新任务准入。

生命周期调用必须由沙箱管理服务按用户协调；本模块提供状态比较，不创建后台操作线程。已有方法适合单服务实例串行协调每个用户的生命周期，多实例跨网络操作的 fencing token 仍需在部署扩展时增加，不能把数据库原子准入误当作远程调用的分布式锁。

## 一次性空失败资源修复

常规服务不会调用 `clearUnboundSandboxAfterVerifiedDeletion`。它是明确授权的操作员修复边界，仅在官方接口删除了尚未完成绑定的空失败沙箱、且独立 GET 确认 404 后使用。比较的用户和创建 ID 必须一致，状态必须是 `creation_unknown`，sandboxId 必须为空，而且该用户不得有任何执行段或任务引用。事务先写不可覆盖的删除证据审计，再清理这个无引用预留；后续原生 DSH 恢复可以重新获得一个正常创建预留。已有绑定、任务数据或归属变化一律拒绝，不支持定时/盲目重试。首次真实部署的 Daytona 启动超时使用过这个明确修复流程，原始失败及删除证据均保留。

## 验证

```sh
node --experimental-strip-types --test mvp/packages/persistence/index.test.ts
```

12 项真实 SQLite 文件测试通过，包括两个独立连接、两个 Worker 同时争抢用户沙箱、进程连接重开后的意图保留、暂停和任务准入互斥、同类任务并行状态独立、用户归属冲突、外部 ID 唯一约束、未知提交禁止自动失败与重试、工作目录准入、出站消息/游标、持久化 Runtime 选择、空失败资源修复的审计及拒绝条件。

这些是持久化模块验证，不代表 Daytona、Multica 或 DSH 已端到端验收。文件启用 WAL、外键、FULL 同步和 5 秒忙等待；数据库与其 WAL 文件属于同一持久化数据目录，备份应通过 SQLite 备份接口或停服务后的完整备份完成。
