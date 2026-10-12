# 操作索引

Flow 的公开业务操作收束为六类：[task、result、review、message、read、control](api.md)。每类有具体参数 schema；详见代码 `types.ts` 和服务 `service.ts`。

工具操作返回协作事实，不结束当前原生模型回合。任务委派后成员可以继续工作；终态资源由生命周期清理。

本页不保留旧动作别名。历史预算、分配、正式计划和效果修复操作只见于归档记录。
