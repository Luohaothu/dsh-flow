# dsh-flow

本页描述现有包的使用入口；目标架构与接口约定见[设计文档](../../docs/design/design.md)。

为 DeepSeek Harness 标准 Agent 提供任务委派、结果交付、接受记录和成员消息。DSH 负责 Agent 的完整执行，包括原生 preset、业务工具、模型、压缩、sandbox、审批和会话历史。

使用 `/agent-team` 创建协作空间，主会话承担协调者角色。通过 `flow_task.profile` 按需声明成员名称、角色、职责、原生 preset、模型和 skills；协调者和执行者均由标准 DSH Agent 实现。界面可查看任务和原生会话、发送输入及取消当前活动。

插件级配置为 `dataDir`、`workspace`、`preset` 和 `maxConcurrentAgents`。默认容量为 4；模型和工具从宿主配置取得。升级到新的数据契约时使用新数据目录，旧数据库会被明确拒绝并保留。

- [使用文档](https://github.com/Luohaothu/dsh-flow/blob/main/docs/design/index.md)
- [职责与术语](https://github.com/Luohaothu/dsh-flow/blob/main/GLOSSARY.md)
- [当前方案](https://github.com/Luohaothu/dsh-flow/blob/main/docs/design/design.md)
- [验证方法](https://github.com/Luohaothu/dsh-flow/blob/main/docs/design/validation.md)
