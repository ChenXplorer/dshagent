# 多租户目标与 DSH Hub 定位

本文是当前多租户方案的目标说明。早期单用户 Daytona 验收文档仍保留，作为基础执行链路的历史记录；100 用户版本以本文和代码为准。

## 目标

在服务器上运行一个统一 Web 服务，为约 100 个用户提供隔离的 DSH 工作空间。每个用户拥有：

- 一个用户 Profile 版本；
- 一个默认 Daytona Sandbox；
- Sandbox 内一份平台准备的 Multica Daemon；
- 可登记的额外本机或远程 Daemon/Runtime；
- 多个可并行的 DSH Session。

一个 DSH Session 继续对应一个 DSH Agent 和一个 Multica Chat Session。每条消息形成一个 Multica Task；同一 Session 内按顺序处理 Task，多个 Session 可并行。Runtime 切换只改变后续 Task 使用的 Daemon/CLI，继续复用该 Session 的 Multica Chat 上下文和 DSH 轨迹，不上传或同步本地代码目录。

## 分层与职责

```text
Web / Feishu / 其他入口
        ↓
多租户 Gateway（当前固定模拟用户；userId+sessionId 路由、限流、审计）
        ↓
Tenant Control Plane（用户 Profile、Daemon/Runtime、Sandbox、Session 所有权）
        ↓
按需启动的用户 DSH Host（消费该用户 Effective Profile）
        ↓
dsh-multica Agent Loop Plugin → OfficialMulticaClient → Multica Server
                                                    ↓
                         用户 Sandbox 内默认 Daemon / 用户登记 Daemon
                                                    ↓
                                      Codex CLI 或 Claude Code CLI
```

DSH Host/Profile 在 Host 启动时加载一次；不会为每条请求重新组装 Host。`ProfileComposer` 在启动前把系统基线 Plugin、用户 Plugin manifest 和 Skill catalog 合成为用户的 Effective Profile。Plugin 变更通过版本化 Profile 让用户 Host 重启后生效；Skill 变更写入用户配置，活动 Host 刷新 Skill bridge，下一条 Task 使用新版本。

## DSH Hub 是否必需

当前采用的 DSH Hub 是社区项目 `k1412/dsh-hub`（已锁定提交 `cc730d0091337767e437e0964c9f93ba3f490de7`），不是 DeepSeek 官方产品。最终 100 用户部署接入它，但把它作为独立控制面组件，而不是替换 DSH、Multica 或 `dsh-multica`：

- DSH Hub 复用官方 Node Agent、能力命令、Plugin 事务、快照/回滚和审计能力；
- Hub 负责 Node Agent、节点/Runtime 能力、Plugin 事务、快照和 Hub 审计；本项目 Gateway/Tenant Control 负责用户 Profile、Sandbox 绑定、Daemon Registry、Session 所有权、用户配额和租户审计。当前阶段固定映射一个模拟用户，不实现登录鉴权；以后身份系统仍放在 Gateway；
- DSH Host、Multica Server、Daemon 和 CLI 仍是执行面；Hub 不保存 Multica Chat/Task，也不代替 CLI 执行。

部署配置将 `requireHub` 设为 `true`。Hub 仅绑定服务器回环地址，Gateway 使用私有的 `hub.internalOperatorToken` 和 `hub.originSecret`；这只是服务间控制通道，不是终端用户鉴权。`hubProfileTargets`、`hubProfileTargetTemplate`、`hubProfileTargetShards` 或 `hubProfileTargetModule` 为每个用户给出其 DSH Host/Profile 对应的 Hub Node/Runtime。Gateway 启动时先调用 Hub 的 `/hub/v1/me` 验证控制面连通性，缺少 Hub 或目标映射时拒绝启动。上游 Node Agent 的 `management.profiles` 上限为 64，因此 100 用户至少要分到两个 Node Agent/节点。当前 Profile 管理链路不依赖与新版 DSH 不兼容的完整 Connector。

