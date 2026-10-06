# dsh 层次化 Agent Cluster：差距审查与下一阶段实施计划

## 2026-10-06 后续设计评估：移除插件层排他写限制

当前机制只能检查同一 cluster 内 ACTIVE allocation 的声明路径是否重叠，并对受管 Agent 的部分工具调用校验授权范围，不能证明实际文件始终只有一个写入者。宿主外部进程、部分嵌套工具与浏览器/MCP 副作用不由这套路径规则完整覆盖；路径检查也不等于持有文件系统锁。因此不能把 allocation 无重叠或测试中的越 scope 调用被拒绝，解释为文件系统单写者保证。

后续优先评估移除这些限制，并将 `write_scope` 降为任务责任声明、冲突提示和审计参考：

1. 评估取消 `assertWriteScopeFree` 对重叠 allocation 的硬拒绝，允许需要共同修改文件的事务正常分配和执行。
2. 评估取消 `bash` / `job_kill` 必须获得整个 workspace 的前置要求；同步审查 `write` / `edit` 的 per-allocation 路径拒绝，避免只放开分配而保留等价执行限制。
3. 保留宿主 sandbox 的工作区与系统访问边界，以及能力、角色权限、租约 fencing、预算、effect receipts 和精确 `result_revision` 的独立结果验收。结果审核不能被解释为写入互斥，工具回执也不能被解释为完整文件变更记录。
4. 评估通过任务依赖、实际 diff 与验收证据发现并纠正写冲突；需要强文件隔离的场景另行考虑独立工作区。对照受控同一 fixture 的完成率、冲突、等待和请求开销，判断移除限制的实际效果，不预设吞吐或质量改善。

本节记录待评估的后续方向，未改变当前运行时。若采用该调整，须同步更新下面旧计划中的“一文件一 owner”“越 scope 写入为零”等插件层验收要求，以及 README、工具说明、面板提示和相关测试；宿主工作区隔离要求继续有效。

## Context

本轮任务是对照原四阶段计划审查当前实现与已有实验，识别机制缺陷、证据缺口和模型产物失败，并制定下一阶段的改进与实现顺序。已有工作不是从零重做；继续采用单机 DSH 插件、一个 SQLite 状态库和原生面板，不增加第二套调度器或 Agent loop。原计划的本地 Qwen、隔离工作区、固定预算、真实规模与业务验收要求保持不变；只读规划期间不启动实验或修改实现。

## 本轮审查记录

### 已核实的实验基线

本表直接读取现存 `.artifacts/<run-id>/report.json`，不是重跑结果；`PASS/UNKNOWN` 是原报告的判定，不自动认定其计算正确。除 refactor 的输入仓库摘要外，16 份报告的 `source_hashes` 均为空，不能证明加载插件与当前源码同版本。

| 原计划要求 | 现存证据 | 差距 |
|---|---|---|
| V1 三角色／Worker 小闭环 | `suite-smoke` PASSED / UNKNOWN，80.338s | 有正向闭环；不是四阶段总体验收 |
| V7 原生面板 | `suite-panel` PASSED / UNKNOWN，15.320s | 当前检查覆盖基本显示、控制和下载；不是全部数据面验收 |
| V2 恢复 | `suite-recovery` PASSED / UNKNOWN，237.755s，4/4 ACCEPTED | 只证明 ACK 后重启；两个精确崩溃窗口均未验证 |
| V2 Context／browser | `suite-context` 98.931s、`suite-browser` 76.588s，原报告均 PASSED / PASS | 历史正向证据，缺插件构建溯源，不能当当前版本回归 |
| V2 深度 ≥3 且混合浅分支 | `suite-recursion` FAILED / FAIL，2.535s，start报 `UNIQUE constraint failed: transactions.id`，未取得cluster_id | 本次fixture未建立；“数据库不存在”是后续检查的泛化措辞，不能取代原始错误 |
| V3 重构／V4 网站／V5 调研 | 三份 hierarchical 报告均 FAILED / MODEL_OUTPUT | 质量失败已观察；旧 `mechanism_pass:PASS` 仍需按新证据规则复核，三种 mode 对照不齐 |
| V6 固定预算 16 档 | `suite-scale16` 0 Worker，0/16 终态，811,502 tokens，30 requests | INCOMPLETE；不能引用旧同名目录的数字 |
| V6 固定预算 256 档 | `suite-scale256` 10 Worker，10/257 终态，16,715,359 tokens，407 requests | INCOMPLETE；计划256却统计257，fixture 与额外任务混算 |
| V6 64项并发4 | `sweep64-c4` 9 Worker，8 FAILED、1 RUNNING，3,925,715 tokens，215 requests，368.724s | INCOMPLETE；Context block；驻留峰值6与provider峰值4必须分开 |
| V6 千级与公平并发阶梯 | 没有1024档报告；1/2/4/8现存报告均INCOMPLETE | 必须真实运行1024；旧成本比不能推出下一版本必然失败 |

### A. 原计划尚未完成的功能／验收

- **真实递归与管理流程**：`suite-recursion` 连start都因事务ID冲突失败，没有建立本轮depth≥3且并列depth1的组织；Auditor每turn最多8个结果摘要、模型驱动的live Allocator扩缩容／调拨／重分配／checkpoint验证，以及两个精确崩溃窗口均未完成。`suite-recovery` 仅一个management，fixture消息实际送至Auditor及其他Worker，`cross_subtree:false`，不构成跨子树恰好一次证据。已有单元测试和人工调用不等价于原计划的真实角色闭环。
- **业务与规模完整矩阵**：V3有界API重构、V4网站、V5调研各有一次hierarchical失败报告，但single／flat／hierarchical同输入同预算全矩阵未完成；16与256的固定规模任务、64档1/2/4/8的公平测量均未取得完整结果，1024根本未运行。`suite-smoke`不是这些验收的替代。质量失败与机制缺陷分别判定，不能因为模型产物失败就先改任务。
- **面板和有界数据面**：`src/ui/client.jsx:68-88,198-231` 目前只支持基本列表、统计、控制与report，缺通信、Context、事务证据详情，事件无seq追赶，节点未按父节点懒加载；`suite-panel` 基本检查通过不等于V7全通过。`cluster.js:525-608` 的模型查询仍能返回整棵预算树，Auditor最多8个摘要的批处理未落地。

### B. 已实现功能中确认的bug

- **Worker完成语义**：`sweep64-c4` 有8次 `result-staged`、17次 `result-withheld`；seq96明确“reached its 2-request allowance”，且tools_used有read与flow_transaction。`index.js` 成功submit未调用宿主已有 `exec.concludeTurn()`；宿主 `agent-loop/src/agent.ts:515-521` 因工具结果不终结turn尝试第三次请求，随后暂存结果被撤销。不是“模型没有提交”，修复不得提高Worker cap或强行把异常变成功。
- **调度／active容量**：`cluster.js:763-823` 把已登记的live turn与started重复计数，单pass留空槽；`actions.js:createWorkerForTransaction/releaseAllocation` 预留active容量，而 `grantAgentBudget` 又下拨active limit，释放未归还limit，使多批次身份耗尽容量。这两处是独立代码缺陷，不把旧scale全部停滞无条件归咎于它们。
- **状态遍历／生命周期**：`cluster.js:255-278,525-608,611-655` 用100／200／500的public页当内部完整数据，导致调度、域、report、pause/cancel/recover遗漏尾部；`recover()` 只重排没有ACTIVE allocation的RUNNING事务，后者与READY-only领取不相交。pause丢弃暂存结果、resume把未审计DRAFT提升READY；replace/reassign/reparent/restore未真正drain/fence，checkpoint的flushed_seq误记cluster事件seq而非原生Session seq。
- **资金与Context**：`runtime.js:143-201,211-231` 的Worker计数含compaction/NOT_SENT，settle按调用方chain而release读持久scope；`cluster.js:1838-1856` 压缩scope只检查tokens，且Worker的node不是合法出资management。c4 seq383观察到该node压缩请求需87,114 tokens而只剩14,572，seq384/385发生Context阻塞；这不证明所有合法scope均耗尽。固定份额／每turn对半补款让预算困在未使用grant，缺继承deadline、cluster token发送前硬门及turn内8192／16384压力处理。
- **恢复与副作用**：`ctx.sessions.flush(session)` 返回 `Promise<boolean>`，当前忽略false继续ACK／dispatch；`sessionCarries` 把native读取失败与确实缺失合并为false，可能再次注入。`admitToolCall` 只有effect类持久receipt，所有tool quota的chain仍在 `#toolBudgets` 内存；宿主`agents.resume` 会在打开Session时先为未完成工具合成关闭事件，当前没有在它之前修复已提交command的原生tool/result。`EFFECT_UNCERTAIN` 只改表状态而不阻止owner再次dispatch；`actions.restore` 虽返回提示但不实际结算该状态。这些是已有恢复路径的代码缺陷，不把 `effects:[]` 的空检查说成已验证无重放。
- **验收代码误报**：`tests/acceptance/run.mjs:224-241` 分类时wall_time_ms尚为0，`checks/scale.mjs` 把UNKNOWN转成false，Worker实际激活数混用receipt数；部分失败类固定写成LIMIT_REACHED。硬件请求峰值、驻留Agent峰值、Session请求与任务完成各为不同指标，不得互代。

