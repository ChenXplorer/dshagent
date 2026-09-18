# 真实 Daytona 工具快照

固定官方 SDK `@daytona/sdk@0.187.0`，通过 `Image.fromDockerfile`、官方 S3 build context 上传和 `daytona.snapshot.create/get` 创建快照。脚本不调用 Docker CLI，也不创建用户沙箱；首次 Gateway 请求仍由个人沙箱服务预约并创建唯一用户沙箱。

默认新快照名：`dsh-mvp-cli-official-codex01540-claude21270`。仓库里已有的
`dsh-mvp-cli-20260914-dshtrace1-codex01540-claude21270` 是历史验收快照，不能作为
当前“不修改 Multica 源码”目标的证明。

- 基础镜像：Node 22 Debian bookworm slim，固定注册表 SHA-256 摘要，见 Dockerfile。
- Codex CLI `0.154.0`、Claude Code CLI `2.1.270`，使用官方 npm 包。
- 官方 Multica Linux amd64，固定官方源码提交 `8908fcfbc43d18fc515dec747a100fecccc33556`，默认不应用本项目补丁。创建时必须通过 `DSH_MULTICA_SHA256` 显式锁定实际未修改二进制摘要；历史 `dshtrace1/dshtrace2` 仅见 [可选可靠性实验](../../docs/multica-trace-durability.md)。
- Python 3、Git、Bash、procps、ripgrep、sudo；默认用户 `daytona`，目录 `/home/daytona`。只有必要的进程审计通过 `sudo -n python3` 执行；Claude 正常以非 root 身份启动。
- 快照规格 CPU 2、内存 3 GiB、磁盘 8 GiB，已经由真实 API 接受并读回。最终用户沙箱资源由个人沙箱服务统一预约。
- 镜像没有 DeepSeek key、Multica token、CLI 用户配置或任务数据。这些在创建用户沙箱后由运行时私有配置装配。

从项目根目录运行：

```sh
`DSH_MULTICA_SHA256=<official-binary-sha256> node mvp/deploy/sandbox/create-snapshot.mjs`
```

默认读取 `.runtime/daytona/api-key.json`，仅上传指定 Multica 二进制。可通过唯一位置参数传入其他路径的官方未修改二进制；摘要必须与 `DSH_MULTICA_SHA256` 相同。输出 `.runtime/daytona/snapshot.json` 只在官方状态 `active` 后写入，并标记 `multicaSource=official-unmodified`。

若构建容器直连软件源过慢，可设置 `DSH_SNAPSHOT_BUILD_PROXY=http://10.203.0.1:18119`。创建脚本把经校验、不含凭据的代理 origin 写入构建副本的 `ARG DSH_BUILD_HTTP_PROXY` 默认值；apt/npm 仅在对应 RUN 命令中临时设置代理，最终镜像不设置 HTTP_PROXY 环境变量。官方 SDK/Runner 没有通用 buildArgs 参数，因此不依赖未实现的配置。已经提交的快照不会被修改；新构建须用 `DSH_SNAPSHOT_NAME` 指定经协调的新修订名，并保留旧构建的对账记录。当前正在进行的构建不因本地 recipe 修改自动重启。

脚本先按名字查询真实快照；已有构建继续观察，已有完成快照验证规格后复用。首次创建前持久化 intent。若 API 尚未观察到快照但存在 intent，脚本拒绝盲目重发；只有明确的提交前失败或拒绝响应，加官方查无资源证据后，才归档该 intent 并重试。不会自动删除错误快照或已有用户沙箱。

## 本地连接要求

Windows 通过 SSH 连接 Ubuntu 上真实 Daytona：API `http://localhost:33000/api`。个人组织需要通过官方 `PATCH /api/organizations/{organizationId}/default-region` 设置 `{"defaultRegionId":"us"}`；本次已设置并读回验证。

固定版本没有单独的 S3 external endpoint。`getPushAccess` 返回 `http://minio:9000`，其 bucket `daytona` 必须事先存在。`minio-loopback.mjs` 仅在构建脚本当前进程中把精确主机名 `minio` 解析到 `127.0.0.1`，其他域名调用原始解析器。Windows localhost:9000 的 SSH 转发通向 Ubuntu localhost:39000 的 MinIO 映射端口。官方 SDK、返回 URL、HTTP Host 和 S3 签名保持原样，没有修改系统 hosts。

