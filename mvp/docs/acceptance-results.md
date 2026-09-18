# 真实验收结果

## 2026-09-17：免登录 MVP 控制面

- 当前部署没有终端用户登录鉴权；浏览器请求固定映射到模拟用户。
- Gateway 固定映射模拟用户 `user-a`；Windows 端不带 Authorization 请求访问 `/v1/health` 返回 ready，访问 `/v1/profile` 返回该用户 Profile v2。
- 内部 Hub 绑定 `127.0.0.1:19190`，`/healthz` 与 `/hub/v1/me` 实测通过。
- 官方 Node Agent 真实完成 enrollment 并保持在线；`node-a`/`node-b` 分别承载 51/51 个管理 Runtime，102 个 Runtime 均公布 `dsh.plugins`、`dsh.snapshots`、`dsh.files`、`dsh.terminals`。
- 102 个活跃租户已经通过 Multica 官方 Workspace API 获得互不相同的 Workspace；没有直接写 Multica 数据库。只读 Fleet 验证器逐一核对了 102 个用户的 Workspace、稳定 Hub 分片和线上 Runtime。
- 本地 MVP 类型检查通过，自动化测试 **145/145** 通过；Gateway、Hub 与两个 Node Agent 当前均为 persistent/active。

### 第二租户真实执行与同会话切换

为避免把 `user-a` 的旧单用户证据误当成多租户证据，本次另用 `user-003` 完成真实链路。Gateway 为它创建独立 Daytona Sandbox `f231111d-89dc-4eef-8501-005ab2f847bd`、默认 Daemon 和 Multica Workspace，并打开 DSH Session `user-003-live-acceptance`。

同一个 Session 依次执行 Codex → Claude Code → Codex，三个 Task 都进入 `completed`。第一轮 Codex 返回 `USER003_MULTITENANT_OK`；第二轮 Claude Code 通过同一个 Multica Chat Session 的历史读取到该标记并返回；第三轮 Codex 再次从同一 Chat 历史取得该标记。DSH JSONL 中三轮分别记录 `codex`、`claude-code`、`codex`，Sandbox ID 始终相同。该证据说明切换复用了 Multica 的统一 Chat 上下文，DSH 没有另造 handoff，也没有同步用户代码目录。

该验收只证明第二个租户能够独立完成真实 Sandbox/Daemon/CLI 链路，以及单 Session 的 Runtime 往返切换。它不代表 100 个 Sandbox 能在当前 15 GiB 实验机上同时运行。

日期：2026-09-17。本表只把实际运行并核对的项目标为通过；历史真实服务/模型验收与当前 `npm test` 的 145 项自动化测试分开统计，TypeScript 检查通过。历史真实 CLI 队列和断线补传证据使用过 dshtrace 补丁；这部分不代表当前默认的官方未修改 Multica 路径。新增多租户控制面测试是本地 SQLite/HTTP/进程级验证，不等于已经用 100 个真实用户完成压力或生产验收。

## 已通过

## 多租户控制面真实烟测（2026-09-16）

使用本项目 Gateway 的隔离演示租户 `tenant-demo` 完成了一次真实链路烟测：Gateway 在本机 `127.0.0.1:3390` 启动，按需创建 Daytona Sandbox `c793c2be-7991-464b-8004-c0fd48100cb3`、用户 DSH Host 和一个平台默认 Daemon；同一个 DSH Session `session-d817fd0d-3739-403a-afba-a8a185557a8f` 先执行 Codex，再切换 Claude Code。两条请求均由真实 CLI 返回 `READY`/`CLAUDE_READY`，Multica Task 状态为 `completed`，Session 轨迹记录了两个不同 Runtime 的 Task；随后关闭 Session 并将同一 Sandbox 按官方 API 置为 `paused`。这证明 Gateway 的用户→Sandbox→Host→Session→Runtime 关联可运行，但只是单租户烟测，不代表 100 用户容量或生产身份验收。

