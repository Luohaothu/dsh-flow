# dsh-flow 当前契约覆盖矩阵

本文件回答一个问题：**当前插件声明的每一项能力，由哪一个具名测试证明，证据在什么边界上成立。**

它不是覆盖率统计。每一项都指向能失败的行为测试：前置状态、输入、允许的迁移、拒绝分支、副作用和证据位置。设计文档中尚未实现的动作单列在最后，不参与当前功能的通过判定。

证据分层，层与层之间不互相冒充：

| 层 | 载体 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 单元 | `adapter/test/core.test.js` | 纯协议：状态机、权限表、能力映射、预算算术 | 任何真实宿主行为 |
| 公共 command / runtime | `adapter/test/cluster.test.js`、`actions-correctness.test.js`、`context-trigger.test.js` | `ClusterRuntime.command/query` 在真实 SQLite 上的行为、拒绝分支、回滚、幂等 | 真实 DSH Session、真实工具守卫、页面 |
| 原生宿主 + 确定性 mock | `acceptance/native/*.test.mjs`、`acceptance/run.mjs --mock` | 真实 DSH agent loop、真实工具执行、真实 Session、真实 `tools.restrict/guard`、崩溃恢复 | 真实模型的判断质量、真实 token 成本 |
| 页面 | `acceptance/checks/panel.mjs`、`browser.mjs` | 真实 Chromium、真实 DOM、鉴权与分页 | 合成面板树的业务成功（只证明渲染） |
| 精确故障注入 | `adapter/test/fake-host.mjs` + `cluster.test.js` | HTTP 层无法注入的内部窗口：flush=false、不可读 Session、持久化两事务窗口、晚到 epoch、context 硬门 | 真实宿主进程（由原生层负责） |

---

## 1. 角色动作（`adapter/src/protocol.js`）

每一行都是「声明 → 具名行为测试 → 该测试断言的核心事实」。

### 1.1 Orchestrator

| 动作 | 证明测试 | 断言的核心事实 |
|---|---|---|
| `create_transaction` | cluster.test.js::a management node hosts worker and management children at once, and rejects a cycle；::start builds one root management node… | 事务落在 actor 的域内；DRAFT 初始状态；预算子作用域随之建立 |
| `decompose` | cluster.test.js::a delegated parent is not stale while its child is still advancing；::detectCycle 相关用例 | 父事务未终态才可分解；子事务带 parent 与依赖；环被拒绝 |
| `set_dependency` | cluster.test.js::a dependent transaction is not offered to a Worker before its dependency is accepted；::a management node hosts worker and management children at once… | 依赖写入、环检测、revision fence；**依赖未 ACCEPTED 时该事务不进入 Worker 前沿**（含依赖失败的情况） |
| `set_priority` | cluster.test.js::commands are idempotent per command_id…；::a transaction modification reaches the… | 优先级写入并推进 revision；非法值被拒绝 |
| `dispatch` | cluster.test.js::the Orchestrator dispatches, the Auditor supervises… | DRAFT→READY、plan audit 请求、非法重派（未答复 issue）被拒绝 |
| `adjust_transaction` | cluster.test.js::an open correction requires a new plan revision before redispatch；::an Auditor rejection during a Worker turn keeps its settled write… | 委托契约的 expected_output/criteria/levels 不可被替换；revision 必须前进；live turn 禁止修改 |
| `validate` | cluster.test.js::the Orchestrator dispatches, the Auditor supervises…；actions-correctness.test.js::scoped pause/resume… | 仅 SUBMITTED 可验证；accepted 需带证据；父事务有未完成子事务时拒绝提前接受 |
| `accept_result` | cluster.test.js::auditor rejections create issues…；::the Orchestrator dispatches… | 仅 VALIDATING + 已批准审计可接受；重复接受不产生第二次扣账 |
| `reject_result` | actions-correctness.test.js::reject_result records a durable issue and refuses anything not awaiting a verdict | 非待判状态被拒绝；REJECTED + 持久 issue（reporter、required_change） |
| `aggregate` | cluster.test.js::a role reads aggregated child evidence by child id…；::a completed delegated node returns its unspent role and node grants… | 仅 READY 父事务可聚合；未 ACCEPTED 子事务拒绝 |
| `escalate` | cluster.test.js::a parent cannot escalate unfinished delegated work before its child can correct；::auditor rejections create issues, and the correction budget escalates to BLOCKED | 节点/簇进入 BLOCKED 并记录编码原因 |
| `finish_cluster` | cluster.test.js::root Orchestrator closes only after accepted work and its final communication；::completion and progress observe the whole cluster, not a page of it | 未接受的工作阻止收尾；必需通信缺失阻止收尾 |
| `pause_transaction` / `resume_transaction` | actions-correctness.test.js::scoped pause/resume restores DRAFT, READY, SUBMITTED and VALIDATING…；cluster.test.js::transaction-scoped lifecycle control stays inside one subtree | 域内可暂停/恢复；恢复保留 staged result 与审计身份；跨子树被拒绝 |
| `cancel_transaction` | cluster.test.js::transaction-scoped lifecycle control…；::lease epochs fence a stale actor and cancel terminates the subtree | 取消终态、旧 epoch 回执不能生效 |

