# Daytona 个人沙箱管理

`packages/sandbox-management/index.ts` 直接调用官方 `@daytona/sdk@0.187.0`，对应部署版本 Daytona v0.187.0、源码提交 `8a446cb96331737e5a2118cbcaa0604d95c07f71`。已核对安装包中的 SDK、API Client 和 Toolbox API Client 都是 0.187.0。未重写 Daytona HTTP 客户端、Runner 或任务执行器。

## 原生能力与业务关联

复用 [官方 Daytona.ts@v0.187.0](https://github.com/daytonaio/daytona/blob/v0.187.0/libs/sdk-typescript/src/Daytona.ts) 的 `create`、`get`、异步迭代 `list({ labels })`，以及 [Sandbox.ts@v0.187.0](https://github.com/daytonaio/daytona/blob/v0.187.0/libs/sdk-typescript/src/Sandbox.ts) 的 `stop`、`start` 和自动生命周期配置。自研仅保存用户归属、创建意图、任务准入条件和执行环境就绪检查。

```ts
const service = new PersonalSandboxService({
  client: new Daytona({ apiKey, apiUrl, target, otelEnabled: false }),
  repository,
  snapshot: configuredSnapshot,
  timeoutSeconds: 60,
  ensureExecutionReady: async (sandbox, userId) => {
    // 接入真实幂等初始化：CLI 配置、工作目录、官方 Daemon 启动与在线注册确认。
    // 这里不能只检查 sandbox.state，也不能提供无操作回调作为部署验收。
  },
});
```

公开方法为 `ensurePersonalSandbox(userId)`、`pausePersonalSandbox(userId)`、`resumePersonalSandbox(userId)`。`ensurePersonalSandbox` 返回真实官方 SDK 的 `Sandbox` 实例，供后续初始化使用；平台任务仍必须由 Multica Daemon 调度。

创建时先在 SQLite 预留唯一用户创建意图，再把 `dsh-mvp-user-id` 和 `dsh-mvp-creation-id` 标签提交到 Daytona。重复请求不重复创建。响应丢失后通过标签查找并使用 `get` 获取完整状态，完成就绪检查才绑定；列表未找到时保持未知状态，不自动再创建。多个匹配或归属不一致明确报错，已有沙箱失联也不自动替换成新沙箱。

## 生命周期与并行任务

创建固定 `autoStopInterval: 0`、`autoDeleteInterval: -1`、`public: false`。`autoArchiveInterval: 0` 表示服务端最大归档间隔，不表示永不归档。没有启用 `ephemeral`，因为它会覆盖自动删除设置。复用时重新检查自动停止和删除配置，避免长任务因为没有 SDK 交互被服务端停止。

MVP 的“暂停”使用官方 `stop()`：空闲时停止沙箱，保留文件；恢复使用 `start()`。**不宣称保存 RAM、CLI 进程或网络连接。** v0.187.0 没有后续版本的 `pause/resume` 方法。恢复后的回调必须重启或检查 Daemon，并验证两个 CLI 配置与工作目录，才能重新开放准入。

停止前 SQLite 原子检查所有活跃任务并关闭准入，因此多个 Codex、多个 Claude Code 或混合任务不受 Runtime 槽位限制，但任意活跃任务会阻止暂停。停止结果不明确时保持 `pausing`，开始结果不明确时保持 `resuming`，仅凭上游确定状态继续对账。

本服务实例按用户协调生命周期网络操作；它不串行化平台任务。调用等待有截止时间；超时不会取消或重发实际 SDK 请求，仍保留未完成操作直到它结束。这使上游慢响应不会被误判为允许新建。重启后依据持久化意图对账；多服务实例执行网络生命周期的完整 fencing 仍需单独实现，当前应只部署一个沙箱管理服务实例。

## 验证状态

```sh
npx tsx --test packages/sandbox-management/index.test.ts
npm run typecheck
```

8 项测试通过，全部使用真实官方 SDK 对本地 HTTP **单元测试夹具**请求，覆盖字段序列化、同用户创建去重、丢失响应后的标签对账、列表暂缺、活跃任务禁止停止、停止/开始后的绑定保持、就绪失败、归属冲突和请求截止后禁止重复创建。

这些测试没有创建真实 Daytona 沙箱，也没有启动真实 Daemon。真实部署验收仍需要已注册 Snapshot、可用 Runner、沙箱内两个 CLI 原生配置、官方 Daemon 注册、文件变更与停止/恢复后的执行证据。
