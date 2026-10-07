# UX 1.4 实现与验证记录

本记录对应 [ux-design.md](ux-design.md) 的 D0–D6，并按日期保留历次验证记录。主会话 `/agent-team <需求>` 加载 skill，由主 Agent 创建、读取、控制和收尾团队；观察视图只读，点击智能体进入完整原生会话。未回收智能体支持原生输入框中的文本续聊，回收后保留对话和轨迹。旧 Cluster panel 与集群模式预设的生产注册和交互绑定已移除，SQLite 历史及底层程序化服务保留。后文较早记录中的主会话替换渲染及只经主会话输入的限制已被后续修订取代。

## 提供方与版本依据

运行基线是锁文件中的 DeepSeek Harness `0.1.7-rc.2`、Cordis `4.0.4`、pnpm `12.9.1`。2026-10-07 核对了实际安装包的公开声明、导出、原生实现及官方文档；[版本和补丁 SHA-256 清单](ux-provider-baseline.json) 用于复验。npm 没有提供可核实的 `gitHead`，因此不推断这个发行包对应的上游提交。官方仓库的 `master` 文档是架构参考，当前代码契约以这个发行版及下列显式补丁为准。

官方来源：[Web Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md)、[Conversation](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/conversation.md)、[Slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.zh.md)、[Conversation UI](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/README.md)、[Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md)、[Layout](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/README.md)。

| 区域 | 实际提供方及公开接入 | dsh-flow 的业务内容 / 差异 |
|---|---|---|
| 安装、启用、卸载、插件卡片 | `dsh.bundle.patch`、Plugin Manager `plugins.bundle.config`，key 为包名 | 标准卡片，独立显示设置；不另画管理页 |
| 命令与主输入框 | Commands `register`、原生 `/` 提交和 `session/event` | 一个 `/agent-team`；稳定提交意图与主会话归属 |
| 顶栏 | Conversation `conversation.session.header.actions` | 唯一团队按钮，原生 Button、MenuSurface、锚点定位与关闭钩子 |
| 智能体标签 | Conversation `conversation.view`、`registerViewPresentation` | 按主会话启用的只读、contained 内容；保留宿主其他视图 |
| 宽 / 紧凑详情 | Dockkit `DockSurface`、`applyOp`、`DockIntents` | 画布铺满内容区，详情悬浮；宽屏并列对话 / 信息，紧凑时详情标签，提供方负责分隔条与尺寸调整 |
| 子会话 | Sessions `retain/release`、Slots `SessionProvider` / `renderFactorySlot`、官方 `conversation.content` | 在真实 SessionReference 下挂载完整原生会话；分组、折叠、阅读位置和分页均由官方组件管理；不驱动子代理 |
| 图片 | 官方 Chat 的 `conversation.message.images` 和 Attachment 提供方 | 原生会话自动接入图片展示；移除独立观察图片插槽 |
| 设置离开提示 | 原生 `Modal`、`Button`、Layout 导航守卫 | 三项离开选择，保存结果确认后才导航 |
| 主题、焦点、状态 | Primitives、`--dsw-alias-*`、`--dsw-radius-*`、宿主字号 | `.flow-*` 业务内容样式；不覆盖宿主私有 DOM 或全局样式 |

## 明确的公开接口缺口

全部扩展以 `pnpm-workspace.yaml` 的 `patchedDependencies` 固定到同一发行版，冻结安装会校验补丁。未打补丁的同版本 npm 宿主不具备完整接入契约；安装方式见 [开发环境](../design/development/setup.md)。

