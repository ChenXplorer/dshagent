# DSH Agent Platform

企业 Agent 中台概念设计，面向约 200 名员工。

**DSH 是平台主基座；自研 Multica Runtime 插件；复用 Multica Server/Daemon 调度 DSH、Codex、Claude Code、Pi 等 CLI；沙箱作为独立运行环境。**

- [完整技术方案（Markdown）](docs/architecture.md)
- [HTML 阅读版](docs/architecture.html)

## 状态

本文档是目标架构。核心接口已核实；Multica Runtime 插件和整体联调仍需实现。

## 架构主线

`用户入口 → Gateway → DSH 基座 → Multica Runtime 插件 → Multica Server/Daemon → 目标 Runtime / 云端或本地环境`

方案基于 [DSH](https://github.com/deepseek-ai/deepseek-harness) 和 [Multica](https://github.com/multica-ai/multica)。