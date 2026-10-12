# 当前实施方案

本目录保留当前实施方案及其验证记录。被替代的旧方案进入 [archive](archive/README.md)，仅供追溯，不作为当前实现指令。

| 方案 | 状态 | 范围 |
| --- | --- | --- |
| [标准 Agent 精简方案](native-agent-simplification-plan.md) | 实施完成 | 删除 Flow 重复执行控制、固定 Allocator、强制计划门禁、回合切分与层级预算；任务直达标准 DSH Agent |
| [标准 Agent 实施验证](native-agent-simplification-validation.md) | 实施完成，保留限制 | 区分历史诊断、普通任务质量基线、V3 实际协作与局部纠正，记录发布身份和历史接口问题 |

后续实现以精简方案为准。Auditor 移除及其验证、部署记录和上一轮 A 股诊断已进入[历史归档](archive/README.md)，保留当时事实，不作为新实现的守卫或协议要求。

[当前产品文档](../design/index.md)已同步标准 Agent 实现；真实任务与部署结果正在验收。另一任务的 `team-organization-patterns-discussion.md` 保持原文件，不纳入此次方案替换。
