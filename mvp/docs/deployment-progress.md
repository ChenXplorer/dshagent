# 真实部署进展

2026-09-17：新增只读 Fleet 验证器并已在 Ubuntu 执行。它同时读取租户库、Node Agent 配置和 Hub `/hub/v1/nodes` 清单，结果为 `activeUsers=102`、`privateWorkspaceOverrides=102`、`stableHubAssignments=102`，Node A/B 各 51 个 Profile，Hub 有 2 个在线 Node、102 个已公布并逐一核对的 Profile Runtime。验证过程中没有创建 Sandbox、提交 Task、写数据库或重启服务；Gateway、Hub、Node A/B 最后均为 active。

2026-09-17：在不启用 Cloudflare Access、浏览器 Token 或登录页的前提下，临时身份路由验收以私有测试请求头模拟 102 个已开户用户，批量读取各自 Profile。结果为 `requestedUsers=102`、`successfulUsers=102`、`failures=0`；测试 Gateway 在完成后已停止。该验证只覆盖共享 Gateway 的用户解析和资源路由，不启动用户 Host、不创建 Sandbox 或提交 Task；正式入口继续固定映射 `mockUserId=user-a`。

2026-09-17：新增 `deploy/capacity-preflight.py`，它只读取目标主机的可用内存、`/home` 磁盘和 inotify 限制，并要求运维输入已观测到的 Sandbox/Daemon/CLI 峰值预算；不会读取私有配置或创建执行资源。Ubuntu 已完成脚本语法和只读运行烟测，当时 `MemAvailable` 约为 3382 MiB、`/home` 可用约 57477 MiB、inotify 实例上限为 1024。该数据不足以批准 100 个同时运行的 Sandbox；必须从小波次的真实峰值数据开始分批压测。

2026-09-17：无私密交付包 `mvp-v156-capacity-gate-20260917.tgz` 已同步到 Windows 项目根目录和 Ubuntu `/home/dev/dshagent-mvp/`，SHA-256 为 `eaef483af875b2e6bff98be348ccdb88b81b7c7a9359acb07f16355ba6d600b2`。包内已核对包含 `deploy/capacity-preflight.py`，且不含 `node_modules`、运行状态或私有租户配置；同步后 Gateway、Hub 与两个 Node Agent 都仍为 active。

2026-09-17：主 Gateway 已从临时 `systemd-run` 单元切换为持久化且已启用的 `dsh-mt-gateway.service`，源码目录为 `/home/dev/dshagent-mvp/source-multitenant-20260917-v154-persistent-gateway`。部署账号 `dev` 已启用 systemd linger；Gateway 设置 `LimitNOFILE=65536`，健康接口返回 200，旧 `dsh-mt-gateway-lab-v150.service` 已停止。Hub 与两个 Node Agent 均保持 active，`user-a` Host 在切换时和切换后均为 stopped/无引用。因此服务器重启或 SSH 登出后，Gateway 能自动恢复；用户 Host 仍按需创建。

2026-09-17：真实新租户 `user-onboard-e2e-20260917` 已通过入驻工具完成独立 Profile、私有 Multica Workspace 和 Hub Node B Profile Runtime 映射；首次访问按需创建了独立 Daytona Sandbox、平台默认 Daemon，并发现官方 Codex/Claude Code 两个 Runtime。首轮 Host 启动发现 Linux `fs.inotify.max_user_instances=128` 已有 124 个实例占用而报 `EMFILE`；已在目标 Ubuntu 写入 `/etc/sysctl.d/90-dshagent-host-watches.conf` 并生效为 1024，复测成功。验收 Sandbox 已经由 Gateway 正式暂停，临时 Gateway 已停止，主 Gateway 与 Hub/Node Agent 保持 active。该项前置条件已固化为 `deploy/multi-tenant-gateway/90-dshagent-host-watches.conf` 和服务部署说明。

