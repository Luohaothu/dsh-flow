# dsh-flow 确定性验收结果（mock-api）

本文件回答：**当前插件应具备的功能，逐项的实际结果是什么，证据在哪里，哪些项没被验证。**

判定只采信 `.artifacts/<run-id>/` 里的报告与持久证据。设计已声明但当前未实现的动作列在最后，不计入通过。

- 契约矩阵：`acceptance/COVERAGE.md`
- 回归套件：`npm test`（293/293）、`npm run test:mock`
- 本批全部报告：`validation_mode: "mock-api"`，`build_drift: null`

## 冻结的构建与源码指纹

两批验收运行跑在同一份源码上，两次的 `acceptance_source` 指纹相同：

| 项 | 值 |
|---|---|
| `plugin_source` | `sha256:3b6da44b3f162451af45705c01039d88010cb933116e154d322e6432bf5dcd91`（9 个源文件） |
| `lib_index` | `sha256:9a88b2585380be43394c02700c09a09a30c538dc88c2894cc82136195abd3afd` |
| `acceptance_source` | `sha256:293a51a04309e25d5d56420b4e7136d51e78c3aa38d7e82b4d11deeb05943749`（40 个文件） |
| 单 run 内 drift | 两批 16 份报告全部 `null` |

`acceptance_source` 是两批运行时 `acceptance/` 目录的实际内容。本文件（`RESULTS.md`）在两批之后加入，属于文档，不被任何用例执行，因此今天重新计算目录摘要会得到一个不同的值（多一个文件）。把本文件排除后重新计算仍得到上面的值；每个 `.artifacts/<run-id>/report.json` 与 `mock-requests.json` 都各自保留了运行当时的原始记录。`TEST-RESULTS.md` 记录了在这份文档定稿之后、于当前树上再跑一次的确认批次及其目录摘要。

## 两批完整套件的结论

`node acceptance/suite.mjs --mock`，各 8 个场景：

| 场景 | final1（run-id） | final2（run-id） | scenario | mechanism | 断言项 | mock 请求 |
|---|---|---|---|---|---|---|
| smoke | `final1-20261001T112853Z-8264c7` | `final2-20261001T113146Z-85c892` | PASSED | PASS | 16 | 16 |
| recursion | `final1-…-72c145` | `final2-…-b5328c` | PASSED | PASS | 19 | 106 |
| recovery | `final1-…-71715d` | `final2-…-2b30bc` | PASSED | PASS | 17 | 34 |
| context | `final1-…-6bcaba` | `final2-…-554f24` | PASSED | PASS | 18 | 36 |
| browser | `final1-…-602a1c` | `final2-…-611d0d` | PASSED | PASS | 11 | 21 |
| panel | `final1-…-986873` | `final2-…-237785` | PASSED | PASS | 42 | 8 |
| scale16 | `final1-…-d96d24` | `final2-…-d8f146` | PASSED | PASS | 20 | 166 / 127 |
| scale64 | `final1-…-b060d6` | `final2-…-43aa60` | PASSED | PASS | 20 | 454 / 458 |

两次运行的语义结果一致：相同的场景状态、相同的不变量、相同数量的断言。请求计数与事件序列只要求落在约束内（并发上限、两次 Worker 请求、账本守恒），不要求逐字节相同——随机 id、时间戳和并发到达顺序本就不该相同。

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
| 传输故障 | 500 / 提前断流不产生成功、不产生重复效果；已派发即记账 | 通过 | `acceptance/native/mock-runtime.test.mjs::F-transport` |

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
| 验收驱动残留 | `restartMidFlight` 传入未定义的 `qwen` | 删除该实参与未使用的形参，并由 N3 的真实 kill/restart 证明 | recovery 场景两批运行 |