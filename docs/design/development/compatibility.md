---
title: dsh 兼容性
description: dsh-flow 的当前依赖版本、宿主服务、插件导出，以及远程接口和 Typert 的构建边界。
---

# dsh 兼容性

当前 `dsh-flow` 按仓库锁定的 DeepSeek Harness 依赖组合构建。宿主集成是否兼容，取决于依赖版本、注入的服务和构建时生成的产物。模型提供方支持 OpenAI 兼容接口，并不意味着整套宿主集成也兼容。

## 当前版本基线

| 组件 | 仓库声明 |
| --- | --- |
| dsh-flow | `0.1.0`，当前包标记为 `private: true`，可从源码构建并打包安装 |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| pnpm | `12.9.1` |
| DSH 与主要 DSH 对等依赖包 | `0.1.7-rc.2`，精确版本 |
| Cordis | `^4.0.4` |
| Schemastery | `^3.18.4` |
| 浏览器端 | 面向网页平台，依赖 DSH 模块加载器和界面插槽 |

以上版本来自包声明和锁文件，不代表已经测试过其他 DSH 版本或所有 Node 小版本。更换宿主时，应重新构建远程接口产物，并执行类型检查、模拟测试和集成验证。

建议通过仓库中的 `src/host/dsh-launch.ts` 启动宿主。该脚本定位已安装的 `@deepseek-ai/dsh` 并调用 `runCli()`，避免部分 Node 版本缺少 `import.meta.main` 时，命令行程序无提示退出。可用 `DSH_INSTALL_PATH` 指向另一份 DSH 命令行程序的安装目录；这是开发启动脚本使用的环境变量，不是 `dsh-flow.Config` 配置项。

## 宿主必须提供什么

控制平面入口声明了五个必要服务：

| 服务 | 集成职责 |
| --- | --- |
| `tools` | 注册角色工具与执行工具 |
| `agents` | 创建和管理实际运行的智能体身份 |
| `agentLoop` | 驱动宿主原生的智能体执行轮次 |
| `sessions` | 会话、事件、注入与执行结果 |
| `sessionPersistence` | 读取持久化会话，并为恢复过程提供可核验的依据 |

Cordis 会等待这些服务就绪。插件完成恢复与对账后，才会发布 `ctx.flow`；如果必要服务丢失，整个实例会进入清理流程。宿主还需根据启用的能力配置模型提供方、Token 计量、上下文压缩、权限和工具插件。为执行智能体声明 `browser` 能力不会自动提供 Playwright MCP，浏览器工具仍需由宿主配置。可参考 [浏览器验收覆盖配置](https://github.com/Luohaothu/dsh-flow/blob/main/examples/cluster.web.patch.yml)。

集群内部的智能体身份不会自动加载交互会话所选的智能体预设。上下文压缩尤其需要注意：如果只在交互会话预设中配置摘要后端，集群自身的会话就无法使用它。[实例覆盖配置](https://github.com/Luohaothu/dsh-flow/blob/main/examples/instance.patch.yml) 显式启用了宿主侧的上下文压缩，并提供无人值守执行的权限预设。请按实际部署调整这些配置。

## 标准插件导出

| 导出 | 用途 |
| --- | --- |
| `dsh-flow` | 宿主端控制平面，提供 `ctx.flow` |
| `dsh-flow/command` | 主会话 `/agent-team`、进展与执行指令 |
| `dsh-flow/web` | 远程接口服务，绑定通信命名空间 `flow` |
| `dsh-flow/types` | 宿主端、远程接口与浏览器端共享的类型定义 |
| `dsh-flow/client` | 团队顶栏、智能体视图和显示设置 |
| `dsh-flow/typert` | 构建时生成的宿主端接口描述与编解码器 |
| `dsh-flow/remote` | 构建时生成的浏览器端远程接口注册代码与类型声明 |

包还导出 `cordis.patch.yml` 和 `package.json`。安装插件组合时，会将其中声明的插件加入配置方案；内部 `core/` 模块不在公开导出范围内。

标准组合只注册 `/agent-team` skill 启动入口，不注册额外智能体预设或侧栏入口。管理角色工具仍在各身份自己的作用域中。主会话执行工具先验证团队归属。当前基线需应用仓库 `patches/` 的 15 个提供方补丁，涉及命令意图、观察布局、原生消息与图片、历史恢复、子会话输入驱动和导航守卫。普通 npm 宿主同版本尚无完整扩展。公开契约、生命周期和安装校验见[宿主接口与补丁](/development/provider-interfaces)，实际界面行为见[主会话与团队界面](/development/interface)。

## 远程接口与 Typert 的边界 {#remote-与-typert-的边界}

浏览器通过 `ctx.remote.flow` 调用远程接口（Remote）。请求经过 DSH 的连接服务和 API 网关，进入宿主端的远程接口实现，再调用同一个 `ctx.flow` 服务。观察使用 `teamRuns`、`teamRead`、`agentSession`；诊断读取保留 `list`、`read`、`events`、`query`、`report`。远程描述不包含启动和控制操作，参数与语义见 [API 接口](/development/api)。

标准 HTTP 传输使用 `/api/flow/<method>` 路径和结构化的 `args` 参数。`settle`、`tick`、`single`、`recover`、`dispose` 是开发验收使用的进程间通信（IPC）能力，不属于浏览器远程 API；控制平面插件本身也不会读取 `FLOW_IPC` 来启用这些能力。

构建顺序必须保留：

```text
宿主端 TypeScript → 宿主端打包 → Typert 生成 → 浏览器端 TypeScript → 浏览器端打包
```

`packages/typert-protocol` 为生成器提供工作区内的协议声明，其中包含发布包的声明，并通过入口文件重新导出这些声明。它是私有包，没有业务逻辑，也不随 dsh-flow 发布；运行时仍使用实际的 `@deepseek-ai/dsh-typert-protocol` 包。`pnpm-workspace.yaml` 中的 `linkWorkspacePackages: false` 与显式 `workspace:*` 链接共同保证生成期和运行时分别使用对应的包，不能将生成期声明包误用作运行时依赖。

浏览器端构建会内联生成的远程接口注册代码。宿主端则将 `@deepseek-ai/*` 模块保留为外部依赖（`external`），由宿主提供服务实例。插件在内部声明业务 JSON 类型 `FlowJsonValue`，以满足远程接口编解码器对递归类型归属的要求；JSON 合法性检查仍复用宿主工具包。

## 模型接入与已知限制

OpenAI 兼容模型通过宿主的模型提供方接入，dsh-flow 不直接管理服务地址、鉴权、兼容参数或提供方的重试行为。更换模型后，仍需按实际服务同步调整上下文窗口、输出上限和服务端输入上限，见 [智能体配置参数](/configuration/agents)。

当前实现支持分层预算、任务单元持久化和恢复，但不支持跨机器分布式调度、CPU/GPU/内存计量，也不提供可在任意模型之间路由的通用资源池。[集群配置参数](/configuration/cluster) 列出了已声明但尚未生效的字段；判断配置是否有效，应以运行时代码是否实际读取并使用该字段为准。

## 源码依据

[包声明与导出](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/package.json)、[宿主注入与恢复](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/index.ts)、[远程接口实现](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/src/web.ts)、[构建流程](https://github.com/Luohaothu/dsh-flow/blob/main/scripts/build.ts)、[工作区解析配置](https://github.com/Luohaothu/dsh-flow/blob/main/pnpm-workspace.yaml)。