| 补丁包 | 新增或修正的公开契约 |
|---|---|
| `dsh-commands` / `dsh-api-remotes` / `dsh-api-gateway` | `execute` 可选 `submissionId`；保留旧直接 / agent-scoped 参数与 AbortSignal 调用 |
| `dsh-client-ui-commands` | 命令失败保留输入；丢失确认时复用 sessionStorage 意图，成功确认后清除；未启用 / 已卸载时保留 `agent-team` 词法拒绝，原生 Modal 指向插件管理 |
| `dsh-client-ui-conversation` | 顶栏拥有 `selectView/currentView`；`registerViewPresentation` 提供按会话 availability、contained、readOnly、按可用会话替换默认视图的 `replaces` 策略；官方 `conversation.content` 的 `readOnly` / `initialFollow` 输入传至标准会话和 Chat 插槽 |
| `dsh-client-ui-chat` | command-only 会话也可显示对话；标准 Chat 节点 owner 的 `readOnly` 控制分支、反馈和执行动作；`initialFollow` 使用原生阅读位置存储 |
| `dsh-client-ui-renderer` | Factory 递归检查按名称和实际 Session generation 区分；允许跨会话嵌入官方 Conversation，仍拒绝同一作用域及返回祖先会话的循环 |
| `dsh-session-format-v3-to-v4` | V4 恢复允许通知先进入 surface、首个系统消息随后追加，与官方 Session 的 fold 语义一致；保留系统首节点保护、替换范围、事件来源和轮次关系校验，不修改历史 |
| `dsh-api-session-controller` | 公开 `historyError`、`allowUnlisted` 和 `observationOnly` 保留选项；目录预检放宽后仍验证真实历史，订阅策略传至服务端禁止冷会话 promotion。新代打开清理分页状态，旧代拒绝不污染新代 |
| `dsh-api-session-controller` / `dsh-session` | `registerSessionDriver` 将子会话的原生 prompt / cancel 路由给 Flow；输入能力来自驱动策略，冷历史读取不启动普通 Agent。启动意图可标记为 ignorable 元数据，保留记录并避免干扰冷恢复提示词 |
| `dsh-client-ui-subagent` / `dsh-client-ui-workspace` / `dsh-client-ui-conversation` | 完整原生子会话导航与 `conversation.session.header.lineage` 公开面包屑；会话保留选项随导航传递，返回所属主会话 |
| `dsh-client-ui-dockkit` | `allowTabDrag=false` 用于固定观察布局；仍使用原生标签聚焦和分隔条调整 |
| `dsh-client-ui-layout` | `addNavigationGuard/requestNavigation`，以实际提交回调延迟导航 |
| `dsh-client-ui-plugin-manager` / `dsh-client-ui-workspace` | 插件、面板及工作区导航进入同一公开守卫 |

注册随 Cordis 调用方生命周期释放。Reader 每次保留的 SessionReference 均释放；观察轮询串行并以代次栅栏隔离旧请求；进度公告的异步读写在卸载后停止。补丁属于提供方公开接口扩展，不将原型 DOM、截图坐标或原生私有组件作为插件生产入口。

### 官方会话渲染修复（2026-10-07）

此前逐条投影 ChatNode 的适配器将内部调度输入当作用户气泡，固定详细呈现策略，并丢失官方轮次分组与收尾节点，因此出现大块 JSON、独立角色时间行及字体不一致。现已移除自定义消息列表、投影和观察图片插槽，通过公开 Slots 工厂在 ready 的观察 SessionReference 下挂载完整 `conversation.content`。官方 Chat 管理原生轮次、思考、工具详情、图片、阅读位置和分页；业务 CSS 不再覆盖其字体和按钮。

发行版缺少只读工厂输入，且原有递归检查只比较工厂名、隐藏输入框的规则会匹配嵌套详情。上述提供方补丁补齐只读参数，以实际 Session generation 检查递归，并将布局规则限制到当前视图；主会话保留一个原生输入框，详情不挂载输入框。代理信息页的压缩时间另改为已记录原生 summary 对应事件的时间，避免把压缩后 Token 数量当成日期。

最终构建、冻结安装、文档构建和差异检查通过，基础测试 **386/386**、本次针对性回归 **30/30** 通过。浏览器逐个检查真实 Hello World 运行 `2af0dab6-093b-4742-9e0d-cd092007e310` 的四个代理：原生轮次为 4 / 2 / 3 / 1，分析、资源分配、文件读写、审核及工具输入输出均能展开。主对话输入框为 1，详情为 0；已移除的消息行和会话修改按钮均为 0。本轮复用真实历史验证渲染，没有重新执行模型任务。

