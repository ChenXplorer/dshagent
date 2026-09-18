# CubeSandbox 暂缓记录

2026-09-14，用户明确决定“先不用 CubeSandbox，记录卡点，先使用 Daytona”。本记录保留已验证事实，避免后续重复排查。CubeSandbox 不再是当前 MVP 的执行环境验收前提。

## 已验证卡点

1. Ubuntu 22.04.5 是 VMware 来宾虚拟机，CPU flags 无 vmx/svm，`/dev/kvm` 不存在。用户要求尝试后执行 `sudo modprobe kvm_intel`，返回 `Operation not supported`。来宾内部无法自行开放宿主机未提供的硬件虚拟化能力。
2. 官方 PVM 路径支持无硬件扩展透传的环境，但需安装 PVM 主机内核并重启。当前主机仍运行其他服务；仅有 SSH，没有 VMware 控制台或确定的重启失败恢复入口。
3. 官方 `host_grub_config.sh` 修改全局内核启动参数，包含 `net.ifnames=0 biosdevname=0`、`ipv6.disable=1`、`module.sig_enforce=1` 等。主机 NetworkManager 连接明确绑定 `ens160`，直接套用可能导致重启后网络失联。全局参数也影响旧内核，因此仅选择旧内核并不足以完整回退。
4. 根分区和 `/boot` 共用磁盘，剩余约 480MiB；新内核、模块和 initramfs 仍需写入根分区。`/home` 有空间不等于内核安装有空间。VG 无空闲 extent，不能直接在线扩容根 LV。
5. `/home` 为 ext4；官方 CubeSandbox 要求 `/data/cubelet` 使用支持 reflink 的 XFS，且至少 50GB 可用。需要独立 XFS 存储或经验证的文件挂载方案，不能仅创建普通目录。

## 已完成与未执行

- 固定并检查官方源码 `bc198e42a955d4bda2c66ca3e3c7c32ae77abc48`。
- 已从该提交构建官方 Node SDK 0.3.0。npm registry 查询 E404，因此构建产物仅作为暂缓方案的溯源材料保留，不作为 Daytona 运行依赖。
- 已检查当前已启动内核 `6.8.0-101-generic`，还有安装但尚未在本次验证启动的 `6.8.0-138-generic`。GRUB 当前默认项为 0、菜单隐藏且等待时间为 0。
- PVM 候选发布为 `kernel-release-260812-1`，主包约 59MB，SHA256 `a45a386417ff99aec28d9d7e3519b39bde7b5aa7c4dda14c6e5fd7b07eb06338`。包下载检查与安装是不同操作；未安装此包。
- 实际包下载在 180 秒超时，校验值与官方不符；未完成文件已标记为 `/home/dev/dshagent-mvp/upstream/pvm/pvm-host.deb.partial`，不能安装。此不完整包不作为完整性或驱动兼容性验证证据。
- 未修改 GRUB、网络、内核默认项或模块自启动配置，未重启，也未删除现有服务数据。

## 将来恢复评估时的前置条件

优先取得 VMware 控制台/快照与可操作的恢复入口，再在“开放嵌套虚拟化”和“安装官方 PVM 内核”之间选定路径。若选 PVM，保留已验证旧内核和原始启动参数，使用独立 PVM 启动项及一次性试启动；回退时不仅选旧内核，还要恢复本次实际修改的 GRUB、网络及模块配置。一次性启动项不会自动重置已挂起的虚拟机，因此控制台仍必需。

这些是评估结论，不是已执行的系统变更，也不是未经验证即可运行的安装脚本。

官方来源：

- [PVM 部署](https://github.com/TencentCloud/CubeSandbox/blob/bc198e42a955d4bda2c66ca3e3c7c32ae77abc48/docs/guide/pvm-deploy.md)
- [全局 GRUB 参数脚本](https://github.com/TencentCloud/CubeSandbox/blob/bc198e42a955d4bda2c66ca3e3c7c32ae77abc48/deploy/pvm/grub/host_grub_config.sh)
- [快速开始与存储要求](https://github.com/TencentCloud/CubeSandbox/blob/bc198e42a955d4bda2c66ca3e3c7c32ae77abc48/docs/guide/quickstart.md)
