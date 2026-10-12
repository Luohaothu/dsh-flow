# Auditor 移除与 Orchestrator 完整权限实施验证

日期：2026 年 10 月 12 日。源码起点：`0c49836e6fe0c60a9ccff73c132934305608f65c`。实施对应 [执行方案](auditor-removal-plan.md)。本记录描述此次实现及实施阶段验证。

状态：生产实现、单元回归、原生能力及界面验证已完成。本地模型三项运行结果均已归集，其中两项未满足全部质量要求，具体失败项保留如下；不标记为全部测试通过。

## 已交付行为

- 团队只包含 Orchestrator、Allocator、Worker。根域和子域均创建两个管理身份，删除固定 Auditor、审核动作、评分、审核表、审核版本字段、等待审核和回收门禁。没有关闭开关、隐藏角色或自动审核通过分支。
- `validate(accepted=true)` 在同一 SQLite 命令事务中保存不可变 validation 并进入 `ACCEPTED`。守卫失败整次回滚。负向验收进入 `REJECTED` 并生成业务返工问题；删除 `VALIDATING` 和 `accept_result`。
- 管理者默认拥有 `fs_read`、`fs_write`、`shell`、`web_fetch`、`browser`。团队参数 `managementCapabilities`、`managementWriteScope` 独立于 Worker 的 `capabilities`。显式空能力、只读及祖先授权约束有效；子域不能扩大授权。保存的授权同时驱动 Agent 声明、实际工具挂载和执行准入，冷恢复继续使用同一授权。
- Orchestrator 无需 Worker allocation 即可核验交付。管理者写入仍需域授权，执行时与活跃 Worker 写范围协调；shell 需要完整工作区授权。沿用宿主 `workspace-write` 和 Flow 团队会话的 `approval: never`，普通主会话审批设置不变。
- 当前已提交结果可自动成为验收对象；`bind_validation` 可在同一原生回合切换对象。每次调用绑定当时的 transaction、plan、result、Agent 和回合，来源及副作用证据不能跨任务或冒用 Worker。验收后产生的调用不补入旧验收。
- 正向验收和收尾拒绝未结算、不确定副作用及未确认后台任务。管理者修改已发布产物会使对应旧结果及祖先聚合失效，不能继续验收原版本。扫描覆盖显式产物文件、目录和符号链接，限制为 10,000 条目、64 层、256 MiB；超限不会静默跳过。
- `reject_result`、`reopen_transaction` 使用当前 transaction revision 及发布引用防止旧请求影响新结果。业务返工只按新的失败发布消耗预算，同次重试不重复计费；达到上限后不能借修订或重派发绕过。`resolve_issue` 区分业务修复与运行问题，不把未确认执行问题自动关闭。
- 已关闭委派域不能直接复活。后续纠正由活跃父域建立正式任务；有效子树引用、依赖暂停、祖先整合失效和回收条件继续执行。

## 文件与文档范围

实现集中在 `packages/dsh-flow/src/core/{actions,cluster,store,model,contracts,protocol,team,role-tools,native-evidence,briefing,runtime}.ts`，新增 `management-authorization.ts`。同步修改公开类型、团队输入、身份及客户端样式。`src/host/ipc-bridge.ts` 传递管理者授权；`src/host/host.ts` 修复失败启动后日志流异步关闭的竞态。

测试同步迁移固定 Auditor 的夹具和断言，并加入授权、原生验收来源、同回合多任务绑定、并发版本、返工预算、已关闭域、未知副作用及产物修改/扫描边界回归。删除仅验证旧审核协议的测试，保留被审核协议承载的业务守卫。

当前产品 README、CONTEXT、包内 Agent Team skill、配置、API、动作目录、角色/调度/层次结构、持久化、运行与验证文档已同步。历史方案及验证记录物理迁入 `docs/plans/archive/2026-10-12/`，归档说明明确其版本和追溯用途。

## 旧版本与实验保护的历史记录

实施前曾在 `.artifacts/auditor-removal-baseline-20261012/` 冻结旧版本与实验材料。下表记录当时已完成的核对，不是清理后的文件清单；原实验物理材料及旧冻结备份按后续用户要求清理，当前实现的验收报告仍保存在该目录。

