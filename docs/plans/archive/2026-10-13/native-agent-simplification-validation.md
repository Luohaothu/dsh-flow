# 标准 Agent 精简实施验证

状态：**实施完成**。V3 已构建、验证并切换到本地正式实例。本页区分历史诊断样本、V2 普通任务质量基线、V3 实际协作与后续局部纠正，不将某一旧构建的通过结果泛化到所有版本。首次报告错误、未形成完整性能对照和历史变更摘要接口问题均保留。

实现合同见[精简方案](native-agent-simplification-plan.md)。创建团队只建立 run 与由已有主会话持有的根任务，自动成员数为零；实际委派才创建标准 Agent。主 Agent 正常检查产物后，以 `flow_result` 和 `flow_review` 保存根交付与确认，不启动新评审模型或人工点击流程。

## 构建身份与验证阶段

| 阶段 | 身份与结果 | 证据范围 |
| --- | --- | --- |
| V1 普通组 | 559.141 秒正常完成；原始结构检查因 6 字节有效响应被任意长度门槛误拒 | 历史样本；原报告不改写，误拒原因单独记录 |
| V1 团队 pilot | 570.409 秒时有意停止；自动根成员与显式委派重复取数 | 诊断样本，不算模型最终失败，不与普通组组成完整性能对照 |
| V2 构建 | 构建通过、54 项单元测试通过；根任务归已有主 Agent | 普通组与诊断团队组采用下列相同冻结身份，未形成完整配对 |
| V2 普通组 | 原生正常完成，独立来源复核通过并披露限制 | `ordinary-v2-20261013/report.json`、`acceptance.json` |
| V2 团队 pilot | 614.700 秒有意停止；固定两成员提示诱导重复取数与额外核验分工 | `team-v2-20261013/intentional-stop.json`；原 runner `ERROR` 保留，不算模型最终失败 |
| V3 构建与真实团队 | 构建通过、63 项单元测试通过；团队自然完成；初始正文数字错误已保留，主会话随后局部纠正通过范围内离线复核 | 已发布构建；不与 V2 普通组混称同构建性能对照 |

V2 真实任务冻结指纹：

| 范围 | SHA-256 |
| --- | --- |
| Flow 源码 | `09d758584c5955c9016e014a56a0b22a4909f539523aeaeab85f8b83f5b76457` |
| Flow 编译目录 | `e685282876d7e28d462050d48b33cc20af8a7ea41912c0c5cc64632eb03e9646` |
| 真实任务 runner 目录 | `ff5a3acddb9739ef4950ddad75004b13789f853d3343699c306cb08c8e2cec9e` |
| Host helper 目录 | `fd01a968643e351d461d39e554010172453e69842e6cb2f578909ecd55f39352` |
| pnpm lock | `2dd7c27e2ddffcb1bcd958bbecc6997a0d5fec16deddf7a894c7e948f16a6b8c` |

目录摘要算法与前后核对值保存在 runner 和各组 `report.json`。普通组与团队 pilot 均前后相同，`build_drift=false`；V2 两组的源码、编译目录、skill、runner、Host helper 和 lock 已另存于团队 pilot 的 `frozen-runtime/` 并复核摘要。部署构建身份另列，不能用“源码大致相同”替代指纹。

## 实际原生执行

模型脚本仅产生工具调用，业务工具、原生 Agent、Session、preset、权限和持久化都实际运行。各报告保存自己的运行身份，不宣称下面所有历史证据来自同一个编译目录。

