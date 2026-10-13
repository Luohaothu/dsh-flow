# 协作 API

六类协作工具名为 `flow_task`、`flow_result`、`flow_review`、`flow_message`、`flow_read`、`flow_control`。主会话与成员使用同一组接口。

服务参数和事实记录的定义是 `src/types.ts`，服务是 `src/service.ts`。模型工具及其收据定义在 `src/core/member-tools.ts`。调用者 Session 来自实际执行环境，参数不接受伪造身份。

| 接口 | 必要输入 | 含义 |
| --- | --- | --- |
| task | delegate/update 及 objective 或 task_id/version；可选 member_id 或 profile | 委派具有角色配置的标准成员或修改工作；父任务由实际调用者归属决定 |
| result | task_id、summary，可选 artifacts/outcome | 记录执行者当前版本交付 |
| review | result_id、accepted、notes，可选 evidence | 委派者接受或退回具体交付 |
| message | to、content，可选 task_id/mode | request 或 notice |
| read | 可选 team_id、what、id、offset、limit | 分页读取 team/task/member/result/messages/events |
| control | target、id、action | 对团队、成员或任务 pause/resume/cancel |

task/result/review/message 返回身份、版本或状态收据，供后续操作引用，不再次回显刚提交的工作说明、结果或消息正文。完整事实仍持久化，并可由 read 和界面读取。

新成员可传 `profile`（name/role/instructions/preset/model/skills），字段与默认值见[Agent 配置](/configuration/agents)。它由普通委派一次传入；成员记录、运行上下文和界面使用同一配置。复用成员或 update 不接受 profile，不允许静默更换持续职责。角色名称不授予验收权，实际调用者和任务归属仍是依据。

交付要求统一放在 `objective`，不另传 `criteria`。预声明 `depends_on` 与 `parent_task_id` 输入已经删除，无兼容入口。所有者在本团队委派时使用本团队根任务，成员使用其当前任务；同一 Agent 在另一团队拥有根任务时按另一团队归属处理。后续工作需要前置结果时，在实际收到结果后再委派。

`/agent-team` 命令直接创建当前主会话的团队与根任务，提交身份保持幂等。主会话和成员统一使用上述六类工具，没有另一套模型入口或别名。模型读取当前或明确指定团队；团队历史枚举由只读 Web 接口及界面提供。

创建团队仅建立团队和根任务，根任务归已有主 Agent；`flow_task` 委派时才创建成员。成员正常完成的简短最终返回在 idle/flush 后发布为 Result，显式 partial/blocked 保留其 outcome；子任务由委派者实际检查和接受。主 Agent 完成检查后用一次根 `flow_result complete` 完成团队，不创建自验收记录；未完成子任务会原子阻止根完成。完成团队不会关闭主会话。

同一调用者与操作 ID 唯一定位一次调用；类型和参数相同则重放原收据，类型或参数变化必须拒绝。两个有意相同内容的新任务使用不同操作身份。命令的稳定提交 ID 同时保护意图、团队和原生输入，复用 ID 时改变正文或附件同样拒绝。

业务工具和检查直接调用原生工具，不需要 Flow 的计划或证据绑定。Review 只表示对当前具体 Result 的决定，partial/blocked 不能自动接受。

Pause 设置协作调度标记，并启动原生取消与排空；resume 通过正常输入继续工作。宿主没有原生 pause API。任务暂停只针对该任务，不中断同一成员正在执行的另一任务。

同一成员的下一项独立任务只等待原生活动排空，不等待上一成果被接受。修改排队任务也不要求暂停正在做另一任务的成员。业务接受与原生执行槽分别管理。

当前 Flow 数据格式为 schema 8，旧 schema 5/6/7 明确拒绝；部署须使用新 Flow dataDir。原生 Session 历史、Provider 配置与凭据独立保留，不属于 Flow 数据格式迁移。
