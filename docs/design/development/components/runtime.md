# 原生运行时

成员通过公开 `agents.create/resume` 与 `agentPresets.resolve/mount` 创建。需要继承活主会话组合时使用 `composeFrom`。`meta.agentPreset` 只是元信息，不能代替实际挂载。

`flow_task.profile` 的角色、职责和 skills 随成员持久化。创建/恢复先组合所选原生 preset，再用公开 `systemPrompt.section` 添加职责，按成员作用域加载 `skills.get` 并用 `renderSkillContent` 渲染。角色名称不分支执行路径；技能仅接受 modelInvocable，失败不静默降级。模型选择通过原生 AgentOptions 传递，冷恢复优先使用原生会话保存的模型与 preset。

NativeMember 持有真实 AgentHandle，并提供输入、取消、排空、日志和关闭适配。正常回合结束不销毁 Handle。使用原生 followup/steer/inject 和稳定输入身份，保留 Inbox 的持久语义。

执行工具、sandbox、审批、模型、压缩和后台 jobs 由宿主管理。Flow 不安装工具准入 hook，不裁剪工具映射，不复制审批或压缩实现。

取消后等待原生活动排空，真正关闭才 dispose。冷恢复恢复 Session，不主动重发已运行的业务工具；无法确定的运行事实保持未知。
