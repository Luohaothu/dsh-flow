# 设计验收证据

以 `docs/design/design.md` 为唯一行为依据。旧 Controller、SQLite 协作状态、角色执行层和旧宿主夹具均已退出；旧测试不构成当前实现的行为约束。

`tests/contracts/` 按 Core、宿主、作业、模板、看板与 Native 分组，使用设计合同及失败竞争建立新测试。`pnpm test` 执行这些合同；`pnpm typecheck` 分别检查 Node 与 Client 类型。清单检查、Schema 子集、官方 Native API 再生成及 tarball 消费验证分别由 `test:inventory`、`test:schema`、`test:native-api` 和 `test:patterns-package` 执行。

每个场景的源码、测试和验证种类见 `docs/alignment/coverage.json`；旧组件、测试及宿主文件补丁的处置见 `docs/alignment/dispositions.json`。测试数量不等于场景数量，也不证明所有 UI 或真实模型场景已经执行。实际运行结论以分阶段验证记录为准。

实际安装验证固定 SDK 版本、补丁及依赖归属，从空依赖和空状态开始，再检查重复安装。Web、原生 SDK 界面和匹配版本 Desktop 分别记录运行产物与实际操作。真实模型场景使用独立状态和工作区，凭据通过受保护的宿主配置提供；报告只保存模型、输入、工具与结果证据，不保存密钥。
