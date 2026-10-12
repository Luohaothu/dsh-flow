# 代码结构

| 位置 | 职责 |
| --- | --- |
| `packages/dsh-flow/src/core/controller.ts` | 六类协作操作与团队生命周期 |
| `packages/dsh-flow/src/core/store.ts` | SQLite 协作事实和操作幂等 |
| `packages/dsh-flow/src/core/runtime.ts` | 标准原生 AgentHandle 的创建、输入、取消与关闭 |
| `packages/dsh-flow/src/service.ts`、`types.ts` | 共享接口和 DTO |
| `packages/dsh-flow/src/client/` | 任务展示及原生会话观察 |
| `src/host/` | 开发用独立宿主、profile 和日志读取 |
| `tests/unit/`、`tests/integration/` | 最小协作不变量及原生运行验证 |
| `tests/acceptance/` | 隔离真实模型验收 |

Host 和 Client 的 Cordis 类型分别编译，公共 DTO 不混入两端 Context。开发宿主使用正常 DSH app 和公开 API，不建立另一个执行调度器。