### C. 实验实施中新出现、必须解决的需求／问题

- **冻结构建与来源**：16份报告除refactor输入仓库摘要外 `source_hashes` 为空；`suite-scale16` 的compaction池200,000 token与当前源码的64,000不符，旧报告不能用来证明当前代码的回归。执行前必须建立已构建 `lib/index.js`／插件源码／profile／case的hash与本地Qwen端点fingerprint，报告校验前后输入未变。
- **可控故障注入与传感器**：`suite-recovery` 仅轮询到seq29 delivery-flushed、seq30 messages-acked以后再在seq33 recovered，没打中flush→ACK窗口；第二个command commit→Session tool/result窗口也未执行。须在确切native边界挂有限时barrier，再强杀仅本次宿主，并以native Session结构化来源和call/result引用而非字符串搜索证明恰好一次；传感器失效记UNKNOWN，不宣称PASS。
- **隔离与归因**：现有 `buildHostEnv` 仅剔少数密钥、`run-id` 可碰撞、IPC response pending未delete；`docs/reports/test-results.md` 混用不同时间同名run数值与未经运行的1024推断。先使用env allowlist、排他工作目录、证据三态、真实时间戳与结构化拒绝码；report更新为后续冻结运行的派生物，不倒写旧实验“通过”。
- **路由／交互可核验**：宿主AgentOptions不支持temperature、目前未用request waterfall固定temperature0；当前插件 `expectedBaseUrl` 只计算未校验。运行前核对隔离profile路由与runner配置，在 `agent/request` 持久request/header与LLM hook核验实际provider/model，辅助compaction单独固定采样；面板仅开放用户安全op并带event seq/cursor重连，浏览器关闭不终止运行。


## 已核实的入口与保留约束

- 工作目录 `/home/leo/projects/dsh-flow`；`package.json` 已提供 `build`、`test`、`test:qwen`、`accept`，Node声明为 `^22.19.0 || >=24.0.0`。`npm test` 当前只覆盖 `tests/unit/*.test.js`，执行验收时须同时包含 `tests/acceptance/test/*.test.mjs`。
- 宿主源码 `/home/leo/projects/deepseek-harness`，`apps/cli/package.json` 版本为 `0.1.7-rc.2`；通过现有 `src/host/dsh-launch.mjs` 与 `DSH_INSTALL_PATH=/home/leo/projects/deepseek-harness/apps/cli` 启动。只修改本插件，不修改该宿主输入仓库。
- `examples/cluster.patch.yml` 固定 `http://127.0.0.1:8000/v1`、`local-sglang/Qwen3.8-27B-FP8`、contextWindow131072、maxTokens4096、request timeout120000ms、stream idle60000ms、provider retry0、`reasoningEffort:off`，并启用宿主compaction。`Bearer EMPTY` 是本地客户端占位符，不是真实密钥；不回退云模型或Ollama，不重配SGLang。
- `protocol.js` 当前Context默认值为role8192、Worker16384、trigger0.8、server_input142074。服务器实际输入上限与运行槽数须在执行前只读复核；原计划的4运行槽仅为历史服务快照，8客户端并发不得称为8路GPU并行。
- 复用 `ClusterRuntime`、`ClusterStore`、`runTurn`、原生工具守卫、租约fencing、command/effect/usage回执、认证 `/api/flow` 与IPC；不复活旧controller，不新建替代Agent loop，不因质量失败手改业务产物。
- 业务默认预算仍为tokens2,097,152／requests256／tools2,048／wall3,600,000ms／agents2,048／active8，最多两轮纠正。scale严格按N计费：tokens65,536N／requests12N／tools16N／wall21,600,000ms／agents4,096／active9；Worker最多2次非compaction实际请求、max_tokens512。不可用提高额度“修复”失败。
- 每次运行独立HOME、DSH_HOME、TMPDIR、SQLite和workspace；原始工作树、旧实验目录与Qwen服务不改动。现有 `buildHostEnv` 仅删除少数key，不满足完整凭据隔离，须先按后文修正再启动实验。

## Approach

执行顺序为：证据与隔离基线 → 调度／账本正确性 → Worker完成与Context → 确定性恢复／安全点 → 递归与原生面板 → 同版本验收矩阵。修改同一 `cluster.js/runtime.js/store.js` 的工作由一个集成者合并；验收静态检查与面板可在接口确定后独立推进，但真实Qwen实验串行运行。先通过相应小场景门槛再运行大档位，不通过时修复已确认机制缺陷，不扩大预算或调提示词掩盖问题。

### 1. 先使实验可追溯、隔离且可正确归因

1. 在 `src/host/host.mjs:createRunLayout` 校验run-id为单一安全路径段，并使用排他创建；目录已存在即明确失败，禁止覆盖、删除或自动恢复旧run。`suite.mjs` 接受 `--run-prefix`，未提供时生成时间戳加随机后缀，所有case/mode/tier使用唯一后缀。重启仅复用当前run已创建的layout，不再次创建。
2. `buildHostEnv` 改为复用 `checks/refactor.mjs:isolatedEnv` 的allowlist策略：只继承 `PATH,LANG,LC_ALL,TERM,SHELL,USER,PNPM_HOME`，额外显式放行安装路径 `DSH_INSTALL_PATH`；HOME/DSH_HOME/TMPDIR、Qwen路由和FLOW_IPC全部由runner赋值。case `env` 仅允许现有 `FLOW_CONTEXT_{ROLE,WORKER,MODEL,TRIGGER,SERVER_INPUT}`，拒绝覆盖隔离目录、模型路由或携带任意凭据。所有prepare/build/browser子进程使用同一受控环境，不用 `...process.env`。
3. 修复 `DshHost.start` 的reply清理：按 `message.requestId` 从pending删除；退出、超时和正常完成各清理一次。复用同一IPC连接承载后文故障barrier，不新增监听端口。
4. `run.mjs` 在启动前计算并保存插件源码、`lib/index.js`／`lib/client.js`、case、patch的sha256清单；输入仓库／dataset指纹独立保存，不再以 `source_hashes` 混称。结束时对照插件与case未变；变化则该run不是可比验收。Qwen smoke同样带构建指纹。敏感URL认证query只供live连接使用，公开report保存脱敏地址。
5. 提前记录实际 `run_started_at/cluster_started_at/stopped_at`，先计算墙钟和停止原因再调用 `classifyOutcome` 与case checks。总运行时间含准备，预算wall按持久cluster deadline判断，不能把复制／构建耗时误作模型预算。保存现有返回值 `budget_proximity`；预算接近、任意tool-call-refused、模型文字中的“exhausted”都不能独立改判LIMIT_REACHED。保留结构化错误code、scope、dimension、requested、available、request_id/transaction_id；机制错误优先，环境错误不被预算覆盖。
6. 将 `readStoneLedger` 内嵌脚本与scale重复口径统一到现有 `src/host/ledger.mjs`；checks保留 `passed:true|false|null`。无传感器、无执行样本、未知usage和缺失原生日志必须为null/UNKNOWN，不能把0/0结果质量、主键唯一或剩余lease数量当全过程正确性的证据。报告逐项区分“越界被拒绝”与“实际越界写入”；原始历史report不改写。
7. 固定初始事务ID、`needs`／父事务引用、message_fixture的from/to及run专属黑板key先按run-id映射进同一cluster命名空间；输入原ID仍记report便于对账。启动前验证映射后唯一性与引用存在，禁止在SQLite执行半截start时才抛`UNIQUE transactions.id`。`suite-recursion` 旧run的冲突根因缺足够持久证据，不断言它一定由run目录重用造成；新run库与排他layout仍为第一隔离边界。


