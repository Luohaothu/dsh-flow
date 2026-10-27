# dsh-flow

Flow 为智能体提供树状团队、消息协作、结构化作业和实时看板。会话 Agent 与用户沟通，团队根及各级成员自主组织工作；团队可以持续承接多份作业。

## 文档

[设计文档](docs/design/design.md) 是架构与接口约定的依据，VitePress 站点按阅读任务组织专题指南。设计描述目标行为，具体版本的能力由代码和运行验证确认。

- [团队使用流程](docs/design/quick-start.md)：选择、创建和复用团队，取得作业结果。
- [团队模板](docs/design/templates.md)：参数、直接命名的节点、子树引用与初始群聊。
- [作业与交付](docs/design/assignments.md)：任务内容、结果 schema、子作业处置和取消。
- [消息与协作](docs/design/communication.md)：消息、群聊、共享黑板及主动等待。
- [运行时与宿主适配](docs/design/runtime.md)：对象归属、输入处理和资源生命周期。
- [看板与宿主界面](docs/design/dashboard.md)：团队观察、成员会话与停止操作。
- [接口索引](docs/design/api.md)和[验证方法](docs/design/validation.md)：查找完整契约并建立验证证据。

## 预览文档

需要 Node.js `^22.19.0 || >=24.0.0` 和项目声明的 pnpm 版本。在仓库根目录运行：

```sh
pnpm install
pnpm docs:dev
```

生成与预览静态站点：

```sh
pnpm docs:build
pnpm docs:preview
```

## 参与设计与开发

先阅读[领域文档导航](docs/agents/domain.md)，确认当前设计、共享术语与实现的边界。模块方案与接口核验遵循 [module-design skill](.agents/skills/module-design/SKILL.md)。

问题和需求通过 [GitHub Issues](https://github.com/Luohaothu/dsh-flow/issues) 跟踪，操作规则见[问题跟踪说明](docs/agents/issue-tracker.md)。