证据、各代理截图和最终 Chrome 主对话截图在 `.artifacts/official-chat/`，最终已安装包的四个入口与构建字节一致。`18791` 实例保留原有配置、凭据和历史；本机开发 HMR 的文件监听曾阻碍启动，检查实例额外加载只关闭 HMR 的临时 overlay，以稳定检查已安装包。提供方版本及补丁摘要已同步至 [清单](ux-provider-baseline.json)。

## 主对话与紧凑展示修复（2026-10-07）

之前以嵌入式 `conversation.content` 替换主对话，正文宽度停在 920px，而原生宽度把手只影响所属主会话的输入框。真实浏览器拖动复现后先修正了工厂布局类型；随后根据“主对话应直接与用户交流”的反馈，彻底移除 `dsh-flow-main` 替换注册，直接保留官方主 Chat、输入框及统一宽度轴。后台总协调日志只产生思考与工具调用，不能充当用户对话，也不能伪造正文补齐。

`/agent-team` 使用官方主 Agent 的 `followup` 接收实际用户需求。主代理作为用户交互的总调度，通过 skill 评估任务并调用 `agent_team_create` 创建团队，以 `agent_team_read` 检查并轮询状态，通过 `agent_team_message/control` 下达指令，以 `agent_team_finalize` 完成终态收尾；后台总协调执行计划与事务。重要结束、受阻或等待用户通知通过官方持久化 inbox 唤醒主代理，由模型产生真正的正文回复。普通追问及结束后对话保持原生行为。通知按持久化 `team_runs` 的所属会话发现，通过官方 `sessionController.inspect/resolveAgent` 恢复已释放的主代理；仅枚举实时 Session 会漏掉冷会话。去重同时读取已消费消息与持久化待消费 inbox，防止重启时重复投递。各角色详情仍观察它们自己的真实会话，不复制或改写主会话历史。

冷启动复现还发现：发行版 V4 校验器拒绝“通知先于首个系统消息”，但官方 Agent 的系统提示投影会产生这种顺序，官方 Session 也能原样重放。补丁删除这一处过时的拒绝条件，保留所有其他关系校验。修复前真实所属会话的 68 个事件通过原生重放、持久化恢复失败；修复后使用原文件恢复，并验证旧事件前缀保持一致。回归另覆盖已存在的系统首节点仍不能被普通消息覆盖。

智能体工具栏仅保留拓扑与列表。后端投影保留真实 `role`，图与列表使用蓝、绿、黄、紫底色区分总协调、资源协调、质量审核与执行代理；连线采用宿主次级文字颜色及不随缩放减细的 1.75px 描边。顶栏灰色下拉使用官方 MenuSurface 与锚点定位，宽度上限 360px、高度上限 420px；每行两层信息，名称 13px，状态、用量、耗时 12px。不再重复目标长文或回收徽标。设置移除通信范围与摘要两个无对应入口的选项，旧存储字段保留解析兼容。

本轮宽度修复的浏览器前后记录在 `.artifacts/chat-width/`；紧凑菜单、主会话、各角色详情和新 Hello World 的检查记录在 `.artifacts/compact-feedback/`。该记录只以本轮实际检查为准；下面早期规模及旧工具栏验收保留历史口径，不代表本轮重新通过。

最终完整构建、冻结安装、文档构建和差异检查通过，单元及验收基础测试 **391/391** 通过。实际新运行 `b7573b48-cfa3-4ca3-909a-30bd9fd24a1a` 已完成：总协调、资源协调、审核、执行四个真实会话分别为 4 / 2 / 3 / 1 轮，逐个打开并展开原生过程与工具内容，详情无输入框。主会话呈现真实用户需求、启动回应、完成交付及正常追问，共 4 轮；冷重启恢复后未重复投递完成通知。文件 `hello-world-ui.txt` 实际字节核对为 `Hello, World!\n`，14 字节；历史中模型的 13 字节推断不作为验证依据，也未改写其原始上下文。

浏览器测得四角色下拉为 **360×271px**，每行 52px，名称 / 状态字体 13 / 12px，浅灰 MenuSurface，与触发按钮左侧对齐。官方左右宽度把手各实际拖动 24px，正文和输入框同步缩放并恢复；把手贯穿内容区，未出现在消息内部。新安装包的 `index/client/command/web` 四个入口与最终构建字节一致。

