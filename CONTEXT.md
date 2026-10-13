# Flow 的边界与术语

Flow 的最小执行单元是标准 DSH Agent。DSH 负责 preset、工具与插件、技能、模型、上下文压缩、sandbox、审批、Inbox、取消、后台作业和 Session 日志。Flow 只提供协作事实和轻量调度。

## 协作对象

- Team：归属一个主 Session 的协作空间，包含目标、工作区、原生 preset 和可选模型选择。
- Member：一个标准 Agent 和原生 Session 的映射。成员身份就是 Session 身份；任务分工不裁剪工具权限。
- Task：工作说明、委派者、执行者、依赖和版本。任务修改使先前版本的交付不能完成新任务。
- Result：执行者提交的具体结果，包含摘要、产物引用、任务版本和 complete/partial/blocked。
- Review：委派者对当前具体子 Result 的接受或退回决定。检查通过原生工具完成；主会话本人完整根交付以一次 Result 声明完成，不另建自验收。
- Message：有稳定身份的成员消息。request 请求继续工作，notice 仅通知；实际进入模型必须有原生收据。

## 六类协作接口

`task` 创建或修改委派；`result` 提交交付；`review` 接受或退回；`message` 发送信息；`read` 分页读取事实；`control` 暂停投递、继续或取消。参数使用具体 schema，调用者来自真实 Session。

团队主会话的创建工具是入口，成员使用同一协作实现。幂等只覆盖 Flow 自身命令：同一操作身份与相同参数不会重复创建协作对象，有意重复的两个任务使用不同操作身份。

## 执行与生命周期

根任务由已有主 Agent 持有，创建团队不额外创建根成员。只有委派才创建成员；每个活跃成员持有一个原生 AgentHandle。正常回合结束保留 Handle；取消使用原生 cancel 并等待排空；真正关闭才 dispose。团队完成只清理 Flow 创建的成员，保留主 Agent。idle 只表示当前执行空闲，不表示任务接受或后台作业结束。

Flow pause 停止新增投递，并通过原生 cancel 停止、排空当前活动；resume 用普通原生输入继续。宿主没有独立的执行暂停能力。只有一个透明的 Agent 容量设置和用户明确期限；长期任务不再受工具、角色轮数、层级预算或进展事件计数限制。

协作中的目录分工是业务说明，实际隔离由宿主工作区与 sandbox 实现。Flow 不拦截原生业务工具，不建立写范围锁、工具副作用账本或逐次验收绑定。

## 证据

任务结果、原生执行和资源状态分别表达。运行验证必须核对实际 provider/model、native journal、工具结果和交付内容；未发生的检查保持未知。历史方案只提供历史背景，当前决策见 [实施方案](docs/plans/native-agent-simplification-plan.md)。
