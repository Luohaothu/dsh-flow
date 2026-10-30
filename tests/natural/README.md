# 真实用户主线观察器

`host.mjs` 在正常安装的 DSH profile 中创建普通主会话，从正式用户入口交付自然需求。它保持产品原有系统提示、角色职责、工具目录和工具呈现方式，记录后续真实执行。它不创建 Flow 团队、派发作业或向模型注入预定调用顺序。

自动驱动使用与宿主界面相同的 `sessionController.create`、`resolveAgent` 和 `commands.execute` 链路，适合固定输入后复跑。纯 UI 发起更适合验证输入展示、导航和视觉交互。两种方式分别取证，自动入口记录不能代替真实界面检查。

## 启动配置

先使用官方插件管理器把正式 Flow tarball 安装到全新的专用 profile。CLI、profile 与 Flow 应解析到同一份仓库锁定并适配过的 SDK。向该 profile 增加本观察器，保留正常 Flow 和宿主配置。

```yaml
- insert:
    - id: flow-natural-observer
      name: /absolute/workspace/tests/natural/host.mjs
```

通过进程环境传入以下路径。

| 变量 | 含义 |
| --- | --- |
| `NATURAL_SCENARIO_FILE` | 本地私有场景 JSON 的绝对路径。 |
| `NATURAL_PROOF_DIR` | 当前仓库 `.artifacts/` 内的独立证据目录。目录链不能是符号链接。 |
| `NATURAL_PROFILE_NAME` | 专用 profile 名称，默认 `web`。 |
| `DSH_HOME` | 官方 CLI 使用的专用 home。 |
| `DSH_AGENTS_HOME` | 本次新建、独立于 `DSH_HOME` 的空目录。必须位于当前仓库 `.artifacts/`，不能含符号链接。 |

安装与私有模型配置完成后，可使用进程 runner 启动。上述 home、场景文件和证据目录都须位于当前仓库 `.artifacts/` 内，路径链不能是符号链接。

```sh
mkdir -m 700 "$PWD/.artifacts/natural/agents-home-run-001"
DSH_AGENTS_HOME="$PWD/.artifacts/natural/agents-home-run-001" \
DSH_HOME="$PWD/.artifacts/natural/home" \
NATURAL_SCENARIO_FILE="$PWD/.artifacts/natural/private/scenario.json" \
NATURAL_PROOF_DIR="$PWD/.artifacts/natural/private/run-001" \
node tests/natural/run.mjs
```

runner 在启动前验证 `DSH_AGENTS_HOME` 为空且与专用 home 分离，显式传给子进程。观察器在创建 Main 前及每次模型请求进入 provider 前重新验证。已锁定 SDK 的 `SkillRegistry.snapshot()` 在不传 `cwd`、`scope` 时读取全局注册层；观察器要求 `complete=true`，按公开 `SkillSummary.source` 仅接纳 `runtime`、`bundled`，拒绝 `user-dsh`、`user-agents`、`custom` 等意外全局来源。技能名称不参与判定。这样也能拒绝 profile 把 filesystem provider 指向环境变量以外用户目录的配置。依据为 `@deepseek-ai/dsh-skill@0.2.0-rc.2` 的公开类型和 `@deepseek-ai/dsh-skill-filesystem@0.2.0-rc.2` 的来源注册实现。该门不禁用正常 Flow 与 SDK 内置技能。

`run.mjs` 固定启动同仓锁定的官方 Web CLI，绑定 `127.0.0.1`，使用 `web` profile。`NATURAL_PORT` 指定端口，默认 `3191`；profile 的连接来源配置须与实际端口一致。runner 不安装插件，不写入模型配置或凭据，也不添加观察器。观察器须先通过上面的正式 profile patch 加载。

每次使用新的证据目录。runner 拒绝已有 `evidence.json`、`shutdown-evidence.json`、日志、入口 URL、进程回执、`ui-ack`、`finish-request.json` 或 `flow-drain` 收尾文件的目录，避免把旧运行的终态算作新结果。私有输出文件权限为 `0600`，证据目录权限为 `0700`。

runner 在观察器到达 `SETTLED`、`ABORTED` 或 `ERROR` 后保存进程回执并停止自己启动的宿主。对于仍存活宿主的 `ABORTED` 或 `ERROR`，先执行下面的 Flow 技术排空，再发送 `SIGINT`；十秒内仍未退出再发送 `SIGKILL`。独立的 `process.json` 记录 observer 状态、请求数量、停止时间及实际退出状态。观察未收敛、宿主提前退出、强制终止或记录错误均返回非零退出码。`SETTLED` 的零退出码只表示观察收尾正常，仍须独立验收业务和协作。

需要保留界面检查窗口时，设置 `NATURAL_UI_HOLD_MS`。观察收敛后，runner 最多等待指定时长；在同一证据目录创建普通文件 `ui-ack` 可以提前结束等待。业务观察和界面等待仍受 `maxDurationMs + 19000` 毫秒边界约束；非成功终态的技术排空另有独立窗口。`cli.log` 与 `launch-url.txt` 只保存在私有目录，终端摘要不打印实际模型、服务或临时访问 token。