### 2. 修复调度容量与内部完整遍历

1. `ClusterRuntime.#scheduleClusterLocked` 仅用实时 `#activeTurnCount(id)` 判断active上限；Worker余量只减一次active，另保留一个尚未有管理turn占用的管理slot。`started` 只在start返回 `{started:true}` 时递增，仅用于进度判断；保留当前每cluster的 `#scheduling` 门，不将持久租约与本地注册turn重复计数。
2. 两个start路径继续把取delivery、构造prompt、runTurn、finisher纳入permit/lease/active清理。用可控deferred工作建立三个真实eligible Agent、active2，要求单pass登记恰好2个；并发driver必须是 `tick()` 与 `runUntilSettled()`，不是受 `#ticking` 自身串行化的两个tick。
3. 修复现有cleanup回归的前置条件：Worker事务保持READY、已审计且已allocation；记录故障注入的 `collectDeliveries(agent)` 实际收到的ID，必须包含该Worker，再断言无残留permit、lease、active-entry。不能先把事务设RUNNING后断言未执行路径的清理成功。
4. 分离公开分页与内部完整集合。公开列表保留默认100／上限500；控制、恢复、capacity、summary、report使用SQL聚合或针对cluster/subtree的完整谓词，禁止依赖默认列表页。`#pendingFor` 在SQL中过滤可操作状态和未处理revision再限量，不能先取前200历史事务再过滤；Worker领取直接查询READY且已有有效allocation的候选，避免前200未分配任务遮住后续可运行任务。
5. 域成员查询改为SQLite recursive CTE，以 `nodes.parent_id` 为权威，不受500条上限；公开query先按域过滤再分页。给node/agent/allocation等列表补与transaction一致的稳定分页返回。`report()` 用完整SQL汇总并显式分页详情；不再把前500 Agent数／前100 Node数写成总量。
6. 将其余“必须遍历完整集合”的调用迁到内部批扫描／SQL：`recover` 所有未终态cluster、lease/effect/agent/transaction，`reconcileDeliveries` 的agent，`control.pause/resume/cancel`、`cancelSubtree`、`actions` 的scale_in/reparent/release-all/evaluate-allocation，以及scheduler的所有ACTIVE management节点。事务READY查询按状态、allocation和优先级直接筛选；由完整count而非默认页得出panel/report总数，任何>500行重启、取消、报告不可丢尾行。
7. `recover` fence旧lease后，所有RUNNING且没有活turn的事务（**包括仍持有ACTIVE allocation者**）恢复为READY；先 reconcile Session/tool/event与usage，再恢复调度。READY查询直接领取该allocation绑定的Worker；旧进程epoch结果永远不能提交。对没有已持久Session的首次turn可以create；已有历史turn／checkpoint而Session缺失必须BLOCKED `SESSION_MISSING`，不得用同ID新建空白会话冒充恢复。
8. pause记录事务原始status／revision，不在finisher排空前清除 `result_staged_*`；resume仅恢复已审计且依赖满足的原READY状态，未审计DRAFT仍DRAFT。实证一个Worker提交中pause→drain→resume仍交由Auditor处理，不能丢结果或绕开计划审计。`runUntilSettled` 区分真正terminal与runner wall clip的返回原因；重试入队记录 `transaction-status READY` 时间以计算等待延迟。
9. 递归fixture明确定义 `spawn_children` 为剩余链深度而非本层子节点数量：每层最多一条对应的待派生instruction，下一个management继承减1；有待派生指令时忽略模型传入的覆盖数字，达0后不继续。root的额外flat直属分支仍由真实角色执行；每次child深度、owner、plan revision都取可查询持久事实，不以一句模型自述代替拓扑。


### 3. 统一请求准入、实际消费与压缩资金

1. 保持转移式grant账本，不重新对整条祖先链重复扣款。`budgetChainForAgent(agent,{tokens=0,model_requests=1})` 对每个候选同时检查tokens、requests和 `effectiveDeadline`；顺序固定为cluster compaction池、`fundingBudget(cluster,agent)` 所得management grant、Agent自身grant。每次仅返回一个可完整支付的scope；没有可支付scope则记录结构化拒绝，禁止空数组免费发送或仅因“还有一点tokens”选中不足scope。
2. 删除两个start路径及 `topUpAgentBudget` 的“每turn分走node剩余一半”补款；迁移 `cluster.test.js` 直接调用。`topUpBudgetForAgent(agent,amounts)` 改为按当前请求的各维缺口转移，不使用固定262,144-token／8-request大额补款；Worker请求额度剩余为0时不补款。复用同management下闲置身份的未花且未reserved余额回收，移除固定8192-token保留底额；不回收正在请求的reservation、不借其他子树预算。资金变动后重新选择scope并原子预留，不复用旧chain。`reserveChain` 检查祖先最早绝对deadline，发送前检查cluster汇总token spent+reserved；实际overshoot允许如实入账，但不得再启动后续请求。
3. `reserveLlmRequest` 将Worker额度检查放在reservation事务内，计数 `kind='worker' AND status<>'NOT_SENT'`，包括未结算预留／UNKNOWN但不含compaction；保留每身份最多2次实际请求的scale合同。`protocol.validateLimits` 接受默认0作为“未启用Worker额外上限”，正数仍遵守现有范围，normalized spec再次校验必须成功。
4. `usage_receipts.budget_scope_id` 是结算、释放和恢复的唯一资金定位。`settleLlmRequest`、`releaseLlmRequest` 去掉调用参数 `budgetIds`，直接读取receipt的scope和reservation_tokens；同步迁移 `runtime.js` 全部调用与 `core.test.js/cluster.test.js` 引用。RESERVED只转移一次；SETTLED/UNKNOWN/NOT_SENT重复结算不动账。**仅对需要处理的RESERVED**若缺持久scope或该scope不存在，保留reservation并BLOCKED `ACCOUNTING_UNCERTAIN`；历史已结清且scope为空的旧行不倒扣，也不得静默改扣Agent当前scope。
5. `installRequestAccounting` 对未dispatch取消释放全部；已进入provider但结果不可证实则UNKNOWN、保留tokens占用并只消费一次request。分别报告reserved、dispatched、settled、NOT_SENT、unknown，实际Worker激活数只认原生Session/provider请求证据，不认receipt行数。
6. `createToolExecutionHook` 明确区分flush前、flush后未dispatch、已dispatch：flush拒绝、取消、fencing走 `refuseToolCall` 释放而不计执行；`next()`启动后失败才消费一次。保留现有flush后的lease复查，并用deferred flush实测旧epoch与取消不会落副作用，不能只直接测试释放函数。
7. `runSingleAgent` 保留只有一个真实Agent且无管理角色的实现；root→node改用同一grant转移而非两份完整budget，通过同一请求／deadline守卫计费，为single的整段turn持有并释放一次LLM slot，将control(cancel)/dispose信号传入 `runTurn` 并等待清理。runner `report.spec` 必须反映原生single已有active1/llm1，不能沿用case的2并发声称公平。single的执行SUBMITTED与外部质量验收分开，不套用管理Cluster“全部ACCEPTED”门槛伪造Auditor。
8. `max_active_agents` 回归“驻留执行”而非历史身份额度：`createWorkerForTransaction` 仅预留logical agents容量，`grantAgentBudget` 不向Worker转移active limit；active预留在role/Worker/single turn登记时由实际出资management scope取得，finisher／start-failure／fence各恰好释放一次，同时保留cluster实时active硬门。`releaseAllocation` 只回收身份容量及未花grant，不冲销spent。恢复已fence全部旧lease后归零残留active reservation，并把旧Worker grant中的unused active limit转回原出资scope；只迁移运行库，不打开旧实验库写入。两倍以上active窗口的分波allocate→run→release不能耗损容量。
9. `store.js` 在现有`SCHEMA_VERSION=1`基础上用受版本约束的事务迁移新增tool receipts、checkpoint.events_seq和必要索引；先读既有列／旧receipt状态，拒绝比本实现新的user_version，不删除旧usage/effect/command数据。只在新的隔离运行库或用户明确由插件打开的运行库执行迁移，历史 `.artifacts` 报告和数据库作为只读证据保留。增量索引覆盖 `transactions(cluster_id,status,priority,created,id)`、`allocations(transaction_id,status)`、`usage_receipts(cluster_id,agent_id,kind,status)` 与收件Session关联；扫描保持keyset，不加载全部1024输入到模型上下文。


