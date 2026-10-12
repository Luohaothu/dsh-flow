# dsh-flow

为 DeepSeek Harness 标准 Agent 提供任务委派、结果交付、接受记录和成员消息。DSH 负责 Agent 的完整执行，包括原生 preset、业务工具、模型、压缩、sandbox、审批和会话历史。

使用 `/agent-team` 或主会话 Agent Team 工具创建协作空间。成员按需委派，简单任务不需要固定管理角色。界面可查看任务和原生会话、发送输入及取消当前活动。

配置只有 `dataDir`、`workspace`、`preset` 和 `maxConcurrentAgents`。默认容量为 4；模型和工具从宿主配置取得。升级到新的数据契约时使用新数据目录，旧数据库会被明确拒绝并保留。

- [使用文档](https://github.com/Luohaothu/dsh-flow/blob/main/docs/design/index.md)
- [职责与术语](https://github.com/Luohaothu/dsh-flow/blob/main/CONTEXT.md)
- [当前方案](https://github.com/Luohaothu/dsh-flow/blob/main/docs/plans/native-agent-simplification-plan.md)
- [验证方法](https://github.com/Luohaothu/dsh-flow/blob/main/docs/design/development/validation.md)
