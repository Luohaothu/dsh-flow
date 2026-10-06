# 开发文档

修改 dsh-flow 前，先确定改动涉及任务规划、资源分配、执行机制还是宿主集成，再查阅对应组件。各类智能体负责作出业务决策；运行时和持久化层按既定规则校验权限、版本、租约和预算，并更新系统状态。

首次参与开发，请先按[开发环境搭建](/development/setup)安装依赖、构建并测试源码，再启动独立调试实例。日常使用集群的操作流程见[快速上手](/quick-start)。

## 代码与组件

[代码结构](/development/code-structure)介绍仓库目录、宿主端与浏览器端的分工，以及构建流程。各组件的职责如下：

| 组件 | 阅读目的 |
|---|---|
| [控制平面与调度](/development/components/control-plane) | 了解角色何时被唤醒、满足什么条件才能执行，以及集群如何完成收尾 |
| [任务单元与独立审计](/development/components/transactions) | 修改规划、结果提交、业务验收和独立复核流程 |
| [执行分配与组织调整](/development/components/allocation) | 修改执行分配、下级节点创建和节点迁移机制 |
| [智能体运行时](/development/components/runtime) | 对接宿主的执行轮次、工具策略、上下文和执行回执 |
| [持久化与恢复](/development/components/persistence) | 修改账本、命令幂等、租约与重启恢复机制 |
| [预算账本](/development/components/budget) | 了解额度预留、用量结算、层级调拨和资源归还 |
| [通信与共享黑板](/development/components/communication) | 修改消息、订阅、协作组和带有版本记录的共享信息 |
| [查询与可观测性](/development/components/observability) | 修改面板、事件游标、查询与报告 |

[API 手册](/development/api)介绍当前可调用的接口，[设计动作索引](/development/action-catalog)说明各类操作的设计意图和约束。开发时应结合两者核对实现范围。升级宿主前，先检查 [dsh 兼容性](/development/compatibility)。

## 验证顺序

修改系统机制后，先验证从规划到验收的完整流程，再检查返工、版本变更和重启恢复等情况，最后开展真实业务测试和规模实验。

| 验证范围 | 关键检查 |
|---|---|
| 基本执行流程 | 规划、分配、提交、验收和独立复核各环节完整；执行智能体不能自行接受结果 |
| 版本与返工 | 新计划不能沿用已失效的执行分配；新结果不能借用旧结果的验收或审查结论 |
| 递归协作 | 管理节点可以同时管理执行智能体和下级管理节点；下级交付仍需上级验收 |
| 生命周期 | 在提交结果、执行工具和归还额度等环节注入故障，检查恢复后的责任归属和证据是否完整 |
| 预算与上下文 | 压缩、审计、返工均计入用量；额度不足时说明阻塞原因，不自动追加预算 |
| 组织调整 | 替换、缩容和迁移必须等待执行达到可安全中断或交接的状态；调整后，任务责任、执行分配和预算归属应保持一致 |
| 真实业务与规模 | 固定任务、预算、模型和并发条件，分别报告结果质量、成本和性能瓶颈 |

规模报告应分别统计智能体身份总数、同时驻留的智能体峰值、模型请求并发数和实际完成的任务单元数。还应记录直接子节点数、层级深度、子树规模、管理角色的上下文大小、审计事件量和跨子树通信量。

若某个结果被撤销，其他管理域中依赖该结果的任务应如何处理；正在执行的子树如何迁移；根节点无法解决的问题如何交由用户或宿主处理；新增资源类型如何计量——这些机制都需要明确规则并经过验证，不能只依靠提示词约定。

项目验证入口：

```sh
pnpm run typecheck
pnpm test
pnpm run test:mock
```

具体实验场景与历史结果见仓库的[实施计划](https://github.com/Luohaothu/dsh-flow/blob/main/docs/plans/agent-cluster-plan.md)、[验收说明](https://github.com/Luohaothu/dsh-flow/blob/main/docs/reports/acceptance.md)和[测试记录](https://github.com/Luohaothu/dsh-flow/blob/main/docs/reports/test-results.md)。

## 维护文档站

站点根目录是 `docs/design`。新增 Markdown 页面后，在 `.vitepress/config.mts` 中添加导航项；主题与 Mermaid 渲染组件位于 `.vitepress/theme`。

```sh
# 本地编辑，默认只监听本机
pnpm run docs:dev

# 构建静态站点，同时检查站内死链
pnpm run docs:build

# 预览构建产物
pnpm run docs:preview
```

构建输出为 `docs/design/.vitepress/dist`。缓存和构建产物均不提交到 Git。部署到域名下的子路径时，在构建阶段设置 `DOCS_BASE`，例如：

```sh
DOCS_BASE=/dsh-flow/ pnpm run docs:build
```

正文中的站内链接从站点根目录开始，如 `/dispatch`；VitePress 会在构建时添加部署路径前缀。仓库源码、计划和实验报告使用 GitHub 链接，避免指向站点目录之外的本地文件。

图形使用标准的 `mermaid` 代码围栏，由 Vue 组件在浏览器中渲染，支持深浅色切换和源码查看。图形所需的依赖随站点一起构建，无需从外部 CDN 加载。编写规范可参考 [VitePress Markdown 文档](https://vuejs.github.io/vitepress/v1/guide/markdown)、[默认主题扩展](https://vuejs.github.io/vitepress/v1/guide/extending-default-theme)与 [Mermaid 使用说明](https://mermaid.js.org/config/usage.html)。