### 下拉行与箭头修复（2026-10-07）

箭头复用 Primitives 的 Chevron SVG，修正字符基线偏移。按最新用户反馈，标题、状态、用量和耗时组成一个 Button 打开完整对话；右侧独立按钮通过官方 Resources、SidebarRightTabs 与 sidebarRight.openResource 打开只读原生对话。顶部箭头与子树箭头使用 160ms 翻转，遵守减少动效偏好。键盘树事件不拦截子按钮的 Enter / Space，叶子保留空位；列表同步修正。

团队只读投影加入 `model`，按实际请求回执的创建顺序选择每代理最近模型，未请求时采用该代理已解析的路由；选择新的下一请求路由不会改写旧运行显示。下拉行、列表行和拓扑节点只在实际悬浮时于状态右侧显示模型，长名称截断，信息面板保留完整模型名称。证据位于 `.artifacts/row-feedback/`。

## 使用反馈修复（2026-10-07）

用户实际运行显示：团队固定使用示例的本地模型，该地址不可连接，协调代理连续请求错误后进入 BLOCKED；投影遗漏此状态，误显示为未知。代理历史已持久化，但普通客户端目录不包含独立角色会话，`retain` 在读取历史前拒绝。图区的 React 被动滚轮监听和焦点条件又使放大手势交给浏览器。

修复通过主会话的公开 `modelSelection` 投影、最新请求头和默认模型获取下一请求路由。启动时绑定每运行模型，主会话选择变化同步到该会话未结束团队，其他会话保持独立。默认对话经公开 `replaces` 呈现总协调原生 Chat 上下文，所属主会话输入框继续接收后续指令。主对话与历史检查使用独立观察器，查看历史不会改变正文当前接收团队。独立角色历史使用显式 `allowUnlisted` 选项，保留服务端历史鉴权，并以 `observationOnly` 阻止原生 cold follow 自动 promotion；读取不会创建或驱动 Agent。

画布占满内容区；工具和原生详情面板悬浮，不因打开面板改变图的尺寸。非被动画布监听接收两方向缩放并维持指针下坐标，移除焦点要求。重复只读提示与设置说明移除，常用状态、消息身份和请求错误使用中文。

## 数据与执行边界

`team_runs` 将运行绑定到主会话与提交意图，启动在 SQLite 事务内幂等。相同标题不作为身份；同一意图重试与成功后的主动再次提交分别处理。`teamRead` 校验归属并在同一事务中投影所有代理、消息与用量；内部分页读到结束，超过 500 个身份也保留。客户端丢弃旧版本或旧选择的响应，断连保留最后完整快照。

父代理来自实际创建 / 分配身份。未知父关系保留待补全状态。`team_observations` 保存工作结果与结束时间，`TERMINATED` 只表达资源回收。等待用户包含原始问题；普通主会话消息按原生日志序号去重，入队后仍显示等待，实际权威轮次开始才解除。等待协作者指向实际执行或审查对象。阻塞状态投影为“受阻”，已知停滞原因仅结合相同节点、角色及受阻事件序号之前的对应请求结果显示中文错误说明；原始诊断仍保留在执行事件中。

用量分开表达累计 Token、当前上下文及预算条目。未知、零、估算分别显示；团队用量从请求回执去重汇总，共享预算按作用域展示，不将不同单位或各代理重复看到的共享额度加总。多个运行的模型请求上限、许可及等待队列独立保存，启动新团队不会改变已有团队的窗口。

每个主会话 / 运行持有独立选择、筛选、折叠、画布和详情；对话由官方 Chat 以原生 Session 身份保存阅读位置。标准会话组件直接消费完整节点与轮次分组，重开、分页和跟随使用原生滚动及历史读取机制。Flow 不再逐条投影消息或另存阅读锚点。

浏览器 Remote 只包含 `teamRuns/teamRead/list/read/events/query/report`。启动、控制、调度和测试 IPC 不属于观察接口。主智能体的 `agent_team_read/control` 在原生工具调用上下文中校验主会话归属。普通输入、执行确认与进度公告通过原生会话记录展示。

## 验证与证据口径

