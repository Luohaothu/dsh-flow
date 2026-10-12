# 开发环境

需要支持 `node:sqlite` 的 Node（项目声明 `^22.19.0 || >=24.0.0`）及仓库指定 pnpm。运行 `pnpm install --frozen-lockfile` 后依次执行 typecheck、build、test。

插件包位于 `packages/dsh-flow`；宿主开发辅助位于 `src/host`。真实验证创建独立 profile/home/workspace/data，不修改用户当前会话或工作区。

Provider 配置使用宿主 profile，API key 通过已选择的环境引用传入。日志遮蔽认证 token 与 credentials，验证报告仅记录路由身份及配置指纹。
