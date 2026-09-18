# DSH Hub 控制面

本项目通过 `packages/dsh-hub-control` 调用社区 DSH Hub 的公开 `/hub/v1/*` API，不复制 Hub 的 Node Agent、签名 WSS 或 SQLite 实现。当前验证的上游提交是 `cc730d0091337767e437e0964c9f93ba3f490de7`（`k1412/dsh-hub`）；该项目不是 DeepSeek 官方产品，生产部署应固定提交并自行评估维护风险。

在服务器单独目录部署官方 Hub：

```sh
git clone https://github.com/k1412/dsh-hub.git /opt/dsh-hub
git -C /opt/dsh-hub checkout cc730d0091337767e437e0964c9f93ba3f490de7
node /opt/dshagent/mvp/deploy/patches/dsh-hub/apply.mjs /opt/dsh-hub
cd /opt/dsh-hub
corepack enable
pnpm install --frozen-lockfile
pnpm run hub:server:build
```

仓库也提供了可复用的 Compose 模板。当前 MVP 暂不接入用户鉴权；浏览器固定使用模拟用户。
把 `.env.example` 复制为服务器私有的 `.env`，生成三份独立随机值作为内部操作令牌、Node Secret
和 Origin Secret，再启动 Hub：

```sh
cp .env.example .env
chmod 600 .env
# DSH_HUB_SOURCE must point at the pinned upstream checkout when building the
# image locally. Keep the checkout outside this MVP repository.
# git clone https://github.com/k1412/dsh-hub.git /home/dev/dsh-hub
# git -C /home/dev/dsh-hub checkout cc730d0091337767e437e0964c9f93ba3f490de7
# On the reviewed Ubuntu target, use the existing rootless Docker data-root
# under /home; the named Hub volumes are created there instead of in the full
# root partition.
export DOCKER_HOST=unix:///run/dshagent-docker/docker.sock
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml build
docker compose -f compose.yaml up -d
```

`compose.yaml` 只把 Hub 绑定到回环地址，Hub 不作为用户入口。若目标端口已被占用，修改 `.env` 中的
`DSH_HUB_BIND_PORT`，并同步 Gateway 的 `hub.baseUrl`。生产环境把 `DSH_HUB_IMAGE` 固定为已审核的
不可变 digest；示例中的本地 tag 只用于首次构建验证，不能作为生产版本策略。Hub 状态和备份使用
Compose named volumes，存储位置由选定的 Docker data-root 决定；生产环境必须把该 data-root
放在有足够空间的持久文件系统上。

当前配置使用 `DSH_HUB_INTERNAL_AUTH=true`，Public Origin 必须是 `http://127.0.0.1:<端口>`。
Gateway 的 `hub.internalOperatorToken`、Node Agent 的 Client ID/Secret 和 Origin Secret 均只写入
权限为 `0600` 的服务器私有配置。补丁会拒绝非 loopback HTTP。它负责节点注册、能力命令、审计和
Profile/Plugin 事务；不包含 DSH Runtime、Multica Task 或 CLI。浏览器不接触这些内部令牌。

本项目的多租户 Gateway 管理用户 Profile、每用户 Sandbox/Daemon 策略和 Session 所有权。当前阶段
用 `mockUserId` 把全部 Web 请求映射到预置测试用户，不显示登录页、不要求 Bearer Token。
`requireHub: true` 仍表示控制面必须可用；Profile 目标通过 Hub Node/Runtime 映射。上游 Node Agent
不负责启动 DSH 进程，因此 Host 仍由本项目的 `HostSupervisor` 按需启动。真实执行路径保持
DSH Host → Multica → Daemon → CLI。

## Node Agent 与用户 Host 的对应关系

Node Agent 是一台节点上的常驻控制面侧车，不是每个 HTTP 请求启动一个进程，也不要求
100 个用户各运行一个 Node Agent。一个 Node Agent 可以管理多个 DSH Profile；每个 Profile
仍必须有唯一的 `runtimeId` 和 `profileDirectory`。`management.profiles[]` 至少要为每个用户
配置如下对应关系：

```json
{
  "runtimeId": "tenant-user-001",
  "profileName": "web",
  "profileDirectory": "/var/lib/dshagent/hosts/user-001/home/profiles/web",
  "dshExecutable": "/opt/dshagent/mvp/apps/dsh-host/dsh-cli-wrapper.mjs"
}
```

其中 `profileDirectory` 必须与本项目 `HostSupervisor` 启动该用户 Host 时使用的
`DSH_HOME=<stateDirectory>/<userId>/home` 下的 `profiles/web` 一致；`profileName` 固定为
`web`，`runtimeId` 要与 Gateway 的 `hubProfileTargets`（或模板/解析模块）完全相同。
Node Agent 与 DSH Host 应使用同一操作系统账号。用户第一次有请求时，HostSupervisor 才启动
Host；Profile 目录由开户/Fleet 对账流程预置，所以 Host 进程本身可以保持按需启动。

`dshExecutable` 应指向本项目随包提供的 `apps/dsh-host/dsh-cli-wrapper.mjs`，不要直接指向
`node_modules/.bin/dsh`。该包装器仍调用官方 DSH CLI，但会显式进入其公开 `runCli()`、从
`<DSH_HOME>/profiles` 推导 DSH_HOME，并使用项目锁定的 `pnpm`。这样 Node Agent 的 Plugin
事务不依赖宿主机全局 pnpm，也不会因为某些 Node ESM 启动方式静默退出。

