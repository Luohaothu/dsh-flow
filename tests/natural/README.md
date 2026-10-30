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

每次使用新的证据目录。runner 拒绝已有 `evidence.json`、`shutdown-evidence.json`、日志、入口 URL、进程回执、`ui-ack` 或 `finish-request.json` 的目录，避免把旧运行的终态算作新结果。私有输出文件权限为 `0600`，证据目录权限为 `0700`。

runner 在观察器到达 `SETTLED`、`ABORTED` 或 `ERROR` 后保存进程回执并停止自己启动的宿主。先发送 `SIGINT`，十秒内仍未退出再发送 `SIGKILL`。独立的 `process.json` 记录 observer 状态、请求数量、停止时间及实际退出状态。观察未收敛、宿主提前退出、强制终止或记录错误均返回非零退出码。`SETTLED` 的零退出码只表示观察收尾正常，仍须独立验收业务和协作。

需要保留界面检查窗口时，设置 `NATURAL_UI_HOLD_MS`。观察收敛后，runner 最多等待指定时长；在同一证据目录创建普通文件 `ui-ack` 可以提前结束等待。整个进程仍受 `maxDurationMs + 30000` 毫秒边界约束。`cli.log` 与 `launch-url.txt` 只保存在私有目录，终端摘要不打印实际模型、服务或临时访问 token。

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

无进展判断忽略聊天文字和重复查询，依据新成员、群、作业结果及新的成功工具结果更新。相同工具参数和结果不重复计作进展。模型请求在途时不触发无进展中止。若无进展窗口在生成期间过期，刚结束的生成可获得一次最多一秒的接续宽限，让工具处理和反馈完成；同一无进展窗口内的失败、查询或再次生成不能续期，只有实际推进才开启新窗口。中止前的顶层观测与该次判界使用同一快照。整体时间、请求及 token 边界继续生效。所有阈值都只是本次观察的控制条件，不能作为产品故障结论。

主会话主动取消旧作业时，所属运行与目标都匹配的成功取消调用若返回该作业的 `assignmentId` 和 `cancelled` 状态，也证明主会话取得了该取消终态。它不能代替对新提交结果的正式读回；错误响应、其他目标、其他运行或普通文字回执不计。

`readback.mjs` 按同一 Main 原生历史中的调用事件关联正式读回与取消回执：成功的 `append` 结果须以 `sourceEventSeqs: [call.seq]` 指向该调用，turn、step、两处 tool call ID 和 tool 来源须一致，并保留原有 Run、作业和返回状态核对。缺失或冲突的身份不计为读回。call ID 可在后续 step 或 turn 复用，其他工具读取的相似 JSON 不能补作正式回执；surface replacement 也不能充当新的正式完成事件。需要本轮新读回的场景继续要求正式调用晚于指定用户输入边界。

语义进展使用同一原生因果关联取得每份成功回执的实际调用，再判断是否属于查询。复用 ID 后的查询不能沿用较早取消等操作的分类来延长无进展窗口，实际完成的写入等操作也不能被较早查询的分类漏掉；重复结果仍沿用原有去重规则。

达到边界后，外部 launcher 应保存现场并停止自己启动的宿主进程。观察器拒绝边界后的新请求，不发送催促消息，也不直接停止成员或改变作业状态。最终评分者核对业务产物、主会话交付、真实协作过程和界面证据。

语法检查如下。

```sh
node --check tests/natural/host.mjs
node --test tests/natural/observer.test.mjs tests/natural/readback-sdk.test.mjs tests/natural/runner.test.mjs
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

后续 reader 必须先校验 `businessBoundary.sha256` 与冻结文件的实际字节一致。结束后的完整请求列表与边界列表按 `number` 关联，并核对 `startedAt`、`provider`、`model`、`promptSha256` 身份不变，不能接受新增请求或重复编号。已有的 `sessionId` 等身份字段也须保持一致。只允许把原 `running` 请求的结算信息补入独立技术视图，不能改写冻结业务视图，也不能把已有终态退回 running 或改为另一个终态。usage 采用后续累计值，不与原值相加；usage 缺失继续为未知。

后续排空读取及新 wave 的原生 reader/join 应分别验证：边界有在途请求、随后成功结算；随后 cancelled 且无 usage；无效 SHA、身份改变、新请求、重复编号和终态回退均拒绝；shutdown 的取消不能覆盖边界业务状态；观察器 dispose 后追加的最后 native 事件仍能从 process-exit 见证读取。旧 reader 只读取 `evidence.json` 时没有这些后续结算能力，不能沿用为新资格。

`process-exit` 仍不是业务成功标记。缺失见证、强制退出或 `captureErrors` 表示证据不完整，不能补造最终事件或关闭结论。本次修改不改变 B0 历史预算语义、旧运行结果或已有证据哈希。后续实际运行采用 Root 另行冻结和授权的无 token 门协议。