因此不是“100 个用户必须常驻 100 个 Host”。`HostSupervisor` 按需为有请求的用户启动一个 Host，同一用户的多个 Session 共享该 Host；空闲 Host 可停止，下一次请求按保存的 Profile 重新启动。每个用户的 Sandbox/Daemon 仍按用户隔离。

Gateway 是常驻服务，必须使用可 `enable` 的 systemd 单元而不是一次性的 `systemd-run`。用户 DSH Host 仍然由 Gateway 子进程按需启动；Gateway 重启会停止自己拥有的空闲 Host，下一次请求可从持久化 Session/Profile 恢复。用户级 systemd 部署还需启用 `loginctl enable-linger <部署账号>`，以便 SSH 登出与服务器重启后自动恢复 Gateway。

## 配置变化

- 新增或修改 Daemon：Gateway 校验其所有权、Runtime 列表、执行模式和工作区根目录，保存后重启该用户 Host；其他用户不受影响。
- Daemon 发现：标准部署用该用户私有 Multica 凭据读取官方 Runtime catalog，Web 只看到在线 Daemon/Runtime 元数据；登记时 workspace 由服务端填入，用户不需要知道 `runtimeId`，也不能提交另一个用户的 workspace。
- 平台托管的默认 Daemon 由 Sandbox bootstrap 管理，用户 API 只允许查看，不能修改或删除；用户自定义 Daemon 使用独立登记记录。
- 修改 Skill：保存到用户 Profile，活动 Host 立即刷新，下一条 Task 生效。
- 修改 Plugin：创建新 Profile revision；带 `packageName` 和精确 SemVer 的插件通过 DSH Hub 的 `dsh.plugins` 官方能力安装/更新，Host Profile 用同一个包名加载；只提供 `modulePath` 的插件必须由部署侧预置并审核，且 Gateway 只接受位于 `pluginPathRoots` 中的绝对路径。事务成功后重启用户 Host，失败可回滚到上一版本。平台不接受把任意上传文件直接当作可执行插件。
- Session：所有请求都先由 Gateway 校验用户归属，再交给该用户 Host；并发 Session 使用各自的 Agent/Task 关联，不能跨用户复用。

运维开户与状态管理通过 Gateway 的 `GET/POST /v1/control/users` 和
`PATCH /v1/control/users/:id` 完成；普通用户不能查看或修改其他租户。标准
Daytona 装配要求登记的额外 Daemon 使用该用户的 Multica workspace，跨 workspace
的注册会被拒绝，否则无法保证同一 Session 的 Agent/Chat 上下文连续。

Hub 节点本身沿用上游的一次性 Enrollment 流程：运维用户通过 Gateway 的
`/v1/control/enrollments` 创建或查看登记码，把 code 交给目标 Node Agent；节点上线后再由
`/v1/control/nodes` 核对由 Node Agent 公布的 management-only Runtime。取消登记和撤销节点分别调用 Hub 的官方 cancel/revoke API。
这些接口在当前模拟模式下由 `mockUserId` 是否列入 `operatorUserIds` 决定；Hub 的内部令牌和
Origin Secret 不会进入浏览器。

用户到 Hub Node/Profile Runtime 的映射保存在 `tenant_hub_profile_targets`。Fleet 生成和 Gateway 的 Plugin Profile 事务都读取、复用这一条映射；不会按请求重新哈希用户，也不会因为增加 Node 而把已有用户迁移到另一台节点。

标准 Daytona/Multica 装配要求每个用户配置独立的 Multica workspace/token 和 Daemon 身份（`standardRuntime.userOverrides[userId]`）。只有单用户本地调试才允许显式设置 `allowSharedMulticaWorkspace: true`；多租户部署缺少用户覆盖配置时应拒绝启动，避免把多个用户放进同一执行工作区。

安全边界：用户 Plugin 有两种受支持的来源：部署侧预置的 `modulePath`，或由 DSH Hub Node Agent 按精确版本安装的 npm `packageName`。两者都会在用户 Host 启动时进入该用户的 Profile；Plugin 代码运行在用户 Host 进程内。如果需要运行不受信任的第三方代码，必须再为 Host 增加独立操作系统用户、容器或其他隔离层。Daytona 负责 CLI/Daemon 执行隔离，不能自动替代 Host Plugin 的代码隔离。

