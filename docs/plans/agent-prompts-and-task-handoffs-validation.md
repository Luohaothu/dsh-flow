# 智能体提示词与任务交接实施验证

日期：2026 年 10 月 9 日。对应[实施方案](agent-prompts-and-task-handoffs.md)。状态：实现及验证完成。

本次变更把业务交接、角色规则、正式计划、结果发布、调度校验和独立审核分别保存为可追溯的记录。以下确定性检查验证结构、权限和状态保证；真实模型检查实际规划、自然语言交接及完整执行。模型的自然语言判断仍由有权角色负责，字段检查不能证明业务判断正确。

## 要求与检查依据

| 要求 | 实现入口 | 确定性检查 |
| --- | --- | --- |
| 计划不可变，保存作者、理解、执行方式、交接、逐项责任和整合安排 | `core/contracts.ts`、`core/store.ts` | `task-contracts.test.ts`：作者不接受伪造、正式快照、父标准覆盖、原子回滚、稳定子键 |
| 未准备的任务不能直接、批量或经资源动作派发 | `core/actions.ts` | 无计划、错误执行方式、批量失败回滚、替换执行者、空拆分计划门槛 |
| 普通状态推进保留计划；正式修订、父计划驳回和依赖变更正确失效 | `core/actions.ts`、`core/contracts.ts` | 晚到计划审核、子域暂停、祖先整合失效、执行安全点及历史结果保留 |
| 新调用 ID 重试无重复计划、预算或管理委派 | `semantic_receipts`、`management_assignments` | 直接派发、拆分、管理委派语义重试与冲突检查 |
| 管理委派保留不可变预算请求，资源守恒且不足资金时原子回滚 | `spawn_management_node` | `task-contracts.test.ts`：只读及不可扩展预算成功、请求不变、资源守恒、语义重试；资金不足时身份、委派与预算全部回滚 |
| 只有实际成功且已持久化的当前执行轮次发布结果 | `core/runtime.ts`、`core/cluster.ts` | `member-briefing.test.ts`、`cluster.01.test.ts`：轮次、身份、租约、分配及未决副作用检查 |
| 调度实际校验每项正式标准；Auditor 审核其验收行为 | `core/actions.ts`、`core/role-tools.ts` | 未发布结果、遗漏标准、错用结果引用、五项审核规则、重新校验和显式纠正闭环 |
| 所有接受入口匹配当前计划、结果、校验、独立审核及子任务 | `acceptTransaction` | 手动与自动接受、重新校验、委派汇总和真实责任作者 |
| assignment 绑定本轮实际对象，查询受角色与管理域限制 | `core/briefing.ts`、`core/cluster.ts` | 实际原生工具读取、修订后失效、对象不被新事件替换 |
| 局部任务限制保留其主体，不覆盖管理角色的本域职责 | `core/briefing.ts`、`ROLE_SYSTEM_INSTRUCTIONS` | `member-briefing.test.ts`：原生 Allocator 保留除法任务的简报、约束及绑定，通过 agenda 读取本域两项任务，并实际分别创建分配 |
| 纯计算回执按实际轮次读取，不从空副作用列表推断没有工具调用 | `core/native-evidence.ts` | `native-evidence.test.ts`：生产者、成功校验调用、真实参数形态、重复调用 ID 与歧义隔离 |
| 纠正可引用正式输入中的历史产物，当前验收仍绑定当前产物 | `validate`、`historical_result` | `task-contracts.test.ts`：同任务旧发布、确切对象引用、正式修订及越域、伪造、未声明引用拒绝 |
| 小型默认投影、字段白名单及完整大内容读取 | `projectContext` | 大输入跨页保持旧快照；未知字段、分页过期及 actor 隔离 |
| agenda 后续页使用固定的 actor 快照 | `core/cluster.ts` | 新事件出现后跨页不漏项、不同 actor 不复用快照 |
| 四角色、恢复及 single 路径统一 system | `MemberBriefing` | 角色规则、自然正文、普通状态通知、single 用户契约及来源 |
| 首次交接、修订和唤醒有明确持久化身份 | `member_inputs`、`runTurn` | `agent-input.test.ts`：真实原生消息 ID、无关 user 不影响首次任务、重启与缺失证据 |
| 压缩或重启不重复首条委托，不把入队当成进入会话 | `runTurn` | 原始 journal 核对、仅 `user/message` 确认、缺失已确认记录拒绝重投 |
| Worker 的结果先交调度；没有校验记录时不生成 Auditor 验收待办 | `core/cluster.ts` | `member-briefing.test.ts`、`cluster.03.test.ts` |
| 委派交付等待独立审核时不提前生成收尾工作；真正待办空转仍阻塞 | `pendingFor`、`core/cluster.ts` | `delegated-audit-wait.test.ts` 两项回归：真实原生 Auditor 异步等待期间不重复启动作者，批准后按当前引用接受并收尾；有真实校验待办却空转三轮仍 BLOCKED |
| mock 与成员使用相同查询路径，不从旧正文猜身份 | `src/host/mock-identity-adapter.ts`、`mock-model.ts` | 原生身份隔离、工具往返、通信、权限及八个 mock 场景 |
| schema 提升且不迁移或删除旧数据 | `ClusterStore` schema 4 | 旧 schema 拒绝后原数据不变；新隔离目录重启恢复 |

