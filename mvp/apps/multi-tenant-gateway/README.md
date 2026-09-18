# 多租户 Gateway

完整的目标边界（包括 DSH Hub 只作为控制面组件的定位）见 [多租户目标与 DSH Hub 定位](../../docs/multi-tenant-target.md)。

这是运行在服务器上的外层控制面。它不会替换现有 `dsh-multica` Plugin、Multica Server 或官方 CLI。当前 MVP 配置 `mockUserId` 后不做登录鉴权，所有请求映射到一个预置测试用户；`TenantRepository` 仍保存用户/Profile/Daemon/Session 所有权，`HostSupervisor` 按需启动该用户的 DSH Host，并把请求转发到 Host 内现有的 `/v1/*` Gateway。

用户访问 Gateway 根路径 `/` 时会进入该用户的官方 DSH Web（DeepSeek Chat）。DSH Web 自带的一次性启动令牌仅由 Gateway 在服务器内部交换为 DSH 的签名会话 Cookie，令牌不会出现在浏览器地址栏；这不是登录或 Cloudflare Access。租户控制台位于 `/control`，供查看 Runtime、Profile、Sandbox 和 Session 等管理状态。

每个用户的运行边界是：一个用户 Profile、一个 Daytona Sandbox、一个由平台准备的默认 Daemon，以及该用户登记的额外 Daemon。登记额外 Daemon 时可以指定 `executionMode`（`daytona`、`local` 或 `external`）和该 Daemon 可见的 `workspacesRoot`；`external` 表示目录由远端 Daemon 管理，Gateway 不在本机创建。多个 Session 可以并行；同一个 Session 仍由现有 `MulticaAgent` 串行消费 Task。用户切换 Runtime 时，请求仍进入原 Session/Agent，Multica 负责实际 CLI 运行。

平台托管的默认 Daemon 只能由 Sandbox bootstrap 创建或由运维流程更新，用户可以查看但不能通过用户 API 修改或删除；用户自定义 Daemon 单独登记并受该用户 Workspace 和 Runtime allowlist 限制。标准部署还提供 `GET /v1/daemon-candidates`：它从该用户自己的 Multica workspace 读取在线 Daemon/Runtime，Web 页面可选择后调用 `POST /v1/daemons/discover` 登记。Workspace ID 由服务端绑定，Multica token 不会进入浏览器。

## 启动

`start.ts` 支持两种真实部署方式：

* `standardRuntime` 使用仓库已有的 `PersonalSandboxService`、Daytona SDK、官方 Multica REST 客户端和 DSH Host 启动器；
* `sandboxProviderModule` 与 `driverConfigurationModule` 用于接入组织自己的 Sandbox/凭据分配器，模块必须返回真实实现，不能返回模拟服务。

如果配置了 `hub`，`DshHubClient` 使用 DSH Hub 的官方 `/hub/v1/*` API。当前 MVP 的 Hub 只绑定服务器回环地址，Gateway 通过 `hub.internalOperatorToken` 和 `hub.originSecret` 调用；它们只存在服务器私有配置，浏览器看不到。配置 `hubProfileTargets`、`hubProfileTargetTemplate` 或 `hubProfileTargetModule` 后，Profile 更新会通过 Hub 的 `dsh.plugins` 能力命令提交，再重启用户 Host。`requireHub: true` 会在启动时验证控制面可用性，并在缺少目标映射或 Hub 不可用时拒绝启动。Hub 负责节点和 Plugin 事务，Gateway/Tenant Control 负责用户资源映射，DSH Host 和 Multica 是执行面。

用户 Plugin 的来源必须是可审计的部署来源：使用 Hub 管理的包时提交 `packageName` 和精确 SemVer；使用 `modulePath` 时，绝对路径必须位于 `pluginPathRoots` 配置的部署目录内，否则 Gateway 返回 403。`allowUnmanagedPluginPaths` 仅供本地测试，不能与 `requireHub: true` 同时开启；浏览器不能直接上传并执行任意文件。

