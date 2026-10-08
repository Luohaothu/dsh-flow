---
title: 一步步完成 DeepSeek 实战任务
description: 从安装和模型配置开始，通过主会话发起活动预算核对，查看真实工具计算、独立复核和交付文件。
---

# 一步步完成 DeepSeek 实战任务

本教程使用 DeepSeek 官方 API，完成一次有明确输入、独立复核和文件交付的活动预算核对。操作从主会话的 `/agent-team` 命令开始；计算、写文件和审计均由实际运行的团队完成。

以下截图取自 2026 年 10 月 8 日的真实 API 案例。点击图片可查看原始尺寸。

准备一份可用的 DeepSeek API Key、Node.js `^22.19.0 || >=24.0.0` 和 pnpm `12.9.1`。模型请求使用服务账户的额度。密钥只通过宿主读取的环境变量提供，配置文件和报告保存变量名。

## 1. 安装并构建

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm run build
```

当前 Harness 基线为 `0.1.7-rc.2`，需要本仓库冻结安装中的提供方接口补丁。创建独立的宿主目录和工作区，打包插件并安装到 `web` 配置方案：

```bash
FLOW_DEMO_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flow-home.XXXXXX")"
FLOW_DEMO_PACKAGE="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flow-package.XXXXXX")"
FLOW_DEMO_WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flow-budget.XXXXXX")"

pnpm --dir packages/dsh-flow pack --pack-destination "$FLOW_DEMO_PACKAGE"

DSH_HOME="$FLOW_DEMO_HOME" node --import tsx src/host/dsh-launch.ts \
  plugin --profile web add "$FLOW_DEMO_PACKAGE/dsh-flow-0.1.0.tgz"
```

后续命令继续在同一终端执行，保留这三个变量。安装的包自带团队服务、原生观察界面与 `/agent-team` 命令；更多安装说明见[开发环境搭建](/development/setup)。

## 2. 接入 DeepSeek 官方 API

模型提供方使用 `deepseek`，模型为 `deepseek-flash`，服务地址为 `https://api.deepseek.com`。模型名称和请求协议见 [DeepSeek 官方 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)。