| 对象 | 记录 |
| --- | --- |
| 旧源码与实施前未提交内容 | `source.tar.gz`，301 个文件；SHA256 `e9e3a6cf3b0614751ca9622dd4ae50ed0bec116081e3694598d3a1e2f8ef4c84` |
| 旧运行版本、会话及实验材料 | `runtime/`、`evidence/`、`evidence-manifest.json`，3,125 个文件逐项核对 |
| 原始实验报告 | SHA256 `f75321d235b61ac1801119a578df04622853373ea6dff215f9962dc03c5bf769` |
| 原始实验冻结清单 | SHA256 `4e218ebf197cb0f927374829192488189395d8d4eda50c5f5bc8eb17c441856f` |
| 删除生产角色后的离线复核 | 当时记录 72 阶段、48 会话、71 原生结构化决策、154 请求，无额外请求 |

历史结论保持不变：24 个设计配对中 23 个完整，不声称完成统计显著性检验，也没有把实验重新解释为普遍无效的证明。实施期间的离线核查不依赖模型凭据；清理后的当前工作区已撤下实验程序和执行入口，不能复跑旧 Auditor 组或重算原报告。Git 历史不重写；删除材料不改变当时的结果，也不把已删除的附件表示为仍然可用。

持久化版本升为 schema 5。隔离验证实际加载旧、新两版 runtime，完成旧库创建/读取、新版拒绝旧库、新库创建/读取、切回旧版读取原历史记录。冷恢复补修后的最终构建复验中，新版拒绝前后旧库 SHA256 均为 `86407f0378a6e155b8cb12300438e613a98d197251432c8b5e16d124f950bc0a`；证据在 `data-switch-verification/report.json`，全程零模型调用。正常旧版启动会因设置 PRAGMA 修改文件头，因此回退检查历史记录一致，不声称每次正常打开也保持文件字节不变。新验证使用隔离 profile、workspace 和数据目录，不覆盖用户现有实例或实验数据库。

## 检查与运行证据

以下实现验收日志位于 `.artifacts/auditor-removal-baseline-20261012/`，独立原生场景报告位于各 `.artifacts/<run>/report.json`。失败和发生构建漂移的实现验证轮次保留，不计入成功样本；原消融实验检查仅作为当时事实列出，相关物理材料已纳入后续清理。

| 检查 | 当前结果 | 证据 |
| --- | --- | --- |
| 实施前单元基线 | 459/459 通过 | `pnpm-test.log` |
| 冻结依赖安装 | 通过 | `install.log` |
| 类型检查 | 通过；最终构建完整覆盖 Host、Remote、Client 和网站种子类型图；补充集成测试纳入 Host 严格类型图 | `typecheck-final.log`、`build.log`、`host-typecheck-final.log` |
| 最终生产构建 | 通过 | `build.log` |
| 最终单元回归 | 464/464 通过，零跳过 | `unit-final.log` |
| 原生 DSH 能力集成 | 冷恢复补修后同一进程 17/17 通过，零失败/取消；覆盖同回合本人回执查询 | `native-results.json`、`test-mock-after-cold-recovery.log` |
| 管理者真实冷恢复 | 新宿主恢复相同管理者/session及授权，本人 write/read/bash 结算并查询同回合回执，当前发布 ACCEPTED；原初始输入均仅一次 | `manager-native-results.json`、`manager-native-after-cold-recovery.log` |
| 管理者终止作业与网络成功路径 | 独立长作业真实取消，`job_output` 确认 killed/SIGTERM；网页 HTTP 200、正文及本人原生回执核对，通过当前 plan/result 绑定完成 ACCEPTED；两项集成同进程 2/2 通过，11 项共同指纹一致 | `manager-native-results.json`、`manager-native-after-cold-recovery.log` |
| 管理者真实浏览器执行 | 冷恢复补修后的最终构建中，Orchestrator 本人导航、snapshot、点击成功，原生副作用结算；无漂移 | `mock-results.json` 的 browser 条目 |
| mock/UI 套件 | 冷恢复补修后同一串行进程完整 8/8 通过：smoke、recursion、recovery、context、browser、panel、scale16、scale64；与原生集成 11 项共同指纹一致，全部无漂移 | `mock-results.json`、`test-mock-after-cold-recovery.log` |
| 本地 Qwen3.8-27B-4bit | artifact 23/24、delegation 21/24，原判定 FAILED；correction 21/21，PASSED；三项在冷恢复证据补修前的同一构建运行，无漂移 | `qwen-final-results.json`、`qwen-final-invocations.json` 及 handoffs 报告 |
| 文档站、截图和链接 | 最终站点构建通过；3 张当前截图原字节复制并目视检查；6 页面、9 Mermaid、7 实际导航、桌面/手机渲染通过，浏览器错误为零；173 源链接、91 页面 URL 和 59 页面锚点有效。截图与渲染在冷恢复补修前生成，客户端字节未变 | `docs-build-final.log`、`current-ui-images.json`、`docs-render/browser-results.json` |
| 实施期间的原消融实验测试与离线复核 | 当时 6/6 通过，原记录匹配 | 历史事实；实验程序、日志与原材料按后续用户要求清理，不提供现行复跑入口 |
| 新旧数据切换与回退 | 通过，旧库拒绝前后字节相同，回退历史记录一致 | `data-switch-verification/report.json` |
| 发布包残留 | 最终包 106 文件与当前构建逐字节一致；203 个生成文件、51 份源码映射通过；无旧机制语义残留 | `release-package-docs-audit.md`、`package-audit/final-release-check.json` |

