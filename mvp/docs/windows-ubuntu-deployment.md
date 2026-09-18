# Windows 与 Ubuntu 两机部署

2026-09-14 按用户修正：Windows 原生运行 Gateway、DSH 和 Multica Server；Ubuntu Docker 运行 Daytona、数据库等依赖。Multica Daemon 与两套 CLI 必须运行在 Daytona 沙箱内。

| 组件 | 位置 / 地址 |
| --- | --- |
| 项目新代码 | Windows 当前项目 `mvp/` |
| Windows 私有配置、密钥和运行数据 | 当前项目 `.runtime/`，已被 Git 忽略 |
| Multica Server | Windows `127.0.0.1:18381`，真实 health/readyz 已验证 |
| DSH Web / Gateway | Windows `127.0.0.1:3080` / `127.0.0.1:3380`；Web 使用官方认证，Gateway 使用私有 Bearer Token |
| Daytona API / Proxy / Dex | Ubuntu loopback `33000` / `34000` / `35556`，SSH 转发到 Windows 同端口 |
| Multica PostgreSQL | Ubuntu loopback `35432`，SSH 转发到 Windows 同端口，已部署并完成迁移 |
| MinIO 构建上下文上传 | Ubuntu loopback `39000` → Windows SSH `9000`；构建进程把 `minio` 解析为 loopback，保留官方签名 Host |
| 沙箱访问 Multica | `http://10.203.0.1:18382` → Ubuntu socat → SSH 反向转发 → Windows `127.0.0.1:18381` |
| 独立 Docker socket | Ubuntu `/run/dshagent-docker/docker.sock` |
| 独立 Docker data-root | Ubuntu `/home/dev/dshagent-mvp/runtime/docker-data` |
| 独立容器网络 | `dshagent-daytona`，bridge `mvpday0`，`10.203.0.0/24` |

## 已验证的网络事实

Windows SSH 出站使用 `192.168.5.159` 访问 Ubuntu `192.168.3.146`。从 Ubuntu 和独立 Docker 容器直接访问 Windows 临时 HTTP 服务均超时。未修改 Windows 防火墙；采用 OpenSSH 转发。

首次网络检查使用独立 Docker 容器经 bridge relay 和 SSH 隧道读取 Windows 临时 HTTP 服务，并通过未认证请求检查 DeepSeek HTTPS。随后已完成 19 个真实任务的全链路验收，包括两种 CLI 原生调用 DeepSeek；临时 HTTP 探针没有作为模型或框架替身。详见 [真实验收结果](acceptance-results.md)。

## 启动顺序

1. Ubuntu 运行 `sudo --preserve-env=HTTP_PROXY,HTTPS_PROXY,NO_PROXY bash isolated-docker.sh start`。脚本仅操作 MVP 自有 daemon、bridge 和带标记的规则；沿用现有代理拉取镜像。
2. Ubuntu 运行 `sudo bash multica-relay.sh start`，监听仅绑定自有 bridge IP。防火墙只允许该 bridge 的源地址访问 TCP 18382。
3. Windows 运行 `mvp/deploy/windows/start-tunnel.ps1`，保持进程运行。配置密钥位于 `.runtime/ssh/id_ed25519`；远程授权限定转发目标、禁止交互会话，未修改已有 SSH 密钥。
4. 在独立 Docker 上启动 Daytona 与 Multica PostgreSQL；先验证健康，再启动 Windows 官方 Multica Server 与 DSH/Gateway。
5. 沙箱 Daemon 的 `server_url` 使用表中的沙箱访问地址；Windows 适配器使用本机地址。不得将 Windows `localhost` 原样下发给沙箱。

SSH 使用 keepalive 和 ExitOnForwardFailure，断线会退出。当前开发进程需要启动脚本重新拉起；尚未配置 Windows 开机服务。Linux `systemd-run` 单元也是临时单元，重启后须重新运行脚本，不能宣称已通过无人值守恢复验收。

在本次已经配置好的 Windows 项目根目录，服务停止后可使用以下入口恢复。隧道脚本在一个 PowerShell 窗口前台运行，其他启动命令在另一个窗口运行；当前服务仍运行时不要重复启动。

```powershell
# 窗口一：保持 SSH 转发运行
./mvp/deploy/windows/start-tunnel.ps1

# 窗口二：先确认 Ubuntu 依赖就绪，再启动 Windows 服务
./mvp/deploy/windows/start-multica.ps1 -Action start
./mvp/apps/dsh-host/start-host.ps1
```

首次安装和组件边界见 [DSH 集成](dsh-integration.md)、[Multica 集成](multica-integration.md) 与 [Daytona 工具快照](../deploy/sandbox/README.md)。默认部署使用官方未修改的 Multica Server/Daemon；文中历史环境的 `dshtrace1/dshtrace2` 仅作可选实验记录，原快照和旧二进制保留。

Daytona Compose 启动时同时传入 `-f compose.json -f windows-upload.compose.json`，保留 MinIO 的 loopback 发布端口。官方 v0.187.0 没有独立 S3 外网地址配置，SDK 返回 `http://minio:9000`；Windows 构建脚本只在自身进程解析该主机名，不修改系统 hosts，也不改写上传请求 Host。

运行时 Toolbox 使用官方 `PROXY_TOOLBOX_BASE_URL=http://localhost:34000` 配置，通过既有 SSH 转发连接，无需给生产 SDK 添加 DNS 补丁。快照构建前运行 `init-storage.sh` 创建真实 MinIO bucket；通过官方组织 API 将本地个人组织的默认区域设置为已存在的 `us`，然后再提交快照。

Runner 的内部 Docker 也需要镜像代理：运行 `registry-proxy-relay.sh start`，在私有 Daytona `.env` 设置 `DAYTONA_RUNNER_HTTP_PROXY=http://10.203.0.1:18119`。该入口只对 MVP bridge 开放，转发到已有 loopback HTTP 代理，不修改原代理配置。回退时运行该脚本的 `stop`。

Runner 的 `NO_PROXY` 必须同时包含外层 MVP 网段 `10.203.0.0/24` 和实际内部 `runner-bridge` 网段 `172.20.0.0/16`。首次真实创建发现遗漏内部网段会让 Go 健康检查走外部代理，产生 `timeout waiting for daemon to start`，即使 Toolbox 进程已经启动。更换网段时同步修改此配置；已有错误沙箱先核对官方恢复能力，不能直接再创建一个。重载 Runner 会中断其内部沙箱进程，须在没有活跃任务时执行。

## 停止与回退

先停止 MVP 任务和容器，再终止 Windows SSH 隧道，运行 `multica-relay.sh stop` 和 `isolated-docker.sh stop`。脚本删除自身精确匹配的防火墙规则，保留数据。不会停止原 Docker 服务、删除原容器、重启机器或修改内核。原根分区空间仍紧张，MVP 的镜像与数据不写入原 Docker data-root。

多 daemon 的配置依据 [Docker 官方说明](https://docs.docker.com/reference/cli/dockerd/#run-multiple-daemons)，分别设置配置文件、socket、data-root、exec-root、pidfile 和 bridge，并关闭新 daemon 对全局 iptables 的自动改写。
