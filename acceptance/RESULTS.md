# dsh-flow 确定性验收结果（mock-api）

本文件回答：**当前插件应具备的功能，逐项的实际结果是什么，证据在哪里，哪些项没被验证。**

判定只采信 `.artifacts/<run-id>/` 里的报告与持久证据。设计已声明但当前未实现的动作列在最后，不计入通过。

- 契约矩阵：`acceptance/COVERAGE.md`
- 回归套件：`npm test`（293/293）、`npm run test:mock`
- 本批全部报告：`validation_mode: "mock-api"`，`build_drift: null`

## 冻结的构建与源码指纹

验收在这一份源码上跑了两批，其中一批在**第二个 checkout**（同一 commit 的 clean worktree）里跑，两批指纹完全相同：

| 项 | 值 |
|---|---|
| `plugin_source` | `sha256:a751c2d0…`（完整值见 `TEST-RESULTS.md`，9 个源文件） |
| `lib_index` | `sha256:9a88b2585380be43394c02700c09a09a30c538dc88c2894cc82136195abd3afd` |
| `acceptance_source` | `sha256:9ef9ff13…`（41 个文件，完整值见 `TEST-RESULTS.md`） |
| 单 run 内 drift | 16 份报告全部 `null` |

`hashTree` 按**相对树根**的路径取摘要，因此同一 commit 在任何目录下都得到同一个值。完整指纹、两批的 run-id 以及本文件定稿后的确认批次都记在指纹范围之外的 `TEST-RESULTS.md`：**本文件位于被指纹覆盖的 `acceptance/` 目录内**，改动它就会改变该目录的摘要，所以「今天的值是多少」不写在里面，而是写在 `TEST-RESULTS.md`，可随时重算核对。每个 `.artifacts/<run-id>/report.json` 与 `mock-requests.json` 都保存了运行当时的原始记录。

更早的批次（`final1`–`final7`、`fix1`/`fix2`）跑在更早的源码上（指纹函数或急停语义不同），作为历史保留，不再作为本批的通过依据。

## 两批完整套件的结论

`node acceptance/suite.mjs --mock`，各 8 个场景：

| 场景 | 批次 A：`t1` | 批次 B：`t2` | scenario | mechanism | 断言项 | mock 请求 A/B |
|---|---|---|---|---|---|---|
| smoke | `t1-20261001T134053Z-b2c439` | `t2-20261001T134339Z-8f8cd0` | PASSED | PASS | 16 | 16 / 16 |
| recursion | `t1-…-f0c110` | `t2-…-00c187` | PASSED | PASS | 19 | 104 / 104 |
| recovery | `t1-…-3bf3fb` | `t2-…-81be20` | PASSED | PASS | 17 | 34 / 34 |
| context | `t1-…-40bd4b` | `t2-…-ecca6c` | PASSED | PASS | 18 | 36 / 36 |
| browser | `t1-…-224145` | `t2-…-84dbc6` | PASSED | PASS | 11 | 21 / 21 |
| panel | `t1-…-a30dda` | `t2-…-d2ce67` | PASSED | PASS | 42 | 8 / 8 |
| scale16 | `t1-…-d69c24` | `t2-…-2e4d57` | PASSED | PASS | 20 | 113 / 156 |
| scale64 | `t1-…-360739` | `t2-…-6c5b99` | PASSED | PASS | 20 | 495 / 432 |

两次运行的语义结果一致：相同的场景状态、相同的不变量、相同数量的断言、相同的源指纹。请求计数与事件序列只要求落在约束内（并发上限、每个 Worker 的请求上限、账本守恒），不要求逐字节相同——随机 id、时间戳和并发到达顺序本就不该相同。

## 按功能列出的结果

### 1. 事务与依赖

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| create / decompose / dispatch / 优先级 / 修订（fence） | 域内可写，非法迁移与未答复 issue 被拒绝 | 通过 | `adapter/test/cluster.test.js`（revision fence、redispatch 拒绝、`adjust_transaction` 契约保持）、`actions-correctness.test.js` |
| 依赖排序 | 依赖未 ACCEPTED 时，被依赖事务不得进入 Worker 前沿 | 通过 | 本轮修复 + `cluster.test.js::a dependent transaction is not offered to a Worker before its dependency is accepted`（含依赖 FAILED 的情形）；原生 recursion 的 `verify/result.txt` = `verifier-ran 2` |
| validate / accept / reject / aggregate | 仅 SUBMITTED 可验证；仅 VALIDATING + 已批准审计可接受；父事务不得抢先收尾 | 通过 | `cluster.test.js`（audit gate、aggregate 顺序）、`actions-correctness.test.js::reject_result records a durable issue…` |
| 收尾 | 根事务全部 ACCEPTED + 必需通信完成后才允许 finish | 通过 | `cluster.test.js::root Orchestrator closes only after accepted work and its final communication`；recovery 场景的 `blackboard-published` |

