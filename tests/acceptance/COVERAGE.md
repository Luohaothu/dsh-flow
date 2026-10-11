# 当前契约与验收入口

本文件列出系统行为对应的测试入口、执行方法和证据边界。测试名称描述可观察行为；运行结果写入各次验收目录，不作为仓库中的状态声明。

## 执行方式

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:mock
```

`pnpm test` 运行单元测试和验收设施自身的契约测试。`pnpm run test:mock` 先运行原生宿主契约，再运行确定性场景。原生测试与浏览器场景需要可启动的 DSH 宿主；页面场景还需要 Playwright Chromium。单独运行时仍需先构建插件：

```sh
node --import tsx --test --test-concurrency=1 tests/acceptance/native/*.test.ts
node --import tsx tests/acceptance/suite.ts --mock --only smoke,panel
pnpm run accept:mock --case recovery
```

真实模型场景使用 `pnpm run accept --case <场景>`；模型配置、环境白名单和运行目录由 [宿主驱动](../../src/host/host.ts) 与 [验收运行器](run.ts) 管理。每次运行保留独立的配置、代码指纹、SQLite 账本、原生 Session、日志和检查结果。场景通过、机制通过与进程成功必须同时成立。

## 证据层次

| 层次 | 测试入口 | 证明范围 |
| --- | --- | --- |
| 协议与运行时 | [core.test.ts](../unit/core.test.ts)、`tests/unit/cluster.*.test.ts`、[actions-correctness.test.ts](../unit/actions-correctness.test.ts) | 真实 SQLite 上的状态转换、权限、原子性、预算、审计与恢复；模型和宿主边界可精确注入 |
| 主会话与团队接口 | [team-lifecycle.test.ts](../unit/team-lifecycle.test.ts)、[main-dialog.test.ts](../unit/main-dialog.test.ts)、[team-ux.test.ts](../unit/team-ux.test.ts) | 启动意图、生命周期工具、拥有者隔离、展示投影、订阅与输入策略 |
| 宿主提供方契约 | `tests/unit/provider-*.test.ts` | 已安装宿主包的作用域、消息分类、观察模式编解码及 Session 持久化行为 |
| 原生宿主 | [mock-runtime.test.ts](native/mock-runtime.test.ts) | 真实 Agent 循环、工具执行、Session 和守卫；模型输出由确定性端点提供 |
| 浏览器 | [panel.ts](checks/panel.ts)、[browser.ts](checks/browser.ts) | Chromium 中的页面交互、原生会话导航、只读检查器、布局及鉴权 |
| 验收设施 | `tests/acceptance/test/*.test.ts` | 证据归属、源代码指纹、场景状态判定、故障分类与运行隔离 |

确定性模型输出不证明真实模型的判断质量或吞吐。合成树只证明呈现与分页。故障注入证明指定窗口内的行为，不能替代实际宿主的执行证据。

## 主会话、原生成员会话与展示

| 当前契约 | 测试入口与关键断言 |
| --- | --- |
| `/agent-team` 接纳用户请求并加载 skill；主 Agent 评估任务后调用工具创建团队 | [main-dialog.test.ts](../unit/main-dialog.test.ts) 验证接纳幂等且命令本身不创建团队；原生 `N-team-launch` 验证人类请求、skill、`agent_team_create` 的顺序 |
| 主 Agent 使用 `agent_team_create/read/control/message/finalize` 管理团队 | [team-lifecycle.test.ts](../unit/team-lifecycle.test.ts) 验证评估与验收条件、跨拥有者拒绝、参数快照、创建重试、读取与收尾；原生 `N-scopes` 验证普通 Agent 获得生命周期工具而不继承角色工具 |
| 团队执行默认值按字段合并，创建时持久化 | [host-start.test.ts](../unit/host-start.test.ts) 验证服务默认值及非法输入无副作用；[execution-defaults.test.ts](../unit/execution-defaults.test.ts) 验证团队参数、模型路由和重启后的快照 |
| 成员完整对话使用宿主原生 Session；未回收成员可收取文本续聊，回收后保留记录并拒绝输入 | [team-lifecycle.test.ts](../unit/team-lifecycle.test.ts) 验证请求去重、拥有者和回收边界；[agent-session-source.test.ts](../unit/agent-session-source.test.ts) 验证策略刷新与过期响应；原生 `N-agent-session` 验证真实输入、重试和回收后读取；页面 `active-native-session-input`、`recycled-native-session-history-only` 和 `native-trajectory` 验证输入策略及完整会话入口 |
| 团队拓扑和浮动检查器只读；打开记录不激活冷 Agent | [reader-source.test.ts](../unit/reader-source.test.ts)、[provider-observation.test.ts](../unit/provider-observation.test.ts)；页面 `provider-readonly-inspector`、`cold-history-never-promotes-agent` 和 `cold-history-reconnect-remains-observation` |
| 首条任务属于 user；后续调度与通信保持独立来源 | [agent-input.test.ts](../unit/agent-input.test.ts)、[provider-message.test.ts](../unit/provider-message.test.ts)、原生 `N-communication` |
| 通信类别由显式数据决定，未分类消息显示为普通讨论，正文完整保留 | [communication-regression.test.ts](../unit/communication-regression.test.ts) 验证八类消息、重试不可改写、事务归属和完整正文；[communication-presentation.test.ts](../unit/communication-presentation.test.ts) 验证标题、长度及系统通知语义 |
| 读取失败保留可读记录；切换后晚到结果不能覆盖当前选择 | [reader-source.test.ts](../unit/reader-source.test.ts)、[team-ux.test.ts](../unit/team-ux.test.ts)；页面 `history-failure-is-local`、`native-parent-and-selection`、`reconnect-selection` |
| 设置保存、取消、离开确认和失败重试均使用实际持久化结果 | [team-ux.test.ts](../unit/team-ux.test.ts)；页面 `save-display-only`、`three-leave-choices`、`save-failure-retains-draft`、`failed-save-stays` |
| 拓扑保持稳定身份、真实派生层级、折叠关系和可访问孤立节点 | [execution-defaults.test.ts](../unit/execution-defaults.test.ts)、[team-ux.test.ts](../unit/team-ux.test.ts)；页面 50、200、1000 身份呈现及窄屏列表检查 |

## 控制面与安全边界

| 当前契约 | 测试入口与关键断言 |
| --- | --- |
| Orchestrator 负责计划、分解、派发、验证与收尾；Allocator 负责身份、预算和拓扑；Auditor 独立审核；Worker 只提交自身结果 | [core.test.ts](../unit/core.test.ts)、`tests/unit/cluster.*.test.ts`、[actions-correctness.test.ts](../unit/actions-correctness.test.ts) 的角色动作和域越权测试 |
| 结果接受要求正确的事务 revision、result revision 与审核决定；未完成子事务阻止父聚合与收尾 | `tests/unit/cluster.*.test.ts` 的 validation、correction、aggregate、finish_cluster 测试 |
| 事务关系必须存在、同域且无环；拒绝不留下部分状态 | [transaction-relationships-regression.test.ts](../unit/transaction-relationships-regression.test.ts) |
| 命令回执绑定身份与请求，预算转移、结算和嵌套事务具有原子性 | [ledger-command-regression.test.ts](../unit/ledger-command-regression.test.ts)、[actions-correctness.test.ts](../unit/actions-correctness.test.ts) |
| 通信先验证全部目标，再原子记录消息和投递；flush 后确认收取；重试不重复投递 | [communication-regression.test.ts](../unit/communication-regression.test.ts)、`tests/unit/cluster.*.test.ts` 的消息持久化窗口测试；原生 recovery 场景检查接收方 Session 中的消息次数 |
| Worker 工具由 capability 和授权范围约束；权限拒绝不能写文件或创建分配 | [core.test.ts](../unit/core.test.ts)、原生 `F-permission`、`N-missing-capability`、`N-identity`；声明写范围不等于操作系统文件锁 |
| 普通会话使用三个原生权限模式及 `workspace-write / ask` 默认；只有团队成员采用 `never`，冷恢复保持策略和工作区沙箱 | 原生 `N-permission-rpc` 检查实际目录与普通会话日志；`N0`、`N-scopes` 检查 Worker 与三类管理角色；`N-default-compaction` 检查冷恢复 |
| 原生事件被动计量；未知值保留，重放幂等；工具额度与副作用独立恢复 | 原生用量投影与默认压缩组合测试、工具预算与恢复单元测试 |
| 取消、重启和卸载使失效身份失去执行权；依赖未就绪或恢复失败时不发布服务 | [lifecycle-regression.test.ts](../unit/lifecycle-regression.test.ts)、`tests/unit/cluster.*.test.ts`、原生 recovery 场景 |
| 查询按域过滤后分页，按 id 可读完整证据；非法访问被拒绝 | `tests/unit/cluster.*.test.ts` 的 query、paging、domain 测试；页面 `authenticated-observer-route` |

## 确定性场景

| 场景 | 通过判据与证据 |
| --- | --- |
| smoke | Worker 的独立 Session 中存在实际 `flow_sum` 调用和结果；提交值等于工具结果；事务独立审核后接受 |
| recursion | 递归管理链与同层 Worker 同时执行；越界写入被拒；纠正由更高 revision 的完成结果及 Auditor 核销证明 |
| recovery | 在持住的请求上终止并重启真实宿主；失效租约被隔离；原生事件游标和投影一致，失败窗口保留不完整状态；消息不丢失或重复 |
| context | 原生默认压缩的持久化摘要；宿主用量投影不重复；任务仍按正确结果提交 |
| browser | 真实 Playwright MCP 导航、引用点击和点击后快照；工具调用与持久效果收据一致 |
| panel | 主 Agent 团队启动、原生成员会话、只读拓扑与检查器、宿主用量及未知/不完整展示、配置与实际模型区分、分页、断线恢复、主题、响应式布局和设置持久化 |
| scale16 / scale64 | 以冻结任务的文件分配为判据；成功 read 收据的路径、结果符号与行号匹配；每文件独立 Worker；Agent 调度许可、独立 HTTP 并发与工具预算分别有证据 |

`website`、`research`、`refactor` 是面向真实模型的任务场景，分别验证网站交付、来源支撑的研究结果和跨包代码修改。检查器与通过条件以对应 `cases/*.json` 和 `checks/*.ts` 为准。

## 证据限制

- 内部 flush 与 ACK 的多事务窗口由精确故障注入测试覆盖；原生报告中未命中的窗口保留 `not_exercised` 或 `UNKNOWN`。
- 模型服务拒绝、宿主默认压缩失败、宿主能力缺失与页面断言失败分别记录，不能用其中一类推断另一类通过。
- 任一失败或未执行检查都不能记为成功。通过声明应附本次运行的命令、范围与产物位置。

模型统计来自 `native_session_events` 与宿主持久化 Session；以原生会话和 seq 去重。Worker 激活须有真实执行轮生命周期及原生 assistant 结算事实。模型调度许可由 `llm-slot` 事件证明；提供方并发只有独立 HTTP 观测才能证明，不从用量投影推导。上下文验收使用宿主模型适配器容量与官方默认策略，Flow 不设置阈值或主动压缩。