2026-09-17：新增可重复执行的单租户入驻工具 `deploy/onboarding/onboard-tenant.ts`，并已同步到 Ubuntu 的 `/home/dev/dshagent-mvp/source-multitenant-20260917-v151-tenant-onboarding`。该工具复用现有 `TenantRepository`、官方 Multica Workspace API provisioner 和 DSH Hub Node Agent Fleet reconciler；它不会新建另一套控制面，也不会改写 Multica 数据库。远程 TypeScript 检查和入驻回归测试通过，主 Gateway `dsh-mt-gateway-lab-v150.service` 保持 active，未因本次工具部署重启。首次用户访问时仍由既有按需 Host 链路创建该用户的 Daytona Sandbox 与平台默认 Daemon。

2026-09-17：主 Gateway 已切换为 `dsh-mt-gateway-lab-v150.service`，运行源码目录为 `/home/dev/dshagent-mvp/source-multitenant-20260917-v150-main-gateway-no-auth`。切换前 `user-a` Host 已停止且没有运行中的 Task；切换后 `/v1/health` 与 `/v1/profile` 均返回 200，浏览器入口继续为 `http://127.0.0.1:13380/`。该版本没有 Cloudflare Access、浏览器 Bearer Token 或登录页，固定以 `mockUserId=user-a` 运行；Hub 的回环服务令牌仍仅用于服务器进程间调用。远程 TypeScript 检查和完整自动化测试均通过（144 项、0 失败）。

2026-09-17：按当前要求，浏览器入口不使用 Cloudflare Access，也不实现登录鉴权。Gateway 代码只保留固定 `mockUserId` 与服务器回环 Hub 的内部服务令牌路径；Cloudflare JWT 配置不再是本项目 Gateway 的可选项。真实 `user-003` Profile 已完成官方 Hub `dsh.plugins` 安装与回滚验收：安装 `@deepseek-ai/dsh-web-app@0.1.5-rc.2` 成功，随后通过官方 rollback 回到 `plugins: []`。验收中修复了 Node Agent 对无初始 lockfile Profile 的回滚、已管理 Plugin 索引清理及 rollback 响应字段三个上游兼容问题；修复已固化到锁定 Hub patch。Node Agent 使用 `dsh-cli-wrapper.mjs` 显式调用官方 DSH CLI、项目锁定 pnpm 与 npm 官方 registry；默认仅批准 DSH 官方 Web 依赖 `koffi` 的构建脚本，其他带构建脚本的第三方依赖仍需由运维审核后通过 `DSH_PLUGIN_APPROVED_BUILD_PACKAGES` 明确加入。

2026-09-17：当前可测试入口是 `http://127.0.0.1:13380/`。它不显示登录页，也不要求浏览器 Bearer Token；Gateway 用固定 `mockUserId=user-a` 模拟当前用户。用户身份认证、登录和权限系统明确留到后续阶段，当前不作为依赖或验收条件。Hub 的 loopback 操作令牌、Multica PAT、Daytona Key 和模型 Key 仍只在服务器内部使用，它们属于服务凭据，不是终端用户鉴权。

同日完成 101 个租户的 Multica Workspace 官方 API 预置，结果为 100 个新建、1 个复用，共 101 个唯一 Workspace。随后用独立租户 `user-003` 真实创建个人 Daytona Sandbox、默认 Multica Daemon、按需 DSH Host 和 Session；在同一 Session 内完成 Codex → Claude Code → Codex 三轮，三项 Task 均为 completed，三轮都返回 `USER003_MULTITENANT_OK`。持久化 DSH 轨迹证明 Runtime 顺序、Task ID 和统一 Sandbox；Multica Chat 历史证明 Claude/Codex 的上下文衔接来自同一个 Chat Session。当前自动化测试 **143 项、0 失败**，TypeScript 检查通过。

Daytona 首次为 `user-003` 创建 Sandbox 时曾因 Runner 报 `No available runners` 被明确拒绝。代码已区分“确定的 4xx 拒绝”和“响应未知”：确定拒绝会留下审计并释放空预约，未知结果仍禁止盲目重试。实验机上停止一个无租户绑定、无执行记录的旧空闲 Sandbox，并重启泄漏大量内存的桌面辅助进程后，Runner availability score 从 5 恢复到 71；随后真实创建成功。实验环境显式使用 availability 阈值 8，生产默认仍为 10。这是容量恢复记录，不是 100 Sandbox 并发证明。验收结束后通过 Gateway 正式接口将 `user-003` Sandbox 置为 `paused`，并停止临时验收 Gateway；主 Gateway、Hub 与两个 Node Agent 保持运行。