真实宿主集成入口是 `tests/acceptance/checks/panel.ts`：运行实际发布包、标准插件组合、认证 API、原生输入框和提供方组件树。证据写入 `.artifacts/<run-id>/artifacts/team-ui/`，包含断言、原生页面截图、可见布局尺寸、API 响应和客户端异常。报告同时保存构建摘要并拒绝中途代码漂移。设计原型截图不作为通过证据。

原生模型场景验证命令、等待、普通答复、权威轮次及执行收尾。只读规模和边界数据使用明确标注的持久化观察夹具；较早消息由原生 Session API 写入并经实际分页 / 订阅读取。夹具只证明显示与读取契约，不声称 1000 个模型真实并发执行。恢复、预算、调度、通信和业务结果另由确定性原生执行场景验证。

| 验收 | 主要实现与可重复验证 |
|---|---|
| A01–A05、A35 | 原生命令、丢失确认重试、唯一入口、键盘 / 悬停；原生预设与工具作用域验证 |
| A06–A10 | 真父身份、快速选择、只读检查器、两种完整会话返回入口、主输入框答复 |
| A11–A12 | 原生增量消息、未读、历史分页及 stable ID / seq 锚点 |
| A13–A18 | `core/team.ts` 与 `team-ux.test.ts` 的权威投影、资源 / 执行区分、计量、旧版本 / 重复响应 |
| A19–A22 | 原生断连 / 重连、深层路径搜索、固定画布位置与新增提示、减少动态效果 |
| A23–A26 | 实际内容宽度三档布局、七项设置、保存 / 取消 / 默认、存储失败及导航守卫 |
| A27–A31 | 结束历史、局部错误、键盘访问、50 / 200 / 1000 节点与每运行隔离 |
| A32–A34 | 本文提供方映射、锁定补丁、主题 / 容器适配及独立 Spec / Standards 复审 |

验证命令：`pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test`、`pnpm test:mock`、`pnpm docs:build`。浏览器需要本机 Playwright Chromium，可通过 `FLOW_CHROMIUM_PATH` 指定；每次验收使用独立 profile、工作区和数据库，不修改用户既有部署。

### 使用反馈修订前的复验（2026-10-07）

冻结安装、完整构建、文档构建及 `git diff --check` 均通过。单元与验收基础测试 **368/368** 通过；`pnpm test:mock` 的原生契约检查 **11/11** 通过，八个场景全部 `PASSED / PASS`，构建漂移均为空。

| 场景 | 最终运行号 |
|---|---|
| smoke | `smoke-20261006T205537Z-3e5f00` |
| recursion | `recursion-20261006T205537Z-ab9aff` |
| recovery | `recovery-20261006T205537Z-360e5f` |
| context | `context-20261006T205537Z-e58172` |
| browser | `browser-20261006T205537Z-e05bde` |
| panel | `panel-20261006T205537Z-a79581` |
| scale16 | `scale16-20261006T205537Z-9da490` |
| scale64 | `scale64-20261006T205537Z-941af9` |

每个运行的完整报告位于 `.artifacts/<运行号>/report.json`。最终 panel 的原生界面断言 **50/50** 通过，截图及布局记录位于其 `artifacts/team-ui/`。浏览器场景通过实际 MCP 工具读取可访问快照、确认原生中文声明、点击插件管理，再读取页面标题与正文。

验收宿主为每个进程创建独占的短 socket 目录，避免 macOS 的 Unix socket 路径限制；隔离的 `TMPDIR` 保持原用途，socket 目录随宿主关闭清理。启动失败通过 `error/close` 立即结束等待，真实缺失可执行文件的回归测试覆盖这一清理路径。主题检查等待原生设置写入确认并检查实际主题后再关闭窗口。前两轮未通过报告保留作诊断，不计入上述通过结果。

`dsh-flow-0.1.0.tgz` 的 **18 个导出目标**完整，最终构建与打包代码一致，旧 `panel/operations` 编译文件不存在。产物已在独立 `web` profile 安装并冷启动；唯一服务配置、七项设置及零客户端异常均验证通过。打包审计与冷启动结果位于 `.artifacts/ux-package-final/`，汇总记录位于 `.artifacts/ux-final/report.json`。这验证了锁定提供方补丁下的安装契约；未经补丁的 npm 宿主仍按前述接口缺口处理。