### 1.2 Allocator

| 动作 | 证明测试 | 断言的核心事实 |
|---|---|---|
| `allocate_agent` | cluster.test.js::a released worker frees its child slot…；::a transaction without an explicit capability set still yields working workers | 创建 Worker 身份与写作用域；能力继承；子槽上限 |
| `spawn_agent` | cluster.test.js::an authorized Allocator spawns a Worker through spawn_agent；::role permissions reject cross-role actions and domain escapes | 授权角色（Allocator）真的产出 Worker 节点并绑定 transaction；无 `transaction_id` 报错；越权（Orchestrator）拒绝 |
| `spawn_management_node` | cluster.test.js::a delegation fixture builds a decreasing management chain；::a management node hosts worker and management children… | 委派链递减；深度/子数上限；委派事务原子建立 |
| `release_agent` | cluster.test.js::budget transfers move only unused unreserved capacity and releasing reclaims it；::a released worker frees its child slot | 释放回收未用额度；槽位可复用；不存在双重释放 |
| `allocate_budget` | actions-correctness.test.js::allocate_budget moves capacity from the node scope to an identity, and refuses a foreign target | 精确转移；域外目标 403；源与目标总额守恒 |
| `rebalance_budget` | cluster.test.js::budget transfers move only unused unreserved capacity…；::the rebalance hint is executable by…；::a measured child request can draw missing tokens down its ancestor path | 只移动未预留未花费的额度；提示可执行 |
| `set_concurrency` | cluster.test.js::a role cannot raise the limits the run declared；::lowering the model-request cap stops new work instead of handing a busy slot on | 只能降低；已占用槽位不被转交 |
| `scale_out` | actions-correctness.test.js::scale_out and scale_in move the worker ladder inside the node child ceiling | 填满空闲槽；同事务幂等去重；超出上限整体回滚且不留半波 |
| `scale_in` | 同上 | 只释放已终态工作的分配；未完成工作的分配存活 |
| `select_model` | cluster.test.js::allocation operations: model selection, evaluation, replace, reassign, checkpoint and restore | 路由必须已注册；写入分配而非全局 |
| `evaluate_allocation` | cluster.test.js::Allocator evaluation keeps every active allocation reachable after a bounded local capacity page | 容量视图不因分页丢失活跃分配 |
| `replace_agent` | cluster.test.js::allocation operations…；::an Allocator cannot replace or reassign a Worker holding a live lease | 替换需要 turn 已排空；继承同一分配 |
| `reassign_agent` | actions-correctness.test.js::reassignment rejects disjoint contracts and narrows a valid target grant with a revision fence；::reparent preserves local transaction ownership for reassignment | 同域 + 同 owner 才可改派；写作用域只收窄；revision fence |
| `reparent` | cluster.test.js::reparent runs only at a safe point and rejects unsafe requests；::an unsafe reparent is refused without touching the turn or the ledger；actions-correctness.test.js::reparent reissues all five unused grants…；::an underfunded new parent rolls back… | 只读预检、拒绝不留副作用；资金与拓扑同事务迁移；路径/深度/归属重写；最早截止时间不后移 |
| `checkpoint` | cluster.test.js::allocation operations… | checkpoint 记录原生偏移、watermark、turn_seq |
| `restore` | cluster.test.js::restore refuses a checkpoint the session is not at, and fences the instance | 偏移不等返回 409；身份被 fence（租约删除 + epoch 前进） |
| `resolve_effect` | cluster.test.js::an uncertain effect blocks its owner and a human decision releases it | 不确定效果阻塞 owner；人工判定后释放并记事件 |
| `set_context_budget` | cluster.test.js::a per-identity context budget is honoured by the next turn | 每身份额度在下一轮真实生效 |

