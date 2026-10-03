# 层次化 Agent Cluster 设计方案 V1.0

## 1. 目标

面向数百到数千 Agent 的协同执行场景，构建一套动态层次化 Agent 管理与协作体系。

核心能力包括：

- Agent 形成动态、非对称的层次化管理树；
- 每个管理节点由 Orchestrator、Allocator、Auditor 三个角色共同组成；
- 管理节点可以递归创建新的下级管理节点；
- 管理节点与 Worker 可以作为同级 Child 并列存在；
- 不同分支可以具有不同深度和规模；
- 任意两个或多个 Agent 可以直接通信；
- Agent 状态、进度、资源和异常持续可观测；
- Agent、模型和计算资源围绕具体事务动态配置；
- Orchestrator 的事务规划与验收持续接受独立监督；
- Context、Budget 和执行结果沿管理关系逐级聚合。

整个 Agent Cluster 同时维护两种主要拓扑：

**Management Tree**：描述 Agent 的管理和责任关系。

**Communication Graph**：描述 Agent 在执行过程中的实际协作关系。

---

## 2. Agent 层次结构

整个 Agent Cluster 的管理结构是一棵有根树。

其中：

- 叶子节点为 Worker Node；
- 非叶子节点为 Management Node；
- Management Node 可以同时拥有 Worker Node 和其他 Management Node 作为 Child；
- 不同分支可以具有不同深度和规模。

每个 Management Node 内部由三个角色组成：

**Orchestrator + Allocator + Auditor**

三者分别负责：

- **Orchestrator**：事务规划与验收；
- **Allocator**：事务到执行资源的映射与调度；
- **Auditor**：Orchestrator 履职监督。

---

## 3. 三元管理单元

| 角色 | 核心职责 |
|---|---|
| Orchestrator | 以事务为单位进行目标理解、任务分解、事务规划、执行跟踪和结果验收 |
| Allocator | 将事务映射到具体 Agent、模型、预算和计算资源，并负责执行期间的动态资源调度 |
| Auditor | 持续监督 Orchestrator 的事务规划、调整和验收是否健康、正确、完整 |

三个角色的职责边界为：

**Orchestrator 管事务。**

负责回答：做什么、如何拆解、事务之间是什么关系、结果是否合格。

**Allocator 管执行资源。**

负责回答：谁来做、使用什么模型、投入多少资源、执行过程中如何调整资源。

**Auditor 管治理监督。**

负责回答：Orchestrator 的事务规划、调整和验收是否合理。

---

# 4. Orchestrator

Orchestrator 以 Transaction 为基本管理单位。

主要职责包括：

- 理解当前目标；
- 将目标拆解为一个或多个事务；
- 定义事务目标、输入、约束和预期产物；
- 定义事务之间的依赖和优先级；
- 定义事务所需能力和执行要求；
- 跟踪事务级执行状态；
- 根据执行反馈调整事务结构；
- 对事务结果进行验收；
- 汇总多个事务的结果；
- 将复杂事务继续向下展开；
- 将超出当前管理域的问题向 Parent Management Node 升级。

其核心循环为：

**目标理解 → 事务分解 → 事务定义 → Dispatch → 执行跟踪 → 验收 → 调整 / 汇总**

### Orchestrator 动作空间