上游 1.0.4 只有 Connector 登记 Runtime 后才公布 Node Agent 已有的管理能力。MVP 对锁定的
Hub commit 应用 [`management-profile-runtime-v1`](../patches/dsh-hub/README.md) 小补丁，使
`management.profiles[]` 直接公布为只有 `dsh.plugins/files/snapshots/terminals` 的 Runtime。
因此全新用户不需要先启动 DSH Host，Node Agent 在线后就能执行 Profile 事务。补丁没有实现
聊天、Session 或 Web 转发；这些请求仍走多租户 Gateway → 用户 DSH Host。

Hub `1.0.4` 发布的完整 Connector 仍存在版本门槛：它依赖
`@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.7`，而本项目使用的 DSH `0.1.5-rc.2` Profile 不提供
`ctx.apiProxy`。本机真实加载测试中，把旧 ApiProxy 包补进当前 Profile 会因
`dsh-agent-presets` 导出不兼容而失败。这个门槛只影响“从 Hub 直接操作 DSH Session/Web”的完整
Connector 能力，不再阻塞本项目使用 Hub 的 Profile、Plugin、节点和快照控制能力。后续获得兼容
Connector 时，真实 Connector baseline 会在 Host 运行期间覆盖 management-only baseline。

上游 Node Agent 的 `management.profiles` 最多接受 64 个 Profile。面向 100 用户时，
应至少登记两个 Node Agent/节点（每个节点不超过 64 个用户），并在 Gateway 配置
`hubProfileTargetShards` 或静态 `hubProfileTargets`，让每个用户稳定落到对应节点。
分片配置使用固定 `nodeId` 和包含 `{userId}` 的 `runtimeIdTemplate`；模板渲染结果必须与
该用户的 `management.profiles[].runtimeId` 相同。一个节点上的多个用户不能共用 `web`
这个 Runtime ID。
Gateway 会将首次选择持久化，并优先分配当前 Profile 数最少的节点；达到 64 个后停止向该
节点分配。已有用户的节点不会因分片数组顺序变化而漂移，移除已分配节点前必须先完成显式迁移。
分片只解决控制面路由，不会把两个 Node Agent 合并成一个身份，也不会共享用户的
Multica workspace、Sandbox 或 Daemon。

这里的 Hub Node Agent 只管理 DSH Profile、Plugin 事务、快照和命令通道；它不是用户的
Multica Daemon。Multica Daemon 仍由每用户 Daytona Sandbox bootstrap 启动，Gateway 负责把
用户允许的 Daemon/Runtime 绑定到该用户 Session。这样 Hub、DSH Host 和 Multica 执行面的
边界清晰，也不需要在本项目中重新实现 Node Agent。

### 生成 Node Agent 配置

为避免手工拼接上游字段，仓库提供一个只做校验和写文件的辅助工具。把凭据和节点映射放在
不入库的 `node-agent.input.json`，然后在目标节点运行：

```sh
npx tsx /opt/dshagent/mvp/deploy/dsh-hub/render-node-agent-config.ts \
  /opt/dshagent/runtime/node-agent.input.json \
  /opt/dshagent/runtime/node-agent.config.json
chmod 600 /opt/dshagent/runtime/node-agent.config.json
```

输入中的 `profiles[]` 必须使用上面的 `runtimeId`、`profileDirectory`、`profileName`、
`dshExecutable` 和可选 `snapshotPaths`；工具会拒绝 HTTP Hub、相对目录、重复身份和超过
上游每节点 64 个 Profile 的配置。它不会启动 Node Agent、注册节点或打印密钥；注册和启动
仍按上游安装器/服务说明执行。

### 对账 100 用户 Fleet

Node Agent 只在启动时读取 `management.profiles`，新增用户后必须先生成下一版配置，再由运维重启对应 Node Agent。复制 [fleet.input.example.json](fleet.input.example.json) 到私有运行目录，填入两个节点各自的 Service Token、Hub 公钥和绝对路径，然后执行：

```sh
npx tsx /opt/dshagent/mvp/deploy/dsh-hub/reconcile-node-agent-fleet.ts \
  /var/lib/dshagent/private/fleet.input.json
```

工具读取真实 `tenant.db` 中的启用用户，复用 Gateway 的持久化低负载分配，按节点生成 `node-agent.next.json`，同时建立对应的 Profile 和 Session 快照目录。它会拒绝单节点 100 用户方案、重复节点、无 `{userId}` 的 Runtime 模板和超过 64 个 Profile 的节点。输出配置包含私密 Service Token，文件权限为 `0600`。

确认差异后，把 `.next.json` 作为该节点的新配置并重启应用了锁定补丁的上游 Node Agent。
本工具不会自行修改或重启线上服务。当前 Profile 管理路径不安装不兼容的 Connector；未来启用
Hub 侧 Session/Web 能力时，再安装与当前 DSH 版本匹配并通过验收的 Connector。

### 只读验证 Fleet

生成并启用 Node Agent 配置后，可运行只读验证器核对三处事实是否一致：租户库、渲染的
Node Agent 配置和 Hub 实时 Node/Runtime 清单。

```sh
npm run verify:tenant-fleet -- \
  /var/lib/dshagent/private/tenant.config.json \
  /var/lib/dshagent/private/fleet.input.json \
  100
```

它要求每个活跃用户都有私有 Multica Workspace override、持久化 Hub target、对应 Node 配置内的
Profile Runtime，并且 Hub 正在线公布该 Runtime。输出仅包括数量和节点分布，不输出任何 PAT、
Daytona Key、Hub Token 或用户 Token；验证器不会写数据库、创建 Workspace、提交 Plugin 事务或重启服务。
