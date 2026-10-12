# DSH 兼容性

宿主基线为 `0.2.0-rc.2`。Flow 使用公开 Agent、preset、Session、Inbox、工具与界面接口。依赖扩展清单及实际字节记录见 [宿主接口与补丁](provider-interfaces.md)。

rc2 没有可直接调用的 Agent pause/resume。Flow pause 暂停新增调度，并通过原生 cancel 停止、排空当前活动；resume 通过正常输入继续，registry.resume 用于冷恢复 Session。`whenIdle` 不能证明某个业务任务或后台 job 成功。

新的协作数据契约使用新目录，不提供旧执行模型兼容动作或自动数据库迁移。Provider 设置保存在 profile，不放进运行时 CLI overlay。
