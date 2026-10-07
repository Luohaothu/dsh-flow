# 宿主接口与补丁

团队界面使用 DeepSeek Harness `0.1.7-rc.2` 的公开服务和仓库 `patches/` 中的接口扩展。`pnpm-workspace.yaml` 的 `patchedDependencies` 固定补丁，`pnpm-lock.yaml` 固定安装解析。应使用冻结安装和仓库启动器运行这一组合；相同版本号的未打补丁宿主不具备完整接口。

[提供方基线清单](https://github.com/Luohaothu/dsh-flow/blob/main/docs/design/development/provider-baseline.json)列出依赖版本、补丁 SHA-256、包声明和公开入口的预期摘要。该清单用于检查实际安装字节，不推断 npm 发行包对应的上游提交。

## 接入位置

| 功能 | 公开接口 | dsh-flow 内容 |
|---|---|---|
| 插件与配置 | Bundle patch、`plugins.bundle.config`、`configForms` | 标准插件卡片中的执行默认值和显示偏好 |
| 主会话命令 | Commands `register`、`followup`、Skills registry | `/agent-team` 启动意图和主 Agent 管理工具 |
| 顶栏 | `conversation.session.header.actions` | 团队摘要、派生树及原生会话导航 |
| 团队视图 | `conversation.view`、`registerViewPresentation` | 按主会话启用的只读、contained 拓扑与列表 |
| 停靠观察 | Resources、SidebarRightTabs、Dockkit | 原生对话和代理信息的观察容器 |
| 会话内容 | Sessions `retain/release`、Slots `SessionProvider`、`renderFactorySlot` | 真实 SessionReference 下的官方 Conversation |
| 成员输入 | `registerSessionDriver`、原生 prompt / cancel | Flow 身份、调度与生命周期检查 |
| 通信卡片 | `conversation.chat.node` | 可展开的结构化通信内容 |
| 设置离开提示 | Layout 导航守卫、原生 Modal | 保存并离开、放弃或继续编辑 |
| 主题与焦点 | Primitives、宿主 CSS tokens | 业务区域样式、键盘操作与减少动态效果 |

## 补丁契约

| 提供方包 | 约定 |
|---|---|
| `dsh-commands`、`dsh-api-remotes`、`dsh-api-gateway` | `execute` 的可选 `submissionId` 在命令链路传递；直接调用、Agent 作用域调用与 AbortSignal 均有明确参数位置 |
| `dsh-client-ui-commands` | 命令失败保留输入；确认未知时复用 sessionStorage 中的提交意图；不可用的 `agent-team` 引导至插件管理 |
| `dsh-client-ui-conversation` | 顶栏视图选择、会话级视图可用性、contained/readOnly 呈现、原生 lineage 插槽和内容工厂参数 |
| `dsh-client-ui-chat` | 命令会话的原生内容、只读节点操作限制、自动跟随、结构化通信节点 |
| `dsh-client-ui-renderer` | Factory 递归检查结合工厂名与实际 Session generation，允许跨会话嵌入并拒绝循环 |
| `dsh-session-format-v3-to-v4` | 按原生 fold 语义恢复通知与系统消息，校验首节点、替换范围、事件来源与轮次关系 |
| `dsh-api-session-controller` | 历史读取错误、`allowUnlisted`、`observationOnly`、分页代次隔离和公开会话驱动 |
| `dsh-session` | 会话驱动与冷历史读取的执行边界；可忽略的结构化元数据保留在原生日志 |
| `dsh-client-ui-subagent`、`dsh-client-ui-workspace` | 完整子会话导航、保留选项与所属主会话返回路径 |
| `dsh-client-ui-dockkit` | `allowTabDrag=false` 固定观察布局，保留原生聚焦与分隔条调整 |
| `dsh-client-ui-layout` | `addNavigationGuard/requestNavigation` 延迟提交导航，等待保存结果 |
| `dsh-client-ui-plugin-manager`、`dsh-client-ui-workspace` | 插件、面板和工作区导航执行同一守卫 |

所有注册随 Cordis 调用方生命周期释放。每次保留的 SessionReference 都要释放；串行观察轮询使用请求代次隔离迟到结果，卸载后停止计时器与异步公告。公共参数必须同时体现在运行时代码、类型声明和实际调用者中。

修改补丁时，应同步锁文件、基线清单和相关契约测试，再执行冻结安装、构建及真实宿主验证。静态类型通过只说明编译契约成立；导航、输入路由、冷会话读取与卸载仍须运行验证，见[验证方法](/development/validation)。

源码依据：[补丁目录](https://github.com/Luohaothu/dsh-flow/tree/main/patches)、[客户端装配](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/client.ts)、[主会话命令](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/command.ts)、[原生执行](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/core/runtime.ts)。