### 4. 修复两请求提交协议与turn内Context

1. `index.js` 的role-tool执行器在Worker `submit_result` 成功完成command后调用宿主 `exec.concludeTurn()`；失败／拒绝不调用。让原生tool success的 `concludesTurn` 使turn以completed结束，随后仍经过flush、epoch／allocation绑定校验才发布SUBMITTED。不把error／max-tokens／aborted改写成成功，不跳过Auditor，不放宽两请求上限。验证真实Qwen完成“read→submit_result”只用两次普通请求，另加原生loop消费terminal tool-result的确定性回归。
2. `runTurn.setup(agentCtx)` 增加作用域内 `agent/pre-step` listener；`await next()` 后，对enter decision用 `tokenMeter.measure(agent.session)` 加尚未入Session的messages之 `estimateMessage` 计算压力。达到role/Worker预算×0.8时，在这个原生between-step安全点调用 `compactIfNeeded(agent,'context-overflow',signal)` 一次，重新测量；不在 `llm/stream` 内递归启动压缩，不在正在running的Agent调用 `runMaintenance`。保留idle阶段的原生maintenance能力与宿主自动overflow处理，不另造Agent loop。
3. 压缩后只有确实低于对应Context预算才继续；无可压缩区间／资金不足／不可约header或当前输入过大时拒绝该step，持久记录 `CONTEXT_PRESSURE` 或明确的budget拒绝来源。普通请求最终dispatch前再检查model总窗口131072与server input142074硬界；不依赖请求后才发现超限。summary失败不得悄悄继续发送过大请求。
4. 去掉“压缩后仍沿用旧prompt tokens×1.05”的不变下限；普通请求使用原生meter对当前durable surface/header的计量与output reservation，compaction按其实际options估计并单独记账。每次压力检查记录agent/turn/step、native seq、before/after、threshold、summary seq和charged_scope，Worker也写入turn-end Context。Context验收必须在同一个turn的两个普通请求之间看到真实 `compaction/summary`，不能仅看“调用了compact”。
5. 所有三种mode的普通请求通过agent-scoped `agent/request` waterfall返回 `{...await next(),temperature:0}`，让temperature进入原生request/header；不能塞进宿主不支持temperature的AgentOptions。对属于本cluster Session的 `purpose:'compaction'|'session-title'` 辅助请求，在现有LLM hook的手工options上固定temperature0，并单独保留purpose，不算作Worker普通请求。已匹配Session却provider/model不符时fail closed，不再直接next绕过记账。
6. `expectedBaseUrl` 不再是假校验：runner在启动前解析隔离profile与patch并验证provider/model/baseURL等于固定Qwen配置；报告区分“配置endpoint”与实测请求路由，不声称宿主公共API提供了它没有的resolved baseURL。原生request/header与usage保存每次实际provider/model/sampling；本地smoke验证注册模型容量和endpoint响应，不允许cloud fallback。
7. 模型侧 `flow_query` 按域先筛选、后分页，列表仅返回轻量摘要及cursor；详情按单个id读取。管理prompt只带变化摘要、当前行动项、相关issue/summary引用，不带全量tree/budgets/history。Auditor每turn最多领取8个同revision的结果摘要；未裁决仍保持VALIDATING，不按“看过列表”自动接受。增量SQL选取须覆盖尾页，不能通过固定前8条历史记录饿死新结果。

### 5. 确定性恢复、原生Session证据与副作用边界

1. 故障barrier只在runner注入不可由case.env覆盖的 `FLOW_FAULT_TEST=1` 且 `FLOW_IPC=1` 的本次测试宿主启用，并由私有IPC `fault-arm` 指定cluster/call/message和一次性nonce，认证web route不可访问。第一次让async `settleDeliveries` 在Session flush(true)与SQLite写 `delivery-flushed` 后、ACK事务前await，经现有IPC发非请求通知，runner只读核对row后杀本run子进程。第二次接在宿主 `tools/result` 同步observer（post-execute与最终content投影完成，原生Session尚未append tool/result）：先同步持久化最终canonical content/meta/error/concludesTurn及barrier行，事务关闭后仅测试宿主有30s上限的同步等待，runner经只读SQLite见确切行后SIGKILL。首次启动及重启都在`index.js`自动`resumeScheduling()`前挂测试专用startup hold，先完成原生repair并arming下一barrier，再放行；不得在SQLite事务内等待，缺barrier/超时UNKNOWN，不能用事后轮询/定时kill冒充成功。两窗用同一cluster和预算。
2. delivery来源直接带 `{kind:'flow',form:'relay',cluster_id,message_id,recipient,delivery_seq}`，原生 `user/message` 的随机ID仍由宿主创建；从Session event.data.source精确比较这组字段，文字标记只供模型阅读。`sessionCarries` 明确返回FOUND／ABSENT／UNKNOWN：仅FOUND可ACK，仅ABSENT可inject，open/read/解压失败与session不可证明均为UNKNOWN并冻结对应delivery和owner；`ctx.sessions.flush` 返回false一律不能ACK或执行已准入tool。`session-scan.mjs` 去掉zstd失败转raw文本及任意包含ID的计数，检查精确原生event结构。
3. `tests/acceptance/cases/recovery.json` 的message fixture严格解析 `from`/`to` 为各自事务的**实际ACTIVE allocation**；未就绪则等待，绝不退化为Auditor或广播到新Worker。该case加两个管理兄弟分支，确保源／目标在不同管理子树；记录两者的branch根与同一个recipient；多次tick与重启后仍只有该recipient的一个native来源事件。保留普通用户有意选择的multicast，不把fixture路径泛化为广播。
4. 在 `store.js` 为**所有**tool-call加持久 `tool_call_receipts`（宿主必填exec.callId主键，勿以randomUUID顶替；session/turn/step/epoch、tool/args hash、command_id、charged budget_scope_id、native tool/call seq、dispatch状态、最终result/error和原生result seq），与tool quota reservation同事务建立。tool/call seq必须从当前原生Session按精确callId+turn/step取得。`createToolExecutionHook` 在flush(true)与二次fence后标DISPATCHED，`next()`结束只记录dispatch／quota状态，**不**把此时的pre-post result当作最终返回；宿主 `tools/result` observer同步持久化最终模型可见content、meta、error及 `concludesTurn`，后由宿主自然append原生结果。`flow_communicate`变更分支经现有`store.runCommand`用同一commandId幂等；effect表独立跟踪外部副作用。重复call同args仅复用，异参冲突409。
5. 启动恢复顺序：关闭自动调度→fence旧lease→完整扫描usage/tool/effect receipts→用 `sessionPersistence.open(sessionId,'read')` 精确读取原生call/result seq→仅对已有**最终canonical result**且command已提交的孤儿call拿write handle，以原生 `tool/result` `{turn,step,message,sourceEventSeqs:[callSeq],surfaceOp:'append'}` 补记并flush/close→重排未终态事务READY→允许`ctx.agents.resume`与调度。结果message以callId构造稳定ID且存回receipt，补记前再查原生是否已有引用同callSeq的结果；后续重启不得补第二条。宿主resume会先生成interrupted closer，故必须在它之前修复；缺结果／Session不可读／同ID不一致则BLOCKED `RECOVERY_UNCERTAIN`，不从单独的command内容臆造post-execute成功。
6. 仅对最终canonical receipt确认为 `concludesTurn:true,isError:false` 的Worker `submit_result`，在command/staged结果、事务revision／allocation epoch、同step全部tool结果与原生call/result对应都可核验时，才为崩溃尾部补 `step/end`、`turn/end completed` 并让事务走正常SUBMITTED→Auditor路径；否则保持UNKNOWN/宿主interrupted closer，不把错误／取消伪造completed。反复重启后命令revision、tool quota和native result各恰好一次。
7. 已DISPATCHED但没有可证明结果的非幂等工具保持 `EFFECT_UNCERTAIN`、预算UNKNOWN，阻断owner的模型与tool再执行，显式报告需人工判定的effect/call，不调用同工具重试；只有有证据的确定只读／未dispatch才可重新准入。回归用一个真实外部append sentinel与崩溃点，证明最多一次副作用，而不是对空effects数组断言`every`。