### 2. 分配、拓扑与预算

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| allocate / spawn / release / scale_out / scale_in | 只填空闲槽；同事务幂等；超上限整体回滚 | 通过 | `actions-correctness.test.js::scale_out and scale_in move the worker ladder inside the node child ceiling`；scale16/64 的 `one-distinct-worker-per-file` |
| reparent | 只读预检、拒绝无副作用、资金与拓扑同事务迁移、路径/深度/归属一致 | 通过 | `cluster.test.js::reparent runs only at a safe point…`、`actions-correctness.test.js::reparent preserves local transaction ownership for reassignment`、`::an underfunded new parent rolls back…` |
| 归属（owner） | management 自有、Worker 属直接管理父节点、事务属其宿主节点；公开 query 读到同一事实 | 通过 | `cluster.test.js::node ownership is derived from the tree and reported by the public query`、`::an existing database normalises node and transaction ownership on open, idempotently` |
| allocate_budget / rebalance_budget | 只迁移可用资金；域外目标 403；守恒 | 通过 | `actions-correctness.test.js::allocate_budget moves capacity…`、`cluster.test.js`（transfer/settle/reclaim）；scale 两档在真实调度中触发 rebalance 后仍全部 ACCEPTED |
| 预算分维 | tokens / requests / tool_calls 各自独立；Worker 请求上限（scale 为 2）在 API 前拒绝越限 | 通过 | `acceptance/native/mock-runtime.test.mjs::F-budget`（mock 只见到 2 次请求）；scale 场景的 `worker-request-allowance` |
| Worker 授予 | 授予不得超过该次运行声明的每 Worker 请求上限（上限本身仍按请求数强制） | 通过 | `cluster.test.js::a Worker grant never exceeds the run-wide per-Worker request allowance`；scale 两档无一个 Worker 以零请求额度出生 |
| 请求记账 | 已派发请求必须进入终态并写明结果；**未知成本不得按 0 结算** | 通过 | `cluster.test.js::a failed provider request keeps its token hold as UNKNOWN instead of settling at zero`、`::a failed provider request that did report usage settles with the numbers it reported`；`acceptance/native/mock-runtime.test.mjs::F-transport` 断言 Worker 收据为 UNKNOWN、`total_tokens` 为 null、被扣作用域仍持有该预留 |
| 分配提示 | 提示里的分配数量必须落在子槽与可用预算之内 | 通过 | `cluster.test.js::a full node is not offered an allocation it cannot perform`；scale 的 `per-file-results-exact` 16/16 与 64/64 |
| 并发上限 | `max_llm_concurrency` 被真正占满且不被越过 | 通过 | scale 场景 `provider-ceiling-actually-reached`：持住 2 个在途请求 3000ms，期间第三请求为 0；两批均为真 |

### 3. 独立审计与纠正

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| plan / validation 审阅 | 按 revision 判定，过期即 STALE；plan 审阅不阻塞派发 | 通过 | `cluster.test.js::the Orchestrator dispatches, the Auditor supervises…` |
| 纠正闭环 | issue 指向故障事务/revision；真修复后核销，不能靠改计划冒名 | 通过 | 原生 recursion：真实越界写被守卫拒绝（`injected-fault-was-refused`），issue 经修订+重新授权+真写后 `CORRECTED`（2/2），`deep/nested/result.txt` 内容为 `3` |
| 纠正上限与升级 | 超过 `max_corrections` 升级为 BLOCKED，不静默通过 | 通过 | `cluster.test.js::auditor rejections create issues, and the correction budget escalates to BLOCKED` |
| 监督动作 | notify / recommend 持久且不暗改计划；verify_correction 需要在 issue 之后有真实推进 | 通过 | `cluster.test.js`（observation/recommendation、DISMISSED 需要证据） |

### 4. 通信与黑板

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| send / multicast / group / publish / query / subscribe | 成员与域隔离、目标先全量校验、revision fence、订阅有生命周期 | 通过 | `cluster.test.js`（multicast 预校验、跨子树、组、publish fence、subscribe 同一切面） |
| 投递恰好一次 | 接收方原生 Session 中该消息恰好一次；ACK 以 session 落地为条件 | 通过 | recovery 场景 `message-appears-exactly-once-in-the-recipient-session`（读原生 Session 日志，两批均 `FOUND` ×1）；`cluster.test.js`（flush 前不 ACK、重试不重复注入） |