观察器完成非成功判界后持续拒绝新模型调用。runner 使用证据中的真实 Dashboard 地址和当前 Web 端口的 Origin，通过公开 stop 接口排空本次专用主会话拥有的 Run。地址必须是字面 `http://127.0.0.1:<port>` authority，使用独立直连，不经过环境代理或跟随重定向。归属同时核对 `backend: dsh`、主会话 ID 和 epoch；排空期间复读 registry，纳入同一归属新登记的 Run，不操作其他主会话或 backend。公开接口采用服务既定停止策略，runner 不添加业务 prompt，也不放宽请求、token 或业务观察预算。

`NATURAL_FLOW_DRAIN_MS` 设置技术排空上限，默认 `150000` 毫秒，可缩短且不能超过该值。POST 的 202 只表示受理；只有同一 operation 完成、Run 到达终态、节点 cleanup complete 且无持久化错误、作业终态和群解散后，才将该 Run 记为技术排空完成。原观察器和每次真实 GET 已见的成员、成员会话、作业归属与群 ID 会累计保全；缺失、重复或身份漂移均不能记为完成，合法新增继续纳入。所有已观测请求也须结束，已知及未知用量继续保留在原始证据中。全部已观测归属 Run 完成后，继续复读 registry 至归属集合稳定一秒；这只描述该观察窗口，独立 OS 物理验收仍须核查宿主与后代是否退出。

轮询或 stop 遇到认证过期的 401 时，排空器重新获取 token，核对协议及原 epoch 后重试同一请求一次；stop 保持同一 operation ID。刷新失败、epoch 改变或再次 401 时保留 `pending`，不通过反复重试掩盖错误。`tokenRefreshes` 仅记录成功刷新次数，所有已签发 token 均只留在内存中。

排空开始前，`flow-drain-boundary-evidence.json` 按字节保全当时的原始业务证据，其 SHA 和采集时间写入收尾回执。冻结业务证据的观察器将结束后的请求结算写入独立 `shutdown-evidence.json`，runner 按下面的消费契约读取；没有该文件的旧观察器继续使用原证据中的请求结算。`flow-drain.json` 单独记录 `completed`、`pending` 或 `skipped`，以及独立时间窗口、归属、operation ID、用量观测边界、请求见证文件的字节 SHA 和原始响应文件索引。`flow-drain-{registry|snapshot|operation}-NNNN.json` 保存未经删改的真实 API 响应；token 只留内存，不写 token 响应或 Authorization。Dashboard `RunInfo` 没有 Run cleanup 字段；completed operation 表示公开 stop 已等待 Context 清理和持久提交，节点清理另按真实快照核对。它不能代替持久状态与物理进程验收。

超时、接口错误、epoch 变化、清理失败或中断保留 `pending` 再安全退出；外部 signal 或宿主提前退出会中断排空，不追造终态。`ABORTED`、`ERROR`、原作业状态和业务验收结果不会被技术收尾改写，runner 仍返回非零。原生退出码 130 或 `forced: false` 只描述进程退出，不证明 Flow 清理完成。无 Flow 的失败路径记为 `skipped`，普通 `SETTLED` 路径沿用原来的界面等待和停止方式。

场景文件的结构如下。数量和时限由调用者按批次预算填写，不是产品限额。

```json
{
  "workspace": "/absolute/business-workspace",
  "prompt": "/agent-team 帮我检查这份订单表有没有问题。",
  "plain": false,
  "maxRequests": 60,
  "maxTotalTokens": 500000,
  "maxDurationMs": 900000,
  "noProgressMs": 180000
}
```

`plain: true` 使用普通主会话 `sessionController.prompt`，供文件读取和回答接续的接入校准。其结果只证明校准需求的实际执行。主线保持 `plain: false`，通过正式技能入口输入 `/agent-team` 加自然需求。

后续业务输入可以事先确定时，可增加 `userPrompts`，按顺序登记完整自然输入。首条必须与 `prompt` 相同。例如在订单检查完成后继续检查退款表：

```json
{
  "userPrompts": [
    "/agent-team 帮我检查这份订单表有没有问题。",
    "/agent-team 这份退款表也帮我检查一下。"
  ]
}
```

观察器仍只通过正式入口发送首条需求。后续输入由测试者在真实界面中按场景预定条件发送；业务材料也通过正常用户操作提供。观察器不会代发后续消息、复制材料或唤醒会话。对于澄清场景，先确认 Agent 实际提出了业务问题，再按事先准备的业务答复表回答。

后续输入未到达、主会话已结束当前轮次并空闲时，证据中的 `awaitingUser` 为 `true`，`checkpoints` 保存当前用户事件的 `seq` 和观察时间。此时状态保持 `OBSERVING`，runner 继续保留宿主；检查点本身不表示业务已经完成。观察器按顺序匹配真实 `user/message` 中与预登记文本完全相同的内容，把 `index`、`seq`、时间和原文写入 `userTimeline`；全部普通用户消息另存于 `actualUserTimeline`，包含原始内容块。完成通知、技能注入和同一事件的重复读取不会增加匹配数。