| 动作 | 语义 | 可调整参数 |
|---|---|---|
| `create_transaction` | 创建新的事务 | `objective`、`inputs`、`constraints`、`expected_output`、`acceptance_criteria` |
| `decompose` | 将事务拆解为多个子事务 | `transaction`、`subtransactions`、`dependencies`、`priorities` |
| `merge_transaction` | 合并多个相关事务 | `transactions`、`objective`、`acceptance_criteria` |
| `set_dependency` | 定义事务之间的依赖关系 | `source`、`target`、`dependency_type` |
| `set_priority` | 调整事务优先级 | `transaction`、`priority`、`deadline` |
| `set_requirements` | 定义事务执行要求 | `transaction`、`capabilities`、`quality_level`、`latency_target`、`cost_limit` |
| `dispatch` | 将事务提交给 Allocator 执行 | `transaction`、`requirements`、`budget_constraint` |
| `adjust_transaction` | 根据反馈修改事务定义 | `transaction`、`objective_delta`、`constraints`、`acceptance_criteria` |
| `pause_transaction` | 暂停事务 | `transaction`、`reason`、`checkpoint_policy` |
| `resume_transaction` | 恢复事务 | `transaction`、`resume_point`、`updated_requirements` |
| `cancel_transaction` | 取消事务 | `transaction`、`reason`、`artifact_policy` |
| `request_review` | 请求对结果进行独立审查 | `transaction`、`review_scope`、`criteria` |
| `validate` | 根据验收标准验证事务结果 | `transaction`、`result`、`acceptance_criteria` |
| `reject_result` | 驳回事务结果并要求调整 | `transaction`、`issues`、`required_changes` |
| `accept_result` | 接受事务结果 | `transaction`、`result`、`confidence` |
| `aggregate` | 汇总多个事务结果 | `transactions`、`aggregation_scope`、`output_schema` |
| `escalate` | 将事务级问题提交给 Parent | `issue`、`transaction`、`severity`、`evidence` |

Orchestrator 主要操作事务，不直接负责具体 Agent 的日常创建、选择、迁移和负载管理。

---

# 5. Allocator

Allocator 接收 Orchestrator Dispatch 的事务，并负责将事务转换为具体执行配置。

主要职责包括：

- 为事务匹配已有 Agent；
- 创建和回收 Agent；
- 根据事务要求匹配 Capability；
- 为 Agent 选择模型；
- 分配 Token、时间和计算预算；
- 设置事务并行度；
- 调整 Agent 负载；
- 替换执行效果不佳的 Agent；
- 根据运行状态迁移 Agent；
- 管理 Agent 生命周期；
- 管理局部资源生命周期；
- 必要时创建新的下级 Management Node。

Allocator 的主要输入为：

**Transaction + Execution Requirements + Agent Pool + Compute Resources + Budget + Runtime State**

输出为具体的 Execution Allocation。

### Allocator 动作空间

| 动作 | 语义 | 可调整参数 |
|---|---|---|
| `allocate_agent` | 为事务匹配已有 Agent | `transaction`、`agent`、`capability_match`、`allocation_weight` |
| `spawn_agent` | 为事务创建新的 Worker | `transaction`、`role`、`capabilities`、`model`、`budget`、`lifetime` |
| `spawn_management_node` | 为复杂事务创建下级 Management Node | `transaction`、`scope`、`budget`、`max_children` |
| `release_agent` | 回收当前 Agent | `agent`、`handoff_policy`、`state_policy` |
| `replace_agent` | 替换正在执行事务的 Agent | `transaction`、`source_agent`、`target_agent`、`state_transfer` |
| `reassign_agent` | 将 Agent 调整到其他事务 | `agent`、`source_transaction`、`target_transaction` |
| `select_model` | 为 Agent 选择模型 | `agent`、`transaction`、`model`、`reasoning_level`、`cost_limit` |
| `route_capability` | 根据能力要求匹配执行 Agent | `transaction`、`required_capabilities`、`candidate_agents`、`selection_policy` |
| `allocate_budget` | 分配事务或 Agent 的执行预算 | `target`、`tokens`、`wall_time`、`tool_calls`、`compute`、`cost` |
| `rebalance_budget` | 动态调整资源预算 | `sources`、`targets`、`resource_types`、`amounts` |
| `set_concurrency` | 设置事务并行度 | `transaction`、`min`、`target`、`max` |
| `scale_out` | 增加事务执行资源 | `transaction`、`additional_agents`、`additional_compute` |
| `scale_in` | 缩减事务执行资源 | `transaction`、`target_agents`、`target_compute` |
| `reparent` | 调整 Agent 或 Management Node 的 Parent | `target`、`new_parent`、`state_transfer` |
| `set_context_budget` | 配置 Agent Context 策略 | `agent`、`context_limit`、`compression_threshold`、`retention_policy` |
| `checkpoint` | 保存 Agent 执行状态 | `agent`、`scope`、`reason` |
| `restore` | 从 Checkpoint 恢复 Agent | `agent`、`checkpoint`、`target_resource` |
| `evaluate_allocation` | 评估当前资源配置效率 | `transaction`、`metrics`、`evaluation_window` |