### 1.3 Auditor

| 动作 | 证明测试 | 断言的核心事实 |
|---|---|---|
| `inspect_plan` | cluster.test.js::the Orchestrator dispatches, the Auditor supervises… | plan 审阅不阻塞派发，但决定可被记录；过期 target_revision → STALE |
| `inspect_validation` | cluster.test.js::the Orchestrator dispatches…；::auditor rejections create issues… | 仅 PENDING 审计可判；revision 不符 → STALE；拒绝打开 issue 并计一次纠正轮 |
| `request_correction` | cluster.test.js::a later-revision issue consumes the earlier incomplete Worker event…；::a rejected result gives its Orchestrator the actual scope… | 不完整结果留证据；issue 绑定故障 revision |
| `request_replan` | cluster.test.js::an open correction requires a new plan revision before redispatch；::Auditor reopens accepted work as REJECTED…（actions-correctness） | 已接受工作被重开为 REJECTED 并失效过期结果；纠正轮上限 409 |
| `request_revalidation` | cluster.test.js::a revalidation answers its issue: no plan edit is needed to close the round | 无需改计划即可闭合一轮 |
| `verify_correction` | cluster.test.js::an Auditor cannot dismiss a recorded blocked Worker result as an imaginary defect；::auditor rejections create issues… | 未推进的核销被拒绝；DISMISSED 需要证据且不能抹掉已记录的拒绝写入 |
| `escalate` | cluster.test.js::a parent cannot escalate unfinished delegated work before its child can correct | 未完成工作不可越过子域；升级进入编码化终态 |
| `notify` / `recommend` | cluster.test.js::Auditor observations and recommendations are durable and routed without creating a blocking correction | 通知/建议持久且不改动计划 |
| `evaluate_health` | actions-correctness.test.js::health evaluation validates weights and window…；cluster.test.js::a root closes after its final Orchestrator turn and scored Auditor closeout… | 权重/窗口校验；八维评分；收尾由所属 Auditor 记录才生效 |

### 1.4 Worker

| 动作 | 证明测试 | 断言的核心事实 |
|---|---|---|
| `submit_result` | cluster.test.js::a worker submits on its second request, and the turn ends completed；::a blocked Worker submission durably records the unsatisfied result for independent review；::a worker proposal is published only when its turn completed | 仅自身分配的事务可提交；只在 turn 完成时发布；不完整结果留证据 |
| Worker 权限边界 | core.test.js::worker capabilities map to host tools and reject unknown or forbidden capabilities；cluster.test.js::role permissions reject cross-role actions and domain escapes | 能力→工具映射；越权动作 403 |
| 原生越权隔离 | acceptance/native/mock-runtime.test.mjs::F-permission: a Worker cannot reach management tools or write outside its scope | 真实 DSH 守卫拒绝管理工具与越界写；无落盘、无分配副作用 |

---

## 2. 查询入口（`ClusterRuntime.query`）

全部查询都由公共 command 驱动，返回 `items/total/offset/limit/next_offset` 的同一信封。

| query | 证明测试 | 断言 |
|---|---|---|
| `cluster` | cluster.test.js::root Orchestrator closes only after accepted work… | 状态与计数 |
| `nodes` / `node` | cluster.test.js::node ownership is derived from the tree and reported by the public query；::a deep role sees its real management ancestors… | 域内可见、祖先可见、owner 派生、域外 403 |
| `transactions` / `transaction` | cluster.test.js::scoped transaction, audit, issue and usage pages do not lose a child…；::transaction pages honor parent_id before counting and paging the role domain；::transaction detail keeps current result evidence… | 分页总数真实、父过滤先于计数、按 id 的完整证据 |
| `agents` | cluster.test.js::a high-fanout agent list pages role identities without hiding host-visible agents | 分页不隐藏 |
| `allocations` | cluster.test.js::Allocator evaluation keeps every active allocation reachable… | 有界容量页仍可达全部活跃分配 |
| `budgets` | cluster.test.js::a role pages budget ledgers without forcing the whole tree into one model tool result | 预算页有界且完整 |
| `issues` / `issue` / `audits` / `audit` | cluster.test.js::unresolved Auditor issues stay on the first bounded model page…；::issue and effect list pages reference complete per-id evidence… | 未决 issue 优先；按 id 取完整证据 |
| `effects` / `effect` | cluster.test.js::an Auditor can attribute a Worker write to its owning management node；::issue and effect list pages… | Worker 效果的 owner 归属正确 |
| `usage` | cluster.test.js::scoped transaction, audit, issue and usage pages… | 收据分域且可分页 |
| `deliveries` | cluster.test.js::communication crosses subtrees without touching the management tree；::receipt is proven by an incoming delivery marker… | 投递状态可读 |
| `context` | cluster.test.js::a per-identity context budget is honoured by the next turn；::compaction in a turn really lowers the next request it charges | 上下文压力可读 |
| `health` | actions-correctness.test.js::health evaluation validates weights and window… | 评分与窗口 |
| `summary` | cluster.test.js::a child role cannot select another domain through context or summary references | 摘要不泄露域外数据 |
| `blackboard` | cluster.test.js::groups accept cross-subtree members and blackboard publishes are revision fenced | 发布受 revision fence |