当前本地无私密配置交付包为项目根目录 `mvp-v149-no-auth-hub-plugin-validated-20260917.tgz`，SHA-256 为 `c89c53b0e80eeb98b51976d65c3299d656835819522f1a5507b911a8e2949fe5`；包内排除了 `node_modules`、`.runtime` 和日志。

2026-09-17：真实 Hub Plugin 安装验收发现 Node Agent 直接执行 `node_modules/.bin/dsh` 时，在目标 Node ESM 启动方式下会静默返回，且 DSH 官方 `plugin` 子命令需要 `pnpm`。新增版本化的 `dsh-cli-wrapper.mjs`：它显式调用官方 DSH CLI 的 `runCli()`，从 Profile 目录推导私有 `DSH_HOME`，并使用部署包锁定的 `pnpm`。这不是修改 DSH 或 Multica 源码；它是 Node Agent 的可执行适配器。单独回归与完整测试将在切换 Node Agent 配置后复验。

2026-09-17：按当前需求，本阶段不实现 OIDC、SSO 或用户登录。多租户 Gateway 使用 `mockUserId=user-a`，浏览器不需要 Bearer Token，页面会自动识别并加载该模拟用户。目标 Ubuntu 的回环 Hub `dsh-hub-internal-v4.service`（`127.0.0.1:19190`）现连接两个真实 Node Agent：`node-a` 管理 51 个 Profile Runtime，`node-b` 管理 50 个，共 101 个预置用户 Runtime；两节点均在线，101 个 Runtime 均公布 `dsh.plugins/files/snapshots/terminals` 管理能力。Gateway 已改用稳定双节点分片，Windows 经 SSH 隧道无 Authorization 请求访问 `/v1/health`、`/v1/profile` 和控制面查询均成功。Hub 内部操作令牌和 Node 身份密钥只在服务器进程间传递。此前 19090 的上游容器保留作回退，不在当前请求路径中。该结果证明 100 用户控制面容量和注册关系，不等于 101 个用户均已完成 Sandbox/Multica/CLI 端到端执行。

2026-09-17：官方未修改 Multica 的多租户真实链路已首次完整跑通。Ubuntu 上独立启动官方 `multica-server` 和迁移后的 PostgreSQL 数据库；Daytona 使用官方未修改 `multica` Daemon 以及固定的 Codex CLI `0.154.0`、Claude Code CLI `2.1.270` 快照。Gateway 为 `user-a` 创建并持久化了一个真实个人 Sandbox、按需 DSH Host 和 DSH Session。Multica 返回同一 Daemon 下两个在线 Runtime。真实消息验收依次完成 Codex → Claude Code → Codex：返回值分别为 `CODEX_E2E_OK`、包含 `CODEX_E2E_OK_CLAUDE`、`CODEX_E2E_OK_CLAUDE_BACK_CODEX`，三个 Task 均终态完成。随后停止旧 Gateway/Host、从 v139 交付目录重新启动，再向原 Session 提问，Codex 返回 `CODEX_E2E_OK_CLAUDE_BACK_CODEX_RESTART_OK`，证明 DSH JSONL、Runtime 选择和 Multica 资源关联可以跨进程恢复。

持久化证据显示三个执行段始终复用同一个 Multica `agentId`、`projectId`、`chatSessionId`、Sandbox 和工作目录，只更换 `runtimeId`；因此当前实现的 Runtime 切换由 Multica 现有 Agent/Chat 能力承担，DSH 不另造会话 handoff，也不复制本地代码目录。DSH JSONL 同时保留用户消息、Multica 原始状态/工具事件、原生 assistant message、step/end 和 turn/end。测试过程还发现并修复了多租户目录遗漏：此前只给 Daemon home/workspacesRoot 加租户后缀，Codex/Claude home 和模型目录仍可能共享；现在五类路径都按 `userId` 派生，并新增回归测试。当前本机 TypeScript 检查通过，自动化测试 **135 项、0 失败**。