### 6. 生命周期安全点、拓扑及真实角色流程

1. 对 `replace_agent/reassign_agent/reparent/checkpoint/restore` 采用单一async `ClusterRuntime.lifecycle(actor, command)` 准入入口；同步 `command()` 对这些动作不具备preflight token时拒绝409，role-tool通过 `await runtime.lifecycle`，常规动作仍走现有同步`store.runCommand`。先只读验证actor/domain/revision/目标，再在运行态冻结目标scope的新调度；失败与超时都必须在finally解冻且不改持久状态。预检期间不写持久状态、不在SQLite事务内await或abort；最终短事务才修改数据。发起该tool的Allocator若在受影响drain scope，直接409且无副作用，避免等待自己的tool result。
2. 在冻结范围外等待受影响非发起turn自然到idle及pending工具结算；设置明确30s drain上限，超时409且解冻，不把仍在执行的外部副作用假装已经取消。逐Session `await ctx.sessions.flush(live.session)` 必须返回true，或使用read handle确认既有持久日志；读 `session.seq` **是下一个native事件号**，在此时作为 checkpoint.flushed_seq（native offset），另记 `events_seq` 保存cluster游标，不能再交叉用`latestEventSeq`。记录本agent的usage watermark和inbox ack cursor；无可证明的Session／未结算effect则明确冲突。
3. 完成flush后在单一短事务重查expected_revision、epoch、未活跃状态和作用域锁，写checkpoint、安全点变更／command receipt／事件；commit后才解冻scheduler。`restore` 验证checkpoint归属cluster/agent/session，且当前native durable offset等于checkpoint.flushed_seq、没有其后的model/tool/session历史；否则409，不声称可以倒带宿主append-only Session。已接受事务、spent和历史effect不回退；`replace` 归还旧Agent未花且未reserved额度与身份容量再grant新身份，`reassign` 只作用于idle且两事务合法READY的allocation，并重验write scope及owner/revision。
4. `reparent` 对完整递归子树、所有事务／Agent／budgets做权限和冲突预检；若有未settled tool/usage reservation、ACTIVE Worker allocation或 `agents_reserved/max_active_reserved` 未归还，则409并先行要求idle释放，不能让容量随node移动而消失。按底向上把每个budget scope的全部未花／未预留多维grant退回旧出资祖先，预检新父management可支付同维额度，再由新父→子树根→各原scope按旧余额重拨；一个SQLite事务内完成，旧spent保留在原scope，额度合计不变且新父不足则全部回滚。偿还/重拨后改子树顶层node budget.parent_budget_id，重写所有后代path/depth/owner_management_id，并让`store.updateNode`支持owner字段；最早有效deadline不得因移动延后，同时核验child容量及write scope。旧域随即失权，新域可出资，不得先abort再返回409。
5. `acceptance` 中扩展live机制场景，真正让Allocator经模型工具依次做预算发放／未用余额转移、scale out/in、idle Agent replace/reassign、安全点reparent、checkpoint/restore以及注册Qwen合法选择与非法model拒绝；逐步保存前后budget/node/lease/agent证据。递归场景由depth budget chain构成depth≥3并与直属浅branch并行，`topology_source:'fixture'` 表明只预置目标不伪造模型行为。Auditor真实拒绝/纠正、升级最多2轮，非合格结果不能由runner自动改为ACCEPTED。

### 7. 可复核指标、原生面板和最终验收

1. `src/host/ledger.mjs` 与报告只从原生Session事件、持久usage/tool receipts、SQLite完整汇总和实际Web/HTTP响应算数：planned固定为fixture N，activated是有已dispatch普通Qwen请求的**不同Worker agent_id**，completed/failed/blocked只数fixture事务的终态；model辅助请求另列，新增Orchestrator任务另列。queue等待从READY事件→allocation、model延迟从provider dispatch→首chunk/结束、运行效率从真实终态数/墙钟计算；零样本p50/p95和每Worker费用置null。两个并发峰值：本地注册resident Agent与已dispatch仍未settled的provider request，不能用receipts累计数或lease剩余数代替。RSS/CPU/GPU不可采样如实null。
2. 在固定规模比较前，把overload限定为**实际provider错误数/已发送普通请求数>10%**或连续5次原生请求timeout，不把预算拒绝／模型差答案／审计拒绝算作provider错误；触发后该档记overloaded，停止提升并发但保留报告。`suite.mjs` 使SGLang场景严格串行，前一档本run流中请求全部归零才启动下一档；缓存与同机外部负载记录为无法完全控制的混杂因素。256、1024无可靠输入/Session计量时宁记UNKNOWN不制造吞吐。
3. `/api/flow` 的host认证不变；浏览器 `handleFetch` 用独立allowlist只支持 `ping/start/list/read/events/control/report/query`（query限只读且已验证单cluster id与页大小）。`settle/tick/single/recover/dispose` 仅留现有runner IPC，不通过浏览器；未知op返回4xx。不能让未经验证的URL或report输出携带浏览器授权token。用户控制限pause/resume/cancel，不从UI给模型执行内部预算/拓扑命令。
4. `src/ui/client.jsx` 改为按parent_id展开的懒读tree、每节点事务分页、可打开事务的revision／计划审计／结果证据、各Agent的通信队列／交付状态、Context before/after与summary、budgets/usage/未知状态和结构化failure详情。`events({since})` 以最后连续seq增量读取，重连先从已存cursor继续、跳号/过期则完整重取；切换cluster后请求用选中ID防旧异步refresh覆盖新选择。旧基本控制与report下载保留，关闭页面不触发cancel。
5. `checks/panel.mjs` 不再从整个body文字猜按钮存在：用授权本地浏览器点创建/展开多页节点、查看一个事务的审计与通信/Context证据，pause→resume→cancel独立可观察状态，关闭并重新打开页面后序号继续且cluster未丢，下载report内容与实际cluster id一致；未登录401，错误console与截图保存。headless测试只能证实实际可访问面板，不把静态React快照当交互证据。
6. 仅新run复算和更新 `docs/reports/test-results.md`、`docs/reports/acceptance.md`、`README.md` 中本计划影响到的版本和判定；历史记录保留run-id、失败事实和未经验证标签，不把旧数字当新回归。docs明确A未实现/B已实现有bug/C新增问题的收敛状态、每gate是否通过、失败及原始报告路径。清除仅实现期间的临时脚本，不能删除用户已有失败证据或改造业务样本去讨好检查。

## Critical files & anchors

只修改本仓实现、case及验收文档；宿主路径是已核对的只读API契约。实施时由一个人集成共改的 `cluster.js/runtime.js/store.js`，其他独立case/UI在接口固定后接入：