等待用户期间暂停无进展计时，整体时限、请求数和 token 边界继续生效。收到下一条预登记输入后开始新的无进展窗口。最新输入边界之后，必须有更晚的 `turn/end`，再按原有作业读回和连续空闲条件收敛；不会复用上一轮的结束事件。未配置 `userPrompts` 时，只匹配首条普通用户需求，原生问答仍按下文的输入边界记录。

### 顺序任务的新成果

N06 一类“前项完成后再做另一项”的场景可增加 `requireNewTerminalAfterUserWait: true`。等待检查点保存当时本主会话的顶层终态作业 ID。下一轮须出现不在该集合中的顶层终态，并由同一主会话在本轮用户输入后实际读回；只回复用户或重读旧结果不能满足本轮结束条件，也不会提前记录下一轮等待检查点。未观察到前轮完成检查点时，证据标记 `sequentialBaselineMissing`，不从后来的快照补造基线。

该选项默认关闭。执行中追加需求、改变范围和取消场景可由已有作业完成或取消，不要求创建新作业。阶段条件仅说明取证是否齐备，结果仍按业务与自主判据评分。

### 开放式业务澄清

原生问答可在 `auto` 模式按正式作业完成条件自动收尾。如果需要测试者明确决定何时结束观察，使用人工结束门槛：

```json
{
  "completion": "operator",
  "userTurnBoundary": "main-idle"
}
```

仍只自动发送初始自然需求。测试者在真实界面看到业务问题后，按事先准备的事实回答。普通用户消息原样保存到 `userTimeline` 和 `actualUserTimeline`；原生 `ask_user_question` 的直接 `tool/call` 调用及其结果保存到 `questionTimeline`，包含调用、原始结果、事件序号和状态。SDK 的即时回答和显式跳过落在 `tool/result`，不生成普通用户消息；取消及错误也保留原始错误来源，不计作回答。观察器不代答，也不要求后续答复与预登记字符串相同。

在 `auto` 和 `operator` 模式中，本主会话尚未返回的原生问答直接调用都属于等待用户，即使 Agent 仍在运行且没有模型请求，也暂停无进展计时并保留宿主。timed 问答的 pending 结果及恢复后的未知结果继续等待，直至本会话接纳对应 `user-question-reply`。等待不会生成任务完成检查点，也不能提前收敛。整体时限、请求及 token 边界继续生效。自动模式仍须满足预登记普通用户输入、最新输入边界之后的轮次结束、正式作业终态及正确读回、相关会话连续空闲三秒；问答结果不增加普通用户输入的匹配数，也不代替正式交付。

`inputBoundaryTimeline` 按本主会话的 `seq` 合并普通用户消息、原生问答结果和已接纳的补答，分别标记为 `user-message`、`question-result`、`question-reply`。它保留交互边界，不宣称所有条目都是人类输入；pending、自动错误和取消同样保留其来源。消息中的问题目录或回答文本本身不会生成问答记录。不同会话的事件序号不能互相替代。两种完成模式都以最新输入边界检查 `turn/end`；收到答复后重新计算无进展窗口。

交互结束后，在证据目录原子写入普通文件 `finish-request.json`。`sessionId` 取对应主会话，`afterUserSeq` 取其最新 `inputBoundaryTimeline` 条目的 `seq`：

```json
{
  "sessionId": "session-id-from-evidence",
  "afterUserSeq": 42
}
```

先写临时文件再重命名，避免观察器读取半份 JSON。结束请求必须指向本主会话已观察到的输入边界；字段名 `afterUserSeq` 沿用原格式，原生问答即时回答时绑定的是对应 `tool/result` 的事件序号。后续又出现普通用户消息、问答结果或补答时，旧请求失效，需要新的结束请求。尚有未答问题时，结束请求不生效。文件及读取时间保存在 `operatorRequests` 中。

多主会话应从 `mains[]` 中同一条记录取得 `sessionId` 与 `inputBoundaryTimeline`，不能混用不同会话或把顶层首会话摘要当作任意会话的边界。结束请求只允许上述两个字段。未知会话、未观察到的序号、无效 JSON、错误类型或额外字段会使观察以 `ERROR / observer-error` 结束并冻结证据，runner 非零退出；重新运行须使用新的证据目录。这与合法但尚有待答问题、或已被后续输入替代的请求不同，后两者仅暂不满足结束条件。

观察器仍等待最新输入边界之后的 `turn/end`、正式作业终态及正确读回、相关会话连续空闲三秒，再记为 `SETTLED`。人工控制不会直接改写状态、关闭业务作业或把结果判为通过。`awaitingUser` 可来自原生待答问题或预先选择的轮次澄清边界，业务问题是否必要仍由评分者核对；它不能用于证明自动无进展检测能力。`ui-ack` 继续用于 `SETTLED` 后的界面检查收尾。

### 多主会话

各主会话分别记录待答问题与完成条件。只有每个主会话都在等待用户或已经满足完成条件时，整体才暂停无进展计时。若一个主会话在等待原生答复，另一个主会话没有待答问题且工作停滞，后者仍可触发整体 `no-progress` 中止。普通 pending 作业不构成用户等待；所有等待仍受整体硬预算限制。

同一专用宿主内的隔离场景使用 `mains`，数组中的每项对应一个普通主会话：