## 3. 通信（`flow_communicate`）

| 动作 | 证明测试 | 断言 |
|---|---|---|
| `send` / `multicast` | cluster.test.js::communication validates every multicast target before delivering anything；::communication crosses subtrees without touching the management tree | 全部目标先校验；一个坏目标不产生部分投递 |
| `group` | cluster.test.js::groups accept cross-subtree members and blackboard publishes are revision fenced | 跨子树成员、组生命周期 |
| `publish` | 同上 | revision fence、冲突拒绝 |
| `query` / `subscribe` | cluster.test.js::a communication query returns the prefix view with the cursor of its read cut；core.test.js::subscribe returns a snapshot and cursor from one read cut | 前缀/按 key 查询只返回该视图且带读切游标；订阅快照与游标同一次读取 |
| 投递可靠性 | cluster.test.js::resending a message id repairs deliveries without duplicating the message；::a retry after a mid-turn flush does not inject the message twice；::a delivery is only acked once the session is flushed；::receipt is proven by an incoming delivery marker | 去重、flush 后 ACK、标记即凭据 |
| 原生投递证据 | acceptance: recovery 场景 `message-appears-exactly-once-in-the-recipient-session`（读原生 Session 日志） | 接收方 Session 里该消息恰好一次 |

## 4. 生命周期与控制

| 入口 | 证明测试 | 断言 |
|---|---|---|
| `control(id, pause/resume/cancel)` | cluster.test.js::pause stops dispatching and resume returns the cluster to a schedulable state；::lease epochs fence a stale actor and cancel terminates the subtree | 暂停不派发；恢复可调度；取消 fence 子树 |
| 恢复 | cluster.test.js::recovery fences stale leases, marks in-flight effects uncertain and requeues；::a restart fences a Worker without reviving its already rejected plan；::an identity with history but no durable session is blocked, never re-created | 重启后旧租约被 fence、在途效果标 UNKNOWN、可重排 |
| 精确持久化窗口 | cluster.test.js::a rejected flush neither acks a delivery nor dispatches a tool；::an unreadable session is UNKNOWN…；::a message is never lost across the crash window… | HTTP 层无法注入的内部窗口 |
| 原生崩溃恢复 | acceptance: recovery 场景 `host-was-restarted`、`stale-leases-fenced`、`usage-unknown-bounded`、`no-recomputed-acceptance` | 真实 SIGKILL 在持住的模型请求上发生；UNKNOWN 收据由崩溃当时的在途集合精确决定 |
| Web 路线 `/api/flow` | panel 场景 `unauthenticated-flow-route-refused`、`internal-ops-refused`、`internal-ops-refused-with-unknown-op` | 未鉴权 401；`settle/tick/single/recover/dispose` 对页面不可达 |
| 面板控制 | panel 场景 `pause-from-panel`、`resume-from-panel`、`cancel-from-panel`、`control-operations-recorded`、`page-close-does-not-cancel-cluster`、`reconnect-after-close` | 真实 DOM 操作驱动真实状态迁移；关页不取消 |

## 5. 验收场景（`acceptance/run.mjs --mock`）