事务目标、验收标准和预算边界保持不变时，Allocator 可以自主进行 Agent 增减、替换、迁移、模型切换和资源再平衡。

---

# 6. Auditor

Auditor 独立监督当前 Orchestrator 的履职状态。

监督范围集中在事务管理过程，包括：

- 事务拆解是否完整；
- 事务边界是否合理；
- 事务依赖是否正确；
- 优先级安排是否合理；
- Orchestrator 是否及时响应重要事务反馈；
- 验收标准是否充分；
- 验收过程是否可靠；
- 是否遗漏关键事务；
- 是否存在明显的规划震荡；
- 事务安排是否持续服务于上层目标。

Auditor 的核心循环为：

**事务规划观察 → 履职评估 → 反馈 / 纠正 → Orchestrator 调整 → 再验证**

### Auditor 动作空间

| 动作 | 语义 | 可调整参数 |
|---|---|---|
| `inspect_decomposition` | 检查事务拆解质量 | `transaction`、`subtransactions`、`coverage_scope` |
| `inspect_dependency` | 检查事务依赖关系 | `transactions`、`dependencies`、`constraints` |
| `inspect_priority` | 检查事务优先级 | `transactions`、`priorities`、`criticality` |
| `inspect_requirements` | 检查事务执行要求 | `transaction`、`requirements`、`constraints` |
| `inspect_dispatch` | 检查 Dispatch 信息是否充分 | `transaction`、`requirements`、`acceptance_criteria` |
| `inspect_progress_handling` | 检查 Orchestrator 对执行反馈的处理 | `transaction`、`events`、`decision_history` |
| `inspect_validation` | 检查事务验收过程 | `transaction`、`result`、`criteria`、`decision` |
| `detect_omission` | 识别事务规划遗漏 | `scope`、`required_items`、`evidence` |
| `detect_conflict` | 识别事务或管理决策冲突 | `transactions`、`decisions`、`constraints` |
| `detect_oscillation` | 检查规划是否频繁反复 | `decision_history`、`window`、`threshold` |
| `detect_goal_drift` | 检查事务规划是否偏离目标 | `goal`、`transactions`、`decision_history` |
| `evaluate_health` | 综合评估 Orchestrator 履职健康度 | `dimensions`、`weights`、`evaluation_window` |
| `notify` | 向 Orchestrator 提供监督信息 | `issue`、`evidence`、`severity` |
| `recommend` | 提出事务管理改进建议 | `issue`、`recommendation`、`expected_effect` |
| `request_correction` | 要求修正事务安排 | `issue`、`affected_transactions`、`required_change` |
| `request_replan` | 要求相关事务重新规划 | `scope`、`reason`、`constraints` |
| `request_revalidation` | 要求重新执行结果验收 | `transaction`、`reason`、`criteria` |
| `verify_correction` | 验证监督反馈是否得到落实 | `feedback_id`、`expected_change`、`evaluation_window` |
| `escalate` | 将持续或严重问题提交给 Parent | `issue`、`severity`、`evidence`、`history` |

Auditor 主要监督 Orchestrator 的事务管理行为，不承担 Agent 日常资源调度职责。

---

## 7. 三者之间的运行关系

三个角色围绕 Transaction 形成三条相互关联的控制链。

| 来源 | 目标 | 主要信息 |
|---|---|---|
| Orchestrator | Allocator | Transaction、能力要求、质量要求、时延目标、预算约束 |
| Allocator | Orchestrator | 事务执行状态、资源瓶颈、无法满足的执行约束 |
| Runtime / Worker | Allocator | Agent 状态、负载、资源使用、执行进度 |
| Runtime / Worker | Orchestrator | 事务结果、失败、阻塞和关键业务反馈 |
| Auditor | Orchestrator | 履职问题、纠正要求、重新规划或重新验收请求 |
| Orchestrator | Auditor | 事务规划、决策历史、验收结果和纠正结果 |

三者分别运行：

**Orchestrator Loop**

目标 → 事务分解 → 事务规划 → Dispatch → 执行反馈 → 验收 → 调整

**Allocator Loop**

