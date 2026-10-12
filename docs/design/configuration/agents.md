# Agent 配置

团队成员采用宿主标准 preset。可在团队创建时选择 preset 或模型路由；未选择时使用正常宿主配置。模型参数、压缩、技能、业务工具、sandbox 与审批由 DSH 处理。

已经配置的新插件工具可直接由标准 Agent 使用，Flow 无需增加能力枚举或工具名称映射。任务分工和目录说明不会改变权限。

原生 subagent provider 的 delegated approval 行为属于该提供方；Flow 使用的 Agent 组合不通过每轮重写策略模拟它。实际允许或拒绝以所用 preset 和会话设置为准。