| 验证 | 已核对内容 | 本地证据 |
| --- | --- | --- |
| 标准 Agent 与 Flow 成员 | 相同有效工具目录、`ask`；真实读写、shell、同 Handle 多轮、取消、冷恢复及原生输入/选模 | `.artifacts/native-member/` 的各轮报告和原生日志 |
| 长回合与后续输入 | 同回合 32 次真实 read、15 轮后续输入，越过已删除的 Flow 24 工具/12 轮阈值 | `preset-1791825085378` 原生记录 |
| 公网与后台 job | 双路真实 `web_fetch` 读取有效 HTTPS 公网 IP；真实 job ID、`job_output` 完成回执与文件一致 | `.artifacts/native-member/preset-1791825085378/native-tool-comparison.json`、`web-jobs-comparison.md` |
| Browser MCP | 双路真实 Playwright MCP 导航、读取各自测试页快照，服务端记录两条访问；相同 catalog/ask，零外部模型请求 | `.artifacts/native-browser/preset-1791826788622/report.json`、`native-browser-events.json` |
| Provider 设置 | 隔离 profile 中新增、修改、冷重载、定向删除；保留原提供方/default，零模型请求 | `tests/integration/provider-settings.test.ts` 与对应运行报告 |
| 界面 | 真实生产组件和原生组件，业务数据为 fixture；主会话根任务与子成员分开显示 | `team-ui-1791827558703/artifacts/`：8 项检查、桌面/390px 手机、零 console/page errors；截图展示成员用量，不代表真实业务完成 |

V2 整体原生集成共 4 项通过，用时 16.6 秒；V3 修复构建再次整体 4 项通过，用时 15.66 秒。Browser 使用本机已安装 Chrome 的明确路径。首次未提供该路径时默认 chrome-for-testing 不存在，失败轮 `preset-1791826947684` 同样保留。

失败记录保留：公网 `example.com` 因本机 Fake-IP 解析触发原生 URL 拒绝；首轮 Browser MCP 因本机 socket 路径过长失败，测试后改用独立短目录。未放宽原生 URL、sandbox 或审批策略。

## V2 真实任务与诊断

V2 团队组 runner 曾预先要求独立取数/校验及至少两名成员。这是该对照的测试组织条件，不是框架需求；运行中已观察到主会话重复抓取已委派的指数，以及额外安排核验成员。不能将其解释为效率目标已经达成。V2 团队于 614.700 秒有意停止，保存当时所有已落盘响应与未知在途用量。后续真实团队验收已取消固定人数与评审分工提示，只要求实际协作，主 Agent 本人检查交付；不与 V2 普通组混算同构建性能对照。

两组均使用 `standard`、`qwen-token-plan-cn/deepseek-v4.1-flash`、`max`，独立新 home/workspace/data，顺序运行。任务为实际 HTTP 获取 2026-10-12 A 股收盘材料，保留 raw，交付报告与结构化数据；原用户工作区只读保留。

| 指标 | 普通组（正常完成） | 团队 pilot（有意停止） |
| --- | ---: | ---: |
| runner 总耗时 | 441.176 秒 | 614.700 秒时停止 |
| 原生执行区间 | 434.746 秒 | 未完成，不能计算完整区间 |
| 已落盘模型响应 | 41 | 139 |
| 工具调用 | 47 | 181 |
| Flow 控制调用 | 0 | 10 |
| 原生 input tokens | 101,910 | 364,195 |
| 原生 output tokens | 46,996 | 164,555 |
| 原生 cache-read tokens | 1,835,776 | 8,033,280 |
| 正常结束 | 是：单一 Session、1 个 completed 回合 | 否：主先空闲，两个成员仍在途，第三个成员尚排队 |
| 独立来源与数值复核 | 通过，披露脚本复现与字段命名限制 | 不作为完整交付验收 |

普通组来源复核已确认 35 个 HTTP 来源及 57 页实际原生回执，重算 5,572 条记录、成交额与涨跌数据；原 runner 报告仍保持 `AWAITING_SOURCE_REVIEW`，最终判定单独保存在 `acceptance.json`。已披露：一处取数脚本仍留错误代码，正确请求存在原生日志中，故仅运行列出的脚本不能完全复现；中间 `amount` 字段实际为日线 `volume`，最终报告成交额另有正确来源；宽度日期依赖抓取时点与带日期样本，因果新闻表述未全部独立证明。

