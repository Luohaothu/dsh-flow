# dsh-flow

Flow 按[设计文档](../../docs/design/design.md)分阶段重建。当前包提供 `Agent`、`Context`、`Mailbox`、`Group` 和 DSH 宿主适配器；团队、作业、模板、入口工具与界面在后续阶段接入。

`dsh-flow` 和 `dsh-flow/core` 导出编排对象及合同类型，`dsh-flow/host` 导出 DSH 适配器与执行容量。当前构建产物用于基础模块验证，完整插件入口和安装验收在后续阶段完成。

在工作区根目录运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`，分别检查类型、Core/真实 DSH runtime 合同及模块产物。宿主测试使用实际 rc.2 服务和确定性模型适配器，不访问外部模型服务。

阶段记录及验证范围见[实施记录](../../docs/alignment/README.md)。