### Spec 独立复审

**PASS，未关闭问题 0 项。** D0–D6 与 A01–A35 的对应实现、原生接入及证据边界已复核；最后的中文声明确认和宿主清理修复未弱化验收条件。

### Standards 独立复审

**PASS，未关闭问题 0 项。** 提供方公开接口、只读消息投影、工具递归、生命周期、主题和导航守卫均通过；审查发现的启动失败清理问题已修复，并由审查方独立运行回归测试确认。


### 使用反馈修订后的复验（2026-10-07）

冻结安装、完整构建和文档构建通过；单元及验收基础测试 **373/373**、原生契约检查 **11/11** 通过。下列八个确定性模型场景全部 `PASSED / PASS`，最终面板原生断言 **59/59** 通过。F01–F06 补充验证默认总协调上下文、全幅画布、未聚焦时双向缩放、冷历史及重连不提升 Agent、历史检查不改变主对话接收方、不透明主题背景和窄屏列表无遮挡。

| 场景 | 修订后运行号 |
|---|---|
| browser | `browser-20261007T021452Z-dc6aab` |
| context | `context-20261007T021452Z-381bf9` |
| panel | `panel-20261007T021452Z-b1dd48` |
| recovery | `recovery-20261007T021452Z-1e3bfa` |
| recursion | `recursion-20261007T021452Z-5aa8aa` |
| scale16 | `scale16-20261007T021452Z-34feca` |
| scale64 | `scale64-20261007T021452Z-b02b70` |
| smoke | `smoke-20261007T021452Z-f6d52e` |

两位独立审查方的 Spec 和 Standards 复审均为 **PASS**。传输契约遗漏先通过真实两端 codec 回归复现，再补齐 `observationOnly` schema、契约元数据及 `resync` 策略；修复后两项 codec 检查均通过。渲染检查又确认宽屏、紧凑及移动端布局，新增代理提示不会遮挡初始总协调节点。

重新打包后的 18 个导出目标完整，已安装包的四个运行入口与本次构建字节一致。原 `18791` 检查实例已在保留配置、凭据、数据库和会话的条件下升级、冷启动并在 Chrome 打开；凭据文件与升级前备份一致。实际主对话显示总协调的 6 条原生记录和所属主会话输入框，客户端异常为 0。原油调研旧运行仍保留真实的受阻状态及连接失败历史，本轮未重新执行该业务任务。

汇总证据为 `.artifacts/ux-feedback-final/report.json`，打包核验、实际页面检查及 Chrome 主对话 / 画布截图在同一目录；最终原生面板截图位于 `.artifacts/panel-20261007T021452Z-b1dd48/artifacts/team-ui/`。前面“修订前的复验”属于上一版实现证据，不用于替代本次新增行为的验证。

### 执行默认值与节点身份（2026-10-07）

团队默认值使用官方 ConfigForm、SettingsFormModel、SettingsForm 和 SettingsValueField，经原生修订校验保存。配置以 Cordis Volatile 引用读取，每个新团队保存预算、限制、派发模式和模型选项快照；明确设置的团队模型不会被主会话选择覆盖，已有及冷恢复团队保留原配置。部署默认值可恢复，显示偏好与执行设置共同参与离开守卫。

拓扑根据子树宽度居中父节点并适配画布。节点使用稳定身份散列生成两字中文名字与 emoji 头像，右上角显示类型和状态。模型悬浮信息使用厂商 SVG 标识、间隔符与推理等级；实际请求回执新增 reasoning_effort，旧记录仅采用原生 lastUsed 投影，未知等级不猜测。

本轮完整测试 **396/396**、完整构建、冻结安装与文档构建通过。官方设置页实际保存串行、深度 1、子代理 2、代理总数 4、5 分钟、500000 Token 与 DeepSeek Flash / High；真实新运行 `9dbb910d-6d23-4307-b39f-10c7ee5a5148` 按这些值完成，总协调 / 资源协调 / 审核 / 执行分别 4 / 2 / 3 / 1 轮。测试后设置恢复原默认值，运行快照保留原限制；文件实测为 14 字节 `Hello, World!\n`。四个侧边栏详情使用原生 Chat，主会话正常显示真实需求与交付。证据位于 `.artifacts/latest-ux/`。

