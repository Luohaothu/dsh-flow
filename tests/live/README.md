# 真实模型 Flow 验收

此 runner 使用已安装的生产 Flow 包、官方 DSH CLI、AgentLoop 和 pi-ai adapter，验证工具调用、作业状态及资源生命周期。编排器给出受控任务与工具参数，模型发起实际调用；`p7_capture` 只保存观察值，`p7_gate` 只协调并发时序。二者不会代替作业派发、提交或结果读取。它不是模型能力或性能基准，也不属于默认合同测试。

## 准备

先按项目 README 完成匹配 SDK 的安装、Flow 构建和打包。宿主必须使用仓库声明的 8 个 SDK 适配，同一 CLI、profile 中的 Flow 和关键 SDK 应解析到同一安装树。

所有 live 路径必须位于当前项目的 `.artifacts/` 内。runner 在写入前检查路径和现有祖先的 realpath，拒绝指向外部目录的 symlink。使用本次验收专用 home；runner 会替换该 home 的选中凭据文档及 web profile 的 `cordis.patch.yml`。

先用官方 CLI 初始化专用 profile，并安装生产 tarball：

```sh
DSH_HOME="$PWD/.artifacts/p7-live/home" node node_modules/@deepseek-ai/dsh/lib/bin.js web --help
DSH_HOME="$PWD/.artifacts/p7-live/home" node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add /absolute/path/dsh-flow-0.1.0.tgz
```

确认 profile 的 `dependencies` 和 `dsh.profile.bundles` 已包含 `dsh-flow`。官方 plugin manager 会维护 bundle，不需要再次手动插入 Flow entry。

在受控 Node 进程或会话环境中提供 `P7_LOCAL_LLM`，其值是被选中的服务凭据。不要把值写进命令行、公开源文件或报告。runner 只将该 ref 写入专用 home 的 `.credentials.yaml`，权限 `0600`；子进程通过官方 `ctx.credentials` 读取它。日常 DSH home 和模型服务配置不在此 runner 的写入范围。

## 执行

在项目根目录运行：

```sh
node tests/live/runner.mjs
```

默认连接本机 `http://127.0.0.1:8000/v1`，使用 `Qwen3.8-27B-4bit`，SDK Web 端口为 `3090`。可显式覆盖：

| 环境变量 | 含义 |
| --- | --- |
| `P7_LIVE_HOME` | 项目 `.artifacts/` 内的专用 DSH home |
| `P7_PROOF_DIR` | 项目 `.artifacts/` 内的本轮证据目录 |
| `P7_LIVE_BASE_URL` | 真实 OpenAI completions 兼容端点 |
| `P7_LIVE_MODEL` | 该端点实际提供的模型 ID |
| `P7_LIVE_PORT` | SDK Web 端口（`1`–`65535`） |
| `P7_PHASE` | `all`、`main`、`restart`、`probe`、`single`、`herb` 或诊断用 `resume-probe` |
| `P7_MAX_REQUESTS` | 每阶段模型请求上界，默认 `120` |
| `P7_UI_HOLD_MS` | 截图检查点等待上界，默认 `180000` |

默认 `all` 先运行 `main`，正常停止 CLI 后再运行 `restart`。单独执行 `restart` 需要同一证据目录中的真实 `handoff.json`，以及同一专用 home 的会话持久化文件。`probe` 只验证一个真实原生工具调用；`single` 运行一份真实 Flow 作业及主会话结果读取；`herb` 另建空闲 Run 验证真实三次辅助总结/合并及语义保留。

官方 rc.2 adapter 的模型声明不接受仅有 `off` 的 reasoning 字典。默认 Qwen route 声明 `off` 与 `low`，验收请求固定使用 `off` 和 `enable_thinking:false`。其他端点的协议及能力应按实际配置调整，不能仅替换模型名就假定兼容。

每次请求最多输出 `1024` tokens；provider 无自动重试，HTTP/流空闲上界 `120` 秒，普通状态等待上界 `90` 秒，每个 CLI 阶段有 `19` 分钟验收期限。结束或中断后先发送 `SIGINT`，仍未退出时在 `10` 秒后强制终止本 runner 拥有的子进程。

## 场景与证据

`main` 验证创建空闲团队及嵌套模板、不同 schema 顶层作业、真实层级派发/提交、团队和成员复用、局部取消、忙碌主会话的 followup 通知与真实结果读取、显式释放及逻辑终止/物理清理/停止操作完成。`restart` 验证旧 Run 失效、归档结果可读、同 SessionID 的新恢复实例、空的新通信绑定及 `resumesAssignmentId` 后继作业。

模型调用通过官方 `llm/stream` 只读观测器记录实际 usage；原生会话保留真实 request、tool/call、tool/result 和轮次日志。编排器读取这些真实记录和已保存结果进行断言，不能用自制 adapter 或模拟提交替换此路径。

fixture 在它创建的 Agent scope 中使用官方 `tools.presentAs('native')`，并按当前受控命令呈现工具 schema；Flow 工具仍由官方 AgentLoop 实际调用。辅助总结记录完整输入、text-delta、最终 text block 和 finish reason，便于区分提示失败、截断和采集差异。这些观测不会改写请求、结果或原会话历史。

`herb` 的自动检查覆盖六章节、双方来源与关键约束、第五节双方未完成审批、第六节未消解分歧、原历史不变及 child 实际初始上下文；最终语义仍需人工核对，不能仅凭 token 出现或自动 `PASS` 推定归属与状态正确。

截图检查点写入 `ui-ready.json` 或 `restart-ui-ready.json`。截图 owner 完成后，分别创建同目录的 `ui-ack`、`restart-ui-ack`，可提前继续验收。`private-launch-url.txt` 是权限 `0600` 的一次性 SDK 登录入口，不应收入公开报告。

每阶段产生 `evidence.json`、阶段收据和 CLI 日志；原始模型输出、历史与 usage 位于专用证据目录。`PASS` 只覆盖收据中已完成的阶段。Web/Native 截图、matching Desktop、真实模型总结的语义审查分别留证，不能由普通合同测试或同名模型配置推定通过。

matching Desktop 可在其专用 profile 注入 `host.mjs`，设置 `P7_PROFILE_NAME=desktop`、`P7_PHASE=single` 及独立 `P7_PROOF_DIR`，并使用同一匹配 SDK 和真实 provider 配置。该模式的 Run 与 CLI 模式属于不同 runtime，应分别记录身份。
