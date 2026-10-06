# API 手册

系统提供三类调用入口：宿主端与浏览器端使用的集群 API、用户会话中的三个工具，以及集群内部智能体的角色工具。这些入口共用控制平面，但调用权限、参数和返回数据的结构各不相同。

本页描述当前已开放的接口。[设计动作索引](/development/action-catalog)另行列出设计层面的完整动作及其含义，其中的概念参数不能直接当作实际工具参数。

## 公共服务：ctx.flow

`FlowService` 类型从 `dsh-flow` 导出，传输类型从 `dsh-flow/types` 导出。使用服务的插件应声明 `inject: ['flow']`，待服务可用后再调用。宿主端方法同步返回当前状态；启动集群的调用不会等待全部业务工作完成。

| 宿主端方法 | 参数 | 返回 |
|---|---|---|
| `start(request)` | `FlowStartRequest` | `FlowSnapshot` |
| `list(request)` | `{status?, limit?, offset?}` | `{clusters}` |
| `read(id, request)` | 集群标识；`FlowReadQuery` | `FlowSnapshot` |
| `events(id, request)` | 集群标识；`{since?, limit?}` | `{events}` |
| `control(id, action)` | `pause` / `resume` / `cancel` | 控制后的 `FlowSnapshot` |
| `queryCluster(id, what, params)` | 查询种类与对应参数 | `{what, data}` 联合类型 |
| `report(id)` | 集群标识 | `FlowReport` |

```ts
import type { FlowService } from 'dsh-flow';

function startReview(flow: FlowService) {
  const snapshot = flow.start({
    objective: '检查指定工作区模块的导出接口，给出带文件引用的说明',
    capabilities: ['fs_read'],
    acceptance_criteria: ['每个结论附可核对的源码位置'],
    budget: { tokens: 120_000 },
  });

  const id = snapshot.cluster.id;
  const answer = flow.queryCluster(id, 'transactions', { limit: 20, offset: 0 });
  if (answer.what === 'transactions') {
    return { id, items: answer.data.items, next: answer.data.next_offset };
  }
  throw new Error('Unexpected query result');
}
```

调用该函数前，部署中须已配置可访问的工作区和模型。示例中的预算额度不代表对完成质量或耗时的保证。

### 启动参数

| 字段 | 含义 |
|---|---|
| `objective` | 必填，整体目标 |
| `id` | 可选集群标识；用户工具不暴露此字段 |
| `workspace` | 可选工作区；缺省使用部署配置 |
| `capabilities` | `fs_read`、`fs_write`、`shell`、`web_fetch`、`browser` 的子集 |
| `budget` | 局部覆盖 `tokens`、`model_requests`、`tool_calls`、`wall_time_ms`、`agents`、`max_active_agents` |
| `limits` | 身份数量、层级深度、直接子节点数、执行并发、尝试与纠正次数上限，以及执行智能体的请求限制等 |
| `initial_transactions` | 可选的初始任务单元 JSON，用于指定集群启动时的工作安排 |
| `acceptance_criteria` | 隐式根任务单元的验收标准 |

配置按字段合并，后者覆盖前者：参数定义中的默认值 → 部署配置 → 本次请求。`budget: {}` 保留完整默认预算；显式 `capabilities: []` 则保持为空。非法参数会被拒绝，不会静默回退成默认值。

`read` 的参数包含 `limit`、`offset`、`node_id`、`status`、`since`、`event_limit`、`include_events` 和 `include_summary`。数据量较大时，应优先使用分页查询。`report.transactions` 自带 `total` 和 `truncated`，读取报告时也要判断是否包含全部任务单元详情。

### 增量事件

`events(id, {since, limit})` 返回该集群中序号 `seq` 大于 `since` 的事件。客户端应保存已处理的事件序号，并据此请求下一页，不能仅凭当前页面中的列表推断完整状态。

```ts
const page = flow.events(clusterId, { since: cursor, limit: 100 });
for (const event of page.events) {
  consume(event);
  cursor = event.seq;
}
```

`flow`、`clusterId`、`cursor` 与 `consume` 由调用者持有。重新获取快照及事件流重连的策略见 [可观测性组件](/development/components/observability)。

## 远程接口：ctx.remote.flow

`web.ts` 通过远程接口机制（Remote）提供相同的七个操作，其中查询方法名为 **`query`**，对应宿主端的 `queryCluster`。浏览器通过生成的 `ctx.remote.flow` 客户端调用这些方法，插件不应另行创建自有 HTTP 路由。

```ts
const result = await ctx.remote.flow.query(clusterId, 'nodes', {
  parent_id: null,
  limit: 50,
  offset: 0,
});
if (!result.ok) throw result.error;
if (result.value.what !== 'nodes') throw new Error('Unexpected query kind');
const roots = result.value.data.items;
```

