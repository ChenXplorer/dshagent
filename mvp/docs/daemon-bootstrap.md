# 真实沙箱 Daemon 装配

`packages/sandbox-management/bootstrap.ts` 通过官方 Daytona SDK 上传固定 Multica Daemon 二进制、原生 CLI 配置，以及权限为 0600 的私有 Daemon 配置与环境文件。工作目录权限为 0700。CLI 以 `daytona` 用户执行；进程审计单独使用 `sudo -n python3`。工具快照必须安装 Python 3、sudo、真实 Codex / Claude Code 和无密码 sudo 权限。

启动使用官方 `multica daemon start --foreground --no-auto-update --no-auto-reload --daemon-id ... --max-concurrent-tasks 2`，认证通过官方 `~/.multica/config.json`。Daemon HOME 是私人配置目录；原生 CLI 配置来自各自独立的 CODEX_HOME 和 CLAUDE_CONFIG_DIR，Agent 不覆盖模型或密钥。

2026-09-14 直接获取的 [DeepSeek 官方 Codex 配置脚本](https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh) 提供当前 `deepseek-flash` 模型 catalog，最低客户端 0.144.0。本次只把脚本当作数据读取，提取完整官方 JSON；没有执行安装脚本或改写模型元数据。私有目录中的 catalog SHA256 为 `d47876f3bca395fe2d9d3c7fc7312282a60da8a2479dd13b995cb8e0fe2695dd`，生产配置同时指定 `nativeCatalog` 来源/哈希和原生 `modelCatalogPath`，上传前验证内容与选中模型。

就绪检查在真实沙箱内读取 `127.0.0.1:19514/health`，确认 daemon_id、沙箱可达的 Windows server_url、固定 cli_version、Linux OS 和 PID，再等 status=running。官方未修改 Daemon 不包含 outbox/claim 扩展字段；平台会在提交终态后读取官方 Task 消息，并以稳定 PID 和 `/proc` 进程核验作保守收尾。若配置显式开启 `requireEnhancedHealth`，才要求历史补丁提供的扩展字段。平台还检查两个真实 Runtime 已注册。配置 fingerprint 变更时拒绝直接复用运行中的 Daemon，需明确空闲重启。检查 `codex --version`、`claude --version` 不调用模型。

生产配置在 `DSH_MVP_CONFIG` 指向的私有 JSON，类型定义位于 `apps/dsh-host/create-driver.ts`。Windows 本地 Multica API URL 和沙箱访问的 Windows URL 是两个独立字段。当前本地私有配置为 `.runtime/driver/config.json`；目录已由 Git 忽略。密钥只在进程内解析、上传至私有文件，未拼进命令参数。

收到 Server 终态之后，通过真实 `/proc` 两次扫描目标 `MULTICA_TASK_ID` 环境标记，并保守检查 Daemon 的全部子孙进程已经退出。读取失败或没有权限时不确认结束。官方模式再确认 Daemon PID 未变；历史增强健康模式还会确认 claims、outbox 和活动任务为空。官方模式无法从 Daemon 健康端点证明 outbox 已落盘，因此长期断线仍保持待对账；环境标记也不是恶意程序主动抹去标记、重新托管进程的隔离证明。

`bootstrap.test.ts` 是身份/证据格式和命令引用单元测试；SDK 合同测试也不是模型执行验收。真实快照、Daemon 启动、两种 CLI 模型调用与 DSH 页面验收必须另外运行，不能从这些测试推断完成。

首次并发验收脚本是 `tests/run-first-concurrency.ts`，必须在真实快照 active、Toolbox 代理可达、Host 加载 Multica Factory 之后显式运行。参数依次为私有 Driver JSON、Gateway token 文件、全新的证据 JSON 路径。脚本创建两个原生 DSH 会话，持久化稳定请求 ID 后并发投递两条真实 Codex 请求；每条只在独立目录写入一个 nonce 证明文件，并等待 30 秒使执行重叠可观察。验证真实文件、Daemon 同时持有两个 Task、唯一个人沙箱。已有 sandbox reservation 或证据文件时拒绝重新执行；错误保留真实意图，不自动重复 POST。这是会使用实际模型额度的验收入口，不在单元测试自动运行范围内。

`tests/run-sandbox-lifecycle.ts` 只在已有个人沙箱上执行，参数为 `assert-active|cycle-idle`、私有 Driver JSON、首次并发证据 JSON、全新生命周期证据 JSON。`assert-active` 在存在真实活跃任务时验证停止被拒绝；`cycle-idle` 在所有任务和轨迹确认结束后调用生产服务的官方 stop/start，检查沙箱 ID、证明文件和 CLI 配置/catalog 哈希保持相同，Daemon 与两种 Runtime 重新就绪。它不会创建替代沙箱。观察上限 5 分钟，超时退出保留持久化的 pausing/resuming 意图，不能自动重发操作。首次请求、Runtime 矩阵与停止恢复验收必须协调运行，避免同时修改生命周期。

