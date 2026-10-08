---
title: 集群配置参数
description: 启动请求、部署默认值、预算和运行限制的实际优先级与生效边界。
---

# 集群配置参数

部署配置设定集群的默认行为，宿主程序化 `ctx.flow.start` 请求可覆盖本次启动参数。用户通过主会话 `/agent-team` 加载 skill，由主 Agent 读取默认值、评估任务并调用创建工具，团队绑定所属主会话；浏览器观察接口不公开启动或控制方法。

## 配置优先级

```text
配置规则默认值 → 部署 defaultBudget / defaultLimits → 插件设置保存的默认值 → 本次 start 覆盖
```

`budget` 和 `limits` 按字段合并。例如，`budget: { tool_calls: 100000 }` 只替换 `tool_calls`，其余三个预算维度保留部署值；`budget: {}` 则保留完整默认预算。显式传入的非法值会被拒绝，不会被替换为默认值。

`capabilities` 按整个数组替换：省略时继承 `defaultCapabilities`，传入 `[]` 时保持空数组。在部署配置中，已声明默认值的字段可用 `null` 取默认值；`provider`、`model` 必须填写，不使用 `reasoningEffort` 时应省略该字段。这一约定不适用于 `start` 请求：请求中显式传入 `null` 与省略字段的含义不同。

```yaml
- id: dsh-flow
  config:
    provider: local-sglang
    model: Qwen3.8-27B-FP8
    workspace: ./workspace
    dataDir: ./.dsh-flow
    defaultCapabilities: [fs_read, fs_write]
    defaultBudget:
      tool_calls: 4096
    defaultLimits:
      max_active_agents: 2
      max_llm_concurrency: 1
```

使用上述配置时，启动请求只覆盖显式传入的工具次数、时间或容量维度。

## 启动请求

| 字段 | 含义 |
| --- | --- |
| `objective` | 必填目标，非空，最多 `16384` 字符 |
| `id` | 可选集群 ID，最多 `128` 字符；省略时生成 UUID |
| `workspace` | 本次工作目录；省略时继承部署目录，建议显式传绝对路径 |
| `capabilities` | `fs_read`、`fs_write`、`shell`、`web_fetch`、`browser` 的子集 |
| `budget` | 本次任务需要覆盖的根预算字段 |
| `limits` | 本次任务需要覆盖的结构和执行限制字段 |
| `acceptance_criteria` | 根任务单元的验收条件列表 |
| `initial_transactions` | 可选的固定任务单元计划，主要用于可复现基线；一般任务由编排智能体规划 |

插件设置支持团队的默认层数、子代理数、代理总数、运行时间、工具次数预算、派发模式及模型选项。设置经官方配置表单保存，新团队启动时保存快照；已有团队保持原预算和限制。`defaultDispatchMode` 为 `parallel`（默认）或 `serial`；串行默认每次安排一个代理执行轮。`defaultModel` 为 `{ provider, model }`，省略或 `null` 时跟随主会话；`defaultReasoningEffort` 默认 `inherit`，也可选 `off / low / medium / high`。模型上下文、输出与默认压缩全部由 DSH 实现。废弃字段在部署配置、启动和动作入口直接拒绝。计时器和数据库目录属于部署设置，不在启动请求中配置。调用示例与返回类型见 [API 接口](/development/api)。

## 默认根预算

通过标准插件入口启动集群时，使用以下默认值。四个维度均接受 `1…2⁴⁰` 范围内的整数。

| `budget` 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `tool_calls` | `2048` | 工具调用额度 |
| `wall_time_ms` | `900000` | 按实际经过时间计算的时限，即 15 分钟；子级不能延长祖先的截止时间 |
| `agents` | `64` | 可创建的智能体数量额度，包含三类管理角色 |
| `max_active_agents` | `4` | 预算账本中的活跃执行容量 |

预算账本按根集群、节点、智能体和任务单元等范围管理，各账户记录 `limit / reserved / spent`，分别表示额度上限、已预留额度和已用额度。资源分配智能体可以在授权范围内转移尚未使用、也未预留的额度，但重新分配不会增加根预算。目前预算不计量 CPU/GPU 使用量和内存占用。