```json
{
  "mains": [
    { "workspace": "/absolute/river", "prompt": "/agent-team 帮我核对这批订单。" },
    { "workspace": "/absolute/hill", "prompt": "/agent-team 帮我核对这批订单。" }
  ],
  "maxRequests": 100,
  "maxTotalTokens": 1000000,
  "maxDurationMs": 900000,
  "noProgressMs": 180000
}
```

`mains` 存在时以数组项为会话输入；旧的顶层 `workspace`、`prompt` 格式仍适用于单主会话。每项可配置自己的 `userPrompts`、`userTurnBoundary` 和 `requireNewTerminalAfterUserWait`；数量与时间预算由整次观察共享。

观察器先创建并解析全部普通主会话，核对 `session.header.cwd`，再分别提交各自预登记的首条自然需求。快照采集与业务观测共同核对 `Run.entry.backend === 'dsh'`，并要求 `Run.entry.callerSessionId` 属于本次创建返回的 Main 会话 ID 集合，不从工作目录或显示名称猜测身份。其他 backend 即使 caller 字符串相同也不纳入；原始 registry 保留完整来源记录。`mains` 记录各主会话的输入、ID、运行、用户时间线、技能调用、检查点和观察条件；原有顶层字段继续指向第一个主会话。

每个主会话都须有自己的顶层终态、正确读回及最新用户输入后的结束轮次，全部满足后才收敛。另一主会话的工具调用不能抵扣读回；返回记录的作业 ID、运行 ID 和状态均须匹配。界面仍由测试者交错查看对话及团队页签，验证材料、通知、结果和选择状态的归属。

业务工作区仅包含正常用户材料。评分材料的读取隔离由执行环境保证，观察器不提供该能力；当前锁定 SDK 的 `workspace-write` 约束修改，不隔离工作区外读取，专用 home 或 `private` 目录名也不能证明盲化。最终留出运行须按测试方案封存全新答案，使密钥处于候选不可访问的环境，并在全部候选及后代停止、输出封存后解密评分；本批探索不计入该盲验。模型能力、凭据引用与工作区权限由专用 profile 正常配置。

## 证据和观察边界

观察器写入权限为 `0600` 的 `evidence.json`，包含源文件哈希、SDK 所有者、正式入口回执、技能注入记录、逐请求会话身份、工具目录与真实用量、会话原始事件、团队和作业快照。模型和服务身份可能出现在原始记录中，因此原始证据必须保留在私有目录。公开 PR 只附独立脱敏后的结果。

状态含义如下。

| 状态 | 含义 |
| --- | --- |
| `OBSERVING` | 正在记录真实执行。 |
| `SETTLED` | 普通校准主会话已结束，或主线顶层作业已有终态且主会话真实读回，相关会话连续空闲三秒。它不表示业务或自主协作通过。 |
| `ABORTED` | 到达请求、已报告 token、时间或无进展边界，或宿主在观察结束前退出。 |
| `ERROR` | 正式入口或观察器初始化失败，或记录过程发生错误。 |

`finish` 在清除轮询 timer 前同步重新读取 native histories、registry 和全部 Main 所属快照，然后冻结 `evidence.json`。结束后的流结算、`agent/disposed`、观察器 dispose 与进程 exit 读取写入独立的 `shutdown-evidence.json`，其中 `businessBoundary` 指向冻结原件 SHA，`scoringEligible=false`。进程 exit 通过已经持有的 native 会话对象保留观察器卸载后追加的最终事件。无法读取的组件写入 `captureErrors`，不能据此声称完整关闭。shutdown 的取消、快照和用量只用于技术收尾，不改写结束时的业务事实或评分。各 Main 的时间线、检查点和完成判断保留最后一次正常轮询的结果；结束采集的原始 histories 是该边界的原生事实，不在 shutdown 重新接纳结束请求、推演检查点或回填业务字段。后续排空消费者若需要最新请求结算，应读 shutdown 见证，不能再依赖被冻结的 `evidence.json` 持续变化。

consumer 提前 return 会等待上游生成器真实关闭后记录 `cancelled` 和 `endedAt`，缺失用量继续列为未知。正常 return 不捏造 `error`；真实抛出异常记录 `failed` 和错误原因。

同一请求中的用量采用最后一次累计值，避免流式重复相加。缺失 `totalTokens` 的请求单独记录，不能计成已知的零消耗。已开始请求可能在返回用量时才越过总量边界，观察器会保留该请求并阻止后续请求。

无进展判断忽略聊天文字和重复查询，依据新成员、群、作业结果及新的成功工具结果更新。相同工具参数和结果不重复计作进展。模型请求在途时不触发无进展中止。若无进展窗口在生成期间过期，刚结束的生成可获得一次最多一秒的接续宽限，让工具处理和反馈完成。首次宽限只从各会话最新请求中选取已完成或正常 consumer return 的结束时刻；同一会话更晚的失败不能借用旧请求，独立会话的失败也不改变另一会话的有效接续时刻。各会话仍共用一次宽限，首次授予时固定各候选的原截止时间；同一会话后续任一失败撤销该候选，后续生成不恢复或延长已授宽限，其他会话保留各自原截止时间。查询或再次生成不能续期，只有实际推进才开启新窗口。中止前的顶层观测与该次判界使用同一快照。整体时间、请求及 token 边界继续生效。所有阈值都只是本次观察的控制条件，不能作为产品故障结论。