Token 保留原生提供方字段，不转换成未经核实的货币成本。V2 没有完整性能配对，团队 pilot 的已落盘用量不包括未知在途费用。不得据此声称任务完成率、统计显著性或一般性能提升。团队主会话成本纳入完整原生日志汇总；界面中的“成员用量”仅表示子成员，不能当作完整团队成本。

Runner 只将自然结束且结构有效的任务标记为 `AWAITING_SOURCE_REVIEW`。模型自报的 HTTP 200、日期和核验结论不是最终通过证据；最终复核需将实际 HTTP 工具调用/结果、raw 日期与价格、报告和当前接受记录对照。最终 owner 回合必须匹配最新 start/end，且原生状态稳定空闲，不在成功路径额外 cancel 截断末次回答。

所有真实任务与失败记录位于 `.artifacts/native-agent-simplification/`。V1 原包字节已单独保存于 `team-final-20261013/frozen-runtime/`，摘要匹配当时两轮报告；不包含 node_modules、凭据或用户配置，也不宣称是独立完整开发环境。

## V3 团队与发布收尾

V3 在 V2 封存后修复两类真实缺陷：团队、成员或根任务取消时，按 cancel → drain/flush → dispose 释放 Flow 所有的子成员；成员创建尚未返回时发生关闭，返回后也不能派发旧工作，必须释放迟到的 Handle。普通任务取消仍保留 Handle 供该成员后续任务复用，已有主 Agent 不由 Flow 销毁。另一处将同成员任务顺序建立在持久插入顺序上，避免同一毫秒创建的后一任务越过尚未接受的前一结果。

相关 9 项确定性回归从 RED 转为通过：团队/成员/根任务关闭 3 项、单任务取消复用 1 项、创建尚在途时四种关闭路径 4 项、同毫秒任务顺序 1 项。全量单元共 63 项通过，生产构建通过。这 9 项使用受控 NativeFactory 验证控制器边界；实际 NativeMember 集成另验证真实 shell 取消、排空与 dispose。V3 真实团队中三个成员最终 closed，主会话在根接受后仍执行工具并完成响应，且随后能冷恢复纠正文件。以上覆盖不能描述成逐一路径的实际资源内存监测，也不把受控测试当作真实 shell 执行。

V3 同时取消 runner 固定两成员及取数/校验分工提示，公共任务源码段 SHA-256 仍为 `119b89a5ca22f0560fd7a2f821863dfec3fc76af84498feb78e02dce2cad1816`，日期、输出格式与模型不变。`team-v3-20261013/` 已在冻结构建上自然完成。运行器只要求存在一个确实产生原生模型响应和工具调用的协作成员，不规定产品中的固定组织。本轮模型自行委派两个独立业务部分，其中盘面成员又委派新闻取材，形成主会话 → 盘面 → 新闻的三层真实执行与接受链。


V3 完整执行记录为 `team-v3-20261013/report.json` 与 `execution-summary.json`，原运行器状态保持 `AWAITING_SOURCE_REVIEW`：

| 项目 | 实际结果 |
| --- | --- |
| 总耗时 | 764.660 秒（12 分 44.66 秒） |
| 原生执行 | 4 个 Session，5 个回合全部 `completed`；主会话最后回合 start seq114 → end seq309，稳定 `running=false` |
| 业务终态 | 团队 completed；根与三个子任务全部 ACCEPTED；三个 Flow 成员 closed |
| 模型与工具 | 170 个模型响应，204 次工具调用，其中 Flow 控制 17 次 |
| 原生工具错误 | 1 次 `web_search` 缺少独立的 Search API Key；Flow 控制调用无原生错误 |
| 提供方用量 | input 514,580 / output 175,505 / cache-read 7,899,904；170/170 响应有原生 usage |
| 最终文件 | `report.md` 18,275 字节；`market-data.json` 4,435 字节；raw 与失败材料保留 |
| 路线与指纹 | 实际 provider/model 与预设一致；五项运行前后指纹相同，`build_drift=false` |
| 独立来源验收 | 三指数和 15 个来源的实际 HTTP 回执已验证；正文附加累计涨跌有一处错误，不判整份报告完全通过 |

