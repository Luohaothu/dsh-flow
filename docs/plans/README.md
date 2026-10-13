# 当前实施方案

本目录保留当前实施方案及其验证记录。被替代的旧方案进入 [archive](archive/README.md)，仅供追溯，不作为当前实现指令。

| 方案 | 状态 | 范围 |
| --- | --- | --- |
| [标准 Agent 精简方案](native-agent-simplification-plan.md) | 已实施并发布 | 标准 Agent、确定性启动、自然交付和一次根完成；移除预声明依赖等待图与重复确认 |
| [标准 Agent 实施验证](native-agent-simplification-validation.md) | 确定性机制验证 | 真实 Controller/SQLite 状态切面、幂等故障切点与脚本模型的原生链路；最终汇总以该记录为准 |

后续实现以当前精简方案为准。Auditor 移除及其验证、部署记录和上一轮 A 股诊断已进入[历史归档](archive/README.md)，保留当时事实，不作为新实现的守卫或协议要求。

用户已将验证范围转向第一性原理和确定性机制。严格模型对照安全中止，执行方案、验证草稿及观察草稿原字节保存在 [2026-10-13 归档](archive/2026-10-13/README.md)。已有报告与耗时属于历史观察，没有完整优化配对，不作产出排名或提速结论，也不继续未运行阶段。

[当前产品文档](../design/index.md)已同步标准 Agent 实现；最终构建与部署结果由当前验证记录汇总。另一任务的 `team-organization-patterns-discussion.md` 保持原文件，不纳入此次方案替换。