早期 Hub 容器基线曾在回环端口 `19090` 完成健康检查；该实例现仅作为回退。当前验收使用 `19190` 的内部回环 Hub，不配置浏览器登录。真实 `node-a` 与 `node-b` Enrollment 已完成，两个节点均在线；102 个用户 Runtime 按 51/51 注册，全部公布 `dsh.plugins` 管理能力。该项是控制面 Fleet 验收，100 用户同时执行、每用户 Multica workspace 和 Sandbox/CLI 压力测试仍未完成。

| 项目 | 实际证据 |
| --- | --- |
| 官方框架执行链 | Windows Gateway → 官方 DSH AgentFactory → 官方 Multica Server → Daytona 内官方 Daemon → 原生 Codex/Claude Code CLI；两个 CLI 均使用私有原生配置调用 DeepSeek Flash |
| 同用户双 Codex 并行 | 两个真实工具命令的执行区间重叠约 29.736 秒，工作目录独立，共用一个个人沙箱 |
| 同用户双 Claude Code 并行 | 两个真实工具执行区间重叠，目录独立 |
| Codex/Claude Code 混合并行 | 两种 CLI 的工具执行区间重叠，切换一个会话不改变另一个会话的 Runtime |
| **同一个会话双向切换** | **同一个 DSH Session 完成 Codex → Claude Code → Codex**；三段复用同一个 Multica Agent、Project 和 Chat Session，切换只更新 Agent 的 `runtime_id`，工作目录、项目和沙箱不变；每次只提交当前 prompt，Multica 负责 Chat 历史和 CLI 恢复 |
| 单任务取消 | 取消 Codex 时并行 Claude Code 正常完成；被取消的长命令没有写出最终文件，平台确认执行停止后才标为 cancelled |
| 原生 CLI 意外退出 | pidfd 精确终止独立测试任务的原生 Codex app-server；官方任务与平台均 failed，确认没有存活的任务进程且轨迹已上报；DSH 原生 error 和 Gateway SSE 保留失败，不伪造回复/工具结果 |
| Daemon 离线恢复 | 官方停止后确认健康端点消失，新 Gateway 请求自动恢复同一个 Daemon 与个人沙箱，两个 Runtime 重新就绪，实际任务完成且 DSH/Gateway 回复与工具轨迹完整 |
| 原生 DSH 轨迹与 Gateway 回复 | 实际 JSONL 与 Gateway SSE 中存在最终回复、真实工具调用和对应结果、任务关联，无重复投影；取消任务保留原生 aborted 和未完成工具事实 |
| 活跃任务禁止停止沙箱 | 通过生产沙箱管理服务实际调用停止，收到 ACTIVE_TASKS，沙箱仍 started |
| 官方额度排队与自动收尾 | `dshtrace2` 下两个名额占满时第三任务排队，释放后运行，真实执行区间无三任务重叠；三个任务自动结算，无人工清理、重启或重放，原生轨迹与 Gateway 回复完整 |
| 空闲沙箱停止/启动 | 官方 API 确认 stopped/started，SQLite paused/ready，同一个沙箱与 Daemon 身份、两个 Runtime 可用；CLI 配置、模型目录和原测试文件 SHA256 不变 |
| 固定用户身份 | 实际 Gateway 覆盖 userId 请求返回 400，未认证请求返回 401 |
| 首次故障后的原请求对账 | 两个原始 requestId 重放后，原 JSONL 前缀保持、各仅一个 user/message 与 turn/start、各仅一个实际 Multica Task |
| DSH 冷启动与重复请求 | 升级后对 9 个真实会话的原请求各重复两次，共 18 次 accepted；任务/执行段/Runtime/沙箱映射和旧事件哈希前缀保持，无新增用户消息、turn、任务或 CLI 调用 |
| 真实断线补传 | 停止 Multica Server 后捕获 pending=1 且任务仍 active；恢复后 pending=0，同 requestId/taskId/messageId 经 DSH 冷启动对账保持不变，游标 1→8、序号连续、全部事件已投影、最终回复与两对工具完整 |

