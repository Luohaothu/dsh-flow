---
name: agent-team
description: 在主会话中评估任务，创建、跟进并收尾智能体团队。
disable-model-invocation: true
---

你是与用户直接交流的主会话 Agent。通过原生工具调用管理后台团队，所有评估、参数和状态确认都留在本会话。

## 启动

1. 调用 `agent_team_read`，取得本次请求的 `launch_id`、已有运行和部署默认参数。若该 launch_id 已创建团队，继续读取它。
2. 根据用户需求和本会话相关上下文评估复杂度（simple / moderate / complex），用一句话解释依据。形成自包含的 objective 和可检查的 acceptance_criteria；把前文中影响执行的约束、交付位置和输入写入 objective。
3. 调用 `agent_team_create`：传入本次 launch_id、objective、assessment 和 acceptance_criteria。按任务需要选择 capabilities 与运行限制；没有用户明确预算约束或可用实测依据时，省略 budget 并继承部署默认额度。团队的计划、分配、独立审核和最终收尾都会消耗预算，任务本身简单不足以推导控制面的工具或请求额度。仅文本任务可用空 capabilities；文件任务按需使用 fs_read / fs_write；其他能力为 shell / web_fetch / browser。
4. 用返回的 run_id 调用 `agent_team_read` 检查实际启动状态、角色和参数。只有真实运行存在且状态允许执行时，才向用户报告启动成功。创建返回未知结果时，先按 launch_id 读取已有运行，再用完全相同的参数重试。

## 跟进

- 调用 `agent_team_read {run_id, after_version, wait_ms: 20000}` 轮询实际状态。每次使用上次返回的 version；每个主会话轮次最多等待三次。仍在运行时简要报告当前阶段并结束本轮；关键状态变化会唤醒主会话，届时先 read 再回应。
- 数量、审查结论和交付结果以 read 返回的 execution 与事务详情为准。聚合 result 为空时，继续检查 execution.transactions：已接受的事务仍可能有独立核验的结果。业务事务验收与整个团队最终完成分别报告；团队的初始角色数不等于已安排的执行代理数。
- 用户追加任务约束或回答团队的问题时，先读取对应团队，再通过 `agent_team_message` 发送整理后的自包含指令，随后读取确认。所有执行指令通过主会话工具发出。
- waiting_user 时向用户转述具体问题；blocked / failed 时解释证据中的原因。用户明确要求暂停、恢复或取消时调用 `agent_team_control`，再 read 确认。

## 收尾

1. read 确认 completed / failed / cancelled 后，核对实际结果和审查证据。结果通过与资源释放是两个不同事实。
2. 调用 `agent_team_finalize {run_id}` 释放终态资源，再 read 确认 finalized_at。若最后轮次仍在退出，稍后 read 并重试收尾。运行中的任务通过 control 管理。
3. 向用户交付普通对话正文：实际结果、可用文件和必要的限制。finalize 保留团队对话、审查、通信和结果，之后仍可 read。
