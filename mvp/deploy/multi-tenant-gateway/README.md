# 多租户 Gateway 服务单元

这个目录只负责把本项目的 `apps/multi-tenant-gateway` 作为一个服务器常驻进程运行。它不会常驻启动每个用户的 DSH Host；Host 由 `HostSupervisor` 在用户第一次请求时按需启动，空闲后回收。

## 安装

以下步骤假定代码固定部署在 `/opt/dshagent`，Node.js、npm 和依赖已按[部署手册](../../docs/deployment-handbook.md)安装，运行账户为非特权用户 `dshagent`：

```bash
sudo useradd --system --home /var/lib/dshagent --shell /usr/sbin/nologin dshagent
sudo install -d -o dshagent -g dshagent -m 0750 /opt/dshagent /etc/dshagent
sudo install -d -o dshagent -g dshagent -m 0700 /var/lib/dshagent /var/log/dshagent
sudo chown -R dshagent:dshagent /opt/dshagent
sudo -u dshagent npm --prefix /opt/dshagent/mvp ci --ignore-scripts
```

DSH Web Host 会监视 Profile 与 Skill 文件。多租户部署前安装随仓库提供的 inotify 参数；否则 Linux 的默认 `max_user_instances=128` 可能在已有桌面、浏览器或容器监视器占用后让新 Host 以 `EMFILE` 退出：

```bash
sudo install -o root -g root -m 0644 90-dshagent-host-watches.conf /etc/sysctl.d/90-dshagent-host-watches.conf
sudo sysctl -p /etc/sysctl.d/90-dshagent-host-watches.conf
cat /proc/sys/fs/inotify/max_user_instances
```

期望最后一项至少为 `1024`。服务单元同时为 Gateway 和它启动的 DSH Host 设置 `LimitNOFILE=65536`；这与 inotify 是两项不同的内核资源限制。

把经过审核的私有配置保存为 `/etc/dshagent/tenant.config.json`，权限设为 `0600`，所有者设为 `dshagent`。配置必须使用绝对的 `database`、`stateDirectory`，生产环境设置 `requireHub: true`，并填写真实的 Hub 凭据、目标映射、Daytona、Multica 和每个用户的私有 workspace/token。参考 [`config.example.json`](../../apps/multi-tenant-gateway/config.example.json)。

服务通过 `/usr/bin/env npm` 启动，不假定 npm 一定位于 `/usr/bin/npm`。若 Node 安装在版本目录，创建 root-owned 的 `/etc/dshagent/gateway.env`：

```ini
PATH=/opt/node-v24/bin:/usr/local/bin:/usr/bin:/bin
```

该目录必须同时包含可执行的 `node`、`npm` 和 `npx`。使用系统级 Node 时不需要创建这个文件。

复制并启用服务：

```bash
sudo install -o root -g root -m 0644 dsh-multi-tenant-gateway.service /etc/systemd/system/dsh-multi-tenant-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-multi-tenant-gateway.service
sudo systemctl status dsh-multi-tenant-gateway.service
```

当前 Ubuntu 若由没有 root systemd 服务权限的部署账号管理，可使用同目录的
`dsh-multi-tenant-gateway.user.service`。复制到 `~/.config/systemd/user/` 后将
`WorkingDirectory`、`DSH_TENANT_CONFIG` 和 Hub 单元名改为该机器的绝对路径，执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-multi-tenant-gateway.service
loginctl enable-linger "$USER"       # 需要一次 sudo；让服务跨 SSH 登出和重启保留
systemctl --user is-active dsh-multi-tenant-gateway.service
```

不能继续依赖临时 `systemd-run --unit=...` 作为生产 Gateway；临时单元不会通过
`enable` 纳入启动目标。切换前确认用户 Host 没有活动 Task，再停止旧临时单元并启动此持久化单元。

Gateway 启动前会验证 `requireHub`、Hub `/hub/v1/me` 和用户 Node/Runtime 目标；检查失败时不会打开公网监听器。反向代理、TLS、Hub 和 Daytona 的服务单元应分别按对应部署文档配置。

## 执行面容量门禁

102 个 Profile/Workspace/Hub Runtime 的控制面登记不代表 102 个 Sandbox 能同时运行。执行面压测前，先在目标 Linux 主机用实测的 Sandbox、Daemon 和 CLI 峰值内存运行只读门禁：

```bash
python3 deploy/capacity-preflight.py \
  --active-sandboxes 10 \
  --concurrent-tasks 10 \
  --sandbox-mib 1024 \
  --task-mib 512 \
  --control-plane-mib 2048 \
  --reserve-mib 2048 \
  --disk-mib 20480
```

所有 MiB 参数都必须来自一次较小、真实的 Daytona/Daemon/CLI 波次观测，不能从用户总数猜测。脚本只读取内存、`/home` 磁盘和 inotify 限制；成功才以退出码 `0` 返回，失败返回 `2`，不会创建 Sandbox、启动 Task 或读取私有配置。通过后再逐步增加波次规模，例如 10 → 25 → 50，而不是在实验机直接启动 100 个执行实例。

## 更新与回滚

先停止 Gateway，切换到已审核的代码版本，再运行 `npm ci` 和类型检查，最后启动服务：

```bash
sudo systemctl stop dsh-multi-tenant-gateway.service
sudo -u dshagent npm --prefix /opt/dshagent/mvp ci --ignore-scripts
sudo -u dshagent npm --prefix /opt/dshagent/mvp run typecheck
sudo systemctl start dsh-multi-tenant-gateway.service
```

用户 Profile 的 Plugin 更新不会覆盖旧版本目录；Host 重启失败时保留旧 Host 和 Profile revision，之后可从 Gateway 回滚。不要删除 `/var/lib/dshagent` 中的 Session、关联数据库或版本化 Host 目录。
