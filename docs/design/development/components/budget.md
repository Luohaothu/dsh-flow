# 预算账本

预算账本约束工具调用次数、身份容量、执行容量和截止时间。父子授予来自已有额度，汇总时不能重复累加。Token 用量另从宿主持久化事件被动投影，不参与准入、分配或扣减。

## 主要入口

| 符号 | 用途 |
| --- | --- |
| `createBudget`、`budgetView` | 建立工具和容量账户，生成查询视图 |
| `reserveChain` | 在截止时间和工具额度内预留 |
| `settleChain`、`releaseChain` | 结算工具调用或释放未使用预留 |
| `transferBudget` | 转移未使用且未预留的额度 |
| `reclaimCapacity` | 归还身份和执行容量 |
| `effectiveDeadline`、`rollupBudgets` | 继承截止时间并汇总资源 |

## 维度与边界

| 维度 | 语义 |
| --- | --- |
| `tool_calls` | 累计额度，保存 `limit / reserved / spent` |
| `agents`、`max_active_agents` | 占用时预留，释放时归还的容量 |
| `wall_time_ms` | 绝对截止时间，继承祖先中最早期限 |

`allocate_budget` 与 `rebalance_budget` 的 `amounts` 只接受 `tool_calls`、`agents` 和 `max_active_agents`；截止时间由父域继承，不是可调拨额度。不能用零、无限值或极大整数表示已删除的模型预算。无压缩预算账户、模型付款范围、模型请求预留或结算。

工具调用仍保留回执、准入、结算、权限、租约隔离和未确认副作用处理。共享 `ACCOUNTING_UNCERTAIN` 可能由工具额度产生，不表示模型请求付款状态。管理轮次、任务尝试与纠正次数仍然有效，也不等同于模型请求次数。

暂停和重启不会重置截止时间或工具消耗；调整父节点不能延长已有更早期限。调拨不能转移已使用或预留额度。CPU/GPU 和内存尚无可靠的按管理域计量。

源码：[budget.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/budget.ts)。
