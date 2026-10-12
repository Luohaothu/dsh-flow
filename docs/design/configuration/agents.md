---
title: 智能体配置参数
description: 模型路由由 Flow 配置，上下文、输出和官方默认压缩由 DSH 原生 Agent 处理。
---

# 智能体配置参数 {#agent-配置参数}

管理角色与执行智能体均使用独立的 DSH 原生 Agent。Flow 配置任务输入、结果交付、模型选择、推理设置与工具能力。模型解析、上下文窗口、输出和压缩由 DSH 处理，Flow 不查询或缓存模型容量，不在模型发送前添加准入守卫。

## 部署模型默认值

| 参数 | 作用 |
| --- | --- |
| `provider` | DSH 中配置的模型提供方 |
| `model` | 模型 ID |
| `reasoningEffort` | 可选推理设置，由宿主模型适配器解释 |
| `defaultModel` | 新团队的固定 `{ provider, model }`；省略或 `null` 时跟随主会话 |
| `defaultReasoningEffort` | `inherit / off / low / medium / high`，用于新团队 |

```yaml
- id: dsh-flow
  config:
    provider: local-sglang
    model: Qwen3.8-27B-FP8
    reasoningEffort: off
```

宿主模型适配器自己的 `contextWindow` 和输出设置仍由 DSH 配置管理。Flow 使用模型的实际上下文配置；官方默认策略可以提前压缩，也负责处理容量缺失和服务错误。每个 Flow Agent 在隔离作用域挂载一份官方默认 `compaction-basic`，卸载随 Agent 生命周期完成，部署示例无需全局启用第二份监听器或修改摘要参数。

## 运行中调整 {#allocator-可以调整什么}

资源分配智能体通过 `flow_allocation` 调整已有身份，操作仍受管理域权限、可选路由表、资源额度与安全点约束。

| 动作 | 调整对象 |
| --- | --- |
| `select_model` | `provider`、`model` 与可选 `reasoning_effort`；不注册新提供方或预检模型能力 |
| `set_concurrency` | 活跃 Agent 执行容量与 `max_llm_concurrency` 调度许可 |
| `allocate_budget` / `rebalance_budget` | 工具次数、身份容量、执行容量与截止时间 |
| `allocate_agent` / `replace_agent` / `reassign_agent` | 执行身份、能力和分配 |

成员配置优先于团队选择，再继承部署默认值。界面分别展示当前配置模型与最近原生事件记录的实际模型及推理设置；尚无请求事实时，实际模型显示未知。并发许可覆盖 Agent 执行轮的调度，不能据此证明所有宿主辅助模型请求的精确并发。

废弃上下文、输出、Token 预算与模型请求次数参数在实际配置和动作入口明确拒绝；旧团队与数据库不迁移，应使用新的 `dataDir`。

## 能力与工具范围

启动请求中的 `capabilities` 确定 Worker 的能力上限，省略时默认 `fs_read`、`fs_write`，再由资源分配智能体为具体执行者配置能力。总协调使用独立的 `managementCapabilities`，省略时默认五类能力；`managementWriteScope` 默认 `["."]`。两者可显式收窄，空数组保持为空；子管理域的同名参数只能在父域授权内收窄。资源分配智能体保留控制面工具，不因管理域授权而获得业务执行工具。

总协调使用这些工具理解输入、检查产物和验收。文件写入受管理写入范围及活跃 Worker 冲突检查约束；Shell 需要 `["."]` 工作区写入授权，不能用文件级范围声称限制任意 Shell 命令。验收前用 `bind_validation` 绑定实际检查的当前计划与结果，同一原生轮次可继续调用工具；切换检查对象后，回执按调用分别绑定。

| 能力 | 对应工具 | 宿主要求 |
| --- | --- | --- |
| `fs_read` | `read`、`glob`、`grep` | 文件与搜索插件，由运行时挂载到智能体作用域 |
| `fs_write` | `write`、`edit` | 文件插件与有效写入范围 |
| `shell` | `bash`、`job_output`、`job_kill` | Bash / Jobs 插件与宿主权限策略 |
| `web_fetch` | `web_fetch` | 网页插件，启用抓取、关闭搜索 |
| `browser` | 固定允许列表中的 Playwright MCP 工具 | 由宿主组合提供；声明后宿主必须提供相应工具，否则返回 CAPABILITY_UNAVAILABLE |

角色命令工具也在各自的作用域中注册：编排智能体使用 `flow_transaction`，资源分配智能体使用 `flow_allocation`；执行智能体只能通过 `flow_transaction` 提交自身结果。共享工具 `flow_query`、`flow_communicate` 不会赋予调用者其他角色的决策权。

参见：[集群预算与运行限制](/configuration/cluster)、[宿主兼容性](/development/compatibility)、[API 接口](/development/api)。

## 源码依据

[Config 与解析](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/config.ts)、[动作实现](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/actions.ts)、[原生 Agent 接入](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/runtime.ts)、[能力映射](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/protocol.ts)、[角色工具](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/role-tools.ts)。