- `src/adapter/cluster.js`：真实调度／slot与lease、Worker发布、预算grant、递送ACK、恢复顺序、完整域／统计查询；`src/adapter/actions.js`：身份释放、委托、生命周期安全点与预算拓扑；`src/adapter/store.js`、`src/adapter/budget.js`：SQL完整扫描、版本迁移、usage/tool receipts与转移式账本。
- `src/adapter/runtime.js`：`runTurn`、原生pre-step/stream/tool hooks、Session flush、temperature、Context；`src/adapter/index.js`：role-tool原生terminal marker、mutation command ID、认证浏览器路由与测试IPC；`src/adapter/protocol.js`：Worker默认额度与规范化验证；`tests/unit/{cluster,core}.test.js`：持久边界／计费／并发／安全点行为回归。
- `acceptance/{run,suite,qwen-smoke}.mjs`、`src/host/{host,ledger,session-scan}.mjs`、`tests/acceptance/checks/{recovery,scale,panel,context,recursion}.mjs` 与 `tests/acceptance/cases/*`：隔离证据、故障注入、固定输入、浏览器／规模门；`src/ui/client.jsx`：不另建面板体系，拓展当前原生UI。
- `/home/leo/projects/deepseek-harness/packages/core/agent/src/runtime-types.ts:25-35,308-337`：AgentOptions没有temperature，已有作用域内 `agent/pre-step`、`agent/request` waterfall；`packages/core/tools/src/index.ts:418-434`：`exec.concludeTurn()`；`packages/core/agent-loop/src/{agent,tool-calls,index}.ts`：原生turn结束、tool/call/result及resume synthetic closer。
- 宿主 `packages/core/session/src/index.ts:1194-1211` 的flush返回boolean、`packages/session/session-persistence/src/{index,handle}.ts` 的open/read/append/flush、`packages/compaction/compaction-basic/src/{index,summarizer}.ts` 的turn内原生pressure与purpose、`packages/llm/token-meter/src/index.ts:146-190` 的measure；宿主不作为实现改动目标。

## Verification

本轮只读取源码、现存报告／事件和宿主公开契约，未启动服务或发模型请求、未构建／跑测试／修改实现。执行阶段按下列具体gate验证：机制通过必须有真实正向闭环、精确故障窗和账本／权限行为证据；业务质量失败要如实保留，不能以机制PASS冒充业务完成。

按依赖串行设四道门：G0 源码／build／case指纹、env隔离与本地Qwen probe通过；G1 `npm test`+acceptance纯函数/SQLite测试及Qwen smoke/Worker两请求/Context正例通过；G2 两原生崩溃窗口、真实递归/管理动作和浏览器面板通过；G3 V3/V4/V5三mode各一次及V6 16→64→256→1024都产出报告，另在64项并发1→2→4→8到达超载门前逐档运行、超载后的高档标记SKIPPED_OVERLOAD。任一前置机制门失败就先修并重新build，从该门重验；环境前提不可达则保留BLOCKED和既有产物，不能把后续未运行的门写成PASS或以估算取代1024。

### V0. 统一运行方式与证据

- `tests/acceptance/run.mjs`、`suite.mjs` 与现有case已存在；先修排他run目录、环境allowlist、build指纹和端点一致性，再重跑。每个case的目标、workspace、能力、limits、输入和检查固定，只替换run-id／独立路径，不按模型结果降低标准。`npm run build` 之后才启动隔离DSH profile；root `accept` 脚本只作入口，`npm test`另含adapter测试、需显式跑`node --test tests/acceptance/test/*.test.mjs`。
- `.artifacts/<unique-run-id>` 内分隔workspace、report、events、原生Session扫描证据、usage、checks及实际产物；SQLite／Session路径和插件lib/source/case/patch hash记录进报告。真实LLM记录宿主持久request/header与provider/model、已配置endpoint与本地probe，**不伪称**宿主暴露了每请求resolved base URL；profile不匹配或发现别的model route即fail closed。
- `mechanism_pass` 为PASS/FAIL/UNKNOWN三态，`scenario_status`、`quality_checks` 与 `failure_class` 另列；没有原生Session、读失败、无实际请求/效果样本时相应检查UNKNOWN。Agent/Worker激活、fixture计划／终态、subtree读写、真实请求/usage、事务审计、重复副作用、lease与Context事件分别以不同传感器求证；latency／RSS/CPU/GPU等缺样本置null。不能用模型文字、自增主键唯一性或0/0作为正确性证明。
- 分类优先原生异常与结构化拒绝：`MECHANISM` 为错误状态／权限／凭据误入／host tool／账本缺陷，`ENVIRONMENT` 为指定Qwen／浏览器／网络／依赖不可达，`LIMIT_REACHED` 仅明确cap、provider上限或持久deadline触发，`MODEL_OUTPUT` 为机制可工作但编译／网站／调研质量不合格。runner先持久化实际时钟和failure证据再分类，预算接近、任意tool拒绝或模型自述不得替代事件。
- 三个业务case每种mode保持原root预算 `{tokens:2097152,model_requests:256,tool_calls:2048,wall_time_ms:3600000,agents:2048,max_active_agents:8}`、每请求max_tokens4096／120s、最多2轮自动纠正；single Agent也按同一预算总额计费但并发1，无管理开销。达到显式预算或runner外部时限均终止并保存部分产物，区分哪个先到；不得人为修补模型输出后算通过。

### V1. 本地 Qwen 接入与真实工具循环

工作目录 `/home/leo/projects/dsh-flow`。执行阶段先用已有依赖 `npm run build`，然后以 `DSH_INSTALL_PATH=/home/leo/projects/deepseek-harness/apps/cli FLOW_QWEN_BASE_URL=http://127.0.0.1:8000/v1 FLOW_QWEN_MODEL=Qwen3.8-27B-FP8 npm run test:qwen` 跑当前smoke；缺服务即报告实际环境错误，不自行启动／重配SGLang、不换模型。隔离profile与配置patch中的路由须与这些参数一致；AgentOptions明确provider/model，temperature0经原生request waterfall，所有辅助请求仍走固定本地模型与预算。

`test:qwen` 必须发真实请求并保存回执，依次检查：
1. models列表仍含精确ID；非流式HTTP短回答和经pi-ai的流式回答正常终止，实际stream_options.include_usage=true，off模式没有未预期reasoning增量；另以high做一次短思考协议探测并记录reasoning_content。非流式仅做API smoke，不另造生产调用通道。
2. 真实 Agent 使用只用于协议验证的 `flow_sum({values:[2,3]})` 工具：返回 native tool_calls → 宿主执行5 → tool result 回传模型 → assistant 最终回答5；能看到成对持久 tool/call、tool/result，不能用应用自己猜JSON模拟tool call。
3. 流中途abort后客户端不继续采纳token、不提交成功；两个并发请求成功隔离；记录服务请求槽是否回收，未观测则不能承诺服务端取消；模型返回异常时Agent FAILED而非空字符串成功。
4. 三角色小闭环完成两组求和15／40→55，三角色和两个Worker有不同Session，Orchestrator验收和Auditor审查都有真实调用。

所有工具smoke必须经完整DSH profile装配。filesystem工具验证一个真实写入／读取与一次越界拒绝；网页抓取验证一个真实官方页面；browser工具验证一次可见页面和快照。这样后续case失败能区分能力未接通与模型产物失败。

### V2. 机制与故障验收

- `npm test` 的node:test临时SQLite回归必须实际反证：≥512节点/事务完整恢复/取消/统计，三eligible恰好两槽与 `tick()`／`runUntilSettled()` 竞态，六次allocate/release active容量不耗损，read→submit在两次请求内completed，compaction与NOT_SENT不占Worker2，flush(false)/失败不计未dispatch tool，spent/UNKNOWN幂等及祖先deadline；旧epoch、写scope变动、两种交错故障与checkpoint原生offset也各有行为断言。完整仓库检查加 `node --test tests/acceptance/test/*.test.mjs`；修改旧的空样本/错前置条件测试而非继续保留wording检查。
- `npm run build` 后用唯一新run-id运行 `npm run accept -- --case recovery --run-id <unique>`：case原预算不变，先要原生Session已flush但delivery仍DELIVERED/未ACK的准确barrier与SIGKILL，重启后一次且仅一次结构化message source；再要command已提交、`tools/result`已保存最终结果而Session有call无result的准确barrier，第二次SIGKILL，修复后一个tool/result连原call_seq、一次tool费用及一个SUBMITTED→Auditor审查路径。缺任一barrier/无recipient/无原生日志一律UNKNOWN或FAILED，不能以重启充当双窗口通过。另以append sentinel模拟非幂等effect未结算，必须阻断重放；复测再次重启证明修复幂等，不kill别人的进程。
- 同一恢复场景用两个真实management子树的源/目标allocation验证一次投递；旧epoch迟到写拒绝、reparent不能再获取已花额度、Context触发真实compaction summary与上级summary。缺资金时另报budget limit而非任意CONTEXT失败。
- 用已构建插件的live机制case让真实Allocator工具完成grant/rebalance、scale out/in、replace/reassign idle Agent、安全点reparent、checkpoint/restore及Qwen合法选择/非法ID拒绝；逐项附前后grant、node/path、epoch、Session seq与lease证据，spent不下降、child active≤cap，不声称测过不存在的第二模型。
- `recursion` 先在新的排他DB检验initial ID映射不冲突，再跑depth≥3与直属depth1真实分支；fixture仅确定拓扑目标，Auditor issue必须真实拒绝/修正。若构建/模型前提缺失就注明BLOCKED；不得以1000个未执行Agent身份替代Worker请求。
- `npm run accept -- --case context --run-id <unique>` 在同turn两个普通请求之间观察同一Session的 `compaction/summary` 和低于role8192／Worker16384的请求前压力；summary收费单列、温度0写在native request/header，cap拒绝有明确 `budget-refused` 而非只有CONTEXT文字。`--case browser` 实际打开/操作认证页面；`--case smoke` 验证两Worker和三个管理角色均到达原生turn-end。三者都记录本次build hash，旧PASSED不能代替。


