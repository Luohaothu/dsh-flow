# dsh-flow

Flow 提供持续存在的 Agent 团队、正式作业、模板目录及 DSH 原生适配。团队创建和任务派发分别执行；作业结束后，成员继续空闲并可复用。

包入口同时导出 Cordis 插件的 `name`、`inject`、`Config` 和 `apply`，通过 DSH Loader/profile 安装并接收宿主的 volatile 配置引用，后端服务为 `ctx.flow`。程序直接构造后端时使用 `FlowPlugin.create(host, plainConfig)`。主会话的 `/agent-team` 注入技能、任务与已接纳附件，由会话 Agent 查询、创建或复用团队，再独立派发作业。团队释放工具只安装到真实普通主会话的局部作用域。Flow 成员安装 `team-strategy`、角色正文、编排工具、模板及作业工具；主会话始终位于团队树外。

`/agent-team` 用户入口需要宿主启用同一份 DSH `0.2.0-rc.2` 安装树中的 `@deepseek-ai/dsh-tool-skill`，由其消费用户技能手势并注入技能正文。宿主管理该消费者，Flow 在接纳新请求及材料接纳完成后检查它是否已就绪且对当前主会话可见；缺失、未就绪或仅属于其他会话时拒绝请求，用户消息不会投递。已成功请求复用原结果，在途同参请求等待原处理完成；失败后补齐宿主能力，可以重试原请求。

配置使用以下字段：

| 字段 | 内容与生效方式 |
| --- | --- |
| `defaults`、`cwd`、`rootRole` | 新运行的显式覆盖；未覆盖模型、工作目录、preset 和权限从发起主会话的当前有效配置捕获。既有运行与 Profile 保持创建时快照。 |
| `patternSources` | 内置模式包之外的目录；保存后重新加载，为新运行创建目录快照，既有运行保持原目录。加载诊断通过 `ctx.flow.diagnostics()` 返回。 |
| `maxConcurrentAgents` | 服务级共享执行容量，默认 4；`ctx.flow.configure()` 更新后续准入，已执行成员继续完成。 |
| `cleanup` | `gracefulTimeoutMs`、`immediateTimeoutMs`，分别默认 120000、10000 毫秒，进入新运行快照。 |
| `stateDirectory` | 运行记录和原生资源配方的状态目录，默认 `.dsh-flow`。 |
| `connection` | 本机 HTTP/SSE 的端口、静态目录、允许来源与价格表。修改后需重启服务生效。 |

`ctx.flow.configure(config)` 接收完整配置，立即更新新运行默认值、模式目录及后续执行容量，并返回需要重载的 `stateDirectory`、`connection` 字段。`getConfiguration()` 返回当前实际生效值，`getRequestedConfiguration()` 返回期望配置；状态目录与连接字段在重启前继续显示当前实际值。插件卸载停止命令和普通会话工具安装，移除仍活会话中的局部工具，并释放本插件的团队资源；宿主服务继续由宿主管理，清理失败向调用方报告。

包同时导出 `Agent`、`Context`、`Mailbox`、`Group`、`RunService`、`AssignmentService` 和 `PatternCatalog`。子路径 `core`、`host`、`run`、`assignments`、`patterns` 提供对应模块。`dashboard` 导出投影、HTTP 服务与客户端；浏览器使用 `dashboard/client` 和 `dashboard/protocol`。模板包与 `skills/` 随包发布。

在工作区根目录运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`，分别检查类型、合同及构建产物。原生合同测试采用实际 DSH rc.2 服务与确定性本地模型适配器，不调用外部模型。设计依据见[设计文档](../../docs/design/design.md)，阶段范围见[实施记录](../../docs/alignment/README.md)。

安装插件后，`ctx.flow.dashboardAddress` 提供实际绑定的本机地址，默认由操作系统选择端口。看板客户端使用同一份展示协议；服务提供查询、fetch SSE 和停止接口。访问先以明确允许的 Origin 换取短期 token，后续请求携带 Bearer；同源页面换取 token 时可使用同源 Referer 与 Sec-Fetch-Site。服务只绑定 loopback 并校验完整 Host。`connection.allowedOrigins` 声明额外的精确页面来源，`dsh-app://app` 和服务自身来源默认允许。

`connection.prices` 是模型价格数组，各项为 `{ model: { provider, id }, currency, input, output, cacheRead?, cacheWrite? }`，费率单位为每百万 token。用量保留实际模型，缺失用量或价格时展示不可用，不按零计费。

看板实例 ID 与 SessionID 分开；冷恢复创建新实例，旧卡片保留。列表和每个 Run 维护独立游标，快照与续订共享同步屏障；持久写入失败时保留真实展示状态、断开增量流，恢复后从包含完整状态的新持久段建立基线，原日志继续保留。

共享 React 界面同时用于独立 Web 页面与 DSH 原生面板。原生入口为全局“智能体”面板、主会话内页签及团队导航；成员观察使用宿主只读会话引用读取完整原生记录，关闭观察仅释放读取引用。设置通过宿主 profile 的修订号保存，区分继承、本地覆盖、保存成功、运行态应用失败及需重启字段。

当前宿主目标是锁定的 DSH `0.2.0-rc.2`。仓库 `pnpm-workspace.yaml` 声明八项必要 SDK 适配：四项用于只读会话引用、阅读器与会话内导航，四项用于稀疏 profile 继承及真实配置持久化。`pnpm install --frozen-lockfile` 应用这些工件；Native 功能须运行于这份适配后的宿主。普通 Flow tarball 不会修改已安装的桌面 App。

## 在锁定宿主中安装

仓库声明的 pnpm 版本和 `pnpm-lock.yaml` 共同固定 DSH `0.2.0-rc.2`、八项 SDK 适配与构建依赖。以下示例从空的项目内 `DSH_HOME` 启动；CLI、Flow 及其 SDK peer 必须解析到同一份安装树。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir packages/dsh-flow pack --pack-destination "$PWD/.artifacts/dist"
export DSH_HOME="$PWD/.artifacts/demo-home"
node node_modules/@deepseek-ai/dsh/lib/bin.js web --help
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add "$PWD/.artifacts/dist/dsh-flow-0.1.0.tgz"
cp examples/flow.patch.yml "$DSH_HOME/profiles/web/cordis.patch.yml"
node node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open
```

官方插件管理器会把 Flow 同时加入依赖与 profile 的 bundle 列表；重复添加保持一个 bundle。进入宿主后在原生设置中选择实际可用的模型、权限和工作区，使用 `/agent-team` 开始协作。完成有效模型配置后，空闲团队和模板成员的创建本身不发起模型调用。

独立 Web 资源随包发布，`ctx.flow.dashboardAddress` 返回实际本机地址；Native 注册入口和阅读器使用同一实例的数据。SDK 适配的文件、必要能力与验证记录见[实施记录](../../docs/alignment/README.md)。匹配 Desktop 必须加载同一份适配后的 SDK；普通 tarball 只安装 Flow 包，不改写其他宿主。