主会话主动取消旧作业时，所属运行与目标都匹配的成功取消调用若返回该作业的 `assignmentId` 和 `cancelled` 状态，也证明主会话取得了该取消终态。它不能代替对新提交结果的正式读回；错误响应、其他目标、其他运行或普通文字回执不计。

`readback.mjs` 按同一 Main 原生历史中的调用事件关联正式读回与取消回执：成功的 `append` 结果须以 `sourceEventSeqs: [call.seq]` 指向该调用，turn、step、两处 tool call ID 和 tool 来源须一致，并保留原有 Run、作业和返回状态核对。缺失或冲突的身份不计为读回。call ID 可在后续 step 或 turn 复用，其他工具读取的相似 JSON 不能补作正式回执；surface replacement 也不能充当新的正式完成事件。需要本轮新读回的场景继续要求正式调用晚于指定用户输入边界。

语义进展使用同一原生因果关联取得每份成功回执的实际调用，再判断是否属于查询。复用 ID 后的查询不能沿用较早取消等操作的分类来延长无进展窗口，实际完成的写入等操作也不能被较早查询的分类漏掉；重复结果仍沿用原有去重规则。

达到边界后，外部 launcher 应保存现场并停止自己启动的宿主进程。观察器拒绝边界后的新请求，不发送催促消息，也不直接停止成员或改变作业状态。最终评分者核对业务产物、主会话交付、真实协作过程和界面证据。

语法检查如下。

```sh
node --check tests/natural/host.mjs
node --test tests/natural/observer.test.mjs tests/natural/readback-sdk.test.mjs tests/natural/evidence-view.test.mjs tests/natural/runner.test.mjs
```

这些回归核验采集和进程边界，其中快照归属另通过实际 `DashboardProjector` 的投影结构验证；它们不计入真实模型的业务与自主覆盖。

多轮团队场景默认在前一任务终态、读回且相关会话空闲后记录等待用户的检查点。`userTurnBoundary: "main-idle"` 用于事先登记的业务澄清，允许在主会话结束一轮后等待回答。检查点只记录用户操作时机，评分者仍需核对实际问题和任务结果。尚未结束的团队作业不会默认暂停无进展计时。

## N08 的普通 UI 手动隔离流程

B1 的 `mains` 自动入口可在同一宿主创建多个普通 Main。本节补充 N08 的普通 UI 手动取证；入口和本地回归不代表 N08 业务已执行或通过，业务覆盖仍待实际取证。

1. 准备两个独立业务目录。两边使用相同文件名和字段结构，但内容不同，并在模型不可访问的证据目录分别保存材料 SHA 和预期归属。
2. 在正常 DSH UI 创建两个普通 Main，各自选择对应目录。两边输入完全相同的自然需求，例如 `/agent-team 帮我核对这批订单。`，不添加角色、工具或内部 ID。
3. 记录 UI 会话与原生 session ID 的对应关系。交错查看两边，分别记录各自 `Run.entry.callerSessionId`、根与成员 session、作业、材料引用、通知和完整结果。检查 Main 到所属 Run 的正向关联，也检查每份结果、材料与通知回到原 Main 的反向关联。
4. 核对两个 Main 各自实际读取的作业 ID、返回的 Run/作业身份及业务结果与本侧数据一致，另一侧身份或结果不能抵扣本侧完成。分别取得最终用户交付与返回原会话的 UI 证据。

单侧提交、不同 workspace 路径或后端快照不能替代同 prompt 不同数据的双向取证。两侧任一正式读回、业务交付或 UI 未完成，整例仍未闭环。

本地纯 stub 边界回归可运行 `node --test tests/natural/boundary-observer.test.mjs tests/natural/isolation.test.mjs tests/natural/runner.test.mjs`。它们不加载 SDK、不调用模型或外部 API。原有 `observer.test.mjs` 保留多 Main、原生澄清、人工结束及真实 `DashboardProjector` 结构验证；这些本地回归均不代表实际业务新一轮。

## 结束后见证的消费契约

`shutdown-evidence.json` 的结构如下。它只描述结束后的技术收尾。

```json
{
  "schema": "flow-natural-shutdown/v1",
  "phase": "post-boundary-stream | agent-disposed | observer-dispose | process-exit",
  "scoringEligible": false,
  "observedAt": 0,
  "businessBoundary": { "file": "evidence.json", "sha256": "...", "status": "ABORTED", "reason": "...", "endedAt": 0 },
  "capturedAt": 0,
  "histories": [],
  "registry": null,
  "snapshots": [],
  "captureErrors": [],
  "requests": [],
  "totalReportedTokens": 0,
  "usageMissingRequests": []
}
```

