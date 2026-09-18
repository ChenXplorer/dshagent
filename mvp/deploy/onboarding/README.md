# 多租户入驻工具

`onboard-tenant.ts` 是运维侧的单用户入驻编排器。它只组合已有能力，不创建另一套 Hub、Workspace 或 Sandbox 实现：

1. 在 `TenantRepository` 创建用户与初始 Profile；
2. 调用 `provision-tenant-workspaces.ts`，通过官方 Multica Workspace API 创建或复用该用户的私有 Workspace，并写入私有 Gateway 配置；
3. 调用 `reconcile-node-agent-fleet.ts`，为用户选择稳定的 Hub Node Agent/Profile Runtime，并生成上游 Node Agent 配置；
4. 返回需要受控重启的 Node Agent 配置路径。

Sandbox 不在导入账户时批量创建。用户首次打开 DSH Session 时，既有 `HostSupervisor → PersistentTenantSandboxManager → PersonalSandboxService` 链路会创建该用户唯一的 Daytona Sandbox，并在其中启动平台默认 Multica Daemon。后续空闲时 Host 可以停止，Sandbox 可以暂停；再次访问会复用这份绑定。

命令只接受服务器上 owner-only 的私有配置，输出不包含 Multica PAT、Daytona Key 或用户 Token：

```bash
npm run onboard:tenant -- \
  /srv/dsh/runtime/tenant.config.json \
  /srv/dsh/runtime/hub/fleet.input.json \
  user-102 user-102@example.com codex
```

成功后先检查输出中的 `nodeAgentRestartRequired`，再按变更窗口重启受影响的 Node Agent。Node Agent 在启动时读取 `management.profiles`；脚本不会擅自重启它，因此不会中断无关的控制面操作。Gateway 和用户 DSH Host 不需要为这个配置文件生成步骤一起重启。

重复执行默认拒绝已存在的用户，防止把不相干的身份合并。程序 API 的 `allowExisting: true` 只允许同一个 active 用户与同一邮箱的恢复性重试。
