# 接口索引

Flow 的进程内接口使用对象引用。宿主工具将 Agent、群、材料和作业序列化为 ID，适配器解析目标并注入真实调用者。下列索引按调用者的工作路径组织，签名与完整契约链接到设计文档。

## 会话入口

会话 Agent 通过 RunService 选择团队、创建根和派发顶层作业。其身份来自宿主调用上下文。

| 工具 | 服务操作 | 完成含义 |
| --- | --- | --- |
| `flow_teams` | `RunService.list` | 取得该会话关联的团队快照。 |
| `flow_team_create` | `RunService.create` | 立即取得运行句柄，根异步创建。 |
| `flow_team_get` | `RunService.read` | 读取团队状态。 |
| `flow_team_assign` | `RunService.assign` | 顶层作业已保存并入箱，不等待模型执行。 |
| `flow_team_assignment_read` | `RunService.readAssignment` | 读取顶层作业快照与结果。 |
| `flow_team_assignment_cancel` | `RunService.cancelAssignment` | 取消所选作业及未结束后代。 |
| `flow_team_release` | `RunService.release` | 取消未结束作业并完成团队资源处理。 |

## 模板创建

| 工具或接口 | 输入与结果 |
| --- | --- |
| `flow_patterns` | 列出模板 ID、用途与参数声明。 |
| `flow_pattern_define` | 提交同格式候选模板与依赖文件，编译后供当前运行使用。 |
| `flow_pattern_apply` | 接收模板 ID、参数、可选节点覆盖及请求身份，返回成员、群和根管理指引。 |
| `PatternCatalog.resolve` | 按目录内唯一的模板 ID 解析定义。 |
| `applyPattern` | 以当前调用 Agent 为根创建实际成员与群，完成时对象和指引已就绪。 |

根使用创建结果管理成员，随后独立派发作业。模板结构及参数语法见 [团队模板](templates.md)。

## 作业管理

| 工具 | 服务操作 | 主要约定 |
| --- | --- | --- |
| `flow_assign` | 依次 `prepare`、`deliver` | 树内只派发给直属子 Agent，并明确上级作业。 |
| `flow_assignment_read` | `read` | 返回作业快照。 |
| `flow_assignments` | `list` | 可按上级作业和状态查询。 |
| `flow_submit` | `submit` | 检查子作业处置、校验结果并保存。 |
| `flow_assignment_cancel` | `cancel` | 真实发送方取消作业及未结束后代。 |
| `flow_material_read` | 宿主材料呈现 | 读取实际材料，并遵循接收者权限。 |

`AssignmentSpec` 描述任务，`AssignmentRequest` 连接发送方、接收方和上级作业，`AssignmentSubmission` 包含结果与子作业存续理由。完整定义见 [团队与作业接口](design.md#接口定义-1)。

## 编排对象

| 对象 | 主要职责 | 完整定义 |
| --- | --- | --- |
| `Agent` | 创建、恢复、派生、转移、通信与逻辑生命周期 | [Agent 接口](design.md#接口定义) |
| `Message` | 来源、时间、摘要与正文 | [消息](design.md#消息) |
| `Group` | 固定成员的群聊与共享黑板 | [群聊](design.md#群聊) |
| `Mailbox` | 收件、过滤、来源评级与读取状态 | [收件箱](design.md#收件箱) |
| `Context` | 对象登记、查找与生命周期管理 | [上下文](design.md#上下文) |
| `HostAdaptor` | 模型输入、原生会话、工具与资源映射 | [宿主适配器](design.md#宿主适配器) |

## 看板接口

看板通过认证后的本机 HTTP 接口取得快照，以事件流接续变化。`epoch` 标识进程代次，`seq` 是对应事件流的顺序号，`operationId` 标识一次停止操作。

| 接口 | 用途 |
| --- | --- |
| `GET /api/token` | 取得令牌、进程身份与协议版本。 |
| `GET /api/runs` | 读取运行列表及列表游标。 |
| `GET /api/events?after=<seq>&epoch=<epoch>` | 订阅运行列表变化。 |
| `GET /api/runs/<runId>` | 读取指定团队的完整快照。 |
| `GET /api/runs/<runId>/events?after=<seq>` | 订阅团队内部变化。 |
| `POST /api/runs/<runId>/stop` | 提交指定 Agent 范围的停止请求。 |

状态变更操作校验令牌和页面来源。事件顺序、重连和操作结果结构见 [查询与事件订阅](design.md#查询与事件订阅)。
