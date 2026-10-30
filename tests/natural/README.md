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

每次使用新的证据目录。runner 拒绝已有 `evidence.json`、日志、入口 URL、进程回执或 `ui-ack` 的目录，避免把旧运行的终态算作新结果。私有输出文件权限为 `0600`，证据目录权限为 `0700`。

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

业务工作区仅包含正常用户材料。答案、检查器、原始证据和接入配置放在模型不可访问的位置。模型能力、凭据引用与工作区权限由专用 profile 正常配置，观察器不代替它们。

## 证据和观察边界

观察器写入权限为 `0600` 的 `evidence.json`，包含源文件哈希、SDK 所有者、正式入口回执、技能注入记录、逐请求工具目录与真实用量、会话原始事件、团队和作业快照。模型和服务身份可能出现在原始记录中，因此原始证据必须保留在私有目录。公开 PR 只附独立脱敏后的结果。

状态含义如下。

| 状态 | 含义 |
| --- | --- |
| `OBSERVING` | 正在记录真实执行。 |
| `SETTLED` | 普通校准主会话已结束，或主线顶层作业已有终态且主会话真实读回，相关会话连续空闲三秒。它不表示业务或自主协作通过。 |
| `ABORTED` | 到达请求、已报告 token、时间或无进展边界，或宿主在观察结束前退出。 |
| `ERROR` | 正式入口或观察器初始化失败，或记录过程发生错误。 |

`finish` 在清除轮询 timer 前同步重新读取 native histories、registry 和当前 Main 所属快照，然后冻结 `evidence.json`。结束后的流结算、`agent/disposed`、观察器 dispose 与进程 exit 读取写入独立的 `shutdown-evidence.json`，其中 `businessBoundary` 指向冻结原件 SHA，`scoringEligible=false`。进程 exit 通过已经持有的 native 会话对象保留观察器卸载后追加的最终事件。无法读取的组件写入 `captureErrors`，不能据此声称完整关闭。shutdown 的取消、快照和用量只用于技术收尾，不改写结束时的业务事实或评分。后续排空消费者若需要最新请求结算，应读 shutdown 见证，不能再依赖被冻结的 `evidence.json` 持续变化。

consumer 提前 return 会等待上游生成器真实关闭后记录 `cancelled` 和 `endedAt`，缺失用量继续列为未知。正常 return 不捏造 `error`；真实抛出异常记录 `failed` 和错误原因。

同一请求中的用量采用最后一次累计值，避免流式重复相加。缺失 `totalTokens` 的请求单独记录，不能计成已知的零消耗。已开始请求可能在返回用量时才越过总量边界，观察器会保留该请求并阻止后续请求。

无进展判断忽略重复查询和相同工具参数，记录新成员、群、作业结果及新的实质操作。模型请求在途时不触发无进展中止，整体时间边界仍然有效。所有阈值都只是本次观察的控制条件，不能作为产品故障结论。

达到边界后，外部 launcher 应保存现场并停止自己启动的宿主进程。观察器拒绝边界后的新请求，不发送催促消息，也不直接停止成员或改变作业状态。最终评分者核对业务产物、主会话交付、真实协作过程和界面证据。

语法检查如下。

```sh
node --check tests/natural/host.mjs
```

## N08 的普通 UI 手动隔离流程

B0 的自动入口只创建一个 Main。本节规定后续 N08 的手动取证，不声明本批已执行或通过 N08，也不从 B1 搬入多 Main 自动驱动。

1. 准备两个独立业务目录。两边使用相同文件名和字段结构，但内容不同，并在模型不可访问的证据目录分别保存材料 SHA 和预期归属。
2. 在正常 DSH UI 创建两个普通 Main，各自选择对应目录。两边输入完全相同的自然需求，例如 `/agent-team 帮我核对这批订单。`，不添加角色、工具或内部 ID。
3. 记录 UI 会话与原生 session ID 的对应关系。交错查看两边，分别记录各自 `Run.entry.callerSessionId`、根与成员 session、作业、材料引用、通知和完整结果。检查 Main 到所属 Run 的正向关联，也检查每份结果、材料与通知回到原 Main 的反向关联。
4. 核对两个 Main 各自实际读取的作业 ID、返回的 Run/作业身份及业务结果与本侧数据一致，另一侧身份或结果不能抵扣本侧完成。分别取得最终用户交付与返回原会话的 UI 证据。

单侧提交、不同 workspace 路径或后端快照不能替代同 prompt 不同数据的双向取证。两侧任一正式读回、业务交付或 UI 未完成，整例仍未闭环。

本地纯 stub 回归可运行 `node --test tests/natural/observer.test.mjs tests/natural/isolation.test.mjs tests/natural/runner.test.mjs`。它们不加载 SDK、不调用模型或外部 API，也不代表实际业务新一轮。

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

B3 的排空读取及新 wave 的原生 reader/join 应分别验证：边界有在途请求、随后成功结算；随后 cancelled 且无 usage；无效 SHA、身份改变、新请求、重复编号和终态回退均拒绝；shutdown 的取消不能覆盖边界业务状态；观察器 dispose 后追加的最后 native 事件仍能从 process-exit 见证读取。旧 reader 只读取 `evidence.json` 时没有这些后续结算能力，不能沿用为新资格。

`process-exit` 仍不是业务成功标记。缺失见证、强制退出或 `captureErrors` 表示证据不完整，不能补造最终事件或关闭结论。本次修改不改变 B0 历史预算语义、旧运行结果或已有证据哈希。后续实际运行采用 Root 另行冻结和授权的无 token 门协议。