MVP 暂不实现登录鉴权，Gateway 用配置中的固定用户模拟访问。真正的身份系统以后只替换第一步身份解析，后面的租户归属检查保持不变：

```text
user = userTable[config.mockUserId]                // 当前固定用户；以后替换为 OIDC/SSO
if user is disabled: reject 401
if route requires operator and user.id not in operatorUserIds: reject 403
resource = load(sessionId | daemonId | profileId)
if resource.userId != user.id: reject 404           // 不暴露其他租户资源是否存在
forward request to HostSupervisor.acquire(user.id)  // 只进入该用户的 DSH Host
```

## 当前实现与验证边界

已实现并通过类型检查和 **145 项自动化测试**的部分包括 TenantRepository、ProfileComposer、按需 HostSupervisor、用户 Sandbox/Daemon/Runtime 注册与在线发现、Profile/Skill 更新、DSH Hub 官方能力命令适配、Hub-managed npm Plugin 包路径、官方 Hub Plugin 回滚与失败补偿、Hub Node 分片路由、Node Agent 在线与 Profile 管理能力校验、Node Agent 配置校验、100 用户 Node Agent Fleet 对账、Skill 命名空间隔离、Session/Task 配额、租户审计和空闲 Host 回收、单租户入驻编排与只读 Fleet 运行时验证。

服务器已运行两个真实 Hub Node Agent，按 51/51 分片登记 102 个用户 Runtime；102 个租户已通过官方 Multica Workspace API 获得独立 Workspace。只读 Fleet 验证器已逐一核对活跃用户、私有 Workspace 覆盖、稳定 Hub 目标、渲染出的 Node Agent Profile 和 Hub 已公布 Runtime，结果均为 102。独立租户 `user-003` 与后续通过入驻工具创建的租户均实际创建了 Daytona Sandbox、默认 Daemon 和按需 DSH Host；其中 `user-003` 在一个 DSH Session 中完成 Codex → Claude Code → Codex 三轮真实执行。三轮复用同一 Sandbox 和 Multica Chat，执行后 Sandbox 已通过 Gateway 暂停。这证明隔离执行链路和同会话 Runtime 切换，不等于 100 个 Sandbox 同时运行。

Profile 事务允许用户 Runtime 离线，因为实际管理命令由常驻 Node Agent 执行；Node Agent 必须在线，而且 Runtime 必须已登记并保留 `dsh.plugins` 能力声明。多 Plugin 事务中途失败时，Gateway 按相反顺序调用官方 rollback，并重新安装本次事务先前移除的原版本；补偿也失败时保留聚合错误，不能把数据库 Profile 当成已生效。

当前浏览器入口仍是免登录 MVP：所有请求固定映射到 `mockUserId`。真正的用户认证和授权适配层尚未启用；它不影响已经实现的用户归属、配额和资源隔离数据模型。100 用户生产上线前还需接入真实身份源、TLS、资源配额策略、监控告警及分批容量验证。

## 新用户入驻

账户导入使用 `deploy/onboarding/onboard-tenant.ts`，而不是手工依次修改租户数据库、Multica 配置和 Hub Node Agent 配置。它复用已有的 `TenantRepository`、官方 Multica Workspace API 适配器，以及 `reconcile-node-agent-fleet.ts`：创建用户 Profile、创建或复用私有 Workspace、写入 `standardRuntime.userOverrides[userId]`，并为该用户分配稳定的 Hub Node/Profile Runtime。命令与 Node Agent 受控重启说明见 [入驻工具](../deploy/onboarding/README.md)。

这里的“每用户一个 Sandbox”是持久绑定、按需创建：首次 DSH Session 获取用户 Host 时创建 Sandbox 并启动默认 Daemon；账户批量导入不会立刻启动 100 个 Sandbox。这样不需要 100 个常驻 Host，也不会把空闲用户的执行资源提前耗尽。