原生能力测试使用 DSH 的真实文件、终端、Jobs、网络及浏览器执行层。由于嵌套宿主 sandbox 会阻止 macOS 原生 sandbox 启动，验收宿主在经自动审批允许的外层运行；DSH 自身仍使用 `workspace-write`。可控错误交付、返工、异步任务和冷恢复由确定性夹具验证。本地模型运行另外验证提示词、工具参数、交接、实际产物和最终验收链，不用 HTTP 成功或模型完成文字替代结果。

网络成功路径的首轮直连被 DSH 拒绝，因为本机 DNS 将 `example.com` 解析为代理 Fake-IP 保留地址；保留此失败轮。成功轮显式为隔离宿主设置 `FLOW_NATIVE_FETCH_PROXY=http://127.0.0.1:7890`，通过 DSH 官方代理 transport 请求公开 HTTPS 材料，没有修改全局代理或关闭 SSRF 检查。新增 `tests/integration/native-management-tools.test.ts` 用 `test:manager-native` 单独复跑；默认直连，需要代理的环境须显式配置。该项依赖公开网络，独立于可重复的 `test:mock` 套件。

新增 `tests/integration/native-management-recovery.test.ts` 使用真实 DSH 宿主，在 Worker 已提交、管理者尚未核验时暂停并停止进程，使用相同 profile、工作区与数据目录启动新进程。恢复后检查持久化授权、实际请求工具、本人 write/read/bash 及当前 plan/result 证据，并完成原发布的验收；Worker 为纯文本能力，管理者没有伪造 Worker allocation，原始任务输入均只进入一次。该项不需要公开网络，与作业/网页测试由 `test:manager-native` 串行执行。

新构建入口 SHA256 记录在 `new-build-identity.json`，其中冷恢复补修后的 `lib/index.js` 为 `612fc908f788a70ddea65271acb78bcc24edec7935ee835066da38a41bff8353`，发布包为 `45bc07c951ee03e1313a5dafc6a9036397aee95b006f896b7cde857992631141`；逐项核对见 `package-audit/final-release-check.json`。本地模型 handoff 驱动实际安装此前的 npm pack，并逐入口比较安装字节、监听和认证访问，记录运行前后指纹；其适用构建另列于下文，不混作补修后的模型验证。

## 验证过程中的发现

独立审查及运行测试补齐了旧 publication 的并发拒绝保护、返工预算绕过、未知运行问题自动关闭、未结算管理者副作用、重新挂父后的授权收窄、`flow_sum` 原生回执遗漏，以及显式验收绑定之前/接受之后修改产物的失效处理。每项都进入对应回归测试。

首次 Qwen 文件任务实际完成产物、管理者读取、终端复算及原子验收，但发现管理者在同回合查询不到本人的原生回执。原因是 `member_inputs` 在 native turn 完成后才标记 `ADMITTED`，此前查询过滤掉仍为 `PENDING` 的当前输入。修复改为以同 Agent、同 session 的持久化 `user/message` 精准证明输入进入，并核对 epoch、Flow turn 和原生顺序；仅排队、错误 session/epoch/turn 的输入仍排除。新增同回合读取、查询、展开自身真实回执、验收的单元及真实 DSH 回归。失败轮与中止轮原样保留，最终模型验证使用修复后的构建。

随后真实冷恢复测试发现第二项证据身份缺陷：旧输入已经进入原生会话时，新恢复 wake 继承旧 epoch/turn，实际工具调用却属于新租约。修复为新 wake 使用当前租约；对于尚未进入的旧输入，保持输入内容、作者、业务引用和消息 ID 不变，另追加精确的执行绑定记录，只有其后持久化的同 Agent/session/input/message 原生消息才可证明执行。活动 assignment 使用当前执行身份；错误身份、未投递消息、旧回合及 native_seq 下界不满足的事件均不关联回执。两项红回归转绿并纳入单元套件，独立复查通过。完整单元回归还发现执行账本记录被误计为业务进展，已将该事件排除出进展计数；停滞阈值和业务守卫不变，相关两项原有回归恢复通过。原失败日志及中间构建证据保留，不计入最终通过样本。

