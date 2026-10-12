# Auditor 移除后的提交、部署与清理

> 历史归档（2026-10-12，标准 Agent 精简方案）：本文保留当时的实现、验证和运行事实，不作为当前实施指令。旧权限/写入守卫、回合租约、执行账本及加强恢复的建议由[当前精简方案](../../native-agent-simplification-plan.md)替代；历史完成和失败判断不改写。见[归档索引](../README.md)。

日期：2026 年 10 月 12 日。实现及验证详见 [实施验证记录](auditor-removal-validation.md)。本记录对应用户随后要求的提交、推送、新目录启动和原材料清理。

## 提交与运行版本

实现提交 `d69fff20e9d871437a47aab1454eb0b63189baf1` 已推送到 `origin/main`。本文件所在的后续提交移除退休实验入口及材料，并记录实际部署；没有改写 Git 历史。

首次部署使用 profile `flow-current`，监听 `127.0.0.1:18791`，启动核验 PID 为 `62107`；随后运行问题修复后的实例见文末。新的 Flow 数据目录是 `/Users/luohao/dsh-flow/.artifacts/local-current/data`，工作区是 `.artifacts/local-current/workspace`；没有把旧 Flow 数据复制或迁入新库。

安装包 SHA256 为 `45bc07c951ee03e1313a5dafc6a9036397aee95b006f896b7cde857992631141`，安装的 `lib/index.js` 为 `612fc908f788a70ddea65271acb78bcc24edec7935ee835066da38a41bff8353`。六个安装入口与已验证构建逐字节一致。实际监听、打开的数据库文件及认证访问分别核对；未认证返回 HTTP 401，认证后返回 HTTP 200。新库为 schema 5，初始团队数为零，无审核表。

模型路由为本机 oMLX 的 `Qwen3.8-27B-4bit`。新 profile 已挂载 Browser 及 Playwright 提供方，并指向本机 Chrome；避免仅声明完整能力却缺少浏览器执行层。

界面验证在新空工作区的新原生会话 `session-14ab918b-544c-48be-83c5-d628107148e2` 中发出一次短提示。原生 journal 确认实际使用 oMLX / Qwen3.8-27B-4bit，零工具调用，第一回合 completed，assistant 实际返回 `Understood.`。这证明模型连通及回合完成，但未通过提示要求的精确 marker 回复断言，不能记为全部回复验收通过。首轮 UI 工作区切换竞态样本已记录为无效并取消；未使用既有聊天，未将其计入成功结果。事实与截图保存在 `.artifacts/local-current/startup-ui-verification.json` 及同目录附件。

## 实际清理范围

- 删除旧部署的 `.artifacts/local-rc2/data`、旧插件包及压缩包、`flow-rc2` profile 和旧启动脚本；退役部署中重复的旧包也已删除。
- 删除九个 `.artifacts/auditor-ablation-*` 原实验及先导运行目录。
- 删除实施前冻结的原实验 `evidence/`、旧 `runtime/`、源码压缩包、冻结清单、原实验复核材料，以及迁移验证中解压的重复旧源码。
- 删除仓库中的七份原实验文档、十一份程序/夹具、四个实验命令及八个 Host 类型检查入口；同步撤下当前文档的实验链接和复现承诺。

本地明确白名单合计删除 28 个文件或目录入口、4,499 个文件、77,287,371 逻辑字节；仓库的 18 份材料另由 Git 删除记录追踪。逐项删除结果在 `.artifacts/local-current/cleanup-report.json`，所有目标删除后逐一确认不存在。

共享 DSH home 中属于 CAE 软件发展展望及默认工作区的原生会话、workspace storage 和登录凭据继续保留，新 profile 使用同一 home；oMLX 服务、模型和凭据未删除。七份历史方案及截图仍在归档目录。当前实现的单元、原生、完整场景、包、文档及本地模型验证证据全部保留，关键报告删除前后 SHA256 一致。数据库切换中的合成 fixture 是实现验证材料，不是旧用户库备份；其历史报告保持原判断，已清理依赖的程序不再承诺可重跑。

## 清理后的核查

Host 类型检查、文档构建与 diff 检查通过；当前文档的 181 个本地链接及 7 个显式锚点有效。323 个源码及生成文件与清理前保持相同字节，本轮没有改动生产逻辑；此前 464 项单元、17 项原生、8 个完整场景和 2 项管理者集成验证仍归属于同一生产构建。清理后再次认证访问新实例并读取 schema 5 成功。

部署身份、HTTP 结果和清理事实分别保存在 `.artifacts/local-current/runtime-identity.json`、`http-check-18791.json` 和 `cleanup-report.json`。此前本地模型复杂任务中的两项未达标判断继续保留，不因部署或清理改判。

## 系统浏览器入口与 Provider 保存修复

后续实际使用发现两个运行问题。系统浏览器尚未取得认证 Cookie，直接打开普通地址会返回 401；旧启动脚本又固定传入 `--no-open`。已恢复原生默认打开认证入口的行为，并在系统 Chrome 中实际进入、跳回普通地址及刷新验证成功。认证继续启用，访问令牌不写入公开记录。

新增第三方 Provider 时，原生设置保存会一并校验已有 oMLX 配置；启动覆盖中的 `!!js` 对象尚未求值，因此触发 `$.providers.omlx.baseURL expected string but got [object Object]`。即使改成普通值，命令行模型覆盖层也会阻止 profile 保存。新增一次性 profile 初始化器，在停机时将已知模型表达式转换为明确字段，保留已有 Provider 和默认模型，凭据继续使用环境变量引用。运行时仅使用 `instance-runtime.patch.yml` 及浏览器策略，不再覆盖 `llm-pi-ai` 或 `agent-default-model`。部署策略关闭开发源码 HMR 监听，原生设置仍校验、持久保存并立即应用。

已有实例已按此方式重启，监听 PID 为 `88198`，仍使用原 `flow-current` profile 和 `.artifacts/local-current/data`。重启前后的团队 ID、状态及记录数量一致：1 个 BLOCKED 团队、1 个任务单元、2 个智能体、1 个事务。没有重建数据库或续跑用户团队。

完整单元测试 470/470、构建、冻结依赖安装及文档构建通过。新增 6 项配置初始化单测与真实原生 HTTP 集成通过；集成覆盖 Provider 新增、修改、冷重启保留及删除，实际模型请求为零。当前运行实例的真实网页也完成临时 Provider 新增、刷新保留、删除及再次刷新，两个写请求均成功，原 Provider 与默认模型指纹未变，临时项已移除。首次删除定位器不匹配的测试记录保留，纠正定位器后仅清理同一临时项，未重复创建。

证据位于 `.artifacts/local-current/auth-red-green-evidence.json`、`provider-save-red.json`、`provider-save-green.json`、`provider-fix-data-before.json`、`provider-fix-data-after.json` 及 `.artifacts/provider-settings-debug/crud-1791813654367/report.json`。六个已安装生产入口与修复后构建逐字节一致；本轮改变的是部署配置初始化与入口策略，没有改写 DSH 上游代码。
