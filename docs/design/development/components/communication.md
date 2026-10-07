# 通信与共享黑板

通信图允许同一集群内的智能体跨子树交换信息。通信不会改变任务单元管理权、资源调拨权或结果验收权；接收消息的角色仍须通过自己有权调用的命令采取行动。

## 主要入口与对象

`core/communication.ts` 导出 `communicate` 和 `COMMUNICATION_ACTIONS`，角色工具通过 `ClusterRuntime.communicateFrom` 调用这些功能。动作在 `store.tx` 中处理，接收方通知与消息状态一起持久化。

| 对象 | 主要标识与作用 |
|---|---|
| 消息 / 接收方 | 消息标识、发送者、不可变内容、接收方及投递状态 |
| 群组 | 集群内的群组标识、名称和成员 |
| 黑板 | 键 `key`、JSON 值 `value`、版本 `revision`、更新者 |
| 订阅 | 智能体、精确匹配或前缀匹配模式、匹配条件 `pattern`、游标 `cursor` |

## 当前工具参数

`flow_communicate` 的参数为 `{action, params}`：

| 动作 `action` | `params` 中的主要字段 |
|---|---|
| `send` / `multicast` | `agent`、`group` 或 `node` 指定接收者；`category`、`content`；可选 `transaction_id`、`message_id` |
| `group` | `operation: create/join/leave/close`；`name` 或 `id`；可选 `members` |
| `publish` | `key`、`value`；可选 `expected_revision` |
| `query` | `key` 或 `prefix`，返回 `entries` 和 `cursor` |
| `subscribe` | `operation: add/remove`；`key` 或 `prefix`；移除时可给 `id` |

`multicast` 通过 `group` 或 `node` 查出接收者，不接受任意 `recipients` 数组。当前一次最多 64 个接收者；跨集群或已处于 `TERMINATED` 状态的接收者会被拒绝。

## 消息类别与会话呈现

创建子 Agent 时的首条任务使用原生 `user` 来源，按普通 user prompt 显示。后续 Agent 通信使用 `flow-message` 来源，每条独立进入接收方会话，默认收起为单行摘要，点击后原位展开类别、发送方 → 接收方、时间、关联任务与完整正文。长摘要省略显示，完整主题保留在展开区。

系统事件的计数与通过状态来自结构化事件记录，不从模型正文猜测。例如单条派发事件显示“派发 1 个任务”，计划通过事件显示“计划审查通过”；请求审查不会显示通过图标。Agent 自发通信显示其主题，未提供主题时使用类别名称，正文与证据保持完整。

| `category` | 显示名称 | 用途 |
|---|---|---|
| `task_instruction` | 任务指令 | 派发补充要求、调整目标或约束 |
| `progress_update` | 进度反馈 | 汇报执行进度与当前状态 |
| `result_report` | 结果反馈 | 提交产物、结论与证据引用 |
| `review_feedback` | 审查意见 | 评审发现、验收意见与纠正要求 |
| `collaboration_request` | 协作请求 | 请求接口说明、依赖信息或协助 |
| `blocker_report` | 阻塞与升级 | 报告障碍、请求上级决策 |
| `resource_coordination` | 资源协调 | 协商预算、执行容量与上下文资源 |
| `discussion` | 普通讨论 | 其他信息交换；省略类别时的默认值 |

发送方明确选择类别，系统不按正文猜测。系统自动通知按事件生产方映射类别，发送方显示为“系统”。未传 `category` 时归为 `discussion`；未知类别被拒绝。`transaction_id` 如提供，必须属于当前集群。类别与关联任务保存在不可变消息内容中，修改类别后复用同一个 `message_id` 会被拒绝。

```json
{
  "action": "send",
  "params": {
    "agent": "agent-reviewer",
    "category": "result_report",
    "transaction_id": "tx-interface",
    "content": {
      "subject": "接口检查完成",
      "text": "检查通过，证据见 artifacts/interface-report.md。"
    }
  }
}
```

后续通信通过原生 `Agent.send(message, 'next-step', false)` 入队，再由调度提示调用 `followup` 唤醒一次执行。首步保留任务在前、通信随后，避免每条通信各启动一轮。Chat 提供方通过公开的 `source.presentation: communication` 提示生成独立节点，插件使用 `conversation.chat.node` 的 `communication` 键贡献渲染器；通信不被收入执行过程的折叠分组。后续调度摘要仍使用 `flow` 来源。

## 黑板参数示例

```json
{
  "action": "publish",
  "params": {
    "key": "interface/status",
    "value": { "transaction_id": "tx-interface", "status": "reviewed" },
    "expected_revision": 0
  }
}
```

示例用于首次创建该键；条目已存在时，应先读取当前版本，再据此进行条件更新。这里的 `expected_revision` 是**黑板条目版本**，不同于角色命令工具顶层的集群版本。

## 投递与幂等

发送成功表示消息及其接收方已登记，不表示接收者已完成业务工作。投递状态依次为 `PENDING → DELIVERED → ACKED`；确认投递需要宿主会话中的持久化证据。恢复过程会区分已找到（`FOUND`）、确认不存在（`ABSENT`）和无法确认（`UNKNOWN`）三种情况。

显式复用 `message_id` 可以重试同一次发送；若集群、发送者、消息种类 `kind` 或内容与已有记录不一致，则拒绝重试。重试可以补齐缺失的接收方记录，但不能修改原始消息。

新增订阅时，从同一时点的状态取得黑板快照和游标，避免“先读快照、后开始订阅”之间漏掉更新。后续通知提醒角色数据发生了变化；正式状态仍以带版本的黑板和任务单元记录为准。

## 权限与终止

发送消息和修改黑板时，需要核对当前执行身份及租约；只读查询不需要有效租约。管理角色发送工作消息后，会结束当前执行轮次，交还调度权，让接收方有机会执行，避免持续查询尚未推进的状态。

源码：[communication.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/communication.ts)、[role-tools.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)。