事务要求 → Agent / Model / Resource 匹配 → 执行 → 资源状态 → 动态调整

**Auditor Loop**

Orchestrator 行为 → 履职评估 → 反馈 / 纠正 → 修正 → 再验证

---

## 8. 管理树的动态形成

Worker Node 承担可直接执行的事务。

当某个事务需要独立的进一步规划和管理时，Allocator 为其创建新的 Management Node。

Management Node 仍由：

**Orchestrator + Allocator + Auditor**

组成。

Management Node 可以继续管理 Worker Node 和其他 Management Node，从而形成动态、非对称的递归管理树。

---

## 9. Fan-out 与 Depth

Management Tree 主要关注两个局部结构参数：

| 参数 | 含义 |
|---|---|
| Fan-out | 当前 Management Node 直接管理的 Child 数量 |
| Depth | 当前分支在 Management Tree 中的深度 |

建议单个 Management Node 的直接 Child 数量初始控制在约 **4～12 个**。

Allocator 根据事务数量、Agent 数量、负载、通信强度、Context 压力和资源状态动态调整局部组织结构。

---

## 10. Agent Tracing

每个 Worker 和 Management Node 持续暴露运行状态。

| 类型 | 典型信息 |
|---|---|
| 执行状态 | running、waiting、blocked、failed、completed |
| 资源状态 | token、wall time、tool call、context、CPU/GPU |
| 事务状态 | progress、remaining work、result、validation status |
| 管理状态 | parent、children、transaction ownership |
| 通信状态 | peers、groups、message rate、cross-subtree traffic |
| Orchestrator 状态 | transaction plan、decision history、validation history |
| Allocator 状态 | allocation、utilization、load balance、resource changes |
| Auditor 状态 | health、alerts、feedback、correction status |

Tracing 数据是三个角色共享的运行时事实来源。

---

## 11. Event-driven Management Node

三个角色订阅不同类型的运行事件。

| 角色 | 主要事件 |
|---|---|
| Orchestrator | 事务完成、失败、阻塞、关键结果、验收事件、目标变化 |
| Allocator | Agent 空闲/忙碌、资源压力、模型异常、Context 压力、负载变化 |
| Auditor | Orchestrator 创建或修改事务、Dispatch、验收、重规划、长期未处理重要事务 |

Orchestrator 的活动主要由事务生命周期驱动。

Allocator 的活动主要由资源和 Agent 状态变化驱动。

Auditor 的活动主要由 Orchestrator 的管理行为及其结果驱动。

---

## 12. Local Control Loop

每个 Management Node 内部形成三个局部控制环：

**事务控制环：Orchestrator**

**资源控制环：Allocator**

**治理监督环：Auditor**

Agent 层面的高频资源变化主要由 Allocator 吸收。

Orchestrator 主要在事务创建、调整、关键反馈和验收阶段介入。

Auditor 持续检查 Orchestrator 的事务管理质量。

---

## 13. Hierarchical Context

Context 按照 Management Tree 逐级聚合。

Worker 保存详细执行 Context。

Management Node 向 Parent 输出结构化 Summary：

```yaml
summary:
  transactions:
    progress: ...
    completed: ...
    failed: ...

  conclusions: [...]
  evidence: [...]
  unresolved_questions: [...]

  resource_state: ...
  management_health: ...

  confidence: ...
```

其中：

- `transactions`、`conclusions` 和验收结果由 Orchestrator 提供；
- `resource_state` 由 Allocator 提供；
- `management_health` 由 Auditor 提供。

---

## 14. Agent 通信模型

Communication Graph 独立于 Management Tree。

任意两个 Agent 可以直接通信，任意多个 Agent 可以形成临时通信组，通信关系可以跨层级和跨子树。

| 动作 | 语义 |
|---|---|
| `send` | 向单个 Agent 发送消息 |
| `multicast` | 向多个指定 Agent 发送消息 |
| `group` | 建立临时多 Agent 协作组 |
| `publish` | 向共享空间发布信息 |
| `query` | 查询共享信息 |
| `subscribe` | 订阅共享信息 |

整个 Agent Cluster 的协作结构由：

**Management Tree + Communication Graph + Shared Blackboard**

