---
title: 开发环境搭建
description: 从源码安装依赖、构建并测试 dsh-flow，在独立 DSH 数据目录中调试插件。
---

# 开发环境搭建

本页面向需要修改源码、验证改动或调试插件集成的开发者。完成以下步骤后，你将得到一个使用独立数据目录的 DSH 实例，可以验证插件安装、配置合并、智能体观察视图和真实模型执行。

安装、构建和模拟测试均不需要模型服务；提交目标并运行集群时，才需要接入可用的模型。日常使用集群的操作流程见[快速上手](/quick-start)。

当前 `0.1.7-rc.2` 基线需要本仓库冻结安装中的提供方接口补丁。启动时使用仓库的 `dsh-launch.ts`；普通同版本 npm 宿主尚未包含这些扩展。

## 1. 安装开发依赖

取得[仓库源码](https://github.com/Luohaothu/dsh-flow)，在仓库根目录执行以下命令。项目要求 **Node.js `^22.19.0 || >=24.0.0`** 和 **pnpm `12.9.1`**。

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml` 已声明工作区和所需原生依赖的构建权限。如果安装时提示构建脚本被忽略，请核对该文件与本地 pnpm 版本，确认原生依赖完成构建后再继续。

## 2. 构建并验证源码

```bash
pnpm run build
pnpm test
pnpm run test:mock
```

| 命令 | 检查范围 |
| --- | --- |
| `pnpm run build` | 宿主端类型检查与打包、Typert 远程接口生成、浏览器端类型检查与打包，以及独立网站测试种子的类型检查 |
| `pnpm test` | 单元测试与验收基础设施测试 |
| `pnpm run test:mock` | 原生接口检查与确定性模拟验收，不请求真实模型 |
| `pnpm run typecheck` | 执行构建流程中的类型检查和远程接口生成，跳过浏览器端的最终打包 |

构建产物位于 `packages/dsh-flow/lib/`。`typecheck` 也会生成中间产物，无需手动创建该目录。真实模型验收使用另一组命令，实验场景与验证要求见[开发文档](/development/#验证顺序)。

## 3. 安装到独立调试实例

以下示例创建临时 DSH 数据目录，并在内置 `web` 配置方案（profile）中安装插件，以加载网页界面和团队视图所需的宿主组件。请在同一终端执行后续步骤，保留这两个变量。

```bash
FLOW_DEMO_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flow-home.XXXXXX")"
FLOW_DEMO_PACKAGE="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flow-package.XXXXXX")"

pnpm --dir packages/dsh-flow pack --pack-destination "$FLOW_DEMO_PACKAGE"

DSH_HOME="$FLOW_DEMO_HOME" node --import tsx src/host/dsh-launch.ts \
  plugin --profile web add "$FLOW_DEMO_PACKAGE/dsh-flow-0.1.0.tgz"
```

`pack` 会通过 `prepack` 再次构建。插件安装后，包自带的 `cordis.patch.yml` 会配置集群服务、只读远程接口与 `/agent-team` 命令。启动脚本直接调用已安装 DSH 的 `runCli()`，可兼容未实现 `import.meta.main` 的部分 Node 版本。

这里安装的是打包产物。修改源码后，需要重新构建、打包并安装，调试实例才会使用修改后的插件；只编辑源码不会自动更新已安装的包。

## 4. 检查模型与覆盖配置

[instance.patch.yml](https://github.com/Luohaothu/dsh-flow/blob/main/examples/instance.patch.yml) 提供完整部署示例，默认使用 `http://127.0.0.1:8000/v1` 上的 `local-sglang / Qwen3.8-27B-FP8`。请按实际部署修改模型提供方、模型名称、服务地址和宿主模型适配器容量；接入 OpenAI 兼容服务时，可参考 [openai-compatible.patch.yml](https://github.com/Luohaothu/dsh-flow/blob/main/examples/openai-compatible.patch.yml)。

使用 DeepSeek 官方 API 时，在实例配置之后追加 [deepseek.patch.yml](https://github.com/Luohaothu/dsh-flow/blob/main/examples/deepseek.patch.yml)。它将模型路由改为 `deepseek / deepseek-flash`，通过普通 YAML 字符串 `apiKeyEnv: FLOW_MODEL_API_KEY` 指定凭证环境变量名，由宿主在运行时读取值；完整命令与工作区操作见 [DeepSeek 实战步骤](/step-by-step#_2-接入-deepseek-官方-api)。`openai-compatible.patch.yml` 是独立的 Coding Plan 服务示例，服务地址与官方 DeepSeek API 不同。

团队默认模型为“跟随主会话”时，创建使用主会话当前选中的模型，后续选择同步给该会话未结束的团队；设置为固定模型时保持团队选择。示例中的 `provider/model` 同时提供底层程序化启动的默认路由。若团队受阻且提示模型服务连接失败，先核对主会话选中服务是否可连接。

先检查合并后的配置，此步骤不会加载服务或运行模型：

```bash
DSH_HOME="$FLOW_DEMO_HOME" node --import tsx src/host/dsh-launch.ts \
  --profile web --patch examples/instance.patch.yml --dump-config
```

确认 `dsh-flow` 只出现一次、模型路由正确，并检查 `workspace`、`dataDir`、权限和宿主上下文压缩配置是否符合调试要求。`instance.patch.yml` 用于覆盖已安装插件组合中的配置条目；验收用的 `cluster.patch.yml` 则会显式插入插件。两者的安装前提不同，不能混用。

## 5. 启动宿主并联调

```bash
DSH_HOME="$FLOW_DEMO_HOME" \
FLOW_DATA_DIR="$FLOW_DEMO_HOME/flow-data" \
node --import tsx src/host/dsh-launch.ts \
  --profile web --patch examples/instance.patch.yml \
  --host 127.0.0.1 --port 8791 --no-open
```

打开终端打印的带访问令牌的 URL。示例使用独立数据目录；不提交目标就不会创建集群任务。示例 YAML 通过 `!!js` 表达式读取 `FLOW_DATA_DIR` 并写入配置，插件核心本身不读取该环境变量。

模型服务准备好后，在主会话输入 `/agent-team <需求>`，说明目标、预期产物和验收条件。团队指令通过主会话下达，“智能体”视图和检查器只读；成员完整原生会话允许符合生命周期条件的文本续聊。执行智能体提交产物后，还必须通过业务验收和独立复核，任务单元才会被正式接受。

联调时可按以下顺序定位问题：

| 检查阶段 | 关注内容 | 进一步阅读 |
| --- | --- | --- |
| 插件加载 | 必要服务是否就绪，远程接口产物是否与宿主匹配 | [dsh 兼容性](/development/compatibility) |
| 模型执行 | 原生 Agent 模型路由、工具能力与宿主默认压缩是否可用 | [智能体配置参数](/configuration/agents) |
| 集群推进 | 是否因预算、并发或结构限制无法继续 | [集群配置参数](/configuration/cluster) |
| 结果提交 | 任务单元、执行记录和验收证据是否一致 | [查询与可观测性](/development/components/observability) |

需要调用工具或远程接口时，见 [API 手册](/development/api)。组件入口与职责见[代码结构](/development/code-structure)。

## 源码依据

[工作区命令与版本](https://github.com/Luohaothu/dsh-flow/blob/main/package.json)、[构建流程](https://github.com/Luohaothu/dsh-flow/blob/main/scripts/build.ts)、[启动脚本](https://github.com/Luohaothu/dsh-flow/blob/main/src/host/dsh-launch.ts)、[插件组合](https://github.com/Luohaothu/dsh-flow/blob/main/packages/dsh-flow/cordis.patch.yml)。