同日完成了第二台执行节点的真实验收：从未修改的 Multica 提交 `8908fcf...` 构建 Windows 官方 Daemon（SHA-256 `01ac73391db6e3b0ca034842de584c0ded16286e9dc1bc747794ec7a1c37435b`），通过 SSH 本地转发接入同一 Multica Server。Gateway 的候选节点发现接口实际发现该 Daemon，登记后列出远程与本机共四个在线 Runtime。原 DSH Session 选择 Windows 本机 Codex 后，任务确实由本机官方 CLI 执行并返回 `LOCAL_EXEC_OK`；另一个长任务由 Gateway 取消后进入 `cancelled`，DSH 轨迹写入 aborted step/turn。跨机器执行仍复用原 Multica Agent、Project 和 Chat Session，只增加目标 Daemon 的目录资源。首次选择一个尚不存在的 Windows 路径时，官方 Multica 按预期拒绝提交；创建该空目录后任务成功，证明实现没有暗中上传或同步代码。

本机测试入口已通过 SSH 转发开放在 `http://127.0.0.1:13380/`，页面和免登录健康接口均返回 200。Multica PAT 和 CLI 密钥只保存在 Git 忽略的私有运行目录，不写入本文或交付包。Windows Daemon 当前以开发前台进程运行，尚未配置开机服务；这项验收证明功能链路，不代表无人值守运维已经完成。

最新 v140 源码在 Windows 与 Ubuntu 全新目录 `/home/dev/dshagent-mvp/source-multitenant-20260917-v140-cross-machine/mvp/` 的 176 个交付文件逐文件内容摘要一致，聚合 SHA-256 均为 `25c17274a54908445b15e272b53613efc0e8b15e60c8e8c2e375f21cf43254f5`。Ubuntu 从 v139 基线应用同一增量后重新执行 `npm ci`，两项锁定 DSH 兼容补丁由 `postinstall` 自动应用，TypeScript 检查和 **135 项测试全部通过**。Ubuntu 复验包为 `/home/dev/dshagent-mvp/mvp-v140-cross-machine-validated.tgz`，SHA-256 `1c8a829a493dafaf4b2dea298c9478b27f1be4d7a204fdf0f5d7df4f013f2468`；Windows 本地交付包为项目根目录 `mvp-v140-cross-machine-validated.tgz`，SHA-256 `3dfcb765247aa36efd0a5ecdb9e3f730f1330ee852046816aa6ec1e124ea888d`。两个 tar 包的容器元数据不同，源码内容由上述 176 文件聚合摘要对齐；两者都排除了 `node_modules` 和私有 `.runtime`。

本次包含 `user-a` 与独立 `user-003` 的真实功能验收，并非 100 个同时在线 Sandbox 的容量证明。当前没有终端用户鉴权，所有浏览器请求固定映射到模拟用户 `user-a`；Hub 继续承担 Profile/Plugin/Node 控制面，Gateway 负责用户资源所有权、Session 路由和按需 Host。生产容量需要按需停启、配额和分批压力测试。

当前方案已变更为 Daytona（2026-09-14 用户明确指定）。下文 CubeSandbox 检查为历史证据，卡点详情见 [CubeSandbox 暂缓记录](cubesandbox-blockers.md)。当前沙箱完成标准以 `docs/mvp-goals.md` 的 Daytona 链路为准。

2026-09-17：当前源码已在本机和 Ubuntu 独立暂存目录 `/home/dev/dshagent-mvp/source-multitenant-20260917-v138-gateway-lab-validated/` 完成 TypeScript 检查和 **134 项自动化测试、0 失败**；远程交付包为 `/home/dev/dshagent-mvp/mvp-v138-gateway-lab-validated.tgz`，SHA-256 为 `df175bdbd3381f8a574ae3a2949d9f26ffd22a4343d1eeb3626fbd9ea96f4f02`。包括 100 用户 Hub Node Agent Fleet 对账、多 Plugin Profile 失败补偿、锁定版本的 Hub management-only Runtime 补丁、Gateway Ubuntu 实机验收记录和可覆盖 Node/npm `PATH` 的 systemd 模板。远程 systemd 单元静态验证返回 0。权限按当前 MVP 范围使用用户 Token 模拟，只保留后续 OIDC/SSO 替换点。线上单用户服务未被覆盖或重启，这些结果仍不等于已完成 100 用户真实 Sandbox/CLI 压力验收。