## 全链验证

真实模型脚本为 `tests/acceptance/handoffs-live.ts`。运行前通过进程环境设置 `FLOW_MODEL_API_KEY`；可设置 `FLOW_MODEL_ID`、`FLOW_MODEL_BASE_URL` 和 `FLOW_MODEL_REASONING_EFFORT=off|high`。脚本不保存密钥，每次创建空工作区、空能力列表和独立数据目录。

```sh
node --import tsx tests/acceptance/handoffs-live.ts
```

脚本分别运行简单任务、拆分、两层管理委派、错误候选纠正和宿主重启。每项保存原生成员 Session 证据、正式计划、实际结果发布、调度校验与审核记录，并检查首次任务只进入一次、正文可读、实际数值及最终接受所用引用和责任作者。

每个实例先执行 `npm pack`，从归档加载插件，并逐字节比较安装包的 Host、Client 与生成协议文件和构建产物。报告保存归档 SHA-256 及运行前后源码、构建指纹；开发过程中源码变化的探索运行不算最终通过。

业务条件与治理的接受门槛分别检查。管理者先记录实际业务检查，Auditor 再独立审核这条记录；当前记录尚未发生的审核批准不能成为创建它的前置条件。正式接受仍必须匹配这次校验的独立审核。委派测试检查实际的两层管理关系与逐层交付，纠正测试检查错误结果、拒绝、正式修订及正确结果的有序证据，恢复测试在首条任务真实进入原生会话后重启。

## 验证结果

final6 冻结产物的 `pnpm typecheck`、`pnpm build`、`pnpm test` 已通过。全量测试为 **452/452**，失败和跳过均为 0。日志分别为 `/tmp/dsh-flow-handoffs-typecheck-final6.log`、`/tmp/dsh-flow-handoffs-build-final6.log` 和 `/tmp/dsh-flow-handoffs-tests-final6.log`。本次文档更新后的 `pnpm docs:build` 日志为 `/tmp/dsh-flow-handoffs-docs-final6.log`。

`spawn_management_node` 修复了直接修改调用方预算对象的问题：先克隆请求预算，再补足管理域所需的结构资源，原只读或不可扩展参数保持不变。两项真实回归分别验证成功创建管理域、预算总量守恒和语义重试不重复分配，以及资金不足时节点、身份、正式委派与预算变化全部原子回滚。

原生验收 **14/14** 通过，失败和跳过均为 0，日志为 `/tmp/mock-native-final-r15.txt`。它覆盖真实原生 Agent、工具往返、消息来源、上下文与压缩、取消、能力及 actor 隔离。

确定性 mock 的 smoke、browser、context、panel、recovery、recursion、scale16、scale64 共 **8/8** 通过，机制检查均为 PASS，集群均为 COMPLETED，无失败检查或源码漂移。见[汇总](../../.artifacts/handoffs-final-mock-r15-summary.json)及 `/tmp/mock-suite-final-r15.txt`。八项共享同一源码及构建指纹，final6 的 `lib/index.js` SHA-256 为 `64b70e39ae9476dad5a67017b53202f90e2074db84d10876bdd9733429ac7669`。