### V3. 大型代码库重构

- 固定输入：**“将 `@deepseek-ai/dsh-token-meter` 的公共方法 `measure(session, requestHeader?)` 完整迁移为 `measureContext(...)`，保持签名、token测量和compaction行为不变；迁移所有真实消费者、测试、模型可见API目录和双语文档，不保留旧名alias，不修改无关measure方法和归档历史。”** 这是大型真实monorepo中的跨包公共API重构，诚实标注为有界迁移，不冒称重写整个架构。
- 宿主仓 `/home/leo/projects/deepseek-harness` 的复制规模由运行时清单实测，不沿用旧“约2.5GiB/312包”数字。每种mode先做完整普通或reflink副本至隔离workspace，保留有效相对node_modules链接、构建产物/native addon及独立.git；复制后递归检查所有符号链接目标只在副本或明确只读依赖目录、无副本文件与原仓共享inode；禁止hardlink/git worktree／原仓install/build/gen。复用现有依赖，固定隔离HOME/DSH_HOME/TMPDIR和allowlist环境，原仓全部输入hash运行前后对比，不能通过清理用户已有修改来通过门。
- 核心定义 `packages/llm/token-meter/src/index.ts`；消费者及调用次数以副本AST／编译发现并动态统计，不钉死旧“9处”。责任域为token-meter定义/测试/双语README、compaction源码/测试、ACP源码/测试、集成生成；一文件一owner，双语与i18n不能拆开并发写，派生步骤等源码owner完成再串行运行。
- hierarchical分支预设的**责任范围**为 root管token-meter定义和最终集成、child management分别管compaction与ACP；每个child自行组织源码/测试Worker。模型仍负责找调用点与完成迁移，fixture只钉交付责任，不提供补丁。flat仅有根团队分区，single全程一个Agent；这样可比较同一任务的层级协调开销。生成目录和README三方由root集成owner在两个child提交后串行更新。
- 此场景的精确迁移映射由Agent在副本自行发现，不把上面消费者清单当已完成答案注入每个Worker；runner仅用它核查覆盖。若有LSP先取真实引用；没有则基于类型／AST和有限检索发现，禁止全仓字符串替换。
- 验证必须覆盖8个spec：`packages/llm/token-meter/tests/{token-meter,route-pricing,context-breakdown-projection,token-usage-projection}.spec.ts`、`packages/compaction/compaction-basic/tests/{compaction-basic,manual-compaction,compaction-loop-repro}.spec.ts`、`packages/acp/acp/tests/updates.spec.ts`；尤其ACP的部分mock绕过类型检查，必须真实运行。runner将这些路径逐项传给 `pnpm exec vitest run`，不以同名命中数代替行为验证。
- 变更前在未改的副本跑同一baseline检查，已有失败原样记录，变更后比较新增失败；不修改无关宿主问题。变更后执行 `pnpm exec tsc -b tsconfig.host.json`、`pnpm exec tsc -b tsconfig.client.json`、上述Vitest、`pnpm run verify-cordis-catalog`、`pnpm run verify-translation-pairing`、`pnpm run verify-export-jsdoc`、`pnpm run verify-type-equiv`。Agent须自己执行 `pnpm run gen-cordis-catalog` 和需要的 `pnpm run verify-translation-pairing --write packages/llm/token-meter/README.md`，不能手改生成目录假装同步。
- 对编译／目录门通过的产物，再在副本 `pnpm exec tsdown --env.DSH_BUILD_FACE host` 重建host JS（不跑desktop bundle）；独立runtime smoke启动真实Session、取得同一已知消息和请求header的token测量，比较baseline旧API与迁移后新API的数值／breakdown，并核实旧方法不再存在、compaction消费新API无错误。源码调用、运行时mock、构建产物、文档生成都要有证据；缺前提时该项明确BLOCKED，不能用仅tsc通过替代。
- 报告包含输入规模、实际分工、改动文件／hash与产物差异、类型／行为／目录门结果、原repo不变证据、写冲突拒绝与恢复次数；`packages/client/**`、`benchmarks/**`、`python/**`、`.agents/notes/**` 等无关同名代码的hash不得变化。评估不钉死“应该恰好改了多少文本位置”，也不允许删除行为测试逃避迁移。
- 量化指标：生产调用点迁移覆盖率、8个行为spec通过数及新增失败数、host/client tsc退出码、模型可见API目录生成校验、双语配对、公共声明新方法与旧名缺失、仓库外改动数、worker写冲突数、审计纠正数、跨层等待、完成耗时和总token。所有检查从隔离副本的命令退出码/文件差异得出；源码被模型改坏而测试红属于case质量失败，不得换一份预写正确副本计为通过。

### V4. 网站设计开发

- 固定输入：**“实现一个中英双语活动报名网站：活动列表可按类别和日期筛选；活动详情可报名；表单校验姓名、邮箱和名额；报名后在‘我的报名’展示并能取消，刷新保留；支持移动端。请分工完成信息架构／界面、交互数据、集成验证。”**
- seed仅包含 React+Vite 的锁定依赖、启动／build脚本、空根挂载点，以及12条活动JSON（含已满额与过去活动），参考时钟固定为2026-09-26T12:00:00Z并在browser runner注入相同时钟；不预写业务组件或给模型参考实现。Agent负责真正产出页面、样式和逻辑；所有文件在独立case workspace。启动前在该workspace `npm ci --ignore-scripts`（锁文件固定且不得读其他项目node_modules）。
- hierarchical模式组织目标至少2个子Management（界面/交互），附一个直属验证Worker；界面契约通过blackboard共享，验证Worker跨分支send问题，Orchestrator整合。flat模式保持同一交付分区但禁用子Management；single模式自行完成同样目标。文件写权按路径分区，公共入口／package配置由一个integration Worker独占。
- runner在产出目录运行 `npm run build`，成功后 `npm run dev -- --host 127.0.0.1 --port 0` 并读取实际URL。独立浏览器按可访问name/role定位实际页面而非预钉CSS selector，检查：类别及日期筛选改变可见项；过去活动不可报名；非法邮箱显示错误且不写入报名；正常报名出现条目；刷新保留；取消后删除；满额活动禁止报名；语言切换；390px和1440px视口无页面级横向溢出。保存截图、Console错误、实际检查结果，build失败则记录其日志而非伪造UI验证。
- 功能通过比例、无障碍基本可操作性、设计一致性作为质量观察；不做审美打磨、不手修模型网站提高分数。插件自身面板则必须真实可操作。

### V5. 深度调研

