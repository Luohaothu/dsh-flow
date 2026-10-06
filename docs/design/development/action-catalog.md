# 设计动作索引

本页按角色列出设计层面的动作及参数含义。这些参数用于说明设计意图，不代表当前工具的实际参数定义；已开放的动作及调用方式见 [API 手册](/development/api)。

所有动作均受管理域权限、版本、安全点和预算约束。`accept_result` 表达编排智能体的业务接受意见，结果达到正式接受状态 `ACCEPTED`，仍须遵循[任务单元与独立审计](/development/components/transactions)的版本复核规则。

创建执行智能体、分解任务单元和验收结果的设计动作分别为 `spawn_agent`、`decompose` 和 `validate`。`spawn_worker`、`decompose_transaction`、`validate_transaction` 是这些设计动作的同义表述，不代表额外的工具接口。

## 编排智能体动作

| 动作                 | 语义                        | 可调整参数                                                                     |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `create_transaction` | 创建新的任务单元                | `objective`、`inputs`、`constraints`、`expected_output`、`acceptance_criteria` |
| `decompose`          | 将任务单元拆解为多个子任务单元      | `transaction`、`subtransactions`、`dependencies`、`priorities`                 |
| `merge_transaction`  | 合并多个相关任务单元            | `transactions`、`objective`、`acceptance_criteria`                             |
| `set_dependency`     | 定义任务单元之间的依赖关系      | `source`、`target`、`dependency_type`                                          |
| `set_priority`       | 调整任务单元优先级              | `transaction`、`priority`、`deadline`                                          |
| `set_requirements`   | 定义任务单元执行要求            | `transaction`、`capabilities`、`quality_level`、`latency_target`、`cost_limit` |
| `dispatch`           | 派发任务单元，由资源分配智能体安排执行 | `transaction`、`requirements`、`budget_constraint`                             |
| `adjust_transaction` | 根据反馈修改任务单元定义        | `transaction`、`objective_delta`、`constraints`、`acceptance_criteria`         |
| `pause_transaction`  | 暂停任务单元                    | `transaction`、`reason`、`checkpoint_policy`                                   |
| `resume_transaction` | 恢复任务单元                    | `transaction`、`resume_point`、`updated_requirements`                          |
| `cancel_transaction` | 取消任务单元                    | `transaction`、`reason`、`artifact_policy`                                     |
| `request_review`     | 请求对结果进行独立审查      | `transaction`、`review_scope`、`criteria`                                      |
| `validate`           | 根据验收标准验证任务单元结果    | `transaction`、`result`、`acceptance_criteria`                                 |
| `reject_result`      | 驳回任务单元结果并要求调整      | `transaction`、`issues`、`required_changes`                                    |
| `accept_result`      | 提出接受任务单元结果的业务意见                | `transaction`、`result`、`confidence`                                          |
| `aggregate`          | 汇总多个任务单元结果            | `transactions`、`aggregation_scope`、`output_schema`                           |
| `escalate`           | 将任务单元中的问题提请上级管理节点处理   | `issue`、`transaction`、`severity`、`evidence`                                 |

## 资源分配智能体动作