`evidence-view.mjs` 只生成请求结算的技术视图。`createDrainEvidenceReader({ boundary, read, preserve })` 接收保全原件的 `{ bytes, value }`，以及经同一私有路径、`O_NOFOLLOW` 和文件身份校验的同步 `read(name)`。读取返回 `{ bytes, value }`、不存在时的 `undefined`，或文件正在写入时的 `{ pending: true }`。技术视图返回 `requests / totalReportedTokens / usageMissingRequests / requestEvidence`，不包含后到的 histories、快照、业务状态或评分。`requestEvidence` 记录实际来源文件、字节数、SHA；shutdown 来源另含 phase、`scoringEligible: false` 和业务原件 SHA。可选的 `preserve(record, source)` 返回原字节副本文件名；runner 据此去重保全 `flow-drain-request-evidence-NNNN.json`，并在 `requestEvidence.frozenFile` 中引用。原 shutdown 仍可在 dispose 和 process exit 时追加最终 native 事件，保全副本可复核排空当时实际采用的见证。

shutdown 必须采用 `flow-natural-shutdown/v1`、`scoringEligible: false` 及正式 phase；`businessBoundary.file` 必须为 `evidence.json`，其 SHA、status、reason、endedAt 必须对应保全原件，当前业务文件也须逐字节保持该 SHA。`captureErrors` 非空时保留排空 `pending`。这些字段的格式通过只表明可消费，实际执行资格仍须绑定真实来源与独立验收，不能由布尔字段授予。

`mergeRequestSettlements(boundary, latest, previous = boundary)` 是可复用的纯合并函数。请求按 `number` 对齐，集合不增不缺不重复；除 `status / usage / finishReason / output / error / endedAt` 外的全部字段，包括已有的 session、事件游标、开始时间、provider、model、prompt SHA、tools 和 maxTokens，须连同字段是否存在保持一致。原 `running` 可继续运行或进入 `completed / failed / cancelled`；原终态与技术视图已接受的终态须整项保持不变。新视图复制请求，不修改任一输入。

usage 使用最新请求的累计值，按请求重算已报告合计，不与边界样本相加。终态请求缺少 `totalTokens` 时列入 `usageMissingRequests`；合计为零且存在未知项不表示零消耗。shutdown 的聚合字段不能覆盖逐请求读回结果。没有 shutdown 时，旧观察器仍受同一请求身份、终态及业务 status/reason/endedAt 校验；冻结原件中的在途请求没有见证就继续在途。

读取到半份 JSON 或读取期间仍在写入时，本次视图为 pending，后续轮询重读；已解析但 schema、SHA、身份或状态不合法的见证直接令排空 pending，不能忽略后转用旧结果。曾出现的 shutdown 不得消失后退回旧读取路径。业务原件和完整 shutdown 原件都保留，技术排空完成仍不能把 `ABORTED`、`ERROR` 或结束后新增 native 事件补为业务成功。

## 容器身份与卷映射

容器测试用 `container-identity.mjs` 校验三项独立身份：`caseId`、创建前为每个 case 分配的 `namespaceId`、以及 create/inspect 原件返回的 64 字符十六进制 `containerId`。Root 执行命名空间另存。物理命令使用 `containerId`，创建标签使用逻辑身份；读回同时核验镜像、非 root 用户、`network=none`、权限和标签。多 case 还须分别拒绝逻辑 token 与物理 ID 复用。

`container-mounts.mjs` 接受冻结的角色映射及 Docker 的 volume/容器原始读回，绑定卷名、daemon `Source`、Root 路径与 guest `Destination`。候选挂载须与冻结集合完全一致；Root 可另外拥有自己的代码、daemon 和私有挂载，其 Destination 须与映射的 Root 路径完全不相交，Source 也不得与映射卷物理源形成相同或父子路径别名。跨 case 的卷名、物理源和 Root 路径不得复用或重叠；敏感源与其父目录、额外挂载及 bind-backed volume 均被拒绝。候选原生输出与 Root 的决策、核账、评分和冻结证据目录分开。

这些 helper 只校验调用方提供的原件形状与绑定，不创建容器或授予实际运行资格。纯对象回归为 `node --test tests/natural/container-identity.test.mjs tests/natural/container-mounts.test.mjs`。

## 镜像包元数据

`image-package-owners.mjs` 通过包元数据检查相同物理 owner、精确版本与可选的冻结 SHA，不执行包入口。SDK 内部依赖从声明它的消费者解析；调用方仍须核验消费者的版本、原字节和目标依赖声明，不能把工作区根不可见直接判为缺包。对应回归使用临时文件树和真实 Node 包解析：`node --test tests/natural/image-package-owners.test.mjs`。

外部环境装配与镜像校验器消费这些 helper 的原字节副本并固定 SHA。公开回归与副本绑定只证明上述检查行为；容器、SDK 加载、界面和业务执行仍需各自实际验证。

## Root 只读文件的复制协议

`root-owned-copy.mjs` 为回执、控制文件、pointer 与停止 marker 生成指定物理容器的默认 stdin 写入及默认 raw-tar 读回参数。tar 输入声明 UID/GID 为 0 不能替代实际读回；调用方解析原始 tar 后，仍须核验唯一普通文件、名称、Root UID/GID、0444 模式和冻结原字节 SHA。pointer 的临时文件须先读回通过，再交原有 Root 发布器原子替换，最终 pointer 也须读回。普通业务目录沿用各自复制契约。

