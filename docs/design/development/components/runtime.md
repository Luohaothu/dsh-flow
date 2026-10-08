# 智能体运行时

`core/runtime.ts` 将智能体的一轮执行接入 DeepSeek Harness 宿主。它连接宿主智能体、会话、模型请求和工具钩子，并向控制平面返回执行结果；执行循环由宿主提供。

## 主要入口

| 符号 | 职责 |
|---|---|
| `runTurn` | 创建或恢复原生智能体；应用本轮配置；执行并将会话持久化 |
| `mountCapabilityTools`、`missingCapabilityTools` | 在智能体自身作用域装配并确认所需工具存在 |
| `installToolPolicy` | 限制继承工具的可见性，并检查当前作用域中所有工具的执行权限 |
| `reserveLlmRequest`、`settleLlmRequest`、`releaseLlmRequest` | 检查请求能否发送、结算用量、释放未发送请求的预留额度 |
| `createToolExecutionHook` | 检查工具调用条件、派发调用、记录结果与异常 |
| `core/role-tools.ts` 的 `registerRoleTools` | 注册当前角色的命令、查询和通信工具 |

## 一轮执行的边界

模型选择由 `core/model-selection.ts` 统一合并：团队模型存在时从部署默认值继承输出上限，再应用团队模型、团队保存的选项和成员覆盖，最后施加执行代理的输出限制。没有团队模型时使用部署默认模型。团队快照在同一事务内复用已读取的团队配置，历史模型回执仍优先于下一轮选择。

控制平面传入智能体身份、执行轮次序号、模型、能力、授权工具、任务单元与预算账户；执行适配层创建或恢复该身份的原生会话。角色工具在该智能体的宿主上下文对象内注册，普通用户会话不会因此获得 `flow_audit` 或 `flow_allocation`。

每次模型请求前，重新确定能够承担本次用量的预算账户并检查上下文占用情况。必要的上下文压缩也会消耗模型请求次数和 Token 额度。若已声明某项能力，但对应宿主工具未能装配，则必须拒绝执行，不能将其视为能力已经具备。

成功的管理命令会调用 `exec.concludeTurn()`，交还调度权，让其他角色有机会执行。执行智能体在 `submit_result` 后结束当前轮次；其此前读写工具调用仍属于同一任务。一轮执行结束不等于业务验收成功，候选结果由控制平面决定是否发布。

## 原生成员会话输入

宿主 `registerSessionDriver` 将成员会话的 prompt 与 cancel 交给 Flow。`agentSession` 只读取团队归属、成员状态和输入资格；读取历史不创建或恢复执行。成员未回收且团队未终止时，文本 prompt 以稳定请求 ID 进入持久化收件箱，重复请求必须具有相同内容和目标。

正在执行的成员使用原生 `send` 接收 queue 或 steer 输入；空闲成员由 Flow 调度继续执行。成员停止动作中断当前轮次，团队暂停、恢复和取消由主会话工具管理。回收或团队终止后继续保留对话和轨迹，拒绝新的输入。

## 工具副作用记录

调用工具前先检查能力、角色、租约、预算和适用的写路径，再实际派发调用，最后记录结果或错误。`tool_call_receipts` 记录工具调用的生命周期；副作用回执记录需要额外关注的外部影响及其证据。两类记录都不能替代完整的文件变更对比。

执行开始时，固定租约与执行轮次的绑定关系；迟到的调用不能通过查询最新租约代次来获得授权。一次成功的原生调用会保留调用标识、原生返回结果及相关参数，供审计智能体和恢复过程核对。

## 异常边界

- 请求没有发送时释放预留并记录 `NOT_SENT`；已发送但结果未知时保留不确定性，不能按未发生处理。
- 未确认会话持久化成功时，不能据此认定消息已持久化或结果可安全发布。
- 因预算不足而拒绝请求时，需要保留具体账户 `scope`、维度 `dimension`、申请量 `requested` 和可用量 `available`，不能误报为模型服务异常。
- 执行智能体的一轮执行正常结束但没有显式提交结果时，运行时可以依据本轮的副作用回执生成候选结果；这一自动生成的结果仍须独立验收。

继续阅读：[持久化与恢复](/development/components/persistence)、[任务单元与独立审计](/development/components/transactions)。

源码：[runtime.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/runtime.ts)、[role-tools.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)。