### 5. 生命周期、恢复与故障边界

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| pause / resume / cancel | 暂停不派发、恢复可调度、取消 fence 子树 | 通过 | `cluster.test.js::pause stops dispatching…`、panel 场景 `pause-from-panel` / `resume-from-panel` / `cancel-from-panel` / `control-operations-recorded` |
| 受控重启 | SIGKILL 后从持久状态恢复；旧 epoch 租约被 fence；已提交产物不重做；UNKNOWN 收据与崩溃当时的在途集合一一对应 | 通过 | recovery 场景：`host-was-restarted`（SIGKILL）、`stale-leases-fenced`、`usage-unknown-bounded`（1 UNKNOWN ↔ 1 在途）、`no-recomputed-acceptance` |
| checkpoint / restore | 原生偏移不等的 checkpoint 被拒绝；身份被 fence | 通过 | `cluster.test.js::restore refuses a checkpoint the session is not at…` |
| resolve_effect | 不确定效果阻塞 owner，人工判定后释放 | 通过 | `cluster.test.js::an uncertain effect blocks its owner and a human decision releases it` |
| HTTP 层无法注入的窗口 | flush=false、不可读 Session、持久化两事务窗口、晚到 epoch、context 硬门 | 通过（精确注入层） | `cluster.test.js` 对应用例；原生报告显式记 `crash-window-exercised = null`，不冒充命中 |

### 6. Context

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| 每身份额度与 set_context_budget | 下一轮真实生效 | 通过 | `cluster.test.js::a per-identity context budget is honoured by the next turn` |
| pre-step 压缩与硬门 | 真实压缩发生、压缩后仍正确提交、不得把超 cap 输入放行 | 通过 | context 场景 `real-compaction-observed`（8 次原生压缩）、`native-compaction-between-requests`、`request-pressure-below-role-budget` |
| 压缩独立计费 | 不占 Worker 的两次额度 | 通过 | context 场景 `summary-charged-separately`、`per-identity-budget-applied` |

### 7. 工具、产物与原生隔离

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| capability → 工具映射 | 未映射/禁用能力被拒绝 | 通过 | `core.test.js::worker capabilities map to host tools…` |
| Worker 越权隔离（真实 DSH） | 管理工具不可达；越界写被拒绝且无落盘 | 通过 | `acceptance/native/mock-runtime.test.mjs::F-permission`（原生工具结果即为证据） |
| submit 后结束 turn；结果只由真实调用产生 | 未提交的 turn 不产生伪造结果 | 通过 | `cluster.test.js::a worker submits on its second request, and the turn ends completed`；smoke 场景 `sums-verified`（逐事务比对提交值与本 Worker 自己 session 里的 `flow_sum` 结果） |
| 参数分片与两种拼写 | 分片参数正确组装；params 对象与 JSON 字符串都能落库；非法参数明确报错 | 通过 | `acceptance/native/mock-runtime.test.mjs::F-arguments`（含非法 transaction_id 的拒绝） |
| 传输故障 | 500 / 提前断流不产生成功、不产生重复效果；**失败请求的收据为 UNKNOWN、总额为 null、token 预留仍被持有**；真正报告了用量的失败仍按报告值结算 | 通过 | `acceptance/native/mock-runtime.test.mjs::F-transport`（逐个 Worker 收据 + 预留守恒 + 管理侧真实用量仍 SETTLED） |

### 8. 规模（真实调度，不是排队身份）

| 档 | 预期 | 结果 | 证据 |
|---|---|---|---|
| 16 | planned = executed = terminal = ACCEPTED = 16 | 通过 | `scale_validation: VERIFIED`、`every-transaction-terminal 16/16` |
| 64 | 同上 = 64 | 通过 | `every-transaction-terminal 64/64`、`real-llm-workers 64/64` |
| 产物精确 | 每个文件一个独立 Worker，符号与行号与文件真实内容完全一致 | 通过 | `per-file-results-exact` 16/16 与 64/64；`one-distinct-worker-per-file`（每个 Worker 都有真实 read） |
| 语料 | 生成语料的哈希与内容一致 | 通过 | `corpus-materialized`（0 missing / 0 mismatch） |

### 9. 页面与 operator

| 功能 | 预期 | 结果 | 证据 |
|---|---|---|---|
| 面板 | 真实 Chromium 驱动真实页面；暂停/恢复/取消、报告下载、分页、游标续读、关页不取消 | 通过 | panel 场景 42 项检查全部通过（`cancel-from-panel`、`cursor-continues-after-close`、`report-download-matches-cluster`、`large-tree-lazy-child-pagination` 等） |
| 鉴权与内部 op | 未鉴权 401；`settle/tick/single/recover/dispose` 对页面不可达 | 通过 | panel 场景 `unauthenticated-flow-route-refused`、`internal-ops-refused`、`internal-ops-refused-with-unknown-op` |
| browser 能力 | 真实 Playwright MCP 导航、解析快照 ref、点击、点击后快照；结果与快照一致 | 通过 | browser 场景 `browser-navigate-called`、`cluster-panel-visible`、`result-names-the-page`、`browser-effects-settled` |