2026-09-17：在 Ubuntu 独立目录启动了真实多租户 Gateway 实验实例 `dsh-mt-gateway-lab.service`，仅绑定 `127.0.0.1:13380`，状态和凭据位于 `/home/dev/dshagent-mvp/runtime/multi-tenant-lab/`（权限 `0600/0700`）。实际 HTTP 验证通过：合法用户健康检查和 Profile 查询成功、错误 Token 返回 401、普通用户访问运维用户列表返回 403、操作员可读取用户列表、Profile 版本更新持久化、Skill 更新返回 `next-task` 且再次读取仍存在。该实验没有创建 Session，因此没有触发 Sandbox、Daemon 或 CLI，也没有改动现有单用户服务。验证同时发现目标机 npm 位于用户级版本目录；systemd 模板已改用 `/usr/bin/env npm` 并允许通过 root-owned `gateway.env` 覆盖 `PATH`。

2026-09-17：复核上游 Node Agent 后修正按需 Host 的 Profile 前置校验：Runtime 可以离线，但其 Node Agent 必须在线，且 Hub 中要保留该 Runtime 的 `dsh.plugins` 能力。官方 Hub Connector `1.0.4` 与当前 DSH `0.1.5-rc.2` 的真实装载测试未通过：Connector 需要 `ctx.apiProxy`，补装其依赖的旧 `dsh-host-apiproxy@0.1.0-rc.7` 又与当前 `dsh-agent-presets` 导出不兼容。该结果已记录为真实版本兼容卡点，未修改 Multica、未伪造 Connector，也未重启线上服务。目标 Ubuntu 的 Hub 容器仍健康，但 Public Origin 还是占位配置；根分区约 59 GiB 已用满，`/home` 仍约有 93 GiB 可用。

为解除上述卡点对 Profile 控制面的影响，新增锁定 Hub 1.0.4 commit 与补丁摘要的 `management-profile-runtime-v1`：Node Agent 直接把 `management.profiles[]` 公布为仅含其现有 Plugin、Snapshot、File 和 Terminal 管理能力的 Runtime，DSH Connector 在线时仍由真实 baseline 覆盖。该补丁不实现 Hub 侧 Chat/Session/Web 转发，也不复制 Plugin 事务；它只开放 Node Agent 已经实现并实际执行的能力。补丁已在 Ubuntu 的独立干净 worktree `/home/dev/dshagent-mvp/upstream/dsh-hub-management-runtime-v1` 通过上游 typecheck、Node Agent 全部 8 项状态测试和官方 `hub:release:pack`。生成的 Node Agent 包为 `dist/hub-release/k1412-dsh-hub-node-agent-1.0.4.tgz`，SHA-256 为 `9158f9729dc314d5496e4590f30bbd2fe640ff28ec8c114224c2137c8d220098`。验证过程没有覆盖或重启正在运行的 Hub。

同日首次在全新远程目录复验交付包时发现，单独执行 `npm ci` 会还原两处锁定的 DSH 兼容补丁，使 8 项 DSH Loop/Trajectory 测试失败。根工作区已增加 fail-closed 的 `postinstall`，每次安装自动执行 Session informational event 和官方 Inbox export 两项幂等补丁；未知依赖版本或锚点会让安装失败。随后在全新的 v134 远程目录从压缩包执行 `npm ci`，日志确认两项补丁均实际应用，TypeScript 检查和 132 项测试全部通过，交付安装缺口已关闭。

随后补齐多 Plugin Profile 事务的失败补偿：后续 apply 失败时，按相反顺序回滚本次已经成功的 apply，并重新安装本次事务先前通过官方 rollback 移除的原版本。新增测试覆盖“第二个安装失败”和“先移除旧 Plugin、再安装新 Plugin 失败”两条路径；所有补偿仍通过官方 `dsh.plugins` 命令执行。

