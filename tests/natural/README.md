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

安装与私有模型配置完成后，可使用进程 runner 启动。上述 home、场景文件和证据目录都须位于当前仓库 `.artifacts/` 内，路径链不能是符号链接。

```sh
DSH_HOME="$PWD/.artifacts/natural/home" \
NATURAL_SCENARIO_FILE="$PWD/.artifacts/natural/private/scenario.json" \
NATURAL_PROOF_DIR="$PWD/.artifacts/natural/private/run-001" \
node tests/natural/run.mjs
```

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

需要业务澄清或连续任务时，可预先增加 `userPrompts`，按顺序登记完整自然输入。首条必须与 `prompt` 相同。例如在订单检查完成后继续检查退款表：

```json
{
  "userPrompts": [
    "/agent-team 帮我检查这份订单表有没有问题。",
    "/agent-team 这份退款表也帮我检查一下。"
  ]
}
```

观察器仍只通过正式入口发送首条需求。后续输入由测试者在真实界面中按场景预定条件发送；业务材料也通过正常用户操作提供。观察器不会代发后续消息、复制材料或唤醒会话。对于澄清场景，先确认 Agent 实际提出了业务问题，再按事先准备的业务答复表回答。

后续输入未到达、主会话已结束当前轮次并空闲时，证据中的 `awaitingUser` 为 `true`，`checkpoints` 保存当前用户事件的 `seq` 和观察时间。此时状态保持 `OBSERVING`，runner 继续保留宿主；检查点本身不表示业务已经完成。观察器只匹配真实 `user/message` 中与预登记文本完全相同的内容，并按顺序把 `index`、`seq`、时间和原文写入 `userTimeline`。完成通知、技能注入和同一事件的重复读取不会增加匹配数。

等待用户期间暂停无进展计时，整体时限、请求数和 token 边界继续生效。收到下一条预登记输入后开始新的无进展窗口。最后一条输入之后，必须有更晚的 `turn/end`，再按原有作业读回和连续空闲条件收敛；不会复用上一轮的结束事件。未配置 `userPrompts` 时保持原有单轮行为。

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

同一请求中的用量采用最后一次累计值，避免流式重复相加。缺失 `totalTokens` 的请求单独记录，不能计成已知的零消耗。已开始请求可能在返回用量时才越过总量边界，观察器会保留该请求并阻止后续请求。

无进展判断忽略聊天文字和重复查询，依据新成员、群、作业结果及新的成功工具结果更新。相同工具参数和结果不重复计作进展。模型请求在途时不触发无进展中止，整体时间边界仍然有效。所有阈值都只是本次观察的控制条件，不能作为产品故障结论。

达到边界后，外部 launcher 应保存现场并停止自己启动的宿主进程。观察器拒绝边界后的新请求，不发送催促消息，也不直接停止成员或改变作业状态。最终评分者核对业务产物、主会话交付、真实协作过程和界面证据。

语法检查如下。

```sh
node --check tests/natural/host.mjs
```

多轮团队场景默认在前一任务终态、读回且相关会话空闲后记录等待用户的检查点。`userTurnBoundary: "main-idle"` 用于事先登记的业务澄清，允许在主会话结束一轮后等待回答。检查点只记录用户操作时机，评分者仍需核对实际问题和任务结果。尚未结束的团队作业不会默认暂停无进展计时。