客户端方法返回 `Promise`，结果先按 `{ok, value/error}` 解包，再根据 `what` 收窄查询类型。服务端 `@Remote` 方法的 `AbortSignal` 由传输层注入，业务调用者不把它放进请求字段。

`tick`、`settle`、`single`、`recover`、`dispose` 不属于公共服务或远程接口；开发与验收所用的 IPC 也不应向浏览器开放。

## 查询目录

公共查询的完整 `what` 集合如下。`params` 的分页字段只适用于返回列表的分支，并非所有查询都接受同一组筛选条件。

| `what` | 常用参数 | 读取内容 |
|---|---|---|
| `cluster` | `{}` | 集群配置、状态和计数 `counts` |
| `nodes` | `parent_id?`、分页 | 树节点引用；`parent_id: null` 取根，省略则不限父节点 |
| `node` | `id`；`full?` | 节点、祖先拓扑、任务单元与智能体分页，以及子树数量 |
| `transactions` | `node_id?`、`parent_id?`、`status?`、分页 | 任务单元引用 |
| `transaction` | **`id`** | 任务单元、依赖、结果、验收记录，以及审查与纠正问题的引用 |
| `agents` | `role?`、单个 `status?`、分页 | 身份与角色引用 |
| `allocations` | 分页 | 当前作用域内的执行分配 |
| `budgets` | 分页 | 各预算账户的额度与账本视图 |
| `issues` / `issue` | 列表分页 / 单条 `id` | 纠正问题与证据 |
| `audits` / `audit` | 列表分页 / 单条 `id` | 待作出决定的审查 / 单条审查详情 |
| `effects` / `effect` | 列表分页 / 单条 **`call_id`** | 副作用回执 |
| `usage` | `agent_id?`、单个 `status?`、分页 | 模型请求回执与用量汇总 |
| `deliveries` | 分页 | 消息及接收方投递状态 |
| `context` | `agent_id`；`transaction_id?` | 最近的上下文步骤与摘要；宿主端调用必须提供智能体标识 |
| `health` | `node_id?` | 编排质量评估、八项维度及观测信号 |
| `summary` | `node_id?`、`transaction_id?` | 相应作用域最新摘要 |
| `blackboard` | `prefix?`、分页 | 版本化黑板条目 |

列表统一携带 `items`、`total`、`offset`、`limit`、`next_offset`。继续读取直到 `next_offset` 为 `null`；不要把分页结果当完整子树。

角色工具 `flow_query` 使用相同的查询名，但读取范围由调用身份决定，返回的信息也更精简。它直接返回该分支数据，不使用公共 API 的外层 `{what, data}`；例如 `{what:'transaction', params:{id:'...'}}` 读取结果中的 `transaction`、`result` 和 `validation`。执行智能体不能借 `full` 扩大权限；需要历史详情时，应按审查、纠正问题或副作用回执的标识分别查询。

## 用户工具

`dsh-flow/tools` 为选用集群预设的用户会话注册三个工具，用于调用公共服务。它们与集群内部的管理角色工具分开。

| 工具 | 参数 | 输出内容 |
|---|---|---|
| `flow_start` | `objective`；可选 `workspace`、`capabilities`、`budget`、`limits`、`initial_transactions`、`acceptance_criteria` | JSON 文本：`cluster_id`、`status`、`counts` |
| `flow_read` | `id`；可选 `include_events`、`event_limit`、`since` | JSON 文本快照 |
| `flow_control` | `id`、`action: pause/resume/cancel` | JSON 文本：集群标识、动作 `action`、状态 `status`、计数 `counts` |

```json
{
  "id": "<flow_start 返回的 cluster_id>",
  "include_events": true,
  "event_limit": 30
}
```

上例是 `flow_read` 参数。用户工具不提供 `flow_audit`，也不提供直接调用内部运行时的入口。

## 角色工具

角色工具只在集群内部各智能体自己的作用域注册。调用者的角色、所属集群、智能体身份、会话、执行代次和执行轮次均从原生执行上下文取得，模型不能通过 `params` 指定自己的身份。