纯回归通过保留真实所有者差异的后端语义控制验证：相同 Root tar 输入经旧 archive 写入后读回非 Root，必须被拒绝；默认写入通过相同守卫。运行 `node --test tests/natural/root-owned-copy.test.mjs`。这不授予任何 Docker CLI/镜像实际资格，目标环境仍须重新执行写入与读回探针。

## SDK 会话原始来源

`raw-session-evidence.mjs` 为完整 setup 零值检查分别采集 Agent、session service、统一 query 与 persisted 正文。当前锁定 SDK 的同实例适配使用 `snapshotEvents(0, seq)`，保留 `firstLiveSeq` 和继承切点，检查整个前缀。该同步 API 已标 deprecated，适配仅用于 SDK `0.2.0-rc.2` 的测试取证；未知版本记为 unknown，不作为新增产品调用或未来兼容承诺。统一 query 的 live 优先视图不能代替其他来源；persisted 使用 `open(id, 'read')` 和 `handle.read(0)`，并在 `finally` 关闭读句柄，不恢复会话、不取得写所有权、不追加 cold-read 合成事件。前后列表、不可变身份、完整连续日志及读取失败均保留，缺源、变化或错误记为 unknown，不能变成零。

`assertRawSessionZero` 重算原始来源，拒绝任一来源的 request header 或业务事件。计数表示来源中的观测条目，重复出现在两个日志里的请求不计为两次物理模型尝试。SDK 只读接口返回有效连续前缀，这不证明损坏物理尾字节不存在。运行 `node --test tests/natural/raw-session-evidence.test.mjs`；其中包含同 ID live 空、persisted 有 request header 的反例。装配须实际消费固定 SHA 的 helper 和新采集原件；既有 observer 子集、helper 回归或预备清单均不授予完整 SDK、业务或物理关闭资格。

`raw-session-native.mjs` 是这条检查的实际消费流程。`createRawSessionNativeCapture({ ctx, scope, readObserver, loadEvidence, verifySdkEvidence })` 从 SDK 只读 facade 采集四种来源，保留 observer 子集和完整 SDK 证据；`assembleRawSessionSetup` 重新核验原始记录并生成 setup，`assertRawSessionSetupZero` 再次从原始来源重建视图后检查零值。外部 v2 采集入口、Root assembler 和 gate 消费这两个公开模块的同字节副本，不以子集列表替代正文。读取抛出 `null / false / 0 / ''` 时也保留原始失败；随后关闭读句柄再失败，会同时保留两项错误。

实际采集器仅在第一次成功时保存 SDK loader/profile 初始化原件，后续 capture 重用该记录并重验其绑定；初次完整 setup 先于普通 UI 操作。该记录证明初始化来源，不宣称候选可编辑的 profile 工作副本在整个运行期不变，也不以工作副本回填 Root 原始输入。

SDK loader/profile 检查由锁定环境的 `verifySdkEvidence` 必需注入，采集和组装分别调用。它须先核验实际 owner 原件与独立冻结 pins，再返回 `natural-sdk-source-verification/v1`：同一 scope、SDK JSON 子记录 SHA、observer entry/closure SHA 和初始化原件 SHA。缺失、返回布尔值、错 scope 或错原件 SHA 均不能形成 complete 证据；无验证器默认值。调用方还须以安全文件读取固定外层原件的原始字节与来源，并独立核验物理请求账和实际执行资格；子记录 SHA 不替代这些检查。组合回归为 `node --test tests/natural/raw-session-evidence.test.mjs tests/natural/raw-session-native.test.mjs`，使用一致的合成 source/pin 记录覆盖实际 producer → assembler → gate，不启动 SDK、界面或模型。



## 分阶段物理创建与模型通道

Refs #43、#48、#50、#53、#54、#58。`physical-container.mjs` 固定本地镜像、非 Root 身份、network none、nonce labels 和五个独立卷，以递归冻结的计划共享 create 参数与 bind 预期。绑定核原始 create/inspect 回执，并要求容器仍是 created、Pid 0、未启动的零时间状态。原调用输入后改、嵌套身份、argv 或卷映射修改都不能改变计划。

`staged-model-socket.mjs` 只监听一次 Unix socket：bootstrap 及异步准入等待期间均提供本 case 的认证 health，以 409 拒绝 reserve/map/model；Root 验证完成后提升同一 handler/inode。请求 body 有独立有限期限，完整请求后的有效长响应继续排空；未进入有效响应的遗留连接在有限 grace 后技术终止。发生协议解析失败、请求 body、遗留连接终止或完整请求之后的提前响应关闭会记录计数、明确拒绝 normal closure，不作为业务或 F6 证据。实际安装仍须核无候选写权限的父链、跨 UID 的 socket owner/mode，局部同 UID 控制不能代替这些读回。

## Root scope 的环境引用

Refs #45、#47、#49。`root-scope-environment.mjs` 使 overlay 固定环境名，按 overlay → scope → Root boot reference 顺序冻结。SDK import 前从外层物理字段、显式 candidateId 和冻结 observer entry/closure 推导八字段期望，拒绝只在内部自洽的另一 case 引用。必需的 pinned JSON reader 核原始字节与来源，模块保留首次成功初始化的完整 reference 和身份；入口必须由同一 canonical 模块实例重读同一原件。相同八字段但另一文件、同 SHA 异路径、删除环境后重绑、克隆环境或修改返回的 reference 均不能替换首次绑定。实际安装与 Node loader 的同实例原件仍须验证，不能把摘要放回 overlay。

