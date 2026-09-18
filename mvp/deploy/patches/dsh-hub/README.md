# DSH Hub management-only Runtime 与内部回环通信补丁

DSH Hub 1.0.4 的 Node Agent 已经实现 `dsh.plugins`、`dsh.snapshots`、`dsh.files`
和 `dsh.terminals`，但只有 DSH Connector 先登记 Runtime 后才会向 Hub 公布这些能力。
当前 DSH 已移除 Connector 1.0.4 依赖的旧 `ApiProxy`，因此 100 用户 Profile 在 Host
按需停止时无法使用已有的 Node Agent 管理能力。

本补丁只改变 Runtime 公布方式：`management.profiles[]` 中的 Profile 会由 Node Agent
直接公布为 management-only Runtime。用户 Host 运行并连接兼容 Connector 时，真实
Connector baseline 覆盖 management-only baseline；Host 停止后重新退回管理能力。
补丁不实现聊天、Session 或 Web 转发，也不复制 Node Agent 的 Plugin 事务实现。

补丁还修复 DSH Hub 1.0.4 的 Profile Plugin 回滚边界：初始 Profile 没有
`pnpm-lock.yaml` 时，官方 CLI 在恢复依赖后可以重新生成它，但补丁会在校验前移除该临时 lockfile，
从而恢复原始快照哈希。成功回滚后再移除对应 managed Plugin 索引，并从协议响应中排除内部
`checkedAt` 字段。失败路径保留 managed 索引，允许后续按相同锁状态安全重试。

当前 MVP 暂不实现用户鉴权。v4 复用 Hub 已有的 `HubAccessVerifier` 注入点，增加显式
`DSH_HUB_INTERNAL_AUTH=true` 模式，供同一服务器上的 Gateway 和 Node Agent 调用。该模式只接受
`http://127.0.0.1`、`http://localhost` 或 `http://[::1]` 形式的 Public Origin，并同时要求：

- 长度至少 32 的内部控制令牌；
- 独立的 Node Agent Client ID/Secret；
- 原有不少于 32 字符的 Origin Secret；
- Docker/反向代理仍只把 Hub 发布到 loopback。

Gateway 以内控令牌调用真实 Hub API，Node Agent 以 Client ID/Secret 连接；Hub 的节点、能力命令、
Plugin 事务、快照、SQLite 状态和审计实现均保持上游代码。这里没有终端用户登录或权限模型，
也不允许把 Hub 端口直接发布到公网。以后接入 OIDC 时只替换入口身份层。

Node Agent 上游默认只接受 HTTPS。内部模式只额外允许带独立 Origin Secret 的 loopback
HTTP，并自动使用 `ws://`；公网 HTTP、缺少 Origin Secret 的 loopback 配置以及在 HTTPS
配置中直传 Origin Secret 都会被拒绝。

```sh
git clone https://github.com/k1412/dsh-hub.git /opt/dsh-hub
git -C /opt/dsh-hub checkout cc730d0091337767e437e0964c9f93ba3f490de7
node /opt/dshagent/mvp/deploy/patches/dsh-hub/apply.mjs /opt/dsh-hub --check
node /opt/dshagent/mvp/deploy/patches/dsh-hub/apply.mjs /opt/dsh-hub
cd /opt/dsh-hub
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm vitest run packages/hub/hub-server/tests/auth.spec.ts
corepack pnpm vitest run packages/hub/hub-node-agent/tests/state.spec.ts
```

脚本同时锁定上游 commit 和补丁 SHA-256，checkout 不干净、版本不同或补丁锚点变化时
直接拒绝。生产仍应把构建后的 Node Agent 制品固定摘要；不要在运行中的安装目录临时改源码。
