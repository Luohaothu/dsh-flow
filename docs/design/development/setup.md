---
title: 开发环境搭建
description: 从源码安装依赖、构建并测试 dsh-flow，在独立 DSH 数据目录中调试插件。
---

# 开发环境搭建

本页面向需要修改源码、验证改动或调试插件集成的开发者。完成以下步骤后，你将得到一个使用独立数据目录的 DSH 实例，可以验证插件安装、配置合并、智能体观察视图和真实模型执行。

安装、构建和模拟测试均不需要模型服务；提交目标并运行集群时，才需要接入可用的模型。日常使用集群的操作流程见[快速上手](/quick-start)。

当前 `0.2.0-rc.2` 基线需要本仓库冻结安装中的提供方接口补丁。启动时使用仓库的 `dsh-launch.ts`；普通同版本 npm 宿主尚未包含这些扩展。

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

需要通过网页设置新增或编辑 Provider 的实例，应将模型配置保存在 profile 的 `cordis.patch.yml`，启动覆盖文件只负责 Flow 和宿主运行策略。下面以本地 oMLX 为例，在创建 profile 后、启动宿主前执行一次：

```bash
export FLOW_MODEL_PROVIDER=omlx
export FLOW_QWEN_MODEL=Qwen3.8-27B-4bit
export FLOW_QWEN_BASE_URL=http://127.0.0.1:8000/v1
node --import tsx scripts/initialize-omlx-profile.ts \
  --profile-dir "$FLOW_DEMO_HOME/profiles/web"
```

初始化器将地址、模型名和容量写成明确的字符串或数字，凭据仅保留 `apiKeyEnv: FLOW_MODEL_API_KEY` 引用。通过安全的本机方式向宿主进程提供 `FLOW_MODEL_API_KEY`；不要把密钥写进 YAML。初始化器保留已有 Provider、默认模型选择和其他配置，只补充缺失的 oMLX 配置；已有 oMLX 没有默认选择时使用它已声明的首个模型。它只转换本仓库 oMLX 模板中的已知环境表达式，遇到其他表达式或模型配置别名会在写入前拒绝。已有实例迁移时先停止该 profile 的宿主，保留其数据库和会话，再运行初始化器；此命令不用于与网页设置并发写入。

日常增删改 Provider 在原生模型设置中完成。不要同时传入 `instance.patch.yml`、`omlx.patch.yml` 或其他覆盖 `llm-pi-ai` / `agent-default-model` 的启动文件：rc2 的模型热校验不能接受未求值的 `!!js` 字段，命令行模型覆盖层也会阻止 profile 保存。原模型模板继续供独立、固定配置的验收使用；它们不是可编辑实例的启动入口。其他 OpenAI 兼容服务可在模型设置中添加，或参考 [openai-compatible.patch.yml](https://github.com/Luohaothu/dsh-flow/blob/main/examples/openai-compatible.patch.yml) 将明确的模型字段写入 profile。

团队默认模型为“跟随主会话”时，创建使用主会话当前选中的模型，后续选择同步给该会话未结束的团队；设置为固定模型时保持团队选择。运行策略中的 `provider/model` 只为底层程序化启动提供默认路由，不覆盖原生 Provider 设置。

检查合并后的配置，不加载服务或运行模型：

```bash
DSH_HOME="$FLOW_DEMO_HOME" node --import tsx src/host/dsh-launch.ts \
  --profile web --patch examples/instance-runtime.patch.yml --dump-config
```

确认 `dsh-flow` 只出现一次、模型路由正确，并检查 `workspace`、`dataDir` 和权限。安装后的部署策略关闭开发源码 HMR 监听；网页模型设置仍通过原生 ConfigEditor 校验、持久保存并立即应用，重启后保留。`instance-runtime.patch.yml` 用于已有插件的部署；验收用的 `cluster.patch.yml` 会显式插入插件，两者不能混用。

## 5. 启动宿主并联调

```bash
DSH_HOME="$FLOW_DEMO_HOME" \
FLOW_DATA_DIR="$FLOW_DEMO_HOME/flow-data" \
node --import tsx src/host/dsh-launch.ts \
  --profile web --patch examples/instance-runtime.patch.yml \
  --host 127.0.0.1 --port 8791
```

本地启动默认在系统浏览器中打开认证入口；无人值守运行时可显式添加 `--no-open`。未自动打开时，复制本次启动终端打印的完整访问 URL，在需要使用的浏览器中打开。

首次直接访问 `http://127.0.0.1:8791/` 可能返回 `401` 和认证提示。这表示浏览器尚未取得登录 Cookie，不应据此关闭宿主认证。打开本次启动打印的带访问令牌的 URL 后，宿主会设置 Cookie，并自动跳回不带令牌的普通地址。成功后可以收藏普通地址；不要将带令牌的访问链接写入公开文档或分享给他人。

不同浏览器、浏览器用户配置和无痕窗口不共享同一份 Cookie，需要分别从认证入口进入。`127.0.0.1`、`localhost` 及不同端口分别认证，原地址的 Cookie 不能用于新地址；新地址尚未登录时，请打开本次启动打印的认证链接。

每次宿主进程重启都会生成新的访问令牌，旧链接不能作为未登录浏览器的新入口。同一主机名和端口、继续使用原凭据存储且 Cookie 未过期时，重启后普通地址书签仍可使用；如果再次出现 `401`，打开最近一次启动打印的认证链接即可，无需重启服务或关闭认证。

示例使用独立数据目录；不提交目标就不会创建集群任务。示例 YAML 通过 `!!js` 表达式读取 `FLOW_DATA_DIR` 并写入配置，插件核心本身不读取该环境变量。

模型服务准备好后，在主会话输入 `/agent-team <需求>`，说明目标、预期产物和验收条件。团队指令通过主会话下达，“智能体”视图和检查器只读；成员完整原生会话允许符合生命周期条件的文本续聊。执行智能体提交产物后，还必须由总协调实际检查并完成业务验收，任务单元才会被正式接受。

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
