# DSH Web 控制面板

通过官方 DSH client module loader 加载 `client.js`，使用官方槽位提供两项入口：会话输入区的 Runtime 选择器，以及侧边栏的全局 `DSH Skills` 管理页。React 从官方平台模块表取得；不替换 DSH frontend dist、不注入 DOM、不启用默认模型 loop。

Host 的 `/mvp/runtime?sessionId=...` 使用官方 Connection 的 Host/Origin/Cookie 校验，复用生产 TaskOrchestrator 的 Runtime 选择和 SQLite 状态；浏览器不持有 Gateway Token、Multica PAT 或 DeepSeek Key。GET 查询当前 Runtime 与忙碌状态，POST 仅接受 runtime 字段。任务执行、未完成对账及原生 Agent running 时拒绝切换。

Host 的 `/mvp/skills` 是全局 Skill 管理接口：GET 展示当前 DSH Skill 声明及其 Multica 同步状态，POST `{ key, enabled }` 启用或禁用指定 Skill。禁用会持久化到 DSH-owned Multica Skill，并同步已有 Agent 的 Agent-Skill 状态；新任务同步时会继承该状态。页面不是会话级 Skill 选择器，也不会删除 Skill 内容。DSH 源目录删除某个 Skill 后，下一次同步会删除对应的 DSH-owned Multica Skill；外部创建的 Skill 不会被误删。

浏览器按当前槽位的 sessionId 绑定选择器，定期刷新服务端状态；保存期间及网络未知状态禁用操作，过期异步响应不能覆盖新会话或新选择。子 Agent 会话不显示此入口。选择只修改该会话下一次执行使用的 Runtime，不启动模型调用。

`create-profile.mjs` 为新安装启用该插件；`start-host.ps1` 调用 `enable-runtime-ui.mjs` 给既有 Multica profile 添加入口，修改前保存备份。原生模型选择和模型配置 onboarding 均关闭，因为模型凭据由两套 CLI 原生配置管理。Gateway 的 API 切换仍使用相同持久化记录。

浏览器 bundle 使用官方公开的 lazy factory 格式直接编写，无额外打包步骤；修改后重启 DSH，再刷新页面。启动 DSH 后从左侧边栏打开 `DSH Skills` 即可测试全局管理。CLI/任务调度实现仍由其他模块负责。
