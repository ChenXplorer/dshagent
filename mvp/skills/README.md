# DSH Managed Skills

这里存放可以由 DSH 配置并同步到 Multica 的 Skill 源文件。`SKILL.md` 的正文应作为 Multica Skill 的 `content` 字段；辅助文件通过 `files` 字段上传。Skill 同步只分发 Skill 包，不上传用户的项目代码目录。

示例 `anime-phrase-transformer` 可通过私有部署配置中的 `managedSkillsDir` 启用；也可以把同样的声明写进 `managedSkills`。目录路径和配置中的 `key` 必须长期稳定；修改内容时递增 `version`，DSH 会通过官方 Multica Skill API 更新同一个 Skill 并继续绑定到会话 Agent。