离线复核已对照原始快照、日 K、重算脚本输入及报告，确认当日三指数的日期、收盘和涨跌幅；JSON 中 15 条来源均能关联实际 HTTP 200 原生抓取回执。但正文 3.3 将 9 月 30 日开盘 3839.25 误作收盘，得出累计 −1.09%；原始日 K 的收盘为 3842.19，正确累计约 −1.17%。最终 QA 为 `OFFLINE_CONSISTENCY_ISSUES`，报告保存在 `team-v3-20261013/offline-source-review.md` 与 `offline-source-qa.json`。业务产物未被人工修改，运行器状态也未重写。该轮是执行完成与核心数据已核验的证据，整份报告仍有需要纠正的正文数字。QA 没有重新联网，也没有执行模型生成的 workspace 脚本；它验证本次保存材料与原生回执的一致性，未独立重算全部市场广度或新闻因果表述。最初 Unicode 负号解析误拒及修正过程也单独保留。

该记录证明本轮协作完成及资源状态，不证明比普通 Agent 更快或更省。V2 普通组和 V3 团队组的构建、组织指导不同，不能拼成完整性能对照。

V3 前后相同的目录身份：

| 范围 | SHA-256 |
| --- | --- |
| Flow 源码 | `1602e2829ecfd5eed011cf5bc7e6dbc0f59628bf7572806813cf6f69190994b1` |
| Flow 编译目录 | `ff4f33a8a9c4718001cd4c30a445573568b4dbe9bbf07c1dc5f5f332ca6d75cb` |
| 真实任务 runner 目录 | `b179cefedc518b63e431466a351b6443a33587b52061819fe32b818ffa4cc75c` |
| Host helper 目录 | `fd01a968643e351d461d39e554010172453e69842e6cb2f578909ecd55f39352` |
| pnpm lock | `2dd7c27e2ddffcb1bcd958bbecc6997a0d5fec16deddf7a894c7e948f16a6b8c` |

V3 先在独立 18793 实例验证 schema 6 / 8 表 / 零团队、认证入口从 401 到 200、默认 Qwen 提供方路线及原生 17 个会话保留，再切换正式 18791 实例。发布快照创建于真实验收启动后约几十秒；不能称为精确的运行起点快照。已交叉核对 skill 文件、package manifest 和 `lib/index.js` 字节与该快照相同；完整目录前后指纹仍由运行器终态报告给出。

### 已完成团队后的原生普通纠正

独立 QA 指出错误后，经明确授权，用同一冻结构建、原 home/profile/workspace 冷启动正常宿主，向原主 Session 发送普通后续，让它本人读取保存的日 K、重算并纠正。初始产物、4 个闭合日志、任务库与原报告/QA 已保存到 `team-v3-20261013/initial-sealed/`，229 个文件逐项 SHA-256 核对，文件/目录设为只读；凭据与 profile/runtime 配置未复制。原始 `report.json`、`OFFLINE_CONSISTENCY_ISSUES` 和 4 次接受事实不改写。

| 纠正阶段 | 结果 |
| --- | --- |
| 原生执行 | 原主会话第 3 回合，seq312 → seq361 正常 completed，稳定 running=false；59.523 秒 |
| 工具与用量 | 9 个模型响应、8 次真实工具调用（bash 4 / read 3 / edit 1），零错误；input 96,632 / output 5,318 / cache-read 737,536 |
| 产物变化 | 只修改 report.md 3.3 的一段，将 3839.25 / −1.09% 改为收盘 3842.19 / −1.17%，补充计算式 |
| 保持一致的证据 | market-data.json 与全部 raw 的摘要相同；无新增 Session，三个子成员日志摘要相同；Flow 全部 8 张表逐行相同 |
| 构建与记录 | 源码、bundle、runner、Host、lock、skill 前后相同；原主日志前缀及原运行器 report 字节不变 |
| 独立复核 | `CORRECTION_ACCEPTED_WITHIN_OFFLINE_SCOPE`；唯一改动为第 70 行，同节 9 个收盘价、6 个日涨跌幅与邻节成交量变化核对一致 |