仓库的 [deepseek.patch.yml](https://github.com/Luohaothu/dsh-flow/blob/main/examples/deepseek.patch.yml) 配置这条宿主模型路由。将它作为最后一层覆盖配置，应用在已安装插件的实例配置之后。模型解析、上下文、输出与默认压缩由 DSH 处理。

配置中的凭证引用写为普通 YAML 字符串：

```yaml
apiKeyEnv: FLOW_MODEL_API_KEY
```

DSH 在运行时读取这个名称对应的环境变量。配置保存变量名，密钥值由下面的终端输入提供。

在终端输入密钥并导出配置引用的环境变量；输入不会回显：

```bash
read -r -s -p "DeepSeek API Key: " FLOW_MODEL_API_KEY
printf '\n'
export FLOW_MODEL_API_KEY
```

在同一终端启动宿主，保留密钥环境变量，依次应用实例配置与 DeepSeek 模型配置：

```bash
DSH_HOME="$FLOW_DEMO_HOME" \
FLOW_DATA_DIR="$FLOW_DEMO_HOME/flow-data" \
FLOW_WORKSPACE="$FLOW_DEMO_WORKSPACE" \
node --import tsx src/host/dsh-launch.ts \
  --profile web --patch examples/instance.patch.yml \
  --patch examples/deepseek.patch.yml \
  --host 127.0.0.1 --port 8791 --no-open
```

启动后打开宿主打印的访问链接。在主会话选择本次工作区，核对输入框旁的模型为 `deepseek-flash`。工作区决定本次文件任务的输入和交付位置。

[![已选工作区、官方模型 deepseek-flash Off 和空白输入框](/images/deepseek-case/01-workspace-model.png)](/images/deepseek-case/01-workspace-model.png)

## 3. 在主会话提交完整需求

在原生输入框输入以下需求，然后点击“发送消息”：

```text
/agent-team 帮我核对活动预算：场地费 1500 元、物料费 680 元、茶歇费 420 元，总预算 3000 元。
请在当前工作区安排执行智能体使用真实 flow_sum 工具计算总支出和剩余预算，使用 fs_write 写入 budget-report.md，再用 fs_read 读回核对。报告应包含费用明细、计算式、总支出、剩余预算及是否超预算。
产物验收标准：总支出 2600 元，余额 400 元，不超预算；报告文件与真实工具返回一致。
另按正式独立审计流程安排 Auditor：通过 flow_query 查询已 SETTLED 的 write 效果，检查真实文件路径、写入内容和成功结果，并在自己的会话中重新调用 flow_sum 复算 [1500,680,420] 与 [3000,-2600]。
Auditor 审查的是已结算写入证据，禁止声称它直接使用 fs_read 读取文件。产物核验与独立审计都通过后，在主会话如实交付文件路径和各角色实际使用的证据，并完成团队收尾。
```

提交后，主 Agent 读取这次需求、评估任务并调用创建工具。等待实际创建确认，顶栏出现“智能体团队”，会话增加“智能体”标签。

[![在原生输入框准备完整的预算核对需求](/images/deepseek-case/02-request.png)](/images/deepseek-case/02-request.png)

完成后仍可展开主会话的创建工具记录，核对团队绑定与创建结果：

[![主会话保留的实际团队创建工具与返回](/images/deepseek-case/03-created.png)](/images/deepseek-case/03-created.png)

## 4. 查看团队分工

进入“智能体”标签，查看总协调、资源分配、审计和任务执行成员。点击节点查看该成员的职责、状态与原生对话；拓扑连线表示实际派生关系。

任务开始前，编排角色安排预算核对工作，资源分配角色为执行者分配工具能力和工具额度，审计角色负责独立复核。具体人数和分工以这次运行的实际记录为准。

本次共四位成员：总协调“云言”、资源协调“明宁”、任务执行“若然”和独立审计“景禾”。

[![真实运行中四位成员的拓扑、职责和状态](/images/deepseek-case/04-topology.png)](/images/deepseek-case/04-topology.png)

## 5. 核对工具计算与文件写入

选择负责预算计算的成员，在只读对话中展开“已调用工具”，查看输入与返回结果。检查计算使用本次三项费用，并确认文件写入落在当前工作区。

本例的验收基准是：

| 检查项 | 应得到的结果 |
| --- | --- |
| 总支出 | `1500 + 680 + 420 = 2600` 元 |
| 剩余预算 | `3000 - 2600 = 400` 元 |
| 是否超预算 | 未超预算 |
| 交付文件 | 当前工作区中的 `budget-report.md` |

代理详情分别显示当前配置模型和最近实际模型。Token 数字表示宿主已记录用量；字段缺失时仍可能显示“未知”或“可能不完整”，不能据此推断提供方账单金额。

下面两张图分别显示执行者的总支出计算和余额计算；工具组可以内部滚动阅读。

[![Worker 使用 1500、680、420 计算，真实返回 2600](/images/deepseek-case/05-calculation.png)](/images/deepseek-case/05-calculation.png)

[![Worker 使用 3000 和负2600计算，真实返回400](/images/deepseek-case/05-remaining.png)](/images/deepseek-case/05-remaining.png)

随后实际写入并回读 `budget-report.md`，再提交候选结果：

[![Worker 真实文件写入、回读和候选结果提交记录](/images/deepseek-case/05-file-verification.png)](/images/deepseek-case/05-file-verification.png)

## 6. 查看独立复核

打开审计成员的原生记录，核对它通过 `flow_query` 查询该事务的 `effects` 和具体 `effect`，审查已结算（`SETTLED`）写入记录中的文件路径与完整内容，并独立重新调用 `flow_sum` 计算总支出和余额。检查三项费用、工具返回与写入内容一致，再查看 `inspect_validation` 的 `APPROVED` 结论。

Worker 负责实际文件读写和回读；Auditor 使用控制角色的查询工具审查写入证据。执行者提交候选文件后，还需要全部验证项通过、独立复核与正式接受。

如果团队在主会话提出问题，在原主会话回答；选中节点或打开记录只改变阅读状态。

[![独立 Auditor 自己调用计算工具，复算得到2600与400](/images/deepseek-case/06-remaining.png)](/images/deepseek-case/06-remaining.png)

正式验收工具返回 `APPROVED`，事务状态成为 `ACCEPTED`：

[![Auditor 的 inspect_validation 实际输入及 APPROVED、ACCEPTED 返回](/images/deepseek-case/06-audit.png)](/images/deepseek-case/06-audit.png)

## 7. 领取并核验结果

回到“对话”，查看主 Agent 的最终答复和文件位置。在工作区打开 `budget-report.md`，逐项对照上表。任务完成后，团队应保留已接受结果、审计与会话记录；可继续打开成员历史。

[![主会话实际交付文件、计算结论和审计方式](/images/deepseek-case/07-delivery.png)](/images/deepseek-case/07-delivery.png)

本次真实产物可下载：<a href="/downloads/deepseek-budget-report.md" download="budget-report.md">budget-report.md</a>。它包含三项费用、两条计算式、支出 2600 元、余额 400 元和“不超预算”的结论。

[![团队已完成，四位成员的真实历史仍可阅读](/images/deepseek-case/08-history.png)](/images/deepseek-case/08-history.png)

## 本次真实运行记录

案例标识为 `deepseek-budget-live-20261008-03`，通过官方 `https://api.deepseek.com` 路由调用 `deepseek / deepseek-flash`，推理等级为 `off`。一个业务事务的 7 项验收全部通过，独立 Auditor 批准结果，团队完成并收尾；最终 10 项案例检查与 17 项独立只读核验均通过。

主会话记录 36 次模型结算、2,861,540 tokens；团队记录 20 次、125,240 tokens；两者合计 56 次、2,986,780 tokens。这是本次宿主已记录用量，完整性为 `incomplete`，缺失字段保持未知，不据此估算费用。

[下载独立验收记录](/downloads/deepseek-case-receipt.json)，核对真实工具返回、文件摘要、审计、收尾和用量范围。记录同时保留最初的交付采集时序问题及只读复核说明；复核未改写业务数据库、原生会话或 `budget-report.md` 产物。

后续使用方法见[快速上手](/quick-start)，模型与团队默认值见[智能体配置参数](/configuration/agents)。