r15 原生会话和 DOM 检查核对首条自然业务正文、独立成员输入来源、两条 wake 和两条通信。证据见[管理者原生输入](../../.artifacts/handoffs-final-mock-r15-20261009T060051Z-c7089e/artifacts/team-ui/native-orchestrator-inputs.json)、[执行者原生输入](../../.artifacts/handoffs-final-mock-r15-20261009T060051Z-c7089e/artifacts/team-ui/native-worker-inputs.json)及[完整检查](../../.artifacts/handoffs-final-mock-r15-20261009T060051Z-c7089e/artifacts/team-ui/checks.json)。不以截图或只有 initial 输入代替唤醒、通信验证。UI 可视正文的独立证据沿用 r13：[管理者首条输入](../../.artifacts/handoffs-final-mock-r13-20261009T050350Z-6ed904/artifacts/team-ui/native-first-management-input-visible.png)从持久化原生会话补拍，明确显示验收后的归档 **CANCELLED** 状态；[执行者业务输入](../../.artifacts/handoffs-final-mock-r13-20261009T050350Z-6ed904/artifacts/team-ui/native-worker-business-input.png)已通过本机 Chromium 查看。原始数据库、输入和检查报告保留不变。

真实模型使用 DeepSeek 官方端点 `https://api.deepseek.com`，最终五项均使用 `deepseek-flash`：简单任务和恢复为 `off`，拆分、两层委派及纠正为 `high`。[官方思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)定义了配置选项；以下通过结果来自实际运行，不推断该配置保证其他任务成功。

| 场景 | 推理设置 | 结果及原生证据 |
| --- | --- | --- |
| 简单任务 | `off` | [PASS](../../.artifacts/handoffs-simple-2026-10-09T06-00-54-693Z/report.json)：一个 Worker、一个事务，实际结果 5；调度实际检查后经独立审核接受 |
| 拆分 | `high` | [PASS](../../.artifacts/handoffs-decompose-2026-10-09T06-02-08-599Z/report.json)：两个 Worker 分别发布 391 和 12；父整合引用当前子结果及校验 |
| 两层管理委派 | `high` | [PASS](../../.artifacts/handoffs-delegation-2026-10-09T06-05-45-351Z/report.json)：根域 → 一级域 → 二级域 → Worker，四项正式任务全部接受；缺失校验证据经实际复算、新校验、独立审核及 CORRECTED 闭环；合法等待期间无误阻塞 |
| 纠正 | `high` | [PASS](../../.artifacts/handoffs-correction-2026-10-09T06-10-47-022Z/report.json)：错误候选 6 被正式拒绝；修订后交付 5，补充正式输入后再次发布并校验、独立审核；错误候选从未验收通过 |
| 重启恢复 | `off` | [PASS](../../.artifacts/handoffs-recovery-2026-10-09T06-10-50-469Z/report.json)：首条任务进入原生会话后重启，原消息身份保留且仅出现一次，随后正式接受 |

五项共 **135 项在线检查全部通过**，并经完整离线 checker 再次核对当前接受引用、责任作者及原生来源。见[最终汇总](../../.artifacts/handoffs-live-final6-summary.json)及 `/tmp/handoffs-final6-offline-checks.log`。独立 `replay-report.json` 保留原报告摘要，原报告未覆盖。每项的 `native-evidence.json` 保存会话、输入、计划、发布、校验、审核、分配、命令和事件。

简单任务的 Worker 没有调用提交工具，其成功原生正文由运行时在完成、持久化及当前分配检查后正式发布；离线核对正文与 `worker-output.summary` 完全一致。其余最终 Worker 产物核对成功的 `submit_result` 暂存回执及后续成功轮次；委派场景的首次提交因过期 revision 被拒绝，确认的是后一次成功提交。没有把失败暂存、取消轮次或自行构造的记录当作产物。

纠正运行使用当前产物及正式输入中保留的纠正依据；`historical_result` 的严格正反例由单元测试覆盖，最终成功模型运行未采用该引用类型，不算该类型的模型实测。

五项从同一 `dsh-flow-0.1.0.tgz` 安装，归档 SHA-256 为 `83f1edbabe9ac74436169d36707b54c0244f77931714e992e591b983b7c3d85f`。模型与 r15 mock 验证共同使用 `lib/index.js` SHA-256 `64b70e39ae9476dad5a67017b53202f90e2074db84d10876bdd9733429ac7669`。在线与离线报告均核对归档、已安装六个 JS 文件与当前构建的字节一致性，以及运行前后生产源码及构建指纹；源码变化期间的旧探索运行不计入最终通过数量。

