# 代码结构

| 位置 | 职责 |
| --- | --- |
| `packages/dsh-flow/src/core/controller.ts` | 保留外部协作接口，转交协作规则与系统模块 |
| `packages/dsh-flow/src/core/collaboration.ts` | 协作事实、任务版本、交付验收与控制权限 |
| `packages/dsh-flow/src/core/agent.ts` | 会话唯一协作智能体、自身发送接收与原生执行状态 |
| `packages/dsh-flow/src/core/message-queue.ts` | 按接收会话异步交接消息 |
| `packages/dsh-flow/src/core/system.ts` | 组合智能体对象与队列，将执行工作封装为作业 |
| `packages/dsh-flow/src/core/agent-queue.ts` | 固定并行容量的作业调度，同一会话串行执行 |
| `packages/dsh-flow/src/core/store.ts` | SQLite 协作事实和操作幂等 |
| `packages/dsh-flow/src/core/runtime.ts` | 标准原生 AgentHandle 的创建、输入、取消与关闭 |
| `packages/dsh-flow/src/service.ts`、`types.ts` | 共享接口和 DTO |
| `packages/dsh-flow/src/client/` | 任务展示及原生会话观察 |
| `src/host/` | 开发用独立宿主、profile 和日志读取 |
| `tests/unit/`、`tests/integration/` | 最小协作不变量及原生运行验证 |
| `tests/acceptance/` | 隔离真实模型验收 |

宿主与客户端的 Cordis 类型分别编译，公共数据接口不混入两端上下文。开发宿主使用正常 DSH 应用和公开接口；作业调度由系统组合，原生模型循环由 DSH 执行。