## 停止输入与浏览器日志

Refs #51、#56。`root-stop-reader.mjs` 被真实停止适配消费，固定 source/binding/stopTar 三份输入及分角色的 Root 边界策略。源码允许 Root0 的只读父链，binding/tar 保持 owner-only；文件 UID/GID、模式、nlink、不可替换 fd、读前后稳定、原 SHA 和显式 forbidden 边界均保留，根目录与尾斜杠不能绕过排除策略。实际装配与最终重放都重读 source/binding/stopTar，不能仅凭 DTO 中保留的 SHA 接受已改写原件；默认使用 OS 文件读取，合成 FS 控制显式注入。合成 FS 控制不授予 Linux Root0 读取或实际停止资格。

Refs #52。`browser-log-reader.mjs` 仅允许非空 pinned browser-close DTO 指定的 stdout/stderr leaf 为空，按真实零字节及 SHA 返回。JSON 与其他角色继续拒空，父链、所有者、模式、链接、fd 稳定和边界检查不放宽。生产默认 Root0；实际自 UID 文件控制只证明文件读取行为，不充当 Root0、浏览器或正常关闭证明。

Refs #55。`sdk-close-binding.mjs` 提供最终关闭重放所需的断言，以初始 Root 进程来源的 PID/birth 为期望，同时核 native-peer、peer-exit 的唯一 SDK 行和 bridge-closed 的 SDK PID、UID/GID 及出生标识；缺失或矛盾均拒绝。它不返回资格布尔值，合成字段控制不代替实际 OS 原件。

Refs #57、#61。`archive-paths.mjs` 区分规范 POSIX 绝对路径与相对归档名，保留合法的 `.artifacts` 隐藏组件，拒绝点路径、父目录、空组件、反斜杠和控制字符。USTAR 读取要求精确 magic/version、checksum、UTF-8、完整 ASCII 八进制字段及其 NUL 后 padding、数据 padding 和 terminator，只接受普通文件与无正文目录，拒绝链接、特殊类型和重复路径。源码安装包与实际停止消费者共用同字节 parser，所有者、模式与原字节 SHA 继续由各自角色校验。实际编译布局的回归控制与既有 file-only tar 的只读兼容检查，不授予新环境的 SDK 或正常关闭资格。

Refs #59。`case-shutdown.mjs` 将自然停止与通道关闭按顺序执行：等待 owning driver 的明确完成回执后，再调用模型通道关闭；pending、未知或拒绝不触发后一步。通道结果还须为明确 closed 且 normal 的 staged socket 回执。显式 never-started 路径不授予 SDK 关闭资格，不能把尚未创建 driver 当作准备阶段没有资源。Promise barrier 控制验证先后关系，实际浏览器、SDK、peer/ACK 和请求结算仍须独立读回。

Refs #60、#62。`profile-seed.mjs` 分别保留 SDK owning package 的 `installationAnchor` 与 workspace 的 `installationLookupAnchor` 及各自 Root source pin。profile 自然祖先查找检查使用 workspace，SDK context 和 owner 核对继续使用 SDK anchor。准备与安装拒绝缺源、异文件、候选 owner、候选可写或无关 lookup anchor；prepare 与 install 必须使用同一 canonical 模块中的原计划；模块私有副本固定三文件角色、目录、原字节及 pins，未知/克隆/删增或重新核 SHA 的变更在任何写入前拒绝，实际写入只用保留的原件。Root 原始 primary 输入位于可替换 profile 之外，保留独立 source pin；工作 patch 的初始 Root UID/0444 读回不代表运行中不可替换。profile 父目录归候选 UID，普通 settingsSave 可通过原 SDK 的 atomic rename 更新工作副本。Node 查找路径与合成安装控制不代表包入口已执行；实际安装后仍须从独立冻结来源核三锚 owner 和完整产品文件。

Refs #63。`root-authority-layout.mjs` 分别绑定实际 Root 身份、已安装代码 manifest 与 Root 私域核账树，拒绝 case 卷覆盖或物理别名（包括已声明与额外挂载）。历史 read-set 固定原始字节、完整目录选择和已记录的不存在路径；Linux 路径/UID 引用索引单独校核，不改写业务原件。外部 native reader 对完整原始与迁移后 usage 作独立重放，保留全局尝试数、未知用量和 writer inventory 约束。合成角色控制及实际自 UID 文件重放不授予 Linux Root0 安装、唯一 writer、SDK 或业务资格。

公开仓库包含上述 helper 及其回归；本地外部测试装配、启动、准入和关闭消费者使用同字节副本，消费者实现与原始执行材料不在公开 checkout 中。运行 `node --test tests/natural/*.test.mjs`；新回归包含合成物理原件、技术 Unix HTTP 和实际自 UID 文件读回。纯控制和 source 清单不授予真实 SDK、UI、模型、业务或 F6 资格；实际安装、加载、普通 UI 操作、全流程关闭与物理回执继续作为下一波准入条件。
