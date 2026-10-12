# dsh-flow

Flow 为 DeepSeek Harness 的标准 Agent 提供轻量任务协作。成员使用宿主的完整 preset、工具、模型、上下文、审批和原生会话；Flow 保存任务、结果、接受记录、消息与团队归属。

简单工作由当前 Agent 直接完成。需要并行或独立上下文时，委派一个标准成员；同一成员可继续工作或再委派。团队不会自动创建固定管理角色。

## 使用

在 DSH `0.2.0-rc.2` profile 中安装 `packages/dsh-flow`，加载 [基础配置](docs/design/public/downloads/cluster.patch.yml)。从主会话使用 `/agent-team` 或 Agent Team 工具创建团队。团队界面展示任务与原生会话，执行与审批继续使用 DSH 的正常功能。

Provider 与默认模型保存在可编辑的 profile 中；启动 patch 不覆盖模型命名空间。已有部署可参考 [运行配置](examples/instance-runtime.patch.yml)。旧数据库不会自动迁移或删除；新实现使用新的数据目录。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:build
```

原生与真实模型检查分别运行，具体命令和证据要求见[验证方法](docs/design/development/validation.md)。模型端点失败、审批等待或模型未正确交付必须如实报告，不能以 HTTP 成功或文件存在代替任务完成。

- [使用文档](docs/design/index.md)
- [职责和术语](CONTEXT.md)
- [当前实施方案](docs/plans/native-agent-simplification-plan.md)
- [历史归档](docs/plans/archive/README.md)
