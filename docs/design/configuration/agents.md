---
title: 智能体配置参数
description: 区分部署时的模型与上下文默认值，以及资源分配智能体在运行时对具体身份的调整。
---

# 智能体配置参数 {#agent-配置参数}

一个管理节点包含编排智能体、资源分配智能体和审计智能体，三者使用独立身份；执行智能体也使用独立身份。部署配置为所有身份提供一组共同的模型默认值，通过 `context.role` 和 `context.worker` 区分管理角色与执行智能体的上下文预算。目前没有为不同角色分别指定模型的部署配置项。

## 部署时设置默认值

以下参数位于配置方案的 `dsh-flow.config` 中，通过配置规则校验后用于创建运行时。

| 参数 | 默认值 | 作用与约束 |
| --- | --- | --- |
| `provider` | 必填 | 已在 DSH 中配置的模型提供方，非空字符串 |
| `model` | 必填 | 该提供方的模型 ID，非空字符串 |
| `reasoningEffort` | 不设置 | 可选字符串，由宿主的模型提供方解释；未设置时不会写入智能体选项 |
| `maxTokens` | `4096` | 每次模型请求的输出 Token 上限，整数 `1…2³¹` |
| `context.role` | `8192` | 管理角色的上下文压缩预算 |
| `context.worker` | `16384` | 执行智能体的上下文压缩预算 |
| `context.compaction_threshold` | `0.8` | 上下文占用达到该智能体上下文预算的这一比例后，考虑压缩；有效范围 `(0, 1]` |
| `context.model` | `131072` | 部署声明的模型窗口 |
| `context.server_input` | `142074` | 部署声明的服务端输入上限；应与实际服务配置一致 |

上下文 Token 数均须为正整数，最终配置校验上限为 `2³¹`。运行时以模型窗口与服务端输入上限中的较小值作为发送上限，并为输出预留空间，在发送前测量请求大小。提高某个智能体的压缩预算不会放宽这些限制；压缩预算也不等于模型服务的硬性上下文上限。

```yaml
- id: dsh-flow
  config:
    provider: local-sglang
    model: Qwen3.8-27B-FP8
    reasoningEffort: off
    maxTokens: 4096
    context:
      role: 8192
      worker: 16384
      compaction_threshold: 0.8
      model: 131072
      server_input: 142074
```

上例使用的是示例模型路由。模型提供方的地址、鉴权和模型清单仍由宿主 `llm-pi-ai` 配置管理。插件组合默认从 `ctx.agentDefaultModel.currentSelection()` 读取模型选择。覆盖配置会替换对应条目的整个 `config`，因此按上例覆盖时，必须重新填写 `provider` 与 `model`。

## 资源分配智能体可以调整什么 {#allocator-可以调整什么}

资源分配智能体通过自身的 `flow_allocation` 工具调整运行中的智能体及其资源，操作受管理域、集群上限和预算约束。这与用户通过 `flow_start` 设置集群启动参数是两个不同的接口。

| 动作 | 调整对象 | 当前边界 |
| --- | --- | --- |
| `select_model` | 指定 `agent_id`，或本管理域子树内已有智能体的模型设置 | 只能选择运行时路由表中已有的模型提供方与模型；不会注册新的模型提供方 |
| `set_context_budget` | 单个智能体的 `agents.meta.context` | `context_limit` 为 `1024…1048576`；`compression_threshold` 为 `(0, 1]`，默认 `0.8` |
| `set_concurrency` | 当前集群的活跃执行数与模型请求并发数 | 可调 `max_active_agents`、`max_llm_concurrency`；超过启动时声明上限的值会被限制在该上限内，并记录事件 |
| `allocate_budget` / `rebalance_budget` | 本管理域内的预算分配与调拨 | 调拨可用且未预留额度，不产生新的根预算 |
| `allocate_agent` / `replace_agent` / `reassign_agent` | 执行身份、能力和执行分配 | 不修改任务单元的目标或验收标准，仍需满足执行安全点要求并通过资源检查 |

标准 `Config` 当前只构造一条 `provider → [model]` 路由。`select_model` 只能从已有路由中选择，无法单独将普通部署扩展成多模型池。该动作还可接收 `reasoning_effort`、`max_tokens`，并将选择保存在身份元数据中。运行时优先使用针对该智能体单独设置的值，未覆盖的部分沿用部署默认值。

执行智能体还有独立的输出上限：实际 `maxTokens` 取上述有效值与 `limits.worker_max_tokens` 中的较小值。管理角色不受这一专属上限约束。

例如，资源分配智能体可以调整一个已有身份的上下文预算：

```json
{
  "action": "set_context_budget",
  "params": {
    "agent_id": "<本管理域的智能体 ID>",
    "context_limit": 24576,
    "compression_threshold": 0.8
  }
}
```

`retention_policy` 可以记录在身份元数据中，但当前实现不会据此切换压缩算法。摘要和检查点仍由宿主的上下文压缩服务生成。

## 能力与工具范围

启动请求中的 `capabilities` 确定集群可用的能力，再由资源分配智能体分配给具体的执行智能体。默认值为 `fs_read`、`fs_write`；显式传入 `[]` 表示不授予执行智能体任何能力，空数组不会被默认值替换。

| 能力 | 对应工具 | 宿主要求 |
| --- | --- | --- |
| `fs_read` | `read`、`glob`、`grep` | 文件与搜索插件，由运行时挂载到智能体作用域 |
| `fs_write` | `write`、`edit` | 文件插件与有效写入范围 |
| `shell` | `bash`、`job_output`、`job_kill` | Bash / Jobs 插件与宿主权限策略 |
| `web_fetch` | `web_fetch` | 网页插件，启用抓取、关闭搜索 |
| `browser` | 固定允许列表中的 Playwright MCP 工具 | 由宿主组合提供；仅声明能力不会自动安装或连接浏览器 |

角色命令工具也在各自的作用域中注册：编排智能体使用 `flow_transaction`，资源分配智能体使用 `flow_allocation`，审计智能体使用 `flow_audit`；执行智能体只能通过 `flow_transaction` 提交自身结果。共享工具 `flow_query`、`flow_communicate` 不会赋予调用者其他角色的决策权。

参见：[集群预算与运行限制](/configuration/cluster)、[宿主兼容性](/development/compatibility)、[API 接口](/development/api)。

## 源码依据

[Config 与解析](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/config.ts)、[动作实现](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/actions.ts)、[上下文测量](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/runtime.ts)、[能力映射](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/protocol.ts)、[角色工具](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)。