| 动作                    | 语义                                    | 可调整参数                                                                     |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `allocate_agent`        | 为任务单元匹配已有智能体                    | `transaction`、`agent`、`capability_match`、`allocation_weight`                |
| `spawn_agent`           | 为任务单元创建新的执行智能体                   | `transaction`、`role`、`capabilities`、`model`、`budget`、`lifetime`           |
| `spawn_management_node` | 为复杂任务单元创建下级管理节点      | `transaction`、`scope`、`budget`、`max_children`                               |
| `release_agent`         | 回收当前智能体                          | `agent`、`handoff_policy`、`state_policy`                                      |
| `replace_agent`         | 替换正在执行任务单元的智能体                | `transaction`、`source_agent`、`target_agent`、`state_transfer`                |
| `reassign_agent`        | 将智能体调整到其他任务单元                 | `agent`、`source_transaction`、`target_transaction`                            |
| `select_model`          | 为智能体选择模型                       | `agent`、`transaction`、`model`、`reasoning_level`、`cost_limit`               |
| `route_capability`      | 根据能力要求匹配执行智能体              | `transaction`、`required_capabilities`、`candidate_agents`、`selection_policy` |
| `allocate_budget`       | 分配任务单元或智能体的执行预算             | `target`、`tokens`、`wall_time`、`tool_calls`、`compute`、`cost`               |
| `rebalance_budget`      | 动态调整资源预算                        | `sources`、`targets`、`resource_types`、`amounts`                              |
| `set_concurrency`       | 设置任务单元并行度                          | `transaction`、`min`、`target`、`max`                                          |
| `scale_out`             | 增加任务单元执行资源                        | `transaction`、`additional_agents`、`additional_compute`                       |
| `scale_in`              | 缩减任务单元执行资源                        | `transaction`、`target_agents`、`target_compute`                               |
| `reparent`              | 调整智能体或管理节点的父节点 | `target`、`new_parent`、`state_transfer`                                       |
| `set_context_budget`    | 配置智能体的上下文策略                 | `agent`、`context_limit`、`compression_threshold`、`retention_policy`          |
| `checkpoint`            | 保存智能体执行状态                     | `agent`、`scope`、`reason`                                                     |
| `restore`               | 从检查点恢复智能体                | `agent`、`checkpoint`、`target_resource`                                       |
| `evaluate_allocation`   | 评估当前资源配置效率                    | `transaction`、`metrics`、`evaluation_window`                                  |

## 审计智能体动作

| 动作                        | 语义                               | 可调整参数                                            |
| --------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `inspect_decomposition`     | 检查任务单元拆解质量                   | `transaction`、`subtransactions`、`coverage_scope`    |
| `inspect_dependency`        | 检查任务单元依赖关系                   | `transactions`、`dependencies`、`constraints`         |
| `inspect_priority`          | 检查任务单元优先级                     | `transactions`、`priorities`、`criticality`           |
| `inspect_requirements`      | 检查任务单元执行要求                   | `transaction`、`requirements`、`constraints`          |
| `inspect_dispatch`          | 检查任务派发信息是否充分         | `transaction`、`requirements`、`acceptance_criteria`  |
| `inspect_progress_handling` | 检查编排智能体对执行反馈的处理 | `transaction`、`events`、`decision_history`           |
| `inspect_validation`        | 检查任务单元验收过程                   | `transaction`、`result`、`criteria`、`decision`       |
| `detect_omission`           | 识别任务单元规划遗漏                   | `scope`、`required_items`、`evidence`                 |
| `detect_conflict`           | 识别任务单元或管理决策冲突             | `transactions`、`decisions`、`constraints`            |
| `detect_oscillation`        | 检查规划是否频繁反复               | `decision_history`、`window`、`threshold`             |
| `detect_goal_drift`         | 检查任务单元规划是否偏离目标           | `goal`、`transactions`、`decision_history`            |
| `evaluate_health`           | 综合评估编排智能体的履职情况   | `dimensions`、`weights`、`evaluation_window`          |
| `notify`                    | 向编排智能体提供监督信息       | `issue`、`evidence`、`severity`                       |
| `recommend`                 | 提出任务单元管理改进建议               | `issue`、`recommendation`、`expected_effect`          |
| `request_correction`        | 要求修正任务单元安排                   | `issue`、`affected_transactions`、`required_change`   |
| `request_replan`            | 要求相关任务单元重新规划               | `scope`、`reason`、`constraints`                      |
| `request_revalidation`      | 要求重新执行结果验收               | `transaction`、`reason`、`criteria`                   |
| `verify_correction`         | 验证监督反馈是否得到落实           | `feedback_id`、`expected_change`、`evaluation_window` |
| `escalate`                  | 将持续或严重的问题提请上级管理节点处理      | `issue`、`severity`、`evidence`、`history`            |

## 执行智能体与通信动作

执行智能体通过 `submit_result` 提交候选结果与证据，通过通信动作报告进度、阻塞原因和协作中发现的信息。通信动作见[通信组件](/development/components/communication)。执行智能体不拥有任务单元验收、预算扩张和管理拓扑变更权限。