冻结版本的一次 [Flash 委派运行失败](../../.artifacts/handoffs-delegation-2026-10-09T04-49-25-976Z/report.json)：模型提出空拆分、错误责任分配和额外重算，计划被拒绝后未正确修复当前父计划，派发被治理门槛拒绝。该运行不计为通过。另一次同生产构建的 [Pro 非推理委派](../../.artifacts/handoffs-delegation-2026-10-09T05-07-03-454Z/report.json)准确建立两层管理及 Worker，二级交付已接受，但一级 Auditor 只读了原生回执第一页，错误断言管理者没有实际调用求和工具。原生会话能定位其两次真实调用，正确翻页也能读取；该节点因无进展而阻塞后停止运行，仍计为失败。模型运行是有界场景的观察证据，不能证明所有模型、任务或重复运行均会成功。

旧 final5 的 [Pro high 委派失败](../../.artifacts/handoffs-delegation-2026-10-09T05-36-53-013Z/report.json)暴露了真实调度缺口：事件序号 343 时一级独立审核仍为 PENDING，运行时却提前生成不可执行的 `report-to-parent` 待办，反复启动作者后被 no-progress 门槛阻塞。final6 最小修复删除了此阶段的不可执行待办，等待独立审核期间不再重复启动作者；没有放宽无进展保护。`delegated-audit-wait.test.ts` 验证真实原生审核异步等待、批准后接受及完整收尾，并以真实校验工作存在却空转三轮仍 BLOCKED 的控制用例保留该门槛。

旧 final5 的 [Flash 拆分失败](../../.artifacts/handoffs-decompose-2026-10-09T05-38-10-287Z/report.json)还暴露了任务限制的作用域歧义：Allocator 把当前除法任务的“只处理除法”误当成本域所有资源工作的限制。final6 在 system 中明确管理角色覆盖本域已准备工作，在首次业务正文中标明限制所属的当前任务，保留正式任务约束及本轮绑定；原生 Allocator 两任务回归实际分别创建了除法与乘法分配。该失败运行中模型提交的无效审核参数及工具拒绝记录仍保留在原始证据中，失败未改记为通过。

同一 final6 构建的 [Flash 非思考纠正失败](../../.artifacts/handoffs-correction-2026-10-09T06-05-34-521Z/report.json)中，Auditor 错把已持久化的管理者复算当作缺失证据，补正轮次耗尽后阻塞。只读副本使用正式证据函数翻页，能明确区分 Worker 与管理者回执，见[回执复核](../../.artifacts/handoffs-correction-2026-10-09T06-05-34-521Z/native-receipt-replay.json)。另一个 [Pro high 额外试验](../../.artifacts/handoffs-delegation-2026-10-09T06-00-51-511Z/report.json)由模型为二级管理域选择 `max_children: 0`，阻止 Worker 分配；五项验收完成后主动停止，保留为未通过的中止试验。两项均未改记为通过，也未放宽审核、容量或纠正门槛。

规模测试的固定工具预算改为每项事务 64 次，包含新的按需查询、正式计划、逐项校验和独立审核；不再沿用旧状态 dump 脚本的每项 16 次预算。报告同时保留真实扣费次数和执行者数量、真实文件读取、符号及行数核验、并发与完整收尾证据。更高预算下完成不能解释为工具消耗减少或性能提升。

| 规模 | 完成耗时 | 实际扣费调用 | Worker / 管理调用 | Worker 与接受的叶任务 |
| --- | --- | --- | --- | --- |
| 16 | 55.343 秒 | 548 / 1024 预算 | 48 / 500 | 16 / 16 |
| 64 | 282.128 秒 | 2360 / 4096 预算 | 192 / 2168 | 64 / 64 |

数据契约已提升至 schema 4。旧数据库会在写入前被拒绝，原数据不迁移、不删除；旧安装需选择新的 `dataDir`。

验收脚本修正了 Worker 身份断言：任务属于管理节点，执行者驻独立 Worker 节点；必须同时核对 Worker 节点的父节点与真实分配中的执行者、任务、管理域及当前计划。三项回归覆盖完成后释放的合法分配、错域或错执行者、旧计划；最终五项运行再按该身份关系及实际原生发布来源复核。
