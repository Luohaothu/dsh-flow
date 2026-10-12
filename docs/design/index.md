# 标准 Agent 的轻量协作

Flow 将工作直接交给完整的 DSH Agent。任务、成员、结果和沟通可以在团队界面查看，业务执行留在原生会话中。

[快速开始](quick-start.md)介绍创建团队和检查交付；[协作接口](development/api.md)列出 task、result、review、message、read、control。宿主负责工具、模型、压缩、权限和后台作业。

当前实现不要求固定管理角色或正式计划状态机。简单任务可以直接完成，需要独立上下文时再委派。历史设计与运行记录保存在[仓库归档](https://github.com/Luohaothu/dsh-flow/tree/main/docs/plans/archive)，不作为当前操作指南。
