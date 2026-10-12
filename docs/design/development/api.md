# 协作 API

六类成员工具名为 `flow_task`、`flow_result`、`flow_review`、`flow_message`、`flow_read`、`flow_control`。

参数和返回值的权威定义是 `src/types.ts`，服务是 `src/service.ts`。调用者 Session 来自实际执行环境，参数不接受伪造身份。

| 接口 | 必要输入 | 含义 |
| --- | --- | --- |
| task | delegate/update 及工作说明或 task_id/version | 委派标准成员或修改工作 |
| result | task_id、summary，可选 artifacts/outcome | 记录执行者当前版本交付 |
| review | result_id、accepted、notes，可选 evidence | 委派者接受或退回具体交付 |
| message | to、content，可选 task_id/mode | request 或 notice |
| read | 可选 team_id、what、id、offset、limit | 分页读取 team/task/member/result/messages/events |
| control | target、id、action | 对团队、成员或任务 pause/resume/cancel |

主会话入口 `agent_team_create` 接收工作目标和 intent_id；read/message/control 入口连接当前主会话拥有的团队。创建入口和成员六类工具复用同一服务。

创建团队仅建立团队和根任务，根任务归已有主 Agent；`flow_task` 委派时才创建成员。子任务由委派者实际检查和接受，根交付由主 Agent 提交 `flow_result` 后通过 `flow_review` 确认。完成团队不会关闭主会话。

同一操作 ID 在相同调用者、团队与参数下幂等；同一 ID 参数冲突必须拒绝。两个有意相同内容的新任务使用不同操作身份。

业务工具和检查直接调用原生工具，不需要 Flow 的计划或证据绑定。Review 只表示对当前具体 Result 的决定，partial/blocked 不能自动接受。

Pause 设置协作调度标记，并启动原生取消与排空；resume 通过正常输入继续工作。宿主没有原生 pause API。任务暂停只针对该任务，不中断同一成员正在执行的另一任务。
