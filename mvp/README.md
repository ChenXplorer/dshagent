# MVP 实现目录

完整安装、配置、运维与迁移说明见 [跨机器部署手册](docs/deployment-handbook.md)。

组件关系、DSH `ctx`、Multica 插件生命周期和自定义插件开发见 [架构总览](docs/architecture-overview.md)。

模块级消息调用链和真实 Multica REST 请求映射见 [模块级数据流](docs/architecture-overview.md#11-模块级数据流谁请求-multica如何请求)。

给非技术读者的分层说明见 [方案说明（入门版）](docs/solution-guide-for-beginners.md)。

本目录用于本次 MVP 的新实现。当前 100 用户目标、DSH Hub 定位和按需 Host 边界见 [多租户目标与 DSH Hub 定位](docs/multi-tenant-target.md)；早期单用户基础链路和验收记录见 [MVP 目标与验收标准](../docs/mvp-goals.md)。新增的多租户控制面位于 `apps/multi-tenant-gateway` 和 `packages/tenant-control`。真实部署和端到端验收进展见 [部署记录](docs/deployment-progress.md)，未通过的项目不视为完成。

同一会话的 Codex ↔ Claude Code 调用示例见 [本地试用说明](docs/try-mvp.md)。
实际模型调用与原生轨迹验证见 [真实验收结果](docs/acceptance-results.md)。
100 用户执行面扩容前的只读容量门禁见 [容量门禁脚本](deploy/capacity-preflight.py) 与 [多租户 Gateway 部署说明](deploy/multi-tenant-gateway/README.md#执行面容量门禁)。

上一版原型已统一移至 `../bck/legacy-prototype/` 供参考；新实现不直接依赖其中的模拟宿主或自建调度服务。需要复用的逻辑经过审查后迁入对应模块。

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `apps/dsh-host/gateway.ts` | 消息入口，注入固定用户身份，路由至真实 DSH，转发状态和回复 |
| `apps/dsh-host/` | 真实 DSH 的启动、Profile 和插件装配，不重写 DSH |
| `apps/multi-tenant-gateway/` | 面向 100 用户的统一 Web/API 入口、固定模拟用户、Session 所有权和 Host 代理；不执行 CLI；本阶段不做登录鉴权 |
| `packages/dsh-loop/` | DSH AgentFactory/Agent 适配，接管执行入口，调用任务编排并将事件交给轨迹适配器 |
| `packages/task-orchestration/` | DSH 与 Multica 的任务关联、提交与对账、并发、取消和 Runtime 选择；上下文由 Multica Chat Session 管理 |
| `packages/multica-client/` | 官方 Multica API、事件读取、Daemon/执行目标关联及错误转换 |
| `packages/sandbox-management/` | 用户到 Daytona 的绑定、创建、就绪检查、暂停与恢复 |
| `packages/cli-configuration/` | Codex/Claude 原生模型配置生成与校验，不实现模型请求循环 |
| `packages/dsh-trajectory/` | 执行事件到真实 DSH 轨迹的转换、展示适配和去重写入 |
| `packages/skill-distribution/` | DSH Managed Skill 的目录读取、版本摘要、Multica Skill 创建/更新和 Agent 绑定 |
| `packages/persistence/` | DSH Session 与 Multica Task/Runtime/Sandbox 的外部关联、幂等提交和同步位置 |
| `packages/tenant-control/` | 用户 Token、Profile 版本、Skill/Plugin/Daemon 注册、Sandbox 记录、Session 归属和按需 Host Supervisor |
| `packages/dsh-hub-control/` | DSH Hub 官方 `/hub/v1/*` REST 薄客户端；复用 Hub 节点、能力命令和审计控制面 |
| `deploy/` | 官方框架部署、版本锁定、沙箱模板与初始化、配置示例和运维脚本 |
| `tests/run-*.ts` | 显式运行的真实沙箱与 CLI 验收脚本，执行证据存入私有运行目录 |

单元测试靠近所属模块。集成测试和端到端测试分别报告，不能以 mock 测试替代真实框架验收。

## 多租户控制面

公开请求先到 `apps/multi-tenant-gateway`。当前 Gateway 直接使用配置中的固定模拟用户，不要求浏览器登录或携带 Token；随后从 `TenantRepository` 读取该用户的 Profile 和允许的 Daemon，再把带有内部 Host Token 的请求转给该用户的 DSH Host。`HostSupervisor` 按需启动一个用户 Host；同一用户的多个 Session 共享这个 Host，不同用户使用不同 Host、Sandbox 和默认 Daemon。空闲 Host 可停止，下一次请求再启动。

用户 Profile 的 Plugin 变更会产生新版本，调用可选的 DSH Hub `dsh.plugins` 能力命令并重启用户 Host；回滚会生成一个新的恢复版本。Session JSONL、DSH 关联数据库和工作目录放在用户稳定目录，因此 Host 重启不会丢失会话。Skill 变更直接刷新活动 Host 的 Skill bridge，或在下一次 Host 启动时加载，下一条 Task 生效。

DSH Hub 是独立控制面，不包含 DSH Runtime、Multica Task 或 CLI。`packages/dsh-hub-control` 只复用它公开的节点、能力命令和审计 API；多租户用户身份和每用户业务策略由 Gateway 的租户层隔离。实际执行仍是 `DSH Host → mvp-multica-loop → OfficialMulticaClient → Multica Server → 用户 Sandbox 内 Daemon → Codex/Claude Code CLI`。

## 依赖边界

### 优先复用开源与框架原生能力

- 实现每项能力前，先核对已选版本的 DSH、Multica、Daytona 文档与源码。框架已有 API、SDK、配置项或扩展点时，直接使用，不另建同等能力。
- 优先使用官方 SDK；没有适用 SDK 时调用官方 API。仅在确有必要的身份传递、字段转换、错误处理或兼容边界处增加薄适配，不为所有 API 机械地再包装一层。
- Multica 已提供的队列、执行并发、取消、重试、事件订阅及会话恢复能力，先验证后复用。任务编排只补充跨 DSH/Multica/Daytona 的关联、Runtime 切换和缺失的业务规则，不另建平行调度系统。
- DSH 已提供的会话、轨迹、插件装配与持久化机制直接复用。平台关联记录只保存必要外部标识、归属和同步位置，不重复保存一套权威会话或轨迹。
- Daytona 的创建、暂停、恢复、文件及进程接口直接复用；不自建沙箱引擎或另写 Daemon 替代官方 Multica Daemon。
- CLI 的模型调用、工具执行、内部并行和原生配置由 CLI 自身负责；Gateway 的基础 HTTP、认证和流式传输优先使用已有框架或成熟开源组件。
- 框架缺少的基础能力优先评估成熟开源组件，检查适用性、维护情况、许可证及依赖成本；只有确无合适现成能力时才做最小自研。
- 目录表示职责边界，不是必须开发同名子系统的清单。若职责已由框架完整提供，可以只保留配置、装配或删除空模块，不为填满目录增加代码。
- 在实现说明中记录“需求 → 复用 API/组件 → 自研缺口 → 验证方式”。发现上游能力不足时明确记录证据，不以模拟接口冒充上游能力。

- `contracts` 是最底层的业务契约，只放确有跨模块需求的类型，不演变成通用杂物目录。
- `task-orchestration` 通过 `TaskDriver`、就绪与执行段回调连接 DSH 和沙箱；当前直接依赖本项目公开的持久化与 Multica 客户端接口，不直接操作 SQL 或导入 DSH 内部实现。官方执行段适配器封装 Daytona SDK 调用。
- `multica-client`、`sandbox-management` 和 `persistence` 实现各自端口。第三方 API 字段在适配器内转换，不传播到 Gateway 或编排逻辑。
- `dsh-loop`、`dsh-trajectory` 封装真实 DSH 的执行入口和轨迹接口；轨迹仍以 DSH 为平台主记录，不能另建模拟会话系统替代它。
- `dsh-host` 负责装配具体适配器、配置和生命周期。Gateway 通过明确的 DSH 接口通信，不直接访问数据库或调度 Multica。
- 沙箱初始化由部署资源准备，`cli-configuration` 提供两套原生配置。真实官方 Daemon 负责启动 CLI；自研代码不绕过它执行生产任务。
- 模块通过公开入口调用，禁止跨模块导入内部文件或循环依赖。仅在出现独立职责时拆分文件，不为每个类单独创建包。

## 状态与并发

`task-orchestration` 拥有平台任务与执行段的状态转换，Multica 拥有外部任务执行事实，`sandbox-management` 拥有个人沙箱生命周期，DSH 拥有会话与统一轨迹。状态持久化通过接口完成；不使用跨模块全局 Map 作为可靠性保证。

并发以任务标识隔离，支持同一用户、同一沙箱中多个同类 CLI 任务。沙箱暂停必须检查全部活跃任务；取消只能作用于指定任务。提交状态不明确时先对账，不盲目重试。

## 命名与部署

目录、文件与接口使用业务语义命名，避免 `manager`、`common`、`utils` 等无边界集合。模块内部可按需要使用 `domain/`、`application/`、`adapters/`，不要求机械地套用相同层次。

这些目录是代码模块，不意味着每个目录都部署成独立微服务。优先减少自研进程，通过接口保持解耦；DSH、Multica Server、Daytona 及沙箱内官方 Daemon 按真实框架要求部署。

源码与运行数据分离。Gateway、DSH、Multica Server 在本机 Windows 原生运行，私有运行配置放入 Git 忽略的 `.runtime/`。Daytona、PostgreSQL 等 Docker 依赖部署在 Ubuntu `/home/dev/dshagent-mvp/`；Daemon 与 CLI 在 Daytona 沙箱内运行。数据库、缓存、CLI 凭据、日志和沙箱数据目录由部署配置明确指定，不写入 Git。