2026-09-16：默认 Multica 路径已对齐“不修改 Multica 源码”的约束。官方未打补丁 Daemon 的健康检查与任务收尾支持；`dshtrace1/dshtrace2` 及使用它们的真实验收记录保留为历史/可选实验。新增官方健康兼容回归、Hub-managed Plugin 包路径、租户插件路径白名单和官方 Hub Plugin 回滚适配后，当时源码 TypeScript 检查和自动化测试为 **124 项通过**；这仍不等于在目标环境完成 100 用户压力验收。

2026-09-16（历史记录）：`mvp` 源码曾同步到 Ubuntu 独立暂存目录 `/home/dev/dshagent-mvp/source-multitenant-20260916-final/`，未覆盖既有运行目录。远程执行 `npm ci --ignore-scripts`、两项受控 DSH 兼容补丁、`npm run typecheck --silent` 和 `npm test`，当时 **122 项测试全部通过**；随后新增官方 Hub Plugin 回滚适配和 Node 分片路由，本机与远程复验均为 124 项，对应目录为 `/home/dev/dshagent-mvp/source-multitenant-20260916-v124/`。旧暂存目录仍保留作历史证据；最新远程复验见上方 v130 记录。

2026-09-16（阶段性记录）：已加入面向约 100 用户的多租户控制面代码，目标边界见 [多租户目标与 DSH Hub 定位](multi-tenant-target.md)。当时该部分通过 119 项自动化测试；随后总数曾为 122、123、124 项，当前本机总数为 132 项，但尚未在这台机器上启动 100 个真实租户或完成生产压力验收；下文的真实部署证据仍是单用户基础链路，不能扩写为多租户生产证明。

2026-09-16：已在同级临时目录按锁定提交 `k1412/dsh-hub@cc730d0091337767e437e0964c9f93ba3f490de7` 完成 `pnpm install --frozen-lockfile`、Hub Server 构建校验和 Hub TypeScript 检查。该证据证明上游源码可构建，不代表已配置真实用户或已启动生产 Hub。

2026-09-16：多租户 Gateway 已增加 `requireHub` 启动门禁、`/hub/v1/me` 身份预检，以及 `hubProfileTargets` 静态映射、`hubProfileTargetTemplate` 确定性映射、`hubProfileTargetShards` 分片映射和可插拔解析模块；`mvp/deploy/dsh-hub/compose.yaml` 与 `.env.example` 可直接复用上游 Hub 的独立服务部署模板。目标服务器仍未配置真实 Access/SSO 或 100 个用户压测。

2026-09-16（阶段性记录）：早期 `mvp` 源码已安全暂存到 Ubuntu `/home/dev/dshagent-mvp/source-multitenant-20260916/`，当次远程复验 **119 项测试全部通过**。该目录未覆盖既有 `source`，也未复制运行配置或密钥；随后远程 122 项复验及本机 123、124 项复验见上条记录。多租户 Gateway 尚未用生产凭据启动，也不代表完成真实 100 用户压力验收。

2026-09-16（阶段性记录）：在上述远程复验后，新增运维用户启用/禁用接口和跨 Multica workspace 的 Daemon 注册拒绝规则；当次复验最终 **119 项测试全部通过**。新增行为仍属于控制面验收，生产环境还需配置真实身份源和用户级 workspace 凭据；当前最新源码已完成 122 项远程复验。

2026-09-16：已在目标 Ubuntu 的独立 rootless Docker（data-root 位于 `/home/dev/dshagent-mvp/runtime/docker-data`）启动锁定版本 `ghcr.io/k1412/dsh-hub:1.0.4`，镜像摘要为 `sha256:3f548fd79610aabbcb4d735fa1b26e700e1d3395a34c85818a74ab46ff64a483`。服务绑定回环端口 `19090`，`/healthz` 携带内部 Origin Secret 返回 `{"status":"ok"}`。这是早期容器基线记录，已被 2026-09-17 的内部回环 Hub/Node Agent 实际验收替代。

2026-09-16：补充 `mvp/deploy/multi-tenant-gateway/dsh-multi-tenant-gateway.service` 及安装说明，可将多租户 Gateway 作为一个非特权 systemd 服务常驻；用户 DSH Host 仍由 `HostSupervisor` 按需启动。服务单元已做静态审查，尚未在目标 Ubuntu 以真实 systemd 安装运行。

