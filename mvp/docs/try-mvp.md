# 在同一个会话中切换 CLI

> 网页入口已补充：输入栏的“执行器”可在 Codex / Claude Code 间切换，绑定当前 DSH 会话；任务进行中禁止切换，刷新会从服务端恢复选择。无需在 DSH 网页再次配置模型 Key。已有安装运行新版 start-host.ps1 会自动补齐插件 profile（先备份）。

对用户可见的会话标识是 **DSH Session ID**。切换 Runtime 时继续使用这个 ID，不创建另一个 DSH 会话。该会话在 Multica 中只创建一个 Agent、Project 和 Chat Session；切换只更新 Agent 的 runtime 绑定，本地新增的执行段只用于任务关联。每次请求只发送当前 prompt，Multica Chat 负责统一历史和目标 CLI provider session 的恢复/新建，DSH 不生成 handoff 文本。

Gateway 当前监听本机 `http://127.0.0.1:3380`。下面的 PowerShell 示例在项目根目录运行，读取已有私有 Gateway Token，不需要再次填写 DeepSeek Key。先确认 Windows 与 Ubuntu 服务和 SSH 隧道已启动，部署方法见 [两机部署](windows-ubuntu-deployment.md)。

```powershell
$mvpToken = (Get-Content .runtime/dsh/gateway.token -Raw).Trim()
$mvpHeaders = @{ Authorization = "Bearer $mvpToken" }
$mvpBase = 'http://127.0.0.1:3380'
function Send-Mvp($Path, $Body) {
    Invoke-RestMethod -Uri "$mvpBase$Path" -Method Post -Headers $mvpHeaders `
        -ContentType 'application/json; charset=utf-8' -Body ($Body | ConvertTo-Json)
}

# 只创建一次。接下来始终使用同一个 $mvpSessionId。
$mvpSessionId = [guid]::NewGuid().ToString()
Send-Mvp '/v1/sessions' @{ sessionId = $mvpSessionId }
Send-Mvp "/v1/sessions/$mvpSessionId/runtime" @{ runtime = 'codex' }
Send-Mvp "/v1/sessions/$mvpSessionId/messages" @{
    requestId = [guid]::NewGuid().ToString()
    text = '在当前工作目录创建 hello.txt，内容为 hello，并用命令读取验证。'
}
```

消息返回 `accepted` 只代表接收，任务完成和回复应从 `GET /v1/sessions/{sessionId}/events` 的 SSE 流读取。该接口转发真实 DSH 事件快照和增量，包含工具事件、回复与 turn 结束状态。等待当前任务确认结束后再切换：

```powershell
# 同一会话：Codex → Claude Code
Send-Mvp "/v1/sessions/$mvpSessionId/runtime" @{ runtime = 'claude-code' }
Send-Mvp "/v1/sessions/$mvpSessionId/messages" @{
    requestId = [guid]::NewGuid().ToString()
    text = '读取此前的 hello.txt，在末尾添加 from Claude Code，再读取验证。'
}

# 再等待任务结束，然后同一会话：Claude Code → Codex
Send-Mvp "/v1/sessions/$mvpSessionId/runtime" @{ runtime = 'codex' }
Send-Mvp "/v1/sessions/$mvpSessionId/messages" @{
    requestId = [guid]::NewGuid().ToString()
    text = '读取 hello.txt，确认包含此前 Claude Code 添加的内容。'
}
```

有未结束任务时，Runtime 切换会被拒绝。取消使用 `POST /v1/sessions/{sessionId}/cancel`；取消请求被接受不代表 CLI 已停止，仍要等待真实执行结果。其他会话可以继续并行，并继续使用各自选择的 CLI。

网络超时后保留原 `requestId`，先核对任务和轨迹，不换一个请求标识重新发送同一任务。遇到外部状态不明确而暂停观察时，目前通过冷启动恢复与相同请求标识显式对账；仅打开 SSE 不会重启观察循环。

## 试用 DSH Managed Skill

当前部署示例已在私有 `.runtime/driver/config.json` 中启用：

```json
{ "managedSkillsDir": "C:/work/dshagent/mvp/skills" }
```

目录中每个子目录的 `SKILL.md` 会在任务提交前同步到 Multica，并绑定到该 DSH 会话的稳定 Agent。可以直接运行一次只验证绑定的 smoke：

```powershell
$env:DSH_MVP_CONFIG = (Resolve-Path .runtime/driver/config.json).Path
npx tsx mvp/tests/run-skill-sync.ts
```

再运行真实模型验收，检查 Codex 输出是否遵循示例 Skill 的“改写结果/语气说明”格式：

```powershell
npx tsx mvp/tests/run-skill-live.ts
```

跨 Runtime 验收使用同一个 DSH Session，实际执行 Codex → Claude Code，并确认 Agent、Chat Session 和 Skill 绑定不变：

```powershell
npx tsx mvp/tests/run-skill-cross-runtime.ts
```

这些脚本会产生真实任务和模型调用；输出证据保存在 Git 忽略的 `.runtime/driver/`。新增 Skill 时复制 `mvp/skills/anime-phrase-transformer/`，修改 `SKILL.md` 的 `name`、`description`、`version`，并保证 `key`（由目录相对路径生成）稳定。

这些示例是真实模型调用，会执行文件操作。自动验收脚本位于 `mvp/tests/run-*.ts`，不会随 `npm test` 自动运行；已经执行的结果与未验收项见 [部署进展](deployment-progress.md)。
