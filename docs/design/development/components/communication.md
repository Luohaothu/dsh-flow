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
| `send` / `multicast` | `agent`、`group` 或 `node` 指定接收者；`content`；可选 `message_id` |
| `group` | `operation: create/join/leave/close`；`name` 或 `id`；可选 `members` |
| `publish` | `key`、`value`；可选 `expected_revision` |
| `query` | `key` 或 `prefix`，返回 `entries` 和 `cursor` |
| `subscribe` | `operation: add/remove`；`key` 或 `prefix`；移除时可给 `id` |

`multicast` 通过 `group` 或 `node` 查出接收者，不接受任意 `recipients` 数组。当前一次最多 64 个接收者；跨集群或已处于 `TERMINATED` 状态的接收者会被拒绝。

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