## 默认运行限制与取值范围 {#默认-limits-与取值范围}

| `limits` 字段 | 默认值 | 请求范围 | 控制内容 |
| --- | ---: | --- | --- |
| `max_children` | `8` | `1…4096` | 管理节点的直接子节点数上限 |
| `max_depth` | `4` | `1…32` | 管理树最大深度，根深度为 0；管理子节点还需留出执行节点所在的层级 |
| `max_agents` | `64` | `1…100000` | 集群身份数量上限 |
| `max_active_agents` | `4` | `1…512` | 同时进行的智能体执行轮次数上限 |
| `max_llm_concurrency` | `2` | `1…64` | Agent 执行轮外围的模型调度许可上限，不能证明辅助请求的精确并发 |
| `max_attempts` | `2` | `1…16` | 任务单元的执行尝试次数上限 |
| `max_corrections` | `2` | `0…16` | 纠正次数上限 |
| `max_role_turns` | `12` | `1…512` | 单个管理身份的执行轮次数上限 |
| `max_tool_calls_per_turn` | `24` | `1…4096` | 单个执行轮内由 Flow 控制平面入口计数的工具调用上限 |
| `max_scale_batch` | 未指定 | `1…100000` | 保留在配置和团队快照中；当前扩容实现尚未读取 |

请求值均须为整数。

`budget.max_active_agents` 决定预算允许使用的执行容量，`limits.max_active_agents` 则限制调度时的并发执行数，运行时必须同时满足两者。增加 `max_agents` 不会增加智能体数量预算，提高调度许可不会增加其他资源额度。单个字段通过校验，不代表任务一定能启动或完成：建立包含三类管理角色的节点、运行执行智能体和完成审计，都需要实际可用的额度。

`max_tool_calls_per_turn` 在部署解析和团队快照中保留，控制平面入口读取当前团队值；它不等于所有宿主工具调用的总上限。`max_scale_batch` 同样保留，但当前扩容路径尚未读取，不能依赖它改变单次扩容行为。`scale_out` 的单次数量由动作参数 `count` 决定，并受可调度任务单元、身份和预算约束。

### 区分协议回退值与插件默认值 {#不要混用协议回退与交互默认值}

`core/protocol.ts` 中的 `DEFAULT_LIMITS` 用于直接构造运行时的测试等场景，部分值与插件入口不同。例如，它的默认值包括 `max_depth: 6`、`max_agents: 2048`、`max_role_turns: 24`。本页主表列出的是 `config.ts` 的默认值，适用于正常的插件、工具和远程接口调用。

## 部署路径与调度参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `dataDir` | `.dsh-flow` | `cluster.sqlite` 与运行文件目录 |
| `workspace` | `.` | 未指定工作目录时使用的默认值 |
| `tickMs` | `250` | 调度周期的间隔 |
| `staleMs` | `120000` | 未完成工作停滞的报告阈值 |
| `maxTurnMs` | `900000` | 单轮执行的时限 |
| `heartbeatMs` | `20000` | 执行租约心跳间隔 |
| `leaseTtlMs` | `60000` | 租约有效期，必须严格大于心跳间隔 |
| `disposeTimeoutMs` | `5000` | 插件退出时，等待执行收尾并关闭存储的总时限 |

加载插件时，相对路径以 `process.cwd()` 为基准解析为绝对路径。时间参数的单位均为毫秒，须为 `1…2³¹` 范围内的整数。`maxTurnMs` 限制单轮执行时间，集群的时间预算限制整体任务耗时，两者不能相互替代。

模型与能力参数见 [智能体配置参数](/configuration/agents)。修改部署示例后，可按 [快速上手](/quick-start) 使用 `--dump-config` 检查合并后的配置。

## 源码依据

[配置与合并](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/config.ts)、[输入校验](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/validation.ts)、[协议默认值](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/protocol.ts)、[预算账本](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/budget.ts)、[实际调度与计数](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/cluster.ts)。
