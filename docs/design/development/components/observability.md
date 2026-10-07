# 查询与可观测性

可观测性组件根据持久状态和回执生成视图，帮助开发者查明：谁正在执行什么工作、为什么不能继续、预算用在何处，以及哪个版本的结果已被正式接受。团队视图和检查器只读取这些记录。主 Agent 通过团队工具管理整体任务；成员原生会话按生命周期允许文本续聊，参见[主会话与团队界面](/development/interface)。

## 主要入口

| 入口 | 用途 |
|---|---|
| `core/cluster.ts` 的 `read` | 读取集群快照，按参数附加事件和摘要 |
| `queryCluster` / 角色 `query` | 分页读取对象引用，或按标识读取详细证据 |
| `events` | 读取指定事件序号 `seq` 之后的增量事件 |
| `report` | 汇总拓扑、任务单元、审查、用量、回执和通信指标 |
| `web.ts` | 提供八个只读远程接口方法 |
| `core/team.ts` / `client/observer.ts` | 按主会话归属读取一致快照，隔离运行、去重和重连 |
| `client/team-view.tsx` / `reader.tsx` | 宿主视图中的只读拓扑、列表、原生会话内容与通信 |

## 面向用户与面向角色的视图

| 观察面 | 需要展示的信息 | 对应读取入口 |
|---|---|---|
| 任务单元 | 状态、依赖、进展、剩余工作、产物、验收与纠正记录 | `transactions`、`transaction`、`audits`、`issues` |
| 执行资源 | 模型、预算用量与预留、活跃身份、并发、上下文占用 | `agents`、`budgets`、`usage`、`context` |
| 管理结构 | 父子节点、深度、管理归属、分配与迁移历史 | `nodes`、`node`、`allocations`、`events` |
| 通信 | 消息投递和处理状态、协作组、跨子树流量、积压 | `deliveries`、`blackboard`、`report` 与通信动作结果 |
| 决策 | 规划版本、调整原因、验收证据、审计结论及提请上级处理后的结果 | `transaction`、`audit`、`issue`、`health`、`events` |

公共接口 `ctx.flow.queryCluster` 返回 `{what, data}`，调用者可按 `what` 收窄类型。角色工具 `flow_query` 则根据调用时捕获的身份限制读取范围：管理角色可读自己的子树，执行智能体可读自身及获分配的任务单元，并可找到负责它的管理角色。祖先链只用于说明拓扑关系，不会因此开放祖先的任务单元或会话。

列表返回 `items / total / offset / limit / next_offset`。列表中的对象引用只包含简要信息，完整结果、审查、纠正问题和副作用回执应按标识获取。第一页的 `items.length` 不代表集群中的对象总数。

## 证据排查路径

| 现象 | 先查 | 再查 |
|---|---|---|
| 任务单元没有开始 | 任务单元状态、依赖、执行分配 | 预算、纠正问题、拒绝事件 |
| 执行智能体声称已完成，但结果尚未正式接受 | 结果 `result`、验收记录 `validation`、结果版本 `result_revision` | 当前版本的验收审查及检查证据 |
| 文件存在但责任不清 | 副作用回执中的调用标识、写入者和管理归属 | 对应执行轮次、执行分配和任务单元版本 |
| 重启后没有继续执行 | 阻塞代码、租约、模型用量与副作用回执状态 | 宿主会话核对结果与恢复事件 |
| 管理域预算少，但集群仍有余量 | 各预算账户的额度与授予记录 | 余量是否属于兄弟管理域，是否允许显式调拨 |

`effect.node_id` 指执行智能体所在的物理节点；`effect.owner_management_id` 指分配它的管理节点。仅凭产物路径无法判断管理责任。

## 指标边界

智能体身份总数、仍存活身份数、实际激活身份数、活跃执行轮次数和并发模型请求数分别计量。`report` 的全局计数不依赖某一页任务单元；报告中的任务单元详情可能被截断，需要通过 `transactions.truncated` 与 `total` 判断完整性。

编排质量评估包含八项维度：任务覆盖、分解质量、响应性、规划稳定性、目标一致性、验收质量、结果整合和提请上级处理的质量。运行时提供可核对的观测信号 `signals`，审计智能体记录评分 `scores`、权重 `weights` 和评估窗口。管理域完成收尾前，所属审计智能体必须在收到收尾评估请求后完成八项判断；这不是服务可用性检查。

没有实测样本或可靠观测手段时，应将结论保留为未知。创建了 1000 个身份、单元测试通过或静态报告包含相关字段，都不足以证明千级智能体实际执行成功。

源码：[cluster.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/cluster.ts)、[observer.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/client/observer.ts)、[types.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/types.ts)。
