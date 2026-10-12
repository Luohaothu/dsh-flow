# 原生运行时

成员通过公开 `agents.create/resume` 与 `agentPresets.resolve/mount` 创建。需要继承活主会话组合时使用 `composeFrom`。`meta.agentPreset` 只是元信息，不能代替实际挂载。

NativeMember 持有真实 AgentHandle，并提供输入、取消、排空、日志和关闭适配。正常回合结束不销毁 Handle。使用原生 followup/steer/inject 和稳定输入身份，保留 Inbox 的持久语义。

执行工具、sandbox、审批、模型、压缩和后台 jobs 由宿主管理。Flow 不安装工具准入 hook，不裁剪工具映射，不复制审批或压缩实现。

取消后等待原生活动排空，真正关闭才 dispose。冷恢复恢复 Session，不主动重发已运行的业务工具；无法确定的运行事实保持未知。
