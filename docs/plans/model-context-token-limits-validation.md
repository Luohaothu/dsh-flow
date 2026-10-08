# 模型执行限制移除：实施与验收记录

日期：2026 年 10 月 8 日。对应[实施方案](model-context-token-limits-plan.md)，依赖为锁定的 DSH `0.1.7-rc.2` 及仓库补丁。

状态：完整实施、独立审查和最终全部门禁已通过。

## 实现结果

Flow 使用原生 Agent 创建、恢复、输入、结果和取消接口。每个 Flow Agent 作用域装配一份隔离的官方 `compaction-basic`，配置为 `{}`，随作用域卸载；仓库 Web 组合的全局后端关闭。Flow 的模型发送中间件、窗口测量、强制压缩、输出上限、Token 预算、模型请求额度、付款回执及压缩预算账户已经删除。

配置、启动、模型选择、工具和预算动作在写入前拒绝废弃字段，包括 `requests` 别名和嵌套输出设置。宿主模型适配器自己的输出设置仍由宿主管理，主会话模型传入 Flow 时只投影提供方、模型和推理设置。保留配置的 Volatile 热更新仍有效。

数据库采用自足的 schema 3。旧版本、已有业务表的版本 0，以及缺少当前必需表／列或残留旧模型回执表的 schema 3 库在建表和写入前拒绝，原数据保持不变。需要新的 `dataDir`，没有旧团队迁移路径。

用量事实来自持久化原生 Session 事件，以 `(sessionId, seq)` 幂等投影，事实和消费游标原子提交。message、attempt 和 summary 的用量分别读取原生字段或公开的最终 stream usage helper；缺失值保持未知，已知部分和完整性分别报告。总量不会额外加 reasoning。压缩 start/end 及失败状态只影响完整性；宿主已有的 summary 用量仍按事实计入，不依据失败事件补造请求或用量。查询、read、report、最终摘要、宿主证据账本和 UI 使用同一来源，配置模型与最近实际模型分别展示。

工具回执、工具额度、身份与执行容量、时间、租约、未确认副作用、管理轮次、尝试、纠正、权限和审计继续有效。`max_llm_concurrency` 证明 Agent 调度许可的上限；提供方及辅助请求并发需要独立观测。

## 验收证据

| 范围 | 可重跑的证据 |
| --- | --- |
| 废弃入口明确拒绝、无部分写入 | `host-start`、`removed-controls`、`team-lifecycle` 单元测试 |
| schema 3、自足建表、旧库不写、正常恢复 | `native-usage`、`ledger-command-regression`、`lifecycle-regression` 与宿主 recovery 用例 |
| 最终 usage、多 attempt、零与未知、压缩失败 | `native-usage` 单元测试；原生 `F-transport`、`N-summary-cancel` |
| 同 seq 去重、原子游标、作用域统计一致 | `native-usage` 的投影故障回滚证明原子提交，`core` 验证查询一致；原生 `N-default-compaction` 的两次回放证明幂等 |
| 已压缩的同一会话冷恢复 | 原生 `N-default-compaction`：同宿主中卸载 live Session 后原生冷 resume，实际请求含持久化摘要，后续请求完成，游标接续，旧摘要没有双计；宿主进程恢复由独立 recovery 用例验证 |
| 一份官方默认压缩、摘要请求未改写、作用域卸载 | 原生 `N-default-compaction` 的插件注册、请求 envelope 和卸载断言 |
| 超过原 Worker 八次请求上限 | 原生 `N-no-model-limits`：至少十次请求并提交实际工具结果 |
| 工具额度守恒、耗尽与时间取消 | `single-resource-limits`；原有 cluster、工具回执、租约与副作用测试 |
| 真实任务、技能启动、输入输出、权限与身份 | 原生 `N0`、`N-agent-session`、`N-team-launch`、`N-scopes`、`F-permission`、`F-arguments`、`N-identity` |
| UI 设置、宿主已记录用量、完整性、模型区分 | panel 的真实浏览器检查与截图；声明的阅读压力 fixture 单独标记，不充当模型执行证据 |

独立审查发现并闭合了摘要生产与解码不一致、成员过滤汇总不一致、single 工具初始额度重复、single 时间取消缺口、事件持久化 cut 时序、保留限制重启丢失、宿主选择携带输出设置，以及工具根参数开放导致废弃输入被吞掉的问题。模型切换后不再用过期 snapshot 恢复旧窗口；真实 Session 回归覆盖已知窗口切换为未知窗口且尚无新 snapshot 的情况。

## 完成门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm run typecheck` | 通过，Host、Remote 生成、Client 与网站 seed |
| `pnpm run build` | 通过，宿主／客户端 bundle 与 Typert 产物 |
| `pnpm test` | 386 项全部通过，无失败、取消或跳过 |
| `pnpm run test:mock` | 14 项原生测试与 8 个宿主场景全部通过，无原生测试跳过；各场景机制 PASS、无失败检查、无构建漂移 |
| `pnpm run docs:build` | 通过 |
| `git diff --check` | 通过 |

最终宿主验收批次为 `20261008T042330Z`，各场景报告如下。panel 包含 66 项实时浏览器检查及一项数据库总检查，全部通过。

| 场景 | 报告 |
| --- | --- |
| 成员执行 | [smoke](../../.artifacts/smoke-20261008T042330Z-1d3aeb/report.json) |
| 递归委派 | [recursion](../../.artifacts/recursion-20261008T042330Z-400884/report.json) |
| 进程恢复 | [recovery](../../.artifacts/recovery-20261008T042330Z-37fe37/report.json) |
| 默认压缩 | [context](../../.artifacts/context-20261008T042330Z-2b8e04/report.json) |
| 原生浏览器工具 | [browser](../../.artifacts/browser-20261008T042330Z-069d03/report.json) |
| 团队面板 | [panel](../../.artifacts/panel-20261008T042330Z-96f637/report.json) |
| 16 成员 | [scale16](../../.artifacts/scale16-20261008T042330Z-1ff359/report.json) |
| 64 成员 | [scale64](../../.artifacts/scale64-20261008T042330Z-be3e7f/report.json) |

面板的[原生用量证据](../../.artifacts/panel-20261008T042330Z-96f637/artifacts/team-ui/native-usage-information.json)、[实时检查](../../.artifacts/panel-20261008T042330Z-96f637/artifacts/team-ui/checks.json)与[实际截图](../../.artifacts/panel-20261008T042330Z-96f637/artifacts/team-ui/native-usage.png)证明当前 Orchestrator 的四条原生结算共 4,152 Token，与页面一致，缺失字段仍为未知且标记可能不完整。[原生命令记录](../../.artifacts/panel-20261008T042330Z-96f637/artifacts/team-ui/native-command-requests.json)记录响应丢失后的同一提交 ID 重试，未重复创建团队。

当前机器没有系统 Chrome；完整 mock 验收通过既有的 `FLOW_CHROMIUM_PATH` 显式指定 `/home/leo/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`。重跑浏览器场景时将该变量设为本机可用的 Chrome 路径。原生测试与场景汇总日志为 `/tmp/dsh-flow-native-final2-mock.log`。

宿主验收使用真实 DSH Loader、原生 Agent、Session 持久化、SQLite、工具管线、公开 API 与浏览器。模型生成由受控 HTTP 服务提供；目录、ACK、离线故障和阅读压力 fixture 按用例声明，其余原生执行路径实际运行。这些测试验证运行时与契约，不是模型质量评测。探测本地 `127.0.0.1:8000` 时没有监听服务，本次未作 Qwen 实测。