| 角色 | 命令工具 | 当前动作 |
|---|---|---|
| 编排智能体 | `flow_transaction` | `create_transaction`、`decompose`、`set_dependency`、`set_priority`、`dispatch`、`adjust_transaction`、`validate`、`accept_result`、`reject_result`、`aggregate`、`escalate`、`finish_cluster`、`pause_transaction`、`resume_transaction`、`cancel_transaction` |
| 资源分配智能体 | `flow_allocation` | `allocate_agent`、`spawn_agent`、`spawn_management_node`、`release_agent`、`allocate_budget`、`rebalance_budget`、`set_concurrency`、`scale_out`、`scale_in`、`select_model`、`evaluate_allocation`、`replace_agent`、`reassign_agent`、`reparent`、`checkpoint`、`restore`、`resolve_effect`、`set_context_budget` |
| 审计智能体 | `flow_audit` | `inspect_plan`、`inspect_validation`、`request_correction`、`request_replan`、`request_revalidation`、`verify_correction`、`escalate`、`notify`、`recommend`、`evaluate_health` |
| 执行智能体 | `flow_transaction` | 仅 `submit_result` |

每个角色还可以使用 `flow_query`、`flow_communicate`，以及用于检查工具调用链路的确定性工具 `flow_sum`。执行智能体能否使用文件、命令行、网页或浏览器工具，由分配给它的能力 `capabilities` 决定。

命令工具统一接收 `{action, params, expected_revision?}`。顶层 `expected_revision` 比较的是**集群版本**，而非任务单元版本或黑板条目版本。`command_id` 由工具根据原生调用身份产生，无需模型提交。

### 从创建任务单元到正式接受结果

以下片段应由相应角色在满足状态要求时分别调用，不能由同一智能体越权依次执行。`<transaction_id>` 和 `<audit_id>` 必须替换为前序返回或查询得到的真实标识。

编排智能体创建任务单元：

```json
{
  "action": "create_transaction",
  "params": {
    "objective": "说明目标模块的公共导出接口",
    "expected_output": "附源码路径的接口说明",
    "acceptance_criteria": ["每个导出接口附对应源码位置"],
    "capabilities": ["fs_read"]
  }
}
```

编排智能体派发任务单元，再由资源分配智能体建立执行分配：

```json
{ "action": "dispatch", "params": { "transaction_id": "<transaction_id>" } }
```

```json
{ "action": "allocate_agent", "params": { "transaction_id": "<transaction_id>" } }
```

执行智能体提交候选结果：

```json
{
  "action": "submit_result",
  "params": {
    "transaction_id": "<transaction_id>",
    "result": { "completed": true, "summary": "实际接口说明与源码引用" }
  }
}
```

`submit_result` 返回的 `STAGED` 是动作结果，不是任务单元的状态枚举。工具会结束该执行智能体的当前轮次；只有原生执行正常结束、租约有效且记账可确认后，运行时才发布结果并转为 `SUBMITTED`。

编排智能体完成实际检查后，提交接受意见：

```json
{
  "action": "validate",
  "params": {
    "transaction_id": "<transaction_id>",
    "accepted": true,
    "checks": [
      { "criterion": "每个导出接口附对应源码位置", "passed": true, "evidence": "实际读取结果或验证记录的引用" }
    ]
  }
}
```

审计智能体核对返回的验收审查记录后，提交独立决定：

```json
{
  "action": "inspect_validation",
  "params": { "audit_id": "<audit_id>", "decision": "APPROVED", "evidence": { "note": "独立核对的事实与记录引用" } }
}
```

示例中的 `evidence` 字符串只用于说明参数位置，实际调用必须填写可核对的证据。`inspect_validation` 审查指定版本的结果，批准后直接触发正式接受。规划审查不阻塞任务派发，但结果审查仍不可省略。

通信的参数与示例见 [通信组件](/development/components/communication)。`flow_sum` 参数为 `{values: [15, 40]}`，返回数值 `55`；它只检查原生工具调用能否往返完成，不验证智能体的业务工作质量。

## 错误与冲突

通过 `fail()` 发出的业务拒绝为 `RemoteError('flow/rejected', message, {status})`，状态位于 `error.details.status`：400 参数不合法、403 角色或管理域越权、404 对象不存在、409 版本/状态/租约冲突。账本和宿主还可能提供具体失败代码，不要把所有失败都归为预算不足。

遇到冲突应重新读取对象与证据，判断是否需要释放旧分配、修订计划或处理未知副作用，再提交新动作。更换命令标识后盲目重放，不能使过期授权重新生效。

## 设计动作与当前工具的区别

当前未开放 `merge_transaction`、`set_requirements`、`request_review`、`route_capability`。设计中的细粒度 `inspect_*`、`detect_*` 多数没有独立工具动作，相关监督由 `inspect_plan` 等动作完成。当前还开放了 `finish_cluster`、`resolve_effect` 等集群控制与恢复动作。

具体参数以 [role-tools.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)、[actions.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/actions.ts)、[protocol.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/protocol.ts) 为准；公共接口定义见 [service.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/service.ts)、[types.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/types.ts)、[web.ts](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/web.ts)。
