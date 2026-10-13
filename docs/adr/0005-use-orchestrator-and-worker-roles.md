---
status: accepted
---

# 以 Orchestrator 和 Worker 两类职责组织团队

为用少量通用角色表达多种集群组织模式，2026-10-13 的设计讨论决定只保留 Orchestrator 和 Worker，将原 Allocator 的资源分配职责归并到 Orchestrator。相较独立分配角色，这使任务规划与资源选择归于同一责任主体；其额外协调负担需要在后续配方和代表任务中检验。

本决定延续 [ADR 0004](0004-use-standard-native-agents.md)的标准 Agent 边界，角色划分不引入 Flow 对原生业务工具的裁剪或独立执行循环。主会话在所拥有团队中承担 Orchestrator，成员在委派时用 profile.role 声明 orchestrator 或 worker。研究、核验等专业职责通过名称、instructions 和 skills 细化；角色不改变实际委派关系及验收权。配置映射与默认值见[Agent 配置](../design/configuration/agents.md)，实现与验证证据见[实施验证](../plans/native-agent-simplification-validation.md)。
