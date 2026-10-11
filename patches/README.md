# Harness 提供方补丁

这里保存 DeepSeek Harness `0.2.0-rc.2` 的 14 个公开接口扩展。`pnpm-workspace.yaml` 的 `patchedDependencies` 是应用清单；`pnpm-lock.yaml` 固定补丁摘要与依赖解析。使用 `pnpm install --frozen-lockfile` 安装，直接修改 `node_modules` 的内容不会随仓库交付。

补丁保留上游的缩进和 unified diff 的上下文前缀；`.gitattributes` 仅为这些 `.patch` 文件关闭普通源码的空白诊断，避免将补丁格式误报为缩进错误。源码和文档仍接受常规空白检查。

补丁覆盖命令提交意图、只读会话观察、完整子会话导航、原生输入驱动、消息渲染、历史恢复和设置导航守卫。每项契约和接入方式见 [提供方接口](../docs/design/development/provider-interfaces.md)；发布包版本和补丁 SHA-256 见 [提供方基线](../docs/design/development/provider-baseline.json)。

修改现有补丁时，使用 `pnpm patch <包名>@0.2.0-rc.2` 创建编辑目录，再用 `pnpm patch-commit <编辑目录>` 保存。新增或更新后，同时核对应用清单、锁文件、提供方基线和兼容性说明，并运行冻结安装、构建、单元测试及受影响的原生验收。升级 Harness 时，需要重新检查公开契约及每个补丁的必要性。

当前插件依赖这些扩展；单独将插件安装到未经补丁的同版本 npm 宿主，不能提供完整功能。源码部署方式见 [开发环境搭建](../docs/design/development/setup.md)。

旧 Gateway 参数补齐补丁与 V4 关系校验放宽补丁已删除。ui-plan 与 Session.command 同步采用 rc2 唯一命令签名；聚合 Remote 中的命令和观察 codec 与 owner 包一致。