纠正证据为 `correction/report.json`、`native-events.json`、`continuity-verification.json` 与 `corrected-report.md`。它证明已完成团队后，已有主 Agent 可按标准原生路径冷恢复并继续自己的文件/shell 工作；没有新建成员或重写团队接受记录。原错误是 QA 发现后的有指导纠正，不冒称原轮自主发现并一次交付无误。

独立复核见 `correction/offline-source-review.md` 与 `offline-source-review.json`：按保存的日 K 重算 `(3797.24 / 3842.19 - 1) × 100 = -1.1699057048%`，四舍五入为 −1.17%。封存的 229 个文件逐项通过哈希核验，125 个 raw 文件及 market-data 不变，原主日志的 311 行前缀、三个子日志与全部 Flow 表保持一致。纠正回合的 8 次工具调用都有成功回执，只有本地读取、计算和编辑，没有新增取数；模型推理仍使用原远程提供方。QA 首轮两项字段比较器误报另存 `offline-source-review-first-pass.*`，修正比较范围后复核，未改产物。这是局部纠正的一致性验收，没有重新认证整份财经报告、重新获取市场材料或改写初始团队验收结论。

原团队与后续纠正合计 179 个模型响应、212 次工具调用；原生 input 611,212 / output 180,823 / cache-read 8,637,440。两阶段运行器耗时相加 824.183 秒，不包含离线 QA 与两阶段之间等待，也不作为匹配的性能比较。分阶段用量保留于 `correction/combined-usage.json`。

### 正式实例与保留限制

正式实例为 `127.0.0.1:18791`，核验时 PID 49429、profile `flow-native`，安装目录 `.artifacts/local-native/package-v3`，新 Flow data 为 `.artifacts/local-native/data`，schema 6 / 8 表。六个编译入口及 skill 均与 V3 冻结构建一致；`lib/index.js` SHA-256 为 `51f6f36a1d23a1bf95d208d33f5d3bc1ff41148cd39e2fe6e4b80038f6607e1a`。原生 17 个会话保留，原/新 profile 配置与凭据文件的既有摘要保持一致。

实际系统 Chrome 检查记录为 `.artifacts/local-native/browser-qa/report.json`，结论 `PASS_WITH_NATIVE_HISTORY_RESOURCE_WARNING`：认证后刷新成功，默认模型显示 DeepSeek V4.1 Flash · Max，两段历史会话正文可读；提供方新增表单的 Base URL 为普通文本，未复现对象类型错误，检查后取消且没有保存。此检查没有发送模型请求，也不代替前述独立 profile 的完整 Provider CRUD 回归。空 Flow data 未新建业务团队；当前团队组件的视觉验证仍以明确标注 fixture 的截图为准。

历史会话的 `changes.summary` 请求仍返回 404，响应 `Change summary unavailable.`，刷新后可复现。观察到的正文仍可读，没有 JavaScript 异常或错误遮罩；不将其描述为零浏览器错误，也不把侧栏显示的 14 行误报成后端 17 个会话丢失。该原生历史变更摘要问题在本次交付中如实保留。

已删除退休的 schema 5 data、三个旧安装副本与旧启动 helper；原用户业务工作区、原生日志和本次封存诊断均保留。精确清理范围见 `.artifacts/local-native/retired-runtime-cleanup.json`。Git 提交与远端身份由交付时单独记录，不用文档构建或本地部署成功代替推送证据。

实施已完成，但本次没有得出团队更快、更省或一般任务质量更高的结论。V3 业务执行自然完成，首次报告的历史数字错误经原主 Agent 局部纠正并通过范围内复核；初始错误、失败诊断和所有阶段用量保持可追溯。
