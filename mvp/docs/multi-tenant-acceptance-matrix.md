# 多租户 MVP 验收矩阵

本文记录当前服务器部署的实际能力边界。它区分“代码或单元测试覆盖”和“已在目标 Ubuntu 上真实验证”，不把控制面预置当成 100 个并发 Sandbox 的容量结论。

| 目标 | 当前实现 | 真实证据 | 状态 |
| --- | --- | --- | --- |
| 单一 Web 入口 | 持久化 `dsh-mt-gateway.service`，浏览器入口为 `127.0.0.1:13380` | 服务已 `enabled`/`active`，`/v1/health` 返回 200 | 已完成 |
| 当前免登录 MVP | Gateway 固定映射 `mockUserId=user-a`，不使用 Cloudflare Access 或浏览器 Bearer Token | 页面自动加载 user-a Profile；浏览器不显示登录或 Token 输入 | 已完成，按当前范围 |
| DSH Hub 控制面 | Hub + Node A/B 常驻，Gateway 调 Hub 校验 Profile Runtime 与执行官方 Plugin 事务 | 只读 Fleet 验证器确认两个 Node online，102 个 Profile Runtime 分布为 51/51 并逐一在 Hub 公布 | 已完成 |
| 每用户独立 Profile 与 Workspace | `TenantRepository` 保存 Profile revision；入驻工具通过官方 Multica Workspace API 写入 `userOverrides[userId]` | 已创建 102 个私有 Workspace；新租户入驻工具真实创建第 102 个 | 已完成 |
| 每用户默认 Sandbox/Daemon | `HostSupervisor → PersistentTenantSandboxManager → PersonalSandboxService` 首次访问时创建并持久绑定 | 独立新租户首次访问真实创建 Daytona Sandbox、默认 Daemon 与 Codex/Claude Runtime，随后按 Gateway 接口暂停 | 已完成，按需创建 |
| 用户登记外部 Daemon | Web 提供 Runtime 发现/登记；服务端按用户 Workspace 与 Runtime ID 校验 | user-a 已登记 Windows 本机 Daemon 与远程默认 Daemon，页面可选择四个 Runtime | 已完成 |
| 多 Session 与任务并发 | Gateway 按 `userId + sessionId` 归属路由；同 Session 未完成 Task 拒绝切换；不同 Session 有独立 Agent/Task 关联 | 自动化测试覆盖同用户并行 Session、配额与跨连接互斥 | 已完成（自动化） |
| 同会话 Runtime 切换 | DSH Session 保持，Multica Agent/Project/Chat 保持，只更新 Runtime binding | 真实 user-a 与 user-003 都完成 Codex → Claude Code → Codex，复用一个 Multica Chat | 已完成 |
| Skill 下一 Task 生效 | Skill 写入用户 Profile；活动 Host 刷新 Skill bridge；Task 提交前同步 Multica | 自动化验证 DSH Skill namespace、更新、禁用与 Agent 绑定 | 已完成（自动化） |
| 用户 Plugin 版本化回滚 | 精确 SemVer `packageName` 交由 Hub `dsh.plugins`；Profile revision 失败会补偿/回滚 | 真实 user-003 安装官方 DSH Web Plugin，再经 Hub rollback 回到空 Plugin 清单 | 已完成 |
| Host 按需回收 | 同用户 Session 共用一个 Host；空闲 Host 停止，再次请求从 Profile/Session 持久化恢复 | user-a 与新租户均由请求触发 Host；验收后通过 Gateway 停止 | 已完成 |
| 官方执行面 | 使用官方 DSH、官方 Multica Server/Daemon、官方 Codex CLI 和 Claude Code CLI | 真实任务由 CLI 执行；本项目未修改 Multica 源码 | 已完成 |
| Chat 模式 | Gateway 以 DSH Chat Session 代理消息、状态与轨迹 | 当前浏览器 UI、Session API 与真实验收均为 Chat | 已完成 |

## 当前有意未启用的项

- **终端用户认证与权限**：当前按需求使用固定模拟用户。数据层与 Gateway 路由已按 `userId` 设计，并保留 `identityProviderModule` 扩展点；接入 OIDC/SSO 后替换身份解析，不需要重做 Session、Sandbox 或 Hub 分配逻辑。
- **Issue/Work 模式**：当前只接入 Multica Chat。Issue/Work 是后续协作层能力，不影响已经验证的 Chat、Runtime 切换和轨迹链路。
- **100 个运行中 Sandbox/CLI Task 压测**：当前完成了 102 个 Profile/Workspace/Hub Runtime 的控制面预置，以及多个真实 Sandbox/CLI 验收。100 个同时运行的 Sandbox 会受 Daytona Runner、CPU、内存与模型配额共同限制，必须在独立压测窗口分批验证，不能由控制面数量推断。

执行压测前使用 [`capacity-preflight.py`](../deploy/capacity-preflight.py) 读取实际可用内存、`/home` 磁盘和 inotify 上限。它要求由小波次观测填入每个 Sandbox/Daemon 与 CLI 的峰值预算，只有预算满足时才允许扩大下一波；它不是容量估算器，也不会创建执行资源。

## 可复核的无密钥检查

在 Ubuntu 使用部署账号执行：

```bash
systemctl --user is-enabled dsh-mt-gateway.service
systemctl --user is-active dsh-mt-gateway.service
systemctl --user is-active dsh-hub-internal-v4.service
systemctl --user is-active dsh-hub-node-a.service
systemctl --user is-active dsh-hub-node-b.service
curl -fsS http://127.0.0.1:13380/v1/health
cat /proc/sys/fs/inotify/max_user_instances
```

正常结果应为 Gateway 已启用且所有服务 `active`，健康接口返回固定模拟用户，inotify 实例上限至少为 `1024`。这些命令不输出 Multica PAT、Daytona Key、模型 Key 或 Hub 内部令牌。
