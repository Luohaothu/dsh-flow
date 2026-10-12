# Auditor 移除后的提交、部署与清理

日期：2026 年 10 月 12 日。实现及验证详见 [实施验证记录](auditor-removal-validation.md)。本记录对应用户随后要求的提交、推送、新目录启动和原材料清理。

## 提交与运行版本

实现提交 `d69fff20e9d871437a47aab1454eb0b63189baf1` 已推送到 `origin/main`。本文件所在的后续提交移除退休实验入口及材料，并记录实际部署；没有改写 Git 历史。

当前实例使用 profile `flow-current`，监听 `127.0.0.1:18791`，启动核验 PID 为 `62107`。新的 Flow 数据目录是 `/Users/luohao/dsh-flow/.artifacts/local-current/data`，工作区是 `.artifacts/local-current/workspace`；没有把旧 Flow 数据复制或迁入新库。

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