本地可编辑实例的部署策略已移入 profile 的 `cordis.patch.yml`。带同名 config 的命令行覆盖会被官方 ConfigEditor 判定为覆盖源，拒绝设置保存；生产使用可编辑 profile 配置，避免在启动命令中再次覆盖 dsh-flow 的完整 config。

### 完整原生子会话与续聊（2026-10-07）

智能体下拉与检查器的“打开完整会话”通过宿主 `openSession` 导航到真实 Session，并保留对话、轨迹、面包屑和所属主会话返回入口。检查器和右侧预览保持只读。未回收且团队未结束的智能体使用原生输入框；文本 prompt / cancel 经公开 `registerSessionDriver` 交给 Flow，保留角色、模型、权限、预算和调度所有权。已结束或回收的智能体显示历史记录说明，服务端同样拒绝新消息；已接受请求的断线重试仍按原始收件人去重。子会话附件暂由主会话提供。

主 Agent 的 skill 负责复杂度评估、创建参数、启动状态检查、有限等待的 read 和终态 finalize。首条子任务为普通 user prompt；后续通信按八类展示简要卡片，详情可展开。`flow/team-launch` 是可忽略的启动元数据，不作为模型任务正文，也不确定性创建团队。

实际模型运行 `2e7c9f72-d9c2-4aa3-a4f6-130311b00e76` 验证了原生输入框的人工消息持久化和送达、总协调转发、执行与独立审核分别调用 `flow_sum`、结果修订 2 的 ACCEPTED / APPROVED，以及 finalize 后四个智能体回收。两次独立计算分别确认 `2+3=5`、`5-3=2`。验证期间管理角色使用临时 32K 上下文，原部署 8K 设置已恢复；本记录不将该运行描述为 8K 配置的通过证据。

最终构建与基础测试 **414/414**、针对性原生测试 **3/3** 通过，最终 panel 运行 `native-agent-panel-20261007-final7` 的 **61/61** 检查通过，构建漂移为空。真实浏览器的冷会话导航、轨迹、回收后禁用输入和零客户端异常已检查。实际模型与页面证据保留在 `.artifacts/native-agent-session-20261007/`，模拟 panel 报告在 `.artifacts/native-agent-panel-20261007-final7/report.json`；这些本机证据目录不随源码提交。

### 仓库整理与提交前复验（2026-10-08）

冻结安装、完整构建、文档构建和暂存差异检查通过；基础测试 **414/414**、全部原生契约测试 **14/14** 通过。补丁基线已重新采集，15 个补丁的摘要全部与实际文件一致；依赖声明按名称排序，新增补丁维护说明及专用 Git 空白属性。快速上手和兼容性说明已与完整原生子会话行为对齐。

八个模拟场景逐项通过，报告的场景结果均为 PASSED、机制结果为 PASS、构建漂移为空。首轮 browser / panel 因 macOS 沙箱限制无法启动 Chromium，在沙箱外使用独立数据目录重跑后通过；失败报告保留用于诊断，不计入通过结果。最终 browser 为 **11/11**、panel 为 **61/61**。

| 场景 | 最终通过运行号 |
|---|---|
| smoke | `smoke-20261007T162633Z-de57c6` |
| recursion | `recursion-20261007T162633Z-c80ee3` |
| recovery | `recovery-20261007T162633Z-cb4ff9` |
| context | `context-20261007T162633Z-31ab03` |
| browser | `repository-ui-final-20261007T162751Z-b37c5d` |
| panel | `repository-ui-final-20261007T162751Z-f4b753` |
| scale16 | `scale16-20261007T162633Z-b0e1ee` |
| scale64 | `scale64-20261007T162633Z-9530cd` |

报告位于 `.artifacts/<运行号>/report.json`。源码提交包含实现、测试、文档和依赖补丁；构建产物、缓存、数据库、日志、本机配置与访问凭据继续排除。
