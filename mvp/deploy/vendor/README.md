# 官方 CubeSandbox SDK 构建产物

状态：2026-09-14 用户决定本轮使用 Daytona；本目录仅保留暂缓方案的来源、校验和许可证记录，已从 MVP 运行依赖中移除。构建出的 `.tgz` 已在清理中删除，当前无需安装或调用它。

`@cubesandbox/sdk` 的源码已在官方仓库发布，但 2026-09-14 对 npm registry 的实际查询返回 E404。因此从官方固定提交构建 SDK，直接使用其实现，不自行重写生命周期 API。

- 来源：https://github.com/TencentCloud/CubeSandbox
- 提交：`bc198e42a955d4bda2c66ca3e3c7c32ae77abc48`
- 目录：`sdk/node`
- SDK 版本：`0.3.0`
- 许可证：Apache-2.0，随附 `CubeSandbox-LICENSE`
- 构建环境：Node 24.15.0；依赖由该提交的 `sdk/node/package-lock.json` 固定
- 源码无补丁
- tarball SHA256：`6a8567ffb913e0db19a47d774962cd6e5034f76cba99d4c3b33615795328b72f`

复现：检出以上提交，在 `sdk/node` 中执行 `npm ci --ignore-scripts --no-audit --no-fund`、`npm run build`、`npm pack --ignore-scripts`。历史 tarball 由以上步骤生成；当前 MVP 不再把该构建产物放入源码包，也不在 lockfile 中安装它。

SDK 构建完成不代表 CubeSandbox 服务已部署。真实服务检查和沙箱创建结果另行记录。
