# 动作索引

角色工具根据原生执行身份校验权限。所有命令均受管理域、对象版本、执行安全点与预算约束；通信不会授予额外控制权。本页解释已开放动作的职责，调用参数与示例见 [API 手册](/development/api#角色工具)。

## 编排智能体

工具为 `flow_transaction`。

| 动作 | 职责 |
|---|---|
| `create_transaction` / `decompose` | 创建工作单元或将目标分解为子任务，记录约束与验收标准 |
| `set_dependency` / `set_priority` | 设置无环依赖和执行优先级 |
| `dispatch` | 原子保存执行方案与任务简报，再派发；未准备的任务不能派发 |
| `adjust_transaction` | 在安全点修订计划，增加版本并使过期分配失效 |
| `bind_validation` | 将本轮实际检查绑定到指定当前计划与结果，不结束原生轮次 |
| `validate` | 正向原子保存不可变验收记录并接受；负向记录业务失败并进入返工 |
| `reject_result` | 校验当前 `expected_transaction_revision` 后驳回候选结果并记录理由；可附计划与结果引用 |
| `reopen_transaction` | 基于当前版本与原因撤销接受，重验收或重规划，并使受影响汇总失效 |
| `resolve_issue` | 基于实际修复证据关闭问题，或以反证撤销误报 |
| `aggregate` | 基于已接受的下级工作生成汇总候选结果 |
| `pause_transaction` / `resume_transaction` / `cancel_transaction` | 控制本管理域内的单个任务单元 |
| `request_user` | 记录需要用户回答的问题，并暂停相应角色的自主推进 |
| `escalate` | 将本管理域无法解决的问题提交上级 |
| `finish_cluster` | 根编排智能体请求整体收尾；运行时仍检查交付和资源条件 |

`ACCEPTED` 必须同时匹配当前 `plan_ref`、`result_ref`、`validation_ref`及正向逐项校验，并核对当前子任务的接受状态。普通状态推进增加 `revision`，不会使仍适用的计划失效。见[任务单元与业务验收](/development/components/transactions)。

## 资源分配智能体

工具为 `flow_allocation`。

| 动作 | 职责 |
|---|---|
| `allocate_agent` / `spawn_agent` | 为任务建立执行分配与身份 |
| `spawn_management_node` | 为需独立规划的任务建立下级管理域和两类管理身份 |
| `release_agent` / `replace_agent` / `reassign_agent` | 在轮次与租约结束后回收、替换或重新分配执行身份 |
| `allocate_budget` / `rebalance_budget` | 在授权范围内分配或调拨尚未占用的额度 |
| `set_concurrency` / `scale_out` / `scale_in` | 调整执行容量和执行者数量，仍受全局限制与预算约束 |
| `select_model` | 设置目标身份的模型路由 |
| `reparent` | 在无活跃执行和未结算副作用等前提下移动子树 |
| `checkpoint` / `restore` | 保存检查点或按有效证据恢复身份 |
| `resolve_effect` | 依据实际证据处置未知副作用，决定是否允许继续执行 |
| `resolve_issue` | 仅处理资源、分配、预算及副作用问题，不能改变业务结论 |
| `evaluate_allocation` | 保存资源配置的评估依据 |

资源动作不能隐式改变目标、验收标准或根预算总额。写路径检查、迁移和分配条件见[执行分配与组织调整](/development/components/allocation)。

## 执行智能体与共享工具

执行智能体的 `flow_transaction` 只允许 `submit_result`，用于暂存候选结果与证据。一轮执行正常结束、租约有效且工具副作用可确认后，运行时才正式发布结果。执行智能体不能自行验收、扩大预算或改变管理结构。

所有角色可使用 `flow_query` 读取自身权限范围内的状态，通过 `flow_communicate` 发送消息、管理协作组或读写共享黑板。通信动作与参数见[通信与共享黑板](/development/components/communication)。

源码依据：[角色权限](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/protocol.ts)、[命令处理](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/actions.ts)、[工具注册](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)。