2026-09-16：通过 SSH 对目标 Ubuntu 做只读复核：Docker 29.5.2、Compose 5.1.4、Node 22.20.0 可用，内存约 15 GiB；根分区 `/` 仅剩约 411 MiB（100%），`/home` 仍有约 100 GiB。现有 Docker、Daytona、搜索和转发服务未修改。后续 Hub/多租户部署应把状态放在 `/home`，并先处理根分区空间；真实 Hub Access/SSO 凭据尚未配置。

部署位置已再次按用户修正：Windows 运行 Gateway、官方 DSH、官方 Multica Server；Ubuntu 运行 Daytona、PostgreSQL 等 Docker 依赖。沙箱内运行官方 Daemon 与 CLI。详见 [两机部署与网络](windows-ubuntu-deployment.md)。

## 两机部署进展

- Windows 官方 DSH `0.1.5-rc.2` 已安装，Session 与原生 Inbox 导出补丁已应用；依赖已整合为 npm workspaces，Host/Loop/Trajectory 使用同一份 Cordis 与 Session。
- Ubuntu 独立 Docker 已启动，data-root 验证为 `/home/dev/dshagent-mvp/runtime/docker-data`；没有改变原 Docker 服务和数据目录。
- 官方 Alpine 测试容器通过自有网络连接到 DeepSeek HTTPS，收到 401；未使用 API key，未产生模型测试结果。
- Docker 容器经 SSH 反向隧道成功读取 Windows 临时 HTTP 服务。真实 Daytona 沙箱及 Daemon 网络仍需验收。
- Daytona 官方 `0.187.0` 的 API、Runner、Proxy、Dex 均已健康；Windows 经 SSH 检查 API `/api/health` 与 Dex discovery 均返回 200。通过真实 Dex OIDC 流程建立个人组织与 API key，没有 SQL 种子伪造认证。
- MinIO 官方 `mc` 已创建 `daytona` bucket，Windows 官方 SDK 已成功上传构建上下文。CLI 工具快照已由官方 API 确认 `active`，规格 2 CPU / 3 GiB / 8 GiB；构建内真实版本检查为 Codex `0.154.0`、Claude Code `2.1.270`、Multica `dshtrace1`。
- API 已应用官方 `PROXY_TOOLBOX_BASE_URL=http://localhost:34000`，重载后健康检查 200；用于 Windows 经 SSH 调用真实沙箱 Toolbox。
- Windows 官方 Multica Server 使用固定提交及记录的 `dshtrace1` 补丁，`/health`、`/readyz` 返回 200；独立 PostgreSQL 17 已应用到迁移 479。官方本地认证、workspace 与 PAT 初始化完成，没有外发邮件。
- 独立测试数据库运行四项实际 Multica handler 测试，覆盖整批写入、序号顺序、原子回滚和重试去重/真实工具 `call_id`，均明确 PASS。
- Gateway 真实 `/v1/health` 已返回 200；还需通过其消息入口验证沙箱、CLI 和轨迹全链路。
- 阶段性统一模块测试曾为 119 项；当前最新本机总数为 132 项，包括官方 DSH JSONL 恢复、Gateway HTTP/SSE、取消意图恢复、显式空实例预约恢复、安全观察错误分类、多租户 Session/Task 配额、SDK/HTTP 契约夹具、官方 Hub Plugin 回滚契约、Hub Runtime 在线/能力校验和 Node Agent 配置校验；它们仍不能替代端到端验收。

## 首次真实并发创建故障

两条 Gateway 消息均被真实 DSH 接受，官方 Daytona 仅创建一个沙箱；但 Runner 的 `NO_PROXY` 缺少内部网段 `172.20.0.0/16`，导致内部 Toolbox 健康检查通过外部代理，最终报 `timeout waiting for daemon to start`。实际容器 Toolbox 已启动，代理路径返回 502，直连可达。已修正配置并重载 Runner。

该版本将此错误标记为 `recoverable=false`，官方 start/stop/recover 均不能从这一状态恢复。此时尚无 Multica 任务，未执行 Multica bootstrap 或写入模型密钥；SQLite 保留 `creation_unknown`，两个原生 DSH turn 保持 OPEN，没有伪造完成或自动重复创建。私有 `first-creation-failure.json` 保存实际首次失败证据。后续采用确认空沙箱后官方删除、确认资源不存在、显式审计预约恢复的流程；首次创建失败不算端到端验收通过。

