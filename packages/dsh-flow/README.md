# dsh-flow

Flow 提供持续存在的 Agent 团队、正式作业、模板目录及 DSH 原生适配。团队创建和任务派发分别执行；作业结束后，成员继续空闲并可复用。

包入口同时导出 Cordis 插件的 `name`、`inject`、`Config` 和 `apply`，可通过 `ctx.plugin(Flow)` 安装，后端服务为 `ctx.flow`。主会话的 `/agent-team` 注入技能、任务与已接纳附件，由会话 Agent 查询、创建或复用团队，再独立派发作业。团队释放工具只安装到真实普通主会话的局部作用域。Flow 成员安装 `team-strategy`、角色正文、编排工具、模板及作业工具；主会话始终位于团队树外。

配置使用以下字段：

| 字段 | 内容与生效方式 |
| --- | --- |
| `defaults`、`cwd`、`rootRole` | 新运行的显式覆盖；未覆盖模型、工作目录、preset 和权限从发起主会话的当前有效配置捕获。既有运行与 Profile 保持创建时快照。 |
| `patternSources` | 内置模式包之外的目录；保存后重新加载，为新运行创建目录快照，既有运行保持原目录。加载诊断通过 `ctx.flow.diagnostics()` 返回。 |
| `maxConcurrentAgents` | 服务级共享执行容量，默认 4；`ctx.flow.configure()` 更新后续准入，已执行成员继续完成。 |
| `cleanup` | `gracefulTimeoutMs`、`immediateTimeoutMs`，分别默认 120000、10000 毫秒，进入新运行快照。 |
| `stateDirectory` | 运行记录和原生资源配方的状态目录，默认 `.dsh-flow`。 |
| `connection` | 端口、静态目录、允许来源与价格表配置。P4 进行校验；服务连接和界面在 P5/P6 接入。 |

`ctx.flow.configure(config)` 接收完整配置，立即更新新运行默认值、模式目录及后续执行容量，并返回需要重载的 `stateDirectory`、`connection` 字段。`getConfiguration()` 返回当前实际生效值，`getRequestedConfiguration()` 返回期望配置；状态目录与连接字段在重启前继续显示当前实际值。插件卸载停止命令和普通会话工具安装，移除仍活会话中的局部工具，并释放本插件的团队资源；宿主服务继续由宿主管理，清理失败向调用方报告。

包同时导出 `Agent`、`Context`、`Mailbox`、`Group`、`RunService`、`AssignmentService` 和 `PatternCatalog`。子路径 `core`、`host`、`run`、`assignments`、`patterns` 提供对应模块。模板包与 `skills/` 随包发布。

在工作区根目录运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`，分别检查类型、合同及构建产物。原生合同测试采用实际 DSH rc.2 服务与确定性本地模型适配器，不调用外部模型。设计依据见[设计文档](../../docs/design/design.md)，阶段范围见[实施记录](../../docs/alignment/README.md)。