共同组成。

---

## 15. Budget

Budget 沿 Management Tree 分层分配。

主要资源维度包括：

- Token；
- Wall Time；
- Tool Calls；
- Agent 数量；
- CPU / GPU；
- Memory；
- API Cost。

Orchestrator 为事务定义预算边界和优先级。

Allocator 将预算映射到具体 Agent、模型和计算资源，并负责动态再平衡。

Auditor 监督 Orchestrator 的事务预算和优先级设置是否合理。

---

## 16. Agent 生命周期

Worker 使用统一生命周期：

**CREATED → READY → RUNNING → WAITING → COMPLETED**

同时允许进入：

**BLOCKED、PAUSED、FAILED、TERMINATED**

Worker 的创建、替换、回收、Checkpoint 和恢复由 Allocator 管理。

Management Node 结束时：

- Orchestrator 完成事务验收和结果收敛；
- Allocator 回收相关执行资源；
- Auditor 完成最终履职评估。

---

## 17. 动态组织重构

Management Tree 支持以下核心结构操作：

| 动作 | 主要责任角色 |
|---|---|
| `spawn_worker` | Allocator |
| `spawn_management_node` | Allocator |
| `replace_agent` | Allocator |
| `reparent` | Allocator |
| `scale_out` | Allocator |
| `scale_in` | Allocator |
| `decompose_transaction` | Orchestrator |
| `merge_transaction` | Orchestrator |
| `validate_transaction` | Orchestrator |
| `request_replan` | Auditor |
| `request_revalidation` | Auditor |

事务结构由 Orchestrator 决定。

执行组织由 Allocator 根据事务结构动态形成。

治理质量由 Auditor 持续监督。

---

## 18. Orchestrator 健康状态

Auditor 持续维护 Orchestrator 的履职健康状态。

| 指标 | 含义 |
|---|---|
| Transaction Coverage | 当前目标是否得到充分的事务覆盖 |
| Decomposition Quality | 事务粒度、边界和依赖是否合理 |
| Responsiveness | 是否及时处理重要事务反馈 |
| Planning Stability | 事务规划是否保持合理稳定 |
| Goal Alignment | 事务是否持续服务于上层目标 |
| Acceptance Quality | 验收标准和验收过程是否可靠 |
| Result Integration | 是否正确整合下级事务结果 |
| Escalation Quality | 是否在适当情况下向上级升级问题 |

这些指标集中评价 Orchestrator 的事务管理能力。

---

## 19. 大规模扩展

面向 1000+ Agent 时，每个 Management Node 保持稳定的职责分工：

**Orchestrator** 只需要理解有限数量的事务以及事务结果。

**Allocator** 管理当前局部域中的 Agent、模型、计算资源和动态调度。

**Auditor** 监督 Orchestrator 的事务规划和验收质量。

Agent 数量和资源配置的高频变化主要由 Allocator 吸收，因此 Agent Cluster 的扩张不会直接转化为 Orchestrator 的成员管理负担。

需要持续关注：

- Fan-out；
- Branch Depth；
- Subtree Size；
- Transaction Count；
- Orchestrator Context；
- Agent Utilization；
- Resource Utilization；
- Auditor Event Rate；
- Communication Traffic；
- Budget；
- Management Health。

---

## 20. 核心模型

整个 Agent Cluster 包含两种逻辑节点。

### Worker Node

负责具体事务执行。

### Management Node

由三个角色组成：

**Orchestrator**

负责事务规划、分解、调整和验收。

**Allocator**

负责事务到 Agent、模型和计算资源的映射，并承担执行期间的动态资源调度。

**Auditor**

负责监督 Orchestrator 的事务管理行为，并触发纠正、重新规划和重新验收。

三者形成三条相对独立的控制链：

**事务链：Orchestrator → Transaction**

**资源链：Allocator → Agent / Model / Compute**

**监督链：Auditor → Orchestrator**

Management Node 可以递归管理 Worker Node 和其他 Management Node。

所有 Agent 同时可以通过 Communication Graph 进行横向协作。

最终形成一个能够动态展开、局部自治、横向通信、资源自适应并具备独立治理监督能力的层次化 Agent Cluster。