受控恢复已完成：运行 Key 没有删除权限，最终使用本地 Dex 已认证的所有者身份执行官方删除，独立 GET 404 确认旧资源不存在；SQLite 精确预约记录经 CAS 清理，schema 4 的 `sandbox_replacements` 保留审计。运行 Key 未扩权。继续执行时沿用两个原始 DSH 请求标识，不生成替代用户消息。

## 2026-09-14：首次环境验证

目标主机：用户提供的 Ubuntu 开发机。部署根目录已建立为 `/home/dev/dshagent-mvp/`，包含 `source`、`runtime`、`cache`、`tmp`、`logs`、`upstream`。CLI 凭据目录权限设为 700，未使用或修改 root 密码。

- 系统：Ubuntu 22.04.5，内核 `6.8.0-101-generic`，VMware 虚拟机。
- 资源快照：8 vCPU，约 7GiB 可用内存；`/home` 约 131GiB 可用，ext4；根分区仅约 480MiB 可用。
- Node：22.20.0；Docker 可用，数据目录仍在 `/var/lib/docker`。
- `/dev/kvm` 不存在；CPU flags 无 `vmx`/`svm`。
- 用户要求尝试开启嵌套虚拟化后，执行 `sudo modprobe kvm_intel`，返回 `Operation not supported`。确认无法仅在来宾 Ubuntu 内完成启用。
- 尚未关机、重启、修改内核、GRUB 或 VMware 配置。需要用户提供 VMware 管理入口，或者明确采用其他执行节点方案。

官方 CubeSandbox 固定源码：`bc198e42a955d4bda2c66ca3e3c7c32ae77abc48`。

- 官方 [PVM 部署说明](https://github.com/TencentCloud/CubeSandbox/blob/bc198e42a955d4bda2c66ca3e3c7c32ae77abc48/docs/guide/pvm-deploy.md)提供无硬件扩展透传的路径，但要求切换内核并重启。当前没有执行该系统级变更。
- 官方 [快速开始](https://github.com/TencentCloud/CubeSandbox/blob/bc198e42a955d4bda2c66ca3e3c7c32ae77abc48/docs/guide/quickstart.md)要求沙箱存储支持 XFS reflink，至少 50GB 空间。当前 `/home` 为 ext4，不能仅创建普通目录便宣称满足沙箱快照要求；后续需配置独立 XFS 存储或经验证的 XFS 文件挂载。
- 官方 SDK 源码存在但 npm 查询 E404；已从固定提交构建 SDK，出处与完整性见 `deploy/vendor/README.md`。

DSH `@deepseek-ai/dsh@0.1.5-rc.2` 已在远程 `/home/dev/dshagent-mvp/runtime/dsh-host` 安装成功（582 packages，exit 0）。已应用明确记录的 Session informational event 最小补丁。首次直接启动检查 HTTP 为 000，进程已退出；尚未确认真实 DSH 服务健康，正在排查启动方式。本条不代表整个 DSH 部署已完成。

## 最终验收状态

真实 CLI 调用、同类与混合并行、同一个 DSH 会话的 Codex → Claude Code → Codex、原生轨迹和 Gateway 回复、取消隔离、空闲沙箱停止/恢复均已验收。完整证据索引见 [真实验收结果](acceptance-results.md)。

队列运行暴露的后台 Git 进程问题已由 `dshtrace2` 修复，并通过全自动真实队列复验。原生 CLI 意外退出、Daemon 停止恢复、短断线补传、完整冷启动与重复请求重放均已通过。共享 Chat 回归后，最终 17 个 DSH 会话、21 个真实任务均已收尾（19 成功、1 取消、1 失败），无重复轨迹。

验收以真实框架/API、原生 JSONL、Gateway SSE 和文件/进程证据为准；Web 视觉渲染未实测。长时间离线期间的终态报告持久化仍有上游限制，不能把短断线补传通过等同于无限断线自动恢复。完整边界见 [真实验收结果](acceptance-results.md)。






