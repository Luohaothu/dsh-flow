# DSH 0.2.0-rc.2 升级验收记录

日期：2026-10-11。状态：完成。模型运行结果与后续复核分别保留，失败尝试不计入通过项。

## 已交付的迁移

DSH 直接依赖、peer 和生成期声明统一为精确版本 `0.2.0-rc.2`。删除全部 15 个 `@0.1.7-rc.2` 补丁，以 rc2 npm 发行包重新制作 14 个必要扩展。旧 Gateway 参数补齐与 V4 日志关系校验放宽补丁彻底移除；DSH 原生格式读取组件仍保留。

命令接口采用唯一参数位置：Host 五参、root Remote 四个 JSON 参数与独立取消信号、Agent scoped Remote 三个 JSON 参数与独立取消信号。稳定提交意图只用于团队启动去重，每次命令执行保持唯一日志 ID。实际 `api-remotes` 聚合模块的内联 codec 同步更新。

新 Flow 成员的不可变 `agentPreset: dsh-flow/member` 标记其独立执行归属。普通创建、恢复、队列、模型和命令路径检查该身份；驱动缺席时拒绝执行。冷历史观察不创建普通 Agent，保留 DSH 原生 subagent 的分支语义。该保护不扩展为对旧版本无标记日志的卸载后承诺。

跨会话 Factory 按工厂名和实际 Session generation 检查递归。Workspace、设置导航守卫、只读观察与通信节点扩展均适配 rc2。工具中断恢复采用 rc2 保守结果，未知效果不会变成成功，也不会重复执行或计费。

## 构建及确定性验收

验证环境：macOS，Node `26.10.0`，pnpm `12.9.1`。固定上游标签 `dsh-v0.2.0-rc.2`，接口审计提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。运行依据是 npm 发行字节，而非用户本地 DSH 源码检出。

| 检查 | 结果与证据 |
| --- | --- |
| 冻结安装 | `pnpm install --frozen-lockfile` 通过；实际加载的 283 个 DSH 依赖均为 rc2，锁文件固定解析与扩展摘要 |
| 类型与构建 | Host、Typert 生成、Client 和网站种子检查通过；Host/Client 产物已重建 |
| 单元与验收基础设施 | `pnpm test`：458 项通过，0 失败 |
| 原生接口 | 15 项通过，包含未装载 Flow 驱动时的 live/cold 归属保护、活跃输入、命令重试、能力和默认压缩 |
| Provider 实际字节 | 16 个提供方基线记录，14 个扩展 SHA256 与锁文件、安装入口一致；所有补丁反向应用检查通过 |
| 完整 mock 场景 | smoke、recursion、recovery、context、browser、panel、scale16、scale64 全部通过；前后指纹无漂移 |
| 浏览器界面 | panel 69 项交互检查及指纹检查全部通过；菜单偏好断言先等待菜单就绪，已检查团队拓扑与成员原生对话截图 |
| 文档与空白检查 | `pnpm docs:build`、`git diff --check` 通过；文档构建有常规 chunk 大小提示 |

基线：[provider-baseline.json](../design/development/provider-baseline.json)。新增测试直接加载实际浏览器聚合模块，不仅检查单个 owner 包的声明。日志位于本次工作区外临时目录；可复查的场景报告、原生证据、数据库和截图保存在下述 `.artifacts` 运行目录。

| 场景 | 报告 |
| --- | --- |
| smoke | [report.json](../../.artifacts/smoke-20261010T194359Z-5f88a1/report.json) |
| recursion | [report.json](../../.artifacts/recursion-20261010T194359Z-1ce963/report.json) |
| recovery | [report.json](../../.artifacts/recovery-20261010T194359Z-ce600e/report.json) |
| context | [report.json](../../.artifacts/context-20261010T194359Z-6b4e3d/report.json) |
| browser | [report.json](../../.artifacts/browser-20261010T194359Z-724cad/report.json) |
| panel | [report.json](../../.artifacts/panel-20261010T194359Z-6f8a10/report.json) |
| scale16 | [report.json](../../.artifacts/scale16-20261010T194359Z-1770a6/report.json) |
| scale64 | [report.json](../../.artifacts/scale64-20261010T194359Z-c4cc51/report.json) |

## 当前本地 oMLX 实际模型

使用用户已部署的 `http://127.0.0.1:8000/v1`、oMLX `0.7.1.dev1` 和 `Qwen3.8-27B-4bit`，保持当前模型服务设置。认证信息仅在进程环境中传递。先完成模型列表读取与小请求，再运行团队案例。

每个案例先打包插件、校验六个发布入口与构建字节相同，再加载独立 rc2 profile。验收前后记录源码与构建指纹；实际模型执行、原生会话日志、业务验收、独立审核和最终文件分别核对。