| 场景 | 通过判据（摘） | 原生/页面证据 |
|---|---|---|
| N0 单 Worker | `acceptance/native/mock-runtime.test.mjs::N0` | 原生 Session 中 callId 匹配的 call→result→后置回答；事务 SUBMITTED 且结果为工具返回值 |
| N1 smoke | 2/2 ACCEPTED；`sums-verified`（逐事务比对工具返回值与提交值）；`worker-sessions-distinct`（真实 session_id） | 每个 Worker 自己 session 里的 `flow_sum` call/result |
| N2 recursion | 管理树 depth 3、depth-1 的 Worker 分支、真实越界写被拒、Auditor 开 issue→修订→重新授权→真写→核销；deep 文件内容 `3`；`correction-verified-by-the-auditor`（核销必须来自 Auditor 具名的成功 `verify_correction`，仅由验收顺带关闭不算）、`correction-answered-by-later-work`（核销之前必须存在**已发布的、完成态的、更高 revision 的替代提交**）、`correction-written-by-a-replacement-worker`（写下交付物的身份不是被拒的那一个） | 最深子树 worker 的 SETTLED write 效果、write-refused 事件、issue CORRECTED、fixture 自记的逐事务提交序列（`mock_fixture.fixture_evidence`） |
| N3 recovery | 护栏触发的受控重启；4/4 ACCEPTED；租约 fence；UNKNOWN 收据与在途集合一一对应；黑板键已发布 | SIGKILL 快照、原生 Session 投递标记计数 |
| N4 context | 真实压缩发生、计费独立、压缩后仍正确提交、身份 cap 不被越过 | 每身份预算与原生上下文步骤事件 |
| N5 browser | 真实 Playwright MCP 导航/解析 ref 点击/点击后快照；结果与快照标题一致 | 持久 effect 收据 |
| N6 panel | 42 项 DOM/分页/鉴权检查；暂停/恢复/取消由真实页面驱动，取消前持住 closeout 请求 | Chromium DOM 与截图 |
| N7 scale16 / N8 scale64 | planned=terminal=ACCEPTED=N；逐文件符号与行号精确匹配；**结果必须回答本事务被授予的那个文件**（`results-name-the-granted-file`，期望值取自**冻结 spec** 的 `inputs.file`——`transactions-keep-their-frozen-assignment` 另断言运行期没有把 inputs 改写成另一个文件——而不是结果自己声明的文件）;`reads-succeeded` 要求 read 收据是**成功**结果（`SETTLED` 也覆盖错误收据）；每文件一个独立 Worker，且该 Worker 的 **read 收据返回的路径**就是本事务的文件；并发上限被实际占满（两个在途请求 + 第三请求不出现）；`control-plane-calls-clean`（没有一次控制面调用因缺少/错配 audit 引用被拒） | 生成语料的哈希、冻结的 `inputs.file`、`tool_call_receipts` 里 read 的真结果、mock 自己的请求区间 |
| F 参数（原生） | `F-arguments`：分片参数可组装；两种 `params` 写法都持久化；越权/不存在的事务被具名拒绝；**参数流无法组装成对象时**由 host 以 `INVALID_ARGS` 拒绝，且错误**按 callId 归属**、无效果、无结果 | 原生 Session 的 `tool/call` 与同名 `tool/result`；`effects` 为空 |

## 6. 设计已声明但**当前未实现**的动作（不计入通过）

以下动作出现在设计文档中，但不在 `adapter/src/protocol.js` 的当前动作表内，也没有对应实现：

`merge_transaction`、`set_requirements`、`request_review`、`route_capability`，以及 Auditor 的 `inspect_decomposition`、`inspect_dependency`、`inspect_priority`、`inspect_requirements`、`inspect_dispatch`、`inspect_progress_handling`、`detect_omission`、`detect_conflict`、`detect_oscillation`、`detect_goal_drift`。

它们**没有被近似动作、别名或 mock 返回成功冒名顶替**。一个未知动作会走到 `Unknown action` 并在 `flow_*` 工具里返回 403/400，这一点由 `core.test.js::role authorization denies cross-role writes and unknown roles` 与 panel 的 `internal-ops-refused-with-unknown-op` 覆盖。

## 7. 明确未覆盖的窗口（记为 not_exercised / UNKNOWN，不记为 PASS）

| 项 | 原因 | 由谁覆盖 |
|---|---|---|
| 只读场景的写作用域强制 | N1/N4/N7/N8 没有写样本 | N2 与 F-permission |
| flush→ACK 的内部两事务窗口 | 原生 HTTP 层无法命中 | `cluster.test.js` 的精确持久化注入用例；原生报告显式记 `crash-window-exercised = null` |
| 真实模型判断质量 | 模型输出被 fixture 固定 | 不属于本批插件功能判定 |
| 合成 usage 的真实成本 | usage 是测试输入 | 只用于证明插件记账，不代表价格或吞吐 |
| 面板合成大树的业务成功 | 合成 fixture | 只证明渲染与分页；真实业务由受测 cluster 自己证明 |