## 明确未覆盖 / 不适用（记为 not_exercised 或 null，不记为 PASS）

| 项 | 性质 | 由谁覆盖 |
|---|---|---|
| 只读场景的写作用域强制 | 不适用：smoke / context / recovery / scale 没有写样本 | recursion（真实越界写被拒 + 纠正）与 native `F-permission` |
| flush→ACK 的内部两事务窗口 | HTTP 层无法命中 | `cluster.test.js` 的精确持久化注入用例；原生报告记 `crash-window-exercised = null` |
| `symbols-exist-in-the-files` | 被 `per-file-results-exact` 取代（mock 档按精确匹配判定） | 同一 run 的精确检查 |
| 真实模型的判断质量与真实成本 | 模型输出被 fixture 固定；usage 是测试输入 | 不属于本批插件功能判定 |
| 面板合成大树的业务成功 | 合成 fixture | 只证明渲染与分页 |

## 设计已声明但当前**未实现**的动作

`merge_transaction`、`set_requirements`、`request_review`、`route_capability`，以及 Auditor 的 `inspect_decomposition`、`inspect_dependency`、`inspect_priority`、`inspect_requirements`、`inspect_dispatch`、`inspect_progress_handling`、`detect_omission`、`detect_conflict`、`detect_oscillation`、`detect_goal_drift`。

这些动作不在当前 `adapter/src/protocol.js` 的动作表内，也没有实现；未用近似动作、别名或 mock 返回成功冒名顶替。因此本批结论是「当前已声明功能完备」，不是「设计 V1.0 全量完成」。

## 本轮修复的实现缺口

| 缺口 | 现象 | 修复 | 回归 |
|---|---|---|---|
| 事务归属随 reparent 被整体改写到新父节点 | 同一节点在移动前后创建的事务 owner 不一致，合法的同域 `reassign_agent` 被 409 拒绝 | `store.insertNode` / `updateNode` 派生 owner；`reparent` 保持事务 owner = 宿主节点；打开库时一次性归一历史行 | `actions-correctness.test.js::reparent preserves local transaction ownership for reassignment`（先红后绿） |
| `set_dependency` 只是建议 | 被依赖事务在依赖未 ACCEPTED 时仍被派给 Worker，只能读到尚不存在的产物 | `readyForWorker` 排除依赖未结算的事务 | `cluster.test.js::a dependent transaction is not offered to a Worker before its dependency is accepted` |
| 传输失败被按 0 结算 | harness 在错误 finish 之前先发一个**置零**的 usage 块；插件一见 usage 就结算，于是把一次已派发、成本未知的请求当作零成本释放了 token 预留 | 记账推迟到 `finish`：错误/中止且没有真实用量时按 UNKNOWN 结算并保留预留；真实报告的失败仍按报告值结算 | `cluster.test.js::a failed provider request keeps its token hold as UNKNOWN instead of settling at zero`（先红后绿）、`::a failed provider request that did report usage settles with the numbers it reported` |
| 分配提示不可执行 | 节点子槽已满时仍被提示 `allocate_agent`，三个无进展回合后整节点因停滞被 BLOCKED | 提示按子槽上限给出，并公布 `unallocated_total`（还欠多少） | `cluster.test.js::a full node is not offered an allocation it cannot perform`（先红后绿） |
| Worker 授予超出其上限 | 每个 Worker 被授予 8 个请求额度，而该次运行只允许 2 个；64 档时节点额度被提前分光，最后 50 个 Worker 以 **0 请求**出生、根本发不出第一个请求 | 授予按声明的每 Worker 上限封顶（上限本身仍按请求数强制，另留一次会被释放的工作预留） | `cluster.test.js::a Worker grant never exceeds the run-wide per-Worker request allowance`（先红后绿） |
| 验收驱动残留 | `restartMidFlight` 传入未定义的 `qwen` | 删除该实参与未使用的形参，并由 N3 的真实 kill/restart 证明 | recovery 场景两批运行 |

## 本轮修复过程中被测试暴露、并按契约改正的判据

| 判据 | 原写法的问题 | 现在的判据 |
|---|---|---|
| scale 的 `usage-accounted` | 要求 `unknown_requests === 0`，等于强迫把「已派发但结果未知」的请求记成零成本 | 每个收据都离开 RESERVED 且 UNKNOWN 必须带原因（与 smoke 的 `usage-settled` 同一契约） |