`tests/run-failure-offline.ts` 提供两个需要明确协调执行的真实故障验收。`own-cli-failure` 在独立 Gateway 会话中启动无副作用等待命令，只对具有该 Task 环境标记、祖先进程链通向已验证 Daemon、实际可执行文件名为 `codex` 且角色为 `app-server` 的唯一原生进程使用 Linux pidfd 发 SIGKILL；发送前重新验证 PID、启动时钟、可执行文件和祖先链，不使用广域 kill 或修改模型配置。成功条件还包括实际任务 failed、目标进程及其残留子进程退出、轨迹上报完成。`idle-daemon-recovery` 在任务全部结束后用官方 Daemon stop 命令确认健康端口离线，而后通过新 Gateway 请求触发生产自动启动，验证原沙箱/Daemon 身份及两种 Runtime 恢复。它验证的是实际自动恢复，不伪造离线请求错误。中继断网等导致的不可恢复 pending 状态不由这个脚本证明，需另行控制故障；已接收而未结束的请求可通过原生 DSH 重启恢复，同一已结束 requestId 不得重新执行。

## 首轮真实结果（2026-09-14）

已通过 Gateway → 原生 DSH Loop → 官方 Multica Server → Daytona 内真实 Daemon → Codex CLI 0.154.0 / DeepSeek Flash 执行两个任务。两份真实 nonce 文件位于独立工作目录，Python 命令实际重叠约 29.736 秒；Daemon 同时持有两个任务，最终轨迹与进程确认完成。运行中通过生产服务拒绝停止沙箱。原生 DSH/Gateway 中各有匹配的工具调用/结果以及最终证明标记，没有重复事件。证据保存在私有 `.runtime/driver/first-concurrency.json`、`first-active-stop-refusal.json` 及 `.runtime/dsh/acceptance/first-settled.json`、`first-gateway-proof.json`。

首次空沙箱曾因 Daytona 自身启动网络检查超时进入不可恢复 ERROR；没有执行 Multica 任务。修复启动网络配置后，通过官方所有者权限删除这个空失败资源、独立确认 404、保存关联预留修复审计，再恢复原来两个 DSH requestId。只有一个现存个人沙箱；这不等于抹去第一次失败尝试。首次失败、原生 OPEN turn 和受控替换证据均在 `.runtime` 保留。上述通过项不替代 Claude/mixed Runtime、取消、生命周期和额外故障矩阵的独立验收。

随后真实 Runtime 矩阵完成同一 DSH 会话的 Codex → Claude Code 切换、混合 Runtime 并行、两个 Claude Code 并行及单任务取消隔离，六个任务均完成结算，证据为 `.runtime/driver/runtime-matrix.json`。Claude 原生日志实际记录模型 `deepseek-flash`。

`tests/run-runtime-roundtrip.ts` 接着在原来的第一个 DSH 会话中切回 Codex，没有创建新 DSH 会话。真实 Codex 命令读取该会话先前 Codex 和 Claude 写入的两份文件，并生成新的独占证明文件；同一个 Multica Chat、Project、目录和个人沙箱保持一致，第三个本地执行段只用于任务关联。每次出站消息都只包含当前 prompt 和幂等 marker，未生成 DSH handoff 文本；Chat 历史由 Multica 维护。`.runtime/driver/runtime-roundtrip.json` 的断言全部通过；原生 DSH/Gateway 另行验证本次 requestId 对应的最终 `ROUNDTRIP_` 标记和真实工具调用/结果配对。此结果证明同一 DSH 会话的 Codex → Claude Code → Codex 往返；生命周期与额外故障验收仍需独立执行。

实际空闲停止/恢复已通过，证据 `.runtime/driver/sandbox-idle-cycle.json`：官方 Daytona 状态确认为 stopped 后再 start，原个人沙箱和 Daemon 身份保留，两种 Runtime 恢复就绪，原生 CLI 配置、catalog 和两份首轮证明文件的哈希完全一致。

历史队列验收遇到 Codex 插件目录后台 Git 子进程在 CLI 正常退出后残留，进程审计保留任务为未结算，没有把上游 completed 当作进程退出证明。受控清理后原请求自然结算，失败尝试证据仍保留。随后曾将官方 CLI runner 的进程组回收修复作为可选 `dshtrace2` 实验；该实验不属于当前默认部署，官方模式仍按保守进程核验收尾。

升级脚本 `tests/deploy-daemon-revision.ts` 要求 Host 离线、无活跃任务和旧 Daemon 身份正确；验证独立新二进制的 SHA256 与实际版本后调用官方 stop，再由生产 bootstrap 启动同一沙箱内的新 Daemon。旧二进制保留，私有配置更新版本与二进制路径。`.runtime/driver/daemon-dshtrace2-deployment.json` 只记录历史可选实验；新部署应使用官方未修改二进制和新的摘要/版本记录。修复后的队列重跑与额外故障验收不能替代官方路径的重新验收。

原生 CLI 故障与 Daemon 自动恢复也已真实通过，分别记录在 `.runtime/driver/cli-native-failure.json`、`daemon-recovery.json`。原生 Codex 被精确终止后，上游任务与平台均为 failed，进程退出和轨迹上报得到确认；DSH 保留真实 error、已有工具调用和缺失结果的事实。空闲 Daemon 经官方 stop 后健康端口离线，新请求恢复原有沙箱与 Daemon 身份并成功执行。较早的 `.runtime/driver/cli-failure.json` 只终止 npm 启动包装进程，实际 Codex 仍完成任务，因此保留为无效故障注入尝试，没有改写成原生 CLI 失败。