冷恢复证据补修前的文件任务运行 `.artifacts/handoffs-artifact-2026-10-12T02-31-01-430Z/` 用时 1,155 秒，安装包 SHA256 为 `38e294970269df62a44edac18f7e9d7144ddb89d7812d2cfb0ecc930b7c72bc7`，入口 `lib/index.js` 为 `1eac1226153b86e77fd14195e40d2cf166724050da7fc18a2abcb52b618b5984`，运行期间无漂移。真实产物、总协调直接读取、终端复算、原生三次算术调用、当前版本与验收作者均通过，任务正式完成。唯一失败项 `manager-own-native-file-receipt-read` 要求模型再查询并展开本人刚执行的文件回执；模型反复读取内容分页，误用 `what="transactions"`，没有按 `native_tools.read` 的 `what="transaction"` 和 `offset=8` 展开本人条目。只读快照诊断已在同一仍为 PENDING 的输入下找到本人 read（`call_73a63647`，原生 `133→134`），并按返回参数展开正确正文，确认没有新的运行时漏证据。保留原始 FAILED 判定，没有修改检查器、放宽条件或将其改记为全绿；事实在 `final-artifact-receipt-diagnosis/facts.json`。

多层委派运行 `.artifacts/handoffs-delegation-2026-10-12T02-50-16-539Z/` 用时 1,804 秒，21/24 检查通过。模型创建根管理域及一个子管理域，子域直接拆给 Worker，未建立要求的第二层子管理域。叶任务及子域整合任务已接受并回收，根任务仍为 READY；30 分钟期限到达后团队进入 BLOCKED，事件明确记录 `LIMIT_REACHED` / `DEADLINE_PASSED`。失败项是层级深度、全部正式任务接受和团队完成，不归因为管理者缺少权限。

纠错运行 `.artifacts/handoffs-correction-2026-10-12T03-20-20-925Z/` 用时 624 秒，21/21 检查通过。初次 Worker 交付错误候选值 6，Orchestrator 拒绝该发布并安排返工；第二次交付正确值 5 和整数依据，区分旧错误结果并接受当前发布。团队达到 COMPLETED，当前任务 ACCEPTED，所有角色终止。三项均使用 oMLX 的 Qwen3.8-27B-4bit、关闭 reasoning、每项 30 分钟上限，在上述同一构建运行；报告及 SHA256 汇总在 `qwen-final-results.json`，原始失败判断保持不变。后续冷恢复补修的验证单独记录，不把这三项改记为补修后的模型运行。

套件迁移期间发现 mock 的 `reject_result` 分支、UI 旧角色数量断言及执行设置提示仍对应旧协议，已同步修正；16 张旧截图原字节移入历史归档。记录发生源文件指纹漂移的轮次，它们不作为最终通过证据，最终样本要求源码、构建及安装包身份一致。

## 已知范围

Runtime 能检查引用、作者、版本、结算和可定位产物变化，不能确定自然语言观察是否真实或推理是否充分。未用显式路径表达的自由文本产物不声称具有文件内容变更覆盖；专业交叉核验可按普通 Worker 任务安排，仍由 Orchestrator 负责接受。

实施验证阶段没有重跑原消融实验，也没有切换正在使用的本地实例；当时的实验资料和历史记录受到保护。以下后续交付和清理状态不改变以上原始验证判断。

## 后续交付与材料清理

2026 年 10 月 12 日，实现提交 `d69fff2` 已推送；新实例使用 `.artifacts/local-current/data/` 的 schema 5 数据目录启动，监听端口为 18791，认证访问返回 HTTP 200，安装包字节与已验证构建一致，浏览器工具提供方已挂载。上述启动核对不替代前文原生能力及任务质量验证。

此后按用户要求撤下原消融实验的仓库程序、报告、资料及四个执行脚本，移除 Host 类型检查中的实验入口，并删除旧 Flow 数据目录、九个原运行目录及原材料冻结备份。仓库通过后续提交记录删除，不重写 Git 历史。七份历史方案及配套记录、历史截图、此次实现的最终和失败验收证据，以及非消融实验用户工作产物继续保留。实际安装身份、删除白名单、保留边界和清理后核查见 [提交、部署与清理记录](auditor-removal-delivery.md)；依赖已清理冻结文件的旧实验和数据库切换脚本不再承诺可重跑。