| 实际案例 | 验证目标 | 结果 |
| --- | --- | --- |
| 原生成员生命周期 | 鉴权访问、输入重试去重、运行中追加输入、完成回收、重启后冷历史观察不触发模型请求 | 通过：[report.json](../../.artifacts/omlx-lifecycle-2026-10-10T19-19-02-396Z/report.json) |
| 工作区算术报告 | Worker 创建真实文件，总协调读取原生文件回执并独立复算，Auditor 独立审核，验收脚本再次读取文件 | 业务闭环完成、复核通过：[parser-revalidation.json](../../.artifacts/handoffs-artifact-2026-10-10T20-08-39-725Z/parser-revalidation.json)；[原始报告](../../.artifacts/handoffs-artifact-2026-10-10T20-08-39-725Z/report.json) 保留解析误报 |
| 宿主重启恢复 | 已进入原生日志的首条输入在重启后保留一次，沿原任务继续完成与审核 | 通过：[report.json](../../.artifacts/handoffs-recovery-2026-10-10T19-48-40-627Z/report.json) |

## 证据边界

支持基线是 rc2 加本仓库 14 个指定扩展。未经扩展的官方 rc2 宿主不具备完整 Flow 接口。模型案例使用隔离数据目录，不修改用户已有 DSH 会话、数据库或 oMLX 模型配置。宿主恢复案例验证进程正常停止后重启，强制崩溃和更大生产负载不由该案例证明。

初次打包案例因依赖目录链接错误而未能加载插件，已改为复用插件包自己的依赖解析目录。生命周期试跑完成了业务与冷历史读取，但期间修正了验收脚本的宿主对象复用，最终指纹检查正确拒绝该轮结果；该失败报告保留，正式结果使用固定源码重新运行。初次浏览器验收因没有 bundled Chromium 失败，指定本机 Google Chrome 后重跑；失败尝试不计为通过。

实际恢复试跑的审核引用格式未通过，达到时限后记为失败；其首次输入和工作交付证据仍保留。文件试跑先发现 `inputs` 必须位于正式的 `initial_transactions[]` 中，随后发现测试误要求管理角色调用未开放的文件工具。模型声称直接读文件且混用加法和乘法，因此该轮被人工复核拒绝，不能计为通过。新的文件验收将沿既有角色职责读取 Worker 的原生文件回执、独立复算，并保留物理文件的再次读取。

文件案例的一轮实际运行出现原生 `turn/end` 的 `pi-ai stream idle timeout after 90000ms`，因此未完成的审核不计为通过。已把隔离 DSH oMLX 适配器调整为请求等待 360 秒、流空闲等待 300 秒，保持模型服务设置、工具参数和正式验收规则。该调整是传输等待配置，不是模型容量或生成速度结论。

交付文件：[arithmetic-report.md](../../.artifacts/handoffs-artifact-2026-10-10T20-08-39-725Z/workspace/arithmetic-report.md)。文件案例的真实运行达到 `COMPLETED`，正式事务 `ACCEPTED`，计划与验收审核均 `APPROVED`，四名成员全部 `TERMINATED`。总协调读取 Worker 原生 `read` 回执，并在验收前真实执行 `[2,3]`、23 个 17、12 个 12 的三次 `flow_sum`，返回 5、391、144。独立复核确认原生回执中的完整文件内容与最终物理文件逐字一致，文件 SHA256 为 `49f3cac14fa6e1386886a0a5c5dfa8e5b3bfaa0f702e1e06bd022a43e6eddb46`。

该轮原始脚本将字段选择标志 `projection: true` 误读为承载回执的对象，导致唯一一项读取检查误报失败。已修正为读取顶层 `evidence.native_tools`，以该轮真实响应新增回归测试，并在同一份不可变证据上复核全部原通过项与错误判定项；原报告、原生证据的 SHA256 一并保存在复核记录中，没有改写原失败报告。随后完整重跑的模型取消原正式任务并创建两个根任务草稿，偏离单工作单元要求；该重跑被停止并记为失败，不计入验收证据。[重跑记录](../../.artifacts/handoffs-artifact-2026-10-10T20-20-07-458Z/manual-review.json)。因此，本次接口兼容与已完成案例的证据成立，不宣称当前模型每次规划都能稳定完成。

三个已完成/已复核的实际案例使用相同插件发布归档 SHA256：`8a0c2a51757d20cb27eeed865752e6c9bc95800a7857c404b4a1ca16cc0fc430`。每轮执行期间源码与构建指纹保持一致；案例间修订的是验收工具、案例配置和传输等待，Host/Client 发布字节一致。实际恢复案例包含 22 项检查；原生成员生命周期包含 49 次非标题模型请求，鉴权、稳定输入重试、活跃续接、回收与两次冷读取均通过。用户本地 `/Users/luohao/deepseek-harness` 的 `0.2.1-alpha.1` 检出及其原有修改没有被用于 rc2 验收或改写。
