# MVP 文档索引

`mvp/` 是当前可运行 MVP 的唯一主实现目录。本文档按阅读目的整理入口；代码、部署脚本和验收证据仍以各自目录为准。

## 先看这几份

| 目的 | 文档 |
| --- | --- |
| 了解目标、范围和未完成项 | [MVP 目标与验收标准](../../docs/mvp-goals.md) |
| 了解模块边界和请求链 | [架构总览](architecture-overview.md) |
| 快速试用同一会话切换 Codex / Claude Code | [本地试用说明](try-mvp.md) |
| 查看真实验收是否通过 | [真实验收结果](acceptance-results.md) |
| 核对多租户部署范围与真实证据 | [多租户验收矩阵](multi-tenant-acceptance-matrix.md) |
| 在新机器部署或排障 | [跨机器部署手册](deployment-handbook.md) |
| 在扩大 Sandbox/CLI 执行波次前核对资源 | [容量门禁脚本](../deploy/capacity-preflight.py) 与 [Gateway 部署说明](../deploy/multi-tenant-gateway/README.md#执行面容量门禁) |
| 给非技术读者解释方案 | [方案说明（入门版）](solution-guide-for-beginners.md) |

当前多租户目标、每用户 Sandbox/Daemon、按需 Host 以及 DSH Hub 复用边界，优先阅读[多租户目标与 DSH Hub 定位](multi-tenant-target.md)。

## 按主题查阅

### 架构与集成

- [架构总览](architecture-overview.md)：DSH、Multica、Daytona、Daemon 和 CLI 的边界与调用链。
- [DSH 集成](dsh-integration.md)：DSH Agent、Session、Trajectory 和 Gateway 的接入契约。
- [Multica 集成](multica-integration.md)：官方 API、Chat Session、任务、SSE 与 Runtime 切换。
- [任务编排](task-orchestration.md)：任务关联、排队、取消、对账和错误边界。
- [跨框架持久化](persistence.md)：DSH、Multica、Daytona 外部标识的关联规则。
- [原生 CLI 配置](cli-configuration.md)：Codex / Claude Code 的配置生成与校验边界。

### 部署与运行

- [跨机器部署手册](deployment-handbook.md)：完整部署、版本、配置和回退手册。
- [DSH Hub 部署模板](../deploy/dsh-hub/README.md)：独立 Hub 控制面、节点注册和安全边界。
- [多租户 Gateway 服务单元](../deploy/multi-tenant-gateway/README.md)：服务器常驻 Gateway 与按需用户 Host。
- [Windows 与 Ubuntu 两机部署](windows-ubuntu-deployment.md)：当前两机启动顺序和网络约定。
- [Daytona 部署记录](daytona-deployment.md)：当前实际沙箱方案及验证边界。
- [Daemon 装配](daemon-bootstrap.md)：沙箱内官方 Daemon 的版本、配置和就绪检查。
- [沙箱管理](sandbox-management.md)：Daytona 个人沙箱的创建、暂停、恢复和并发约束。
- [部署进展](deployment-progress.md)：阶段性事实记录和历史故障。

### 可靠性、历史和延期项

- [Multica 轨迹可靠性补丁](multica-trace-durability.md)：`dshtrace1` / `dshtrace2` 的历史可选实验；默认部署不修改 Multica 源码。
- [CubeSandbox 暂缓记录](cubesandbox-blockers.md)：历史调研和暂缓原因；当前 MVP 使用 Daytona。

### 图示与验收资产

- [ACP / DSH 架构图](assets/acp-dsh-architecture.png)
- [DSH × Multica 架构图](assets/dsh-multica-architecture-imagegen.png)
- [模块级数据流图](assets/dsh-multica-dataflow-imagegen.png)

## 代码入口

- `apps/dsh-host/`：真实 DSH Host、Gateway、Profile、插件装配和启动脚本。
- `packages/dsh-loop/`：DSH AgentFactory / Agent 执行入口。
- `packages/task-orchestration/`：DSH 与 Multica 的任务编排。
- `packages/multica-client/`：官方 Multica REST / SSE 客户端。
- `packages/sandbox-management/`：Daytona 沙箱生命周期。
- `packages/cli-configuration/`：Codex / Claude Code 原生配置。
- `packages/dsh-trajectory/`：执行事件到 DSH 轨迹的转换。
- `packages/skill-distribution/`：Managed Skill 的同步和绑定。
- `packages/persistence/`：平台关联状态的持久化适配。
- `deploy/`：Daytona、Multica、Daemon、历史可选实验和两机部署脚本。
- `tests/`：集成、故障恢复、并发和真实验收入口。

## 运行数据与历史原型

- `.runtime/`：本地私有配置和验收证据，已被 Git 忽略，不属于源码交付物。
- `node_modules/`：本地依赖安装目录，不提交、不作为部署输入。
- `bck/legacy-prototype/`：上一版原型，当前 MVP 不依赖，仅供历史参考。
