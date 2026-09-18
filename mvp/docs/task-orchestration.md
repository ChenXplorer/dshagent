# Multica 任务编排适配

模块入口为 `packages/task-orchestration/index.ts`，公开 `TaskOrchestrator` 和 DSH Loop 使用的结构接口 `TaskDriver`。它调用 `OfficialMulticaClient` 的真实官方 API，不运行 CLI，不实现队列，也不直接请求模型。

## 与 DSH Loop 的接口

```ts
await driver.run({
  sessionId, requestId, prompt,
  runtime: 'codex', // 或 claude-code；省略时使用持久化选择，随后沿用当前 Runtime
  signal,
}, async (input, binding) => {
  await trajectoryWriter.append(input, { ...binding, turn, step });
});
```

可信 userId 来自构造配置，不接受消息中的 userId。DSH Loop 保存原始 requestId，并负责原生 turn/step/user-message 事件；驱动只发执行轨迹输入。`onEvent` 返回前必须完成真实 DSH 持久化，之后才推进 SQLite 中的 Multica 消息序号。

`driver.selectRuntime(sessionId, runtime)` 在没有活动任务时调用 Multica 官方 runtime 绑定更新，并把选择写入 SQLite。已有 DSH 会话的 Agent 和 Chat Session 不变；只有 Agent 的 `runtime_id` 改变。没有资源的空会话先持久化选择，首个任务创建其官方绑定。

## 幂等、切换与并行

每个请求先持久化意图和待发送 API 消息（含稳定关联 marker），再发送一次 POST。请求状态不明确时，恢复后只调用官方查询对账；查不到不重新 POST。出站消息是必要的事务发送记录，不是一套新的 DSH 会话历史。

同一 DSH 会话始终复用一个 Multica Chat Session。切换 Runtime 只创建本地执行段关联记录，并通过官方 Agent runtime 更新能力重新绑定同一个 Multica Agent；工作目录、Project 和 Chat ID 保持不变。每次出站消息只提交当前用户 prompt，Multica 负责 Chat 历史和 CLI session 的恢复/新建决定，DSH 不再拼接上下文。

不同 DSH 会话并行推进，即使全部选择 Codex 也不会占用同一个平台执行槽位。同一会话存在未完成或待对账任务时拒绝新轮次/切换。持久化准入还阻止两个活跃任务写同一个工作目录；并行修改应由准备流程分配独立目录或 worktree。这是明确拒绝冲突，不是另建排队器；不同目录不受整个用户/沙箱的串行锁限制。

## 装配时必须提供的真实能力

- `ensurePersonalSandbox`：调用 `PersonalSandboxService`，返回用户实际 Daytona 沙箱。
- `provisionExecutionSegment`：通过官方 API 与 Daytona 文件接口准备实际目录、Agent、Project 和 Chat，返回真实关联 ID。驱动先持久化准备意图；`mode: create` 仅对首次预留调用，之后只允许 `mode: reconcile` 的读操作恢复已有资源。没有模拟默认实现。
- `confirmTaskSettled`：正向确认 CLI 进程已结束且轨迹已上报。REST 的 cancelled 状态本身不够，必须结合真实 Daemon/Daytona 检查。未确认时任务保持活跃，阻止沙箱停止。

Windows 上的 Gateway/DSH/Multica API 地址与沙箱能访问的 Windows 主机地址由装配层分别配置。本模块不假设宿主机与 Daemon 使用同一个 localhost。

`createOfficialSegmentProvisioner` 已实现第二个回调：真实 Daytona 文件接口建立每个 DSH 会话的目录，真实 Multica API 创建每会话一个稳定 Agent、Project 和 Chat。Runtime 切换调用官方 `PUT /api/agents/{id}` 更新 `runtime_id`，不创建新的 Chat。使用稳定名称查询并验证 runtime、并发数、目录和 Daemon 归属；拒绝原生 CLI 模型配置覆盖。恢复只读，若上次在多阶段准备中间中断且某个后续资源尚不存在，会保持待对账并要求明确修复；不会把“查询缺失”当作再次创建许可。

生产入口 `apps/dsh-host/create-driver.ts` 导出 `createDriver({ctx})`，从绝对路径环境变量 `DSH_MVP_CONFIG` 读取私有 JSON 并装配三个真实回调。接口 `DeploymentDriverConfiguration` 是配置定义；`DSH_MVP_USER_ID` 若存在必须匹配配置。DSH Context 释放时关闭 SQLite。创建 Driver 本身不会创建个人沙箱。

## 轨迹与错误边界

驱动读取上游持久化 task messages，把 text 投影为 DSH 助手消息。官方未修改版本若提供真实 `call_id`，`tool_use` / `tool_result` 就投影为原生工具调用/结果并保留原文；缺少真实 ID 时继续保留原始事件。仅 `output_truncated: true` 添加截断标记，未提供该字段不声称输出完整。不猜测工具 ID、模型名或 token 数。历史 dshtrace 补丁对 ID/可靠性增加的实验不属于默认依赖。

发生消息序号缺口、持久化失败、未知任务状态、取消未确认或观察截止时抛出 `TaskPendingError` 或原始明确错误，保留活跃记录和原游标。收到完成/失败/取消后先确认进程与上报结束，再做最后一次轨迹读取，最后保存终态；正常完成才返回成功，执行失败或确认取消抛出 `TaskExecutionError`。

取消意图先写入 `cancel_requested`。即使重启后的 AbortSignal 没有取消状态，驱动仍读取这个持久意图，先查询官方任务；尚在活跃状态才重发幂等的取消请求。固定官方源码 `CancelTaskWithResult` 仅更新活跃行，对已经终态的行返回现有任务，因而取消可安全对账重试。取消响应丢失但上游已 cancelled 时只读，不再 POST；提交任务的创建 POST 不因此重发。`TaskExecutionError.outcome` 明确区分 cancelled / failed，DSH 不需解析错误文案。

## 当前测试

```sh
npx tsx --test packages/task-orchestration/index.test.ts packages/persistence/index.test.ts
```

编排测试使用真实 `OfficialMulticaClient` 配合 HTTP 契约夹具以及真实 SQLite 文件，覆盖丢失提交响应后的重连、两个 Codex 会话并发、Claude/Codex 切换再切回、持久化失败后的轨迹重放、缺口、取消进程确认、未知资源准备和工具原始事件保留。它们属于模块测试，不证明真实模型、Daemon、Daytona 或 DSH 页面已验收。
