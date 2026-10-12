# 历史消融实验的恢复与离线核验

本页适用于 2026 年 10 月 12 日完成的 schema 4 消融实验。当前产品已采用两类管理角色；旧实验的角色提示词、实验驱动和运行时必须使用冻结基线。原始分数、协议及结论边界保持原样，后续产品决策见[移除方案](../plans/auditor-removal-plan.md)。

## 保存内容

本地证据包位于 `.artifacts/auditor-removal-baseline-20261012/`，由 Git 忽略，需与源码提交分别备份：

| 路径 | 内容 |
| --- | --- |
| `source.tar.gz` / `manifest.json` | 提交 `0c49836e6fe0c60a9ccff73c132934305608f65c` 的源码及未提交实验覆盖层，逐文件 SHA256 |
| `runtime/` | 旧发布包、解包产物和构建身份；不含运行账户凭据 |
| `evidence/` | 原始报告、冻结材料、采样配置快照、服务计数和 48 份原生压缩会话 |
| `evidence/native-path-map.json` | 原始绝对会话路径到归档内相对路径的映射及各文件 SHA256 |
| `evidence-manifest.json` | 证据及旧运行包的逐文件校验和 |
| `offline-verification.json` | 将证据复制到临时目录后完成的离线核验结果 |

原报告 SHA256 为 `f75321d235b61ac1801119a578df04622853373ea6dff215f9962dc03c5bf769`，冻结清单为 `4e218ebf197cb0f927374829192488189395d8d4eda50c5f5bc8eb17c441856f`，旧包为 `c03628d0fa8fd8980951cb9d8dc09e63b34a4a3c8b63e66ceebcc769090d619e`。映射文件不改写原报告中的路径或决定。

## 离线重算

将完整证据目录复制到任意位置，然后在当前仓库执行：

```bash
pnpm experiment:auditor:check
pnpm experiment:auditor:verify /path/to/evidence/report.json \
  --path-map /path/to/evidence/native-path-map.json \
  --output /private/tmp/native-verification.json
pnpm experiment:auditor:report /path/to/evidence/report.json /private/tmp/recomputed-report.md
```

`verify` 默认只输出核验结果，不写回证据、不联网，也不读取模型配置或密钥。它逐一检查映射文件校验和、原生决定回执、Token 用量、模型请求次数和读取材料的调用 ID。可选的 `--scan-key-env VARIABLE_NAME` 仅在明确需要核对某个已持有密钥是否泄漏时使用；未请求此扫描会显示 `credential_scan: not_requested`，不声称已完成密钥检查。

搬迁核验已得到 72 阶段、48 会话、71 条结构化决定、72 项用量与模型消息计数一致；模型请求数与服务计数增量均为 154。重算保持 23 个完整配对。一个阶段错误仍按原协议排除，不补成成功结果。

## 恢复旧模型运行环境

1. 将完整证据包复制到独立目录，例如 `/private/tmp/flow-auditor-old/`。从仓库创建独立克隆到该目录的 `source/`，检出上面的旧提交，再将 `source.tar.gz` 解压覆盖到 `source/`。保留原始 `manifest.json`，不在主线改写旧源码以适配新角色。
2. 在 `source/` 执行 `pnpm install --frozen-lockfile`；把 `runtime/package/` 和 `runtime/runtime-identity.json` 复制到 `source/.artifacts/local-rc2/` 的对应位置。使用旧源码执行 `pnpm build` 准备宿主所需构建文件，保留已经冻结的旧发布包。依赖锁文件与 DSH 版本来自旧源码。
3. 恢复相同模型文件、服务版本及 `evidence/model-recipe-before.json` 中的非秘密配置。凭据由操作人通过环境变量提供，归档不保存密钥。新运行使用新的 workspace、home 和 data 目录，不复用旧数据库、正在运行的本地实例或当前主线构建。
4. 从当前仓库通过带前置校验的入口启动。它验证旧源码逐文件哈希、Git 提交和运行包身份，然后只在恢复的 `source/` 中执行原驱动：

```bash
pnpm experiment:auditor --baseline /private/tmp/flow-auditor-old --pilot
# 新先导的三个阶段完成后，才运行正式比较
pnpm experiment:auditor --baseline /private/tmp/flow-auditor-old
```

恢复环境验证与新的模型实验分别记录。模型采样具有不确定性；恢复原程序、材料及配置不承诺逐字重复模型响应，也不允许覆盖原始报告。本次产品移除只做离线核验，没有重新启动这轮消融实验。
