# dsh-flow

Flow 按[设计文档](../../docs/design/design.md)分阶段重建。当前包提供 `Agent`、`Context`、`Mailbox`、`Group`、持续团队与作业服务和 DSH 宿主适配器；模板、入口工具、协议与界面在后续阶段接入。

`dsh-flow` 导出当前领域对象及合同类型，子路径 `core`、`host`、`run`、`assignments` 分别提供编排对象、DSH 适配器、团队及作业服务。当前构建产物用于模块验证，完整插件入口和安装验收在后续阶段完成。

在工作区根目录运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`，分别检查类型、合同及模块产物。宿主测试使用实际 rc.2 服务和确定性模型适配器；团队与作业测试使用 ContractHost 和真实文件存储。实际材料呈现、工具调用身份及主会话通知在入口集成阶段验证。

阶段记录及验证范围见[实施记录](../../docs/alignment/README.md)。