往返切换所用 DSH Session：`e0c69f47-ebcd-4670-8b31-a6b48e6f70a7`。
恢复后个人沙箱：`efcbef3d-e2e7-4f33-888d-3de83964a3c4`。

原生成功工具以真实 callId 配对。取消任务没有收到工具结果时保留未配对工具调用，不伪造空结果。缺失的上游模型/用量字段仍视为未知；Claude Code 原生日志实际报告了 `deepseek-flash`。

## 最终审计与验收边界

最终原生审计覆盖 **17 个 DSH 会话、21 个真实任务**：19 completed、1 cancelled、1 failed；没有活动任务、未关闭 turn 或重复投影。两个被取消/失败的工具调用没有结果，均按实际事实保留。Gateway、Multica health/readyz、Daytona health 检查正常；未认证的 DSH Web 请求按官方机制返回 401。

DSH 展示接口以真实原生 JSONL、Session 投影和 Gateway SSE 验收；Web 页面视觉渲染尚未实测。独立目录并行已通过真实任务验证；共享目录采用拒绝并发写入的策略，通过真实 SQLite 多连接事务测试验证，未伪称另一组真实 CLI 场景。

### 队列首次运行发现的进程清理问题

真实队列已观察到两个名额占满、第三任务持续排队、释放后调度，三个工具执行区间符合并发上限。但任务 A 结束后，Codex 自动插件目录更新留下了四个带该任务标识的 Git 进程。平台正确保留未确认状态，首次队列脚本超时，没有将其标为通过。

保存 PID、启动时间、父进程和任务归属证据后，按 pidfd 精确清理了该任务的四个进程。原 DSH 观察器自然完成确认，三个任务的原生最终回复、工具配对与 Gateway SSE 均通过，没有重发任务。原失败证据保留。

随后部署 `dshtrace2` 正常结束时的进程组清理补丁，并以新任务重跑完整队列验收通过；这次全部自动收尾。Linux 子进程回归覆盖正常结束、取消和并行进程隔离，旧版本负向对照复现遗留进程问题。快照保留原基线，生产 bootstrap 使用独立新版二进制，旧二进制保留回退。

## 首次环境故障，不计为首次创建成功

最初两个并发请求只创建了一个沙箱，但 Runner 的代理排除列表遗漏内部网段，Toolbox 健康检查失败。修正 `NO_PROXY` 后，固定 Daytona 版本不支持原地恢复此错误。确认实例为空、没有任务或 CLI 私有配置后，通过官方所有者权限删除并确认 404，再显式审计重置创建预约，以原请求继续；没有盲目重复创建，也没有把数据库状态强写为成功。

详情见 [部署进展](deployment-progress.md) 和 [Daytona 工具快照说明](../deploy/sandbox/README.md)。后续测试复用恢复后的单一个人沙箱。空实例替换与正常空闲停止/启动是不同场景，分别报告。

## 证据保存

凭据、原始请求和运行日志均在 Git 忽略的 `.runtime/`。已完成证据包括：

- `driver/first-concurrency.json`、`driver/first-active-stop-refusal.json`
- `driver/runtime-matrix.json`、`driver/runtime-roundtrip.json`
- `driver/gateway-identity.json`
- `driver/sandbox-idle-cycle.json`
- `driver/daemon-dshtrace2-deployment.json`
- `driver/queue-dshtrace2.json`
- `driver/cli-native-failure.json`
- `driver/daemon-recovery.json`
- `driver/outbox-replay.json`、`driver/final-health.json`
- `driver/first-creation-failure.json`、`driver/empty-sandbox-replacement-owner.json`
- `dsh/acceptance/` 下对应原生 JSONL 与 Gateway SSE 核验结果

长期断线时，官方 Multica 终态上报尚无完整持久化重试队列。轨迹批次补传补丁不等于终态报告持久化；见 [轨迹持久化边界](multica-trace-durability.md)。

