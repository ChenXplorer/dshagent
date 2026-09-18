# 原生 CLI 配置与验证边界

> 2026-09-14 状态更新：真实部署与端到端验收已经完成。下文包含早期检查记录；当前版本、安装步骤和最终边界以 [部署手册](deployment-handbook.md) 与验收结果为准。

检查日期：2026-09-14。模块入口为 `packages/cli-configuration/index.ts`。本模块只生成 CLI 原生配置，不请求模型、不启动 CLI、不替代官方 Multica Daemon。

## 协议与版本证据

| 项目 | 已核实事实 | 尚未证明的内容 |
| --- | --- | --- |
| 本机 Codex | 官方 npm 包 `@openai/codex` 0.133.0；`codex --version` 返回相同版本；原生解析器拒绝 `wire_api="chat"` | 沙箱内的真实模型与工具执行 |
| 本机 Claude Code | 官方 npm 包 `@anthropic-ai/claude-code` 2.1.201；`claude --version` 返回相同版本 | Linux 安装、模型与工具执行 |
| Codex → DeepSeek | 当前官方 DeepSeek 已原生支持 `/responses`，可以使用 Codex 自定义 provider；不需要自行增加 Chat Completions 转换代理 | 用户实际提供的 endpoint、model、key 是否可用 |
| Claude Code → DeepSeek | 官方 DeepSeek 支持 Anthropic 协议，其 Claude Code 指南提供原生环境配置 | 用户所选模型的实际工具兼容性 |

[OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)说明自定义 provider 使用 `base_url`、`env_key` 和 `wire_api="responses"`；当前不支持 `chat`。本地实际执行过一次不含凭据、仅指向回环无服务端口的负向配置检查，CLI 在联网前报告不支持 `chat`。

[DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)已明确支持 Responses 与流式事件，支持函数工具和 `apply_patch` 自定义工具；服务器不保存会话，不能依赖 `previous_response_id` 恢复。会话连续性须由 CLI 保存。使用该接口不等于支持 OpenAI 所有内置工具，本模块关闭 Codex 内置 Web Search。

[DeepSeek Codex 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)提供原生模型 catalog；2026-09-14 实际获取的 catalog 声明 `minimal_client_version: 0.144.0`。本机 0.133.0 只用于基础字段解析检查，不能作为当前 catalog 的兼容版本凭证。部署时应选择并固定满足 catalog 要求的官方 Codex 版本、保存 catalog 来源与 SHA256，再做真实执行验证。模块支持 `modelCatalogPath`，不复制或编造整套模型元数据。

[DeepSeek Claude Code 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)使用原生 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`，并为 Opus/Sonnet/Haiku 别名和子 Agent 指定模型。[Anthropic 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)列出工具调用能力及部分忽略的字段。因此仅设置 API 地址不足以证明实际模型正确，验收还要检查真实返回模型。

检索摘要与当天实际获取的官方页面中模型名称存在差异；不把搜索摘要当部署版本锁。模型、base URL、catalog 均由部署配置明确提供，不能因为名称未知而自动替换成其他模型。

## 模块接口

`buildNativeCliConfiguration(input)` 返回：

- `files`：两份原生配置文件描述，分别为 Codex `config.toml` 和 Claude `settings.json`。不包含密钥，建议写入权限 `0600`，目录 `0700`。
- `environment`：官方 Daemon 进程需要的配置环境，包括共享 Codex 配置源目录、Claude 配置目录及模型选择。不要写入宿主机或用户全局 shell。
- `secretBindings`：沙箱启动器需解析的环境变量名称映射；例如 `DEEPSEEK_API_KEY` 分别供 Codex `env_key` 和 Claude `ANTHROPIC_AUTH_TOKEN` 使用。

`assertCliSecretsPresent(plan, secretSource)` 在启动 Daemon 前检查所需凭据存在且不含换行。只检查形式，不表示凭据有效；错误仅包含变量名。模块不返回、不记录、不持久化秘密值。

示例调用（模型名称是待部署人员填写的示意值）：

```ts
import { buildNativeCliConfiguration } from '../packages/cli-configuration/index.ts';

const plan = buildNativeCliConfiguration({
  codexHome: '/home/agent/.codex',
  claudeHome: '/home/agent/.claude',
  codex: {
    baseUrl: 'https://api.deepseek.com',
    model: '<deployment-model>',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    wireApi: 'responses',
    modelCatalogPath: '/home/agent/.codex/models.json',
  },
  claude: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: '<deployment-model>',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
});
```

初始化流程负责写入文件、供应 catalog、读取 secret 并注入官方 Daemon；不要把密钥放在任务 prompt、普通 custom_env API 记录或命令参数中。实际运行的 Daemon 必须继承环境；重连或恢复时重新验证配置与凭据。不能通过修改所有任务共享的 provider 配置来实现会话级 Runtime 切换。

## 与 Multica 的原生并行机制配合

已阅读官方 Multica 源码（部署检查提交 `8908fcfbc43d18fc515dec747a100fecccc33556`）：`server/internal/daemon/execenv/codex_home.go` 的 `resolveSharedCodexHome` 从 Daemon 的 `CODEX_HOME` 读取共享配置源；`prepareCodexHomeWithOpts` 将原生配置复制到任务目录、维护独立会话状态，并同步配置引用的 catalog 文件。应复用这些机制，不自建 Codex 会话目录调度器。实际部署以锁定版本的同名实现和运行证据为准。

Daemon 会阻止 agent 的 `custom_env` 覆盖 `CODEX_HOME`，因此配置目录必须在 Daemon 启动环境中设置。Multica Agent 的 `model` 留空，并确认 Daemon 环境中的 `MULTICA_CODEX_MODEL`、`MULTICA_CLAUDE_MODEL` 未设置，以免 Multica 命令参数覆盖 CLI 原生模型选择。

Claude 环境通过原生设置和 Daemon 进程继承。并行平台任务由 Multica 为各 Task 管理独立的 provider 执行状态；同一 DSH 会话切换 Runtime 时继续使用同一个 Multica Chat，目标 CLI 的 session 恢复/新建由 Multica 官方执行能力决定。DSH 不使用全局 `--continue`，也不拼接自己的历史 handoff。个人 Claude 配置目录是用户配置源，并不等于允许任务共用可变 CLI 会话。模型别名与子 Agent 默认统一指向部署模型，可显式配置独立小模型。

## 当前验证与待验收

可运行：

```sh
node --experimental-strip-types --test mvp/packages/cli-configuration/index.test.ts
```

8 项本地测试通过，覆盖错误协议、带凭据 URL、无效路径、配置注入、秘密引用和缺失凭据。生成的基础 Codex 配置已由本机 0.133.0 的 `codex features list` 加载成功；使用独立临时配置目录，未修改现有用户配置，也未调用模型。该检查不覆盖模型 catalog、不证明 Claude 配置已被真实任务加载，更不等于 MVP 端到端验收。

真实链路还需提供 DeepSeek Key、明确模型与 endpoint，在 Daytona 中由官方 Daemon 分别调度两种 CLI，验证：文件修改与命令执行、连续追问、同类与混合并行、单任务取消、实际模型标识与工具事件经 Multica 回到 DSH。完成前不能把本模块的本地测试标记为上述验收通过。