- 固定输入：**“为单机多Agent集群比较 SGLang、vLLM、llama.cpp 推理服务，重点研究并发／排队、KV／prefix cache、OpenAI工具调用、结构化输出、取消／usage可观测性和运行限制，给出基于证据的选择建议与仍需实验的问题。”**
- 固定官方入口：[SGLang](https://docs.sglang.io/)、[vLLM](https://docs.vllm.ai/en/latest/)、[llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)。case只允许官方文档／三项目官方GitHub repo路径、在这些seed发现一级来源；至少12个独立页面，三项目各≥4。runtime从真实web_fetch回执保存source_id、请求和最终URL、抓取时间、hash、文本与可对位quote，不能信模型自写sources.json；区分latest与实际部署版本，不把文档主张写成本机实测。
- 检索范围限定官方文档／官方代码仓库的版本文档、server协议、实现说明及release notes；每项目至少4个不同页面。对比矩阵每个单元记“支持/不支持/文档未明/本轮未实测”，不把缺资料写成不支持；遇到两个官方版本表述冲突保留两段原文及版本/日期，列出需本地复现实验而不是挑一个当真。
- hierarchical模式按三个引擎建子域，另设对比与引证核查Worker，使用publish/query共享证据表、跨子树send消解冲突；flat/single保持同样研究问题和产物要求。输出 `report.md`、`sources.json`、`claims.json`，claims项为 `{claim,source_ids,quotes,confidence,unverified}`，结论必须指向runtime捕获的真实材料。
- 验收检查引用URL可解析、source_id存在、引用片段能在已保存返回文本中按段落/偏移定位、12页且每项目≥4页、六个维度无静默遗漏；独立Auditor检查至少10条核心论断与来源是否支持，并单独核查反例／冲突。引用覆盖/矛盾解释/建议可操作性属于质量报告；虚构已访问来源、将web_fetch错误当成功、引用与保存文本不匹配属于机制失败。single对照没有集群Auditor，以同一独立runner核查10条，不伪造审计角色。
- 本轮明确采用**官方seed+链接发现+web_fetch**，不新增搜索服务或读取付费search key；研究工具面不暴露 `web_search`，避免默认DeepSeek搜索绕到另一个LLM。记录搜索覆盖局限，不冒称进行了全网检索。DSH `web_fetch` 仅允许公网、阻止跨源redirect；从已确认最终域名读取，redirect失败作为证据，由Worker显式读取合法最终官方URL。网络不可达保留失败URL与部分报告，scenario_status=BLOCKED，不生成看似完整的调研结论。

### V6. 规模阶梯与公平对照

- 三个业务case均以 `--mode all` 依序执行single/flat/hierarchical，每个新workspace且同一冻结目标／输入仓版本／预算／Qwen配置／temperature0；也允许分别运行指定mode但总矩阵不可缺。single用现有 `ClusterRuntime.runSingleAgent` 的一个原生Agent和host工具，无管理角色／第二个loop，并发1；flat根三角色及直属Worker（max_depth1,max_children32），hierarchical按指定子management分工，后两种active8／LLM2。每个mode只跑一次，不声称统计显著，记录缓存与不可控同机负载而不清服务缓存；比较完成覆盖、质量、时间、token和管理开销。
- 单独scale case使用真实代码文件语料：按排序选择1024个文本源文件，保存每个文件的path/hash和≤4KiB固定片段；每个Worker阅读一个片段，输出一个导出符号／职责与行号证据，无可识别符号则明确unknown。先运行16／64／256，最后1024个Worker；Management三角色额外计数且真实运行，`max_agents=4096`、fan-out8、depth≤6。每一条Worker任务都必须通过真实Qwen请求，禁止deterministic回显替代。
- 每个scale Worker须有自己的agent_id/session_id/request_id和至少一次确实发到 `local-sglang/Qwen3.8-27B-FP8` 的请求；对返回工具/结果的任务以真实Session日志和模型usage对账。1024档只有**至少1000个不同Worker发生真实LLM调用，且1024个任务各进入明确终态**才可宣称“千级真实执行已验证”；未达则报告`scale_validation:"INCOMPLETE"`和瓶颈，不能把created或queued身份计入通过数。
- scale使用固定initial_transactions作控制面基准，不把模型自主分解能力与调度吞吐混为一谈。每个量级完整记录 planned/activated/completed/failed/blocked，未实际执行项单列，不能计入吞吐分母；验收需要观察全部1024项进入终态或明确资源上限导致的部分终止。
- 64个固定文件在客户端LLM并发1/2/4/8档依序实测、active9；4服务运行槽是历史观察，执行前仅只读确认当前SGLang容量，8是排队压力而非声称8路GPU同时跑。各档仅改LLM并发参数；provider错误率>10%或连续5个实际请求timeout后该档overloaded并停止升档，后续较高档不执行、标记SKIPPED_OVERLOAD，不用预算拒绝／模型产物失败算provider故障。上一档本run真实inflight归零后才开始下一档；1024固定LLM2，服务配置不动。
- scale每Worker最多2次模型请求、max_tokens=512；管理与compaction另列且计入总预算 `{tokens:65536*N,model_requests:12*N,tool_calls:16*N,wall_time_ms:21600000,agents:4096,max_active_agents:9}`。触及6小时或预算上限就输出部分完成率与瓶颈，不降低N重写报告；控制面可另以无LLM的10,000节点fixture验证索引／重启，只标记synthetic，不替代真实推理。
- 指标用真实事件时间戳计算：入队→分配p50/p95、模型发送→首token/完成p50/p95、SQL领取p50/p95、各档N/W完成吞吐（completed/wall秒，同时报activated/planned分母）、每完成事务请求/四桶token、root summary/context大小、resident handles峰值、RSS曲线、消息排队／递送、审计纠正、budget overshoot和恢复前后receipt数。机制硬门是重复验收0、重复扣账0、有效双租约0、越scope写入0、丢失事务0、resident handles≤配置max_active_agents、Qwen在途≤配置max_llm_concurrency；质量和吞吐不设未经实测的改善承诺。
- 具体执行入口依次为 `npm run accept -- --case scale --run-id <unique> --dataset-limit 16`、同命令的64／256／1024档；64并发阶梯只在`--dataset-limit 64`下加 `--max-llm-concurrency 1|2|4|8`，各自独立run目录且其他参数逐字相同（触发超载门后不执行更高档）。`tests/acceptance/suite.mjs` 的总墙钟必须保留scale case原 `timeout_ms:21600000`，不以业务3,600,000ms覆盖；若预算或真实deadline先到则存部分证据与INCOMPLETE，不能把挂起的RUNNING算终态。1024验证同时要求原生已dispatch Worker≥1000、所有**固定1024项**明示终态、无双租约/丢任务/重复账，且报告保持原预算，不用费用外推替代运行。


### V7. 实际面板与最终交付判定

用现有隔离runner `npm run accept -- --case panel --run-id <unique>` 启动真实已构建插件、认证DSH web profile及浏览器，保存可用URL／截图／console证据。验证创建、懒展开>100节点、事务revision与原始证据、budgets/审计、跨子树通信和Context、pause/resume/cancel、event seq断线续读及report下载；未登录 `/api/flow` 为401，浏览器POST的内部 `dispose/recover/tick/settle/single` 被拒绝。关闭浏览器不取消cluster，重启本次测试profile后仍可查看同一Cluster；不修改用户默认profile。

四阶段机制必须有真实正向闭环和故障证据；三个业务case及scale都要交报告，失败产物也保留。最终交付概括“机制通过项／失败项、各场景结果、真实推理规模、性能瓶颈、质量观察”，不能以一个求和smoke、全mock测试或单张面板截图替代全部验收。

## Assumptions & contingencies

- 单机、一个本地Qwen服务，1000+指持久逻辑Agent与受控活跃窗口，不是同时向GPU发送1000个请求。本轮不扩展远程多机控制器或重新部署模型。
- 本轮完成四阶段的核心机制与上述验收；不要求逐个铺满V1.0所有动作别名，不为效果不佳增加无限重试或改用更强云模型。
- 用户已指定本地推理用于测试，不再附加云模型付费审批；既有记录报告当时服务无鉴权，pi-ai路由的 `Bearer EMPTY` 是客户端占位，不是用户密钥。本轮仍以只读配置核对及实际probe确认现部署；若chat POST拒绝，记录返回码与所需server-side专属配置变量，不读取或复制其他模型密钥；服务不可用先检查同一已指定本机部署的可达性和配置，不回退到Ollama或其他模型。
- 业务场景在隔离workspace运行；本插件／宿主源码及用户现有工作树只作输入基线，生成产物失败也不可在原仓“补救”。保留每次运行的模型配置、输入hash、执行回执与失败原因供后续调整。