CLI 故障测试首次只终止了 npm 启动包装进程，实际 Codex 正常完成，故未计为故障处理通过。之后修正为按实际可执行文件、app-server 角色、任务标识和父进程链识别原生 Codex，再以新测试任务完成上述故障验收；两次证据分别保存。

## 网页 Runtime 选择器补充验收（2026-09-14）

后续补充了 `packages/ui-runtime-selector`，使用官方 DSH 输入栏槽位与 client module loader。输入栏显示“执行器”下拉框，可选择 Codex / Claude Code；读取和修改均使用当前 sessionId、官方浏览器认证以及原生产 driver。未向浏览器暴露 Gateway Token 或模型密钥。

本次通过真实浏览器操作完成：选择 Claude Code、刷新保持选择、发送第一轮、观察运行期间禁用、完成后切换 Codex、发送第二轮、刷新保持 Codex 且可再次切换。两项任务在官方 Multica 与平台均 completed，官方 provider 分别为 claude 和 codex；同一 DSH session、sandbox 和 workDir。网页真实展示两轮回复。私有证据：`.runtime/driver/browser-runtime-acceptance.json`。该轮测试不修改用户文件，也没有执行额外文件命令。

## DSH Managed Skill 实际验收（2026-09-15）

新增 `packages/skill-distribution` 后，MVP 从 `mvp/skills/<name>/SKILL.md` 读取 DSH Skill，调用官方 Multica Skill CRUD 接口，再调用官方 Agent-Skill 绑定接口。单元测试与类型检查均通过（当前 132 项测试全部通过）。

当前 Windows 部署已启用 `managedSkillsDir`，实际创建了 `dsh-anime-phrase-transformer`，并在同一个 Multica workspace 中读回 Skill ID `e34bd2d8-5c4b-4749-aaca-a9f58fa583ce`。随后通过 Gateway 创建真实 DSH Session，提交真实 Codex CLI 任务；任务 completed，Agent 读回该 Skill 且 `enabled=true`。Codex 返回了按 Skill 约定的“改写结果”和“语气说明”，证明 Skill 已经经过 Multica Daemon 注入并影响了原生 CLI 输出。私有运行证据：`.runtime/driver/skill-live.json`。

该能力只同步 Skill 包和辅助文件，不同步用户项目代码目录。Runtime 切换时继续使用同一个 Multica Agent 的 Skill 绑定；目标 CLI 不支持某种 Skill 能力时，应在后续能力矩阵中明确标记并拒绝静默执行。

随后用同一个新 DSH Session 做了真实 Codex → Claude Code 往返：Codex 任务和 Claude Code 任务均 completed，两个任务的 `agentId` 和 `chatSessionId` 相同，Agent 读回同一个 `dsh-anime-phrase-transformer` 且 `enabled=true`。Codex 和 Claude Code 的实际回复都遵循该 Skill 的“改写结果/语气说明”格式。私有证据：`.runtime/driver/skill-cross-runtime.json`。

## 共享 Chat 回归验收（2026-09-14）

在上述部署重启并加载新版代码后，使用新的 DSH Session `5455bc99-22db-429f-965c-64630154f275` 真实发送 Codex、再切换 Claude Code 并真实发送第二轮。两个任务均 completed；Multica/SQLite 读回确认两段的 `agentId`、`projectId`、`chatSessionId` 和 `workDir` 分别只有一个值，Runtime 顺序为 `codex → claude-code`。这次验证的证据保存在私有 `.runtime/driver/shared-chat-switch.json`；它证明新版实现不会因为切换而创建第二个 Multica Chat。

历史记录：新增认证/配置校验/执行期拒绝切换以及旧资源接管测试后，自动化测试为 120 项全部通过，TypeScript 检查通过。早期“Web 视觉未验收”记录由本次选择器和两轮对话的浏览器检查补充；这不表示全部原生 Web 功能均已验收。另关闭默认模型设置 onboarding，避免再次要求配置已由 CLI 管理的模型 Key。当前总数为 132 项。