示例配置只放占位符，不包含任何密钥。运行前将私有 JSON 的路径放入 `DSH_TENANT_CONFIG`：

```powershell
$env:DSH_TENANT_CONFIG = 'C:\srv\dshagent\tenant.config.json'
npm run start:tenant-gateway
```

`operatorUserIds` 仍用于标记模拟用户能否访问控制接口。当前阶段设置 `mockUserId` 后不会读取浏览器 Token；以后接入 OIDC/SSO 时再替换身份解析，不改资源所有权模型。

Hub 节点登记沿用 Hub 的一次性 Enrollment API：运维用户通过
`POST /v1/control/enrollments` 取得一次性 code，将 code 交给对应 Node Agent；节点上线后通过
`GET /v1/control/nodes` 核对 Node/Runtime，必要时用
`POST /v1/control/enrollments/:nodeId/cancel` 或
`POST /v1/control/nodes/:nodeId/revoke` 收回权限。当前模拟模式不提供浏览器鉴权；Hub 操作令牌和 Node 服务密钥只在服务器进程之间传递，绝不发送给浏览器。

运维用户还可以使用 `GET/POST /v1/control/users` 查看用户摘要或创建用户。创建响应中的 Token 只返回一次；该路由只接受运维身份。若生产 SSO 已经是唯一身份源，可显式设置 `autoProvisionIdentity: true`，首次通过可信 SSO 的用户会自动得到默认 Profile；否则保持 `false`，要求运维先开户。

首次创建用户使用配套管理脚本（只在运维终端执行）：

```powershell
$env:DSH_TENANT_CONFIG = 'C:\srv\dshagent\tenant.config.json'
npm run provision:user -- C:\srv\dshagent\state\tenant.db alice alice@example.com codex
```

创建结果中的 Token 只展示一次；数据库仅保存 SHA-256 摘要。生产环境应把用户创建接入组织身份系统，不把该命令暴露给 Web。

## 用户 API

| 路径 | 用途 |
| --- | --- |
| `GET /v1/profile`、`PATCH /v1/profile`、`POST /v1/profile/rollback` | 查看、版本化更新和回滚用户 Profile；Plugin 更新会重启该用户 Host |
| `GET /v1/sandbox`、`POST /v1/sandbox/stop` | 查看或停止用户 Sandbox/Host |
| `GET/POST/PATCH/DELETE /v1/daemons` | 登记、修改和删除用户允许的 Daemon/Runtime（含 `executionMode`、`workspacesRoot`） |
| `GET /v1/daemon-candidates`、`POST /v1/daemons/discover` | 从用户私有 Multica workspace 发现在线 Daemon，并由服务端绑定 workspace 后登记 |
| `GET /v1/runtimes` | 只返回该用户登记且在线的 Runtime |
| `GET/POST /v1/sessions`、`POST /v1/sessions/:id/messages` | 列出或创建 Chat Session、提交消息；每个 Session 的 Task 串行 |
| `POST /v1/sessions/:id/runtime`、`GET /v1/sessions/:id/events` | 切换后续 Runtime、读取 DSH 轨迹事件 |
| `PUT /v1/skills` | 更新用户 Skill；活动 Host 刷新后从下一条 Task 生效 |
| `GET /v1/audit` | 查看当前用户的租户审计；Hub 全局审计仅运维用户可见 |
| `GET/POST /v1/control/users`、`PATCH /v1/control/users/:id` | 运维用户查看、创建、启用或禁用用户；创建响应一次性取得 Token |
| `GET/POST /v1/control/enrollments`、`POST /v1/control/enrollments/:nodeId/cancel`、`POST /v1/control/nodes/:nodeId/revoke` | 运维用户复用 DSH Hub 的节点登记、取消和撤销能力 |

当前 MVP 配置 `mockUserId` 后，所有路径无需 `Authorization`，Gateway 直接使用该预置用户并继续检查 Session、Daemon 和 Profile 所有权。取消 `mockUserId` 后才恢复 Bearer/身份适配器模式。
