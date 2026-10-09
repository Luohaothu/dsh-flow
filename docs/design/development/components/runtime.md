# 智能体运行时

`core/runtime.ts` 配置 DSH 原生 Agent 的输入输出和工具。Flow 使用 `ctx.agents.create/resume`、原生输入、结果、取消和会话接口；执行循环、模型解析、上下文与输出由宿主实现。

## 执行边界

模型选择合并成员覆盖、团队选择和部署默认值，保留模型与推理设置。Flow 不传自己的上下文窗口或输出上限，不拦截 `llm/stream`，不改写模型参数、摘要内容或工具声明。停止原因和服务错误作为原生 Agent 执行结果处理。

每个 Flow Agent 在自己的隔离作用域装配一份官方默认 `compaction-basic`，共用宿主服务，随作用域卸载。Flow 不主动压缩、不追加溢出重试，也不提供压缩策略覆盖。原生持久化 Session 事件负责记录摘要与已知用量。

控制平面保留工具能力、权限、工具额度、时间、身份容量、执行容量、管理轮次、尝试与纠正次数。`max_llm_concurrency` 约束 Agent 执行轮外围的调度许可；辅助请求的提供方并发需要独立观测。缺少已声明能力的宿主工具仍拒绝执行。

角色工具在 Agent 自身作用域注册。成功的管理命令调用 `exec.concludeTurn()` 交还调度权；Worker 的 `submit_result` 暂存候选，正式发布仍需正常执行结束、有效租约和工具副作用核对，再独立验收。

## 原生成员会话输入

`MemberBriefing` 为普通 Worker、管理角色、恢复与 single-worker 路径提供相同的角色 system 注册入口。首条输入是上游保存的自然语言任务；后续 Flow 修订和运行通知说明真实变化。正文不注入全域状态 JSON、角色／UUID 调试头或固定结束语。动态对象通过 `flow_query assignment/agenda` 和字段投影读取，工具 schema 承载机器协议。

输入类型显式区分 `initial`、`revision` 与 `wake`，真实来源及计划引用保存在投递记录。恢复通过原生 append-only Session 的消息 ID 核对，已进入历史的首次委托不会重复；未确认输入保留待投递。压缩不改变角色规则，也不以任意 user 消息的存在判断首条委托。

宿主 `registerSessionDriver` 将成员会话的 prompt 与 cancel 交给 Flow。`agentSession` 只读取团队归属、成员状态和输入资格；读取历史不创建或恢复执行。成员未回收且团队未终止时，文本 prompt 以稳定请求 ID 进入持久化收件箱，重复请求必须具有相同内容和目标。

正在执行的成员使用原生 `send` 接收 queue 或 steer 输入；空闲成员由 Flow 调度继续执行。成员停止动作中断当前轮次，团队暂停、恢复和取消由主会话工具管理。回收或团队终止后继续保留对话和轨迹，拒绝新的输入。

## 工具副作用记录

调用工具前先检查能力、角色、租约、预算和适用的写路径，再实际派发调用，最后记录结果或错误。`tool_call_receipts` 记录工具调用的生命周期；副作用回执记录需要额外关注的外部影响及其证据。两类记录都不能替代完整的文件变更对比。

执行开始时，固定租约与执行轮次的绑定关系；迟到的调用不能通过查询最新租约代次来获得授权。一次成功的原生调用会保留调用标识、原生返回结果及相关参数，供审计智能体和恢复过程核对。

对象的 `evidence.native_tools` 按需返回原生工具回执引用，关联实际生产轮次或创建验收记录的成功调用。读取保留会话、原生调用序号与调用标识，避免相同调用标识在不同轮次互相借用；无法唯一配对时不宣称成功。纯计算调用通过这条路径读取，副作用回执继续只表达外部影响。

## 用量与异常

宿主已记录用量来自 `assistant/message`、`assistant/attempt` 和 `compaction/summary`。attempt 通过公开 helper 读取最后一条 usage，stream 增量不重复累计。压缩开始、结束与错误只影响统计完整性，不补造用量或请求数。

工具已派发但结果或副作用不能确认时，保留不确定性并阻止相关重放。未确认原生会话持久化时，不认定消息或候选结果已可靠保存。工具预算拒绝保留具体作用域、维度、申请量与可用量。

源码：[runtime.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/runtime.ts)、[role-tools.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)。
