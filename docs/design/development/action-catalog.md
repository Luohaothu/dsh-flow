# 动作索引

角色工具根据原生执行身份校验权限。所有命令均受管理域、对象版本、执行安全点与预算约束；通信不会授予额外控制权。本页解释已开放动作的职责，调用参数与示例见 [API 手册](/development/api#角色工具)。

## 编排智能体

工具为 `flow_transaction`。

| 动作 | 职责 |
|---|---|
| `create_transaction` / `decompose` | 创建工作单元或将目标分解为子任务，记录约束与验收标准 |
| `set_dependency` / `set_priority` | 设置无环依赖和执行优先级 |
| `dispatch` | 原子保存执行方案与任务简报，再派发并发起异步规划审查；未准备的任务不能派发 |
| `adjust_transaction` | 在安全点修订计划，增加版本并使过期分配失效 |
| `validate` / `accept_result` | 保存覆盖正式标准的不可变校验记录；独立复核通过后提交接受状态 |
| `reject_result` | 驳回候选结果并记录理由 |
| `aggregate` | 基于已接受的下级工作生成汇总候选结果 |
| `pause_transaction` / `resume_transaction` / `cancel_transaction` | 控制本管理域内的单个任务单元 |
| `request_user` | 记录需要用户回答的问题，并暂停相应角色的自主推进 |
| `escalate` | 将本管理域无法解决的问题提交上级 |
| `finish_cluster` | 根编排智能体请求整体收尾；运行时仍检查交付和资源条件 |

`ACCEPTED` 必须同时匹配当前 `plan_ref`、`result_ref`、`validation_ref`、正向校验及独立审核，并核对当前子任务的接受状态。普通状态推进增加 `revision`，不会使仍适用的计划失效。见[任务单元与独立审计](/development/components/transactions)。

## 资源分配智能体

工具为 `flow_allocation`。

| 动作 | 职责 |
|---|---|
| `allocate_agent` / `spawn_agent` | 为任务建立执行分配与身份 |
| `spawn_management_node` | 为需独立规划的任务建立下级管理域和三类管理身份 |
| `release_agent` / `replace_agent` / `reassign_agent` | 在轮次与租约结束后回收、替换或重新分配执行身份 |
| `allocate_budget` / `rebalance_budget` | 在授权范围内分配或调拨尚未占用的额度 |
| `set_concurrency` / `scale_out` / `scale_in` | 调整执行容量和执行者数量，仍受全局限制与预算约束 |
| `select_model` | 设置目标身份的模型路由 |
| `reparent` | 在无活跃执行和未结算副作用等前提下移动子树 |
| `checkpoint` / `restore` | 保存检查点或按有效证据恢复身份 |
| `resolve_effect` | 依据实际证据处置未知副作用，决定是否允许继续执行 |
| `evaluate_allocation` | 保存资源配置的评估依据 |

资源动作不能隐式改变目标、验收标准或根预算总额。写路径检查、迁移和分配条件见[执行分配与组织调整](/development/components/allocation)。

## 审计智能体

工具为 `flow_audit`。

| 动作 | 职责 |
|---|---|
| `inspect_plan` | 审查规划、依赖和管理决策，记录证据与结论 |
| `inspect_validation` | 针对指定不可变校验记录独立审核调度的验收行为，核对方法、证据及结论 |
| `request_correction` / `request_replan` / `request_revalidation` | 明确纠正要求、重新规划或重新验收的原因 |
| `verify_correction` | 用修复证据复核纠正项 |
| `notify` / `recommend` | 记录监督信号或管理建议 |
| `evaluate_health` | 依据观测信号评价八项编排质量维度 |
| `escalate` | 将持续或严重的问题提交上级处理 |

规划审查不阻塞每次派发，验收审核是正式接受的必要条件。审核引用与当前记录不一致时，结论不能使当前结果通过。验收审核拒绝保留已发布结果，任务回到 `SUBMITTED`，由调度补充校验；业务结果不合格时才安排 Worker 返工。

## 执行智能体与共享工具

执行智能体的 `flow_transaction` 只允许 `submit_result`，用于暂存候选结果与证据。一轮执行正常结束、租约有效且工具副作用可确认后，运行时才正式发布结果。执行智能体不能自行验收、扩大预算或改变管理结构。

所有角色可使用 `flow_query` 读取自身权限范围内的状态，通过 `flow_communicate` 发送消息、管理协作组或读写共享黑板。通信动作与参数见[通信与共享黑板](/development/components/communication)。

源码依据：[角色权限](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/protocol.ts)、[命令处理](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/actions.ts)、[工具注册](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)。