运行时 toolbox 使用官方 Server 环境变量 `PROXY_TOOLBOX_BASE_URL=http://localhost:34000`；官方 API 会返回 `/toolbox` 后缀。这个设置与 snapshot S3 上传不同，生产 Factory 不需要 DNS 覆盖。

官方 SDK 的 `onLogs` 会使用独立 proxy 域名，Windows 可能无法访问，且其失败可能产生未处理异常。因此创建脚本只用官方状态轮询；构建日志可通过现有官方 `GET /api/snapshots/{id}/build-logs?follow=false` 读取，无需修改 SDK 或另建日志接口。

快照 active 只证明镜像构建成功。两个真实 CLI 的版本、DeepSeek 调用、Daemon 注册、同用户双 Codex 并行与单任务取消，还需在首次由 Gateway 创建的个人沙箱中验证。

## 本次实际结果

2026-09-14，以上快照已通过官方 API 确认 `active`，真实标识与镜像地址保存在 `.runtime/daytona/snapshot.json`。构建完成了系统依赖、两个固定 CLI 及 Multica 版本检查；规格读回 CPU 2、内存 3 GiB、磁盘 8 GiB。原始已提交 Dockerfile 保留在 `.runtime/daytona/snapshot-build/Dockerfile`，摘要记录在 snapshot.json；此次使用直连构建，后来加入仓库的可选构建代理未改变已提交镜像。此步骤没有创建用户沙箱。

## 首次实际沙箱启动失败与受控恢复

随后由 Gateway 首次创建的真实沙箱遇到 `timeout waiting for daemon to start`，这里的 daemon 是 **Daytona Toolbox**，尚未进入 Multica bootstrap。Runner 日志显示 Toolbox 已监听 2280，问题来自 Runner 的 HTTP_PROXY/HTTPS_PROXY 配置：NO_PROXY 没有包含实际嵌套沙箱网络 `172.20.0.0/16`。同一内部 URL 的直连和代理探测分别返回正常 HTTP 响应与代理 502。部署配置已补充该实际 CIDR；不能把任意健康检查超时自动判断为镜像或 CLI 错误。

固定 v0.187.0 的精确启动检查是 `GET http://<sandbox-ip>:2280/version`，使用普通 Go http.Client，继承默认代理规则；`/health` 返回 404 不是该启动检查的失败证据。源码：[runner daemon.go](https://github.com/daytonaio/daytona/blob/v0.187.0/apps/runner/pkg/docker/daemon.go)、[daemon_version.go](https://github.com/daytonaio/daytona/blob/v0.187.0/apps/runner/pkg/docker/daemon_version.go)。

本次失败实例为官方 `state=error, recoverable=false`。该版本存在以下真实恢复限制：

- 用户 `start` 和 `stop` 都拒绝 error 状态；`force` 仅改变停止信号，不跳过状态校验。
- `recover` 首先要求 recoverable=true；Runner 的恢复实现仅支持存储扩容，不支持该启动超时。
- 即使单独启动 Runner 中的原容器，官方 Runner 状态回报 API 也只允许从 started/stopped 更新，不能把当前 error 直接恢复为 started。

依据：[API SandboxService](https://github.com/daytonaio/daytona/blob/v0.187.0/apps/api/src/sandbox/services/sandbox.service.ts)、[Runner recover.go](https://github.com/daytonaio/daytona/blob/v0.187.0/apps/runner/pkg/docker/recover.go)、[recovery.go](https://github.com/daytonaio/daytona/blob/v0.187.0/apps/runner/pkg/common/recovery.go)。

因此本次采用受控的**空实例失败恢复**：保留原始创建 intent 和失败证据，确认没有 Multica task、CLI 用户配置或用户文件，经官方 delete 并 GET 确认已不存在后，显式审计并恢复本地创建预约，再由原 Gateway/DSH 请求重新创建。这个操作属于已确认失败的部署恢复，不是未知结果的自动重试；第一次创建必须记为失败，不能因后续成功改写历史。已有用户数据、凭据或未完成任务的实例不能套用这个空实例流程。
