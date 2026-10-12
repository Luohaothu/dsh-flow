# Auditor 三场景消融实验：实测报告

运行：`auditor-ablation-2026-10-11T22-46-58-130Z`；状态：`COMPLETED_WITH_STAGE_ERRORS`；正式质量比较有效：是。

实际运行 24 个配对单元，23 个三阶段均完整，可用于质量比较。样本是冻结交付的局部验收测试，不能等同于从零完成三类任务。

有效结构化阶段：71/72。失败阶段和整组排除不会被计作成功拦截。

## 实验设计

A：Orchestrator 业务初验。B：同一 Orchestrator 恢复原会话追加业务复核。C：新的 Auditor 会话审核 A 的验收行为和证据；放行要求 A 与审核均通过。B/C 共享同一冻结交付和初验记录，交换执行顺序，预算上限相同。角色规则来自当前 Flow，实验工具不修改生产状态。

模型：`Qwen3.8-27B-4bit`，本地服务 `http://127.0.0.1:8000/v1`，每请求输出上限 2048 token。具体协议见 [执行前协议](./auditor-ablation-protocol.md)。

## 按场景的错误放行与误拦

错误放行的分母是存在缺陷的交付；误拦的分母是合格交付。只纳入三阶段均完整的配对单元。

| 场景 | 完整配对 | 对照 | 缺陷错误放行 | 合格误拦 |
| --- | ---: | --- | ---: | ---: |
| 代码开发 | 8 | A 初验 | 0/6 | 0/2 |
| 代码开发 | 8 | B 追加自审 | 0/6 | 0/2 |
| 代码开发 | 8 | C 初验＋审核门禁 | 0/6 | 0/2 |
| 深度调研 | 7 | A 初验 | 2/5 | 0/2 |
| 深度调研 | 7 | B 追加自审 | 2/5 | 0/2 |
| 深度调研 | 7 | C 初验＋审核门禁 | 2/5 | 0/2 |
| 数学证明 | 8 | A 初验 | 3/6 | 0/2 |
| 数学证明 | 8 | B 追加自审 | 2/6 | 0/2 |
| 数学证明 | 8 | C 初验＋审核门禁 | 1/6 | 0/2 |

## 按缺陷类型的比较

| 交付类型 | 完整配对 | A 错误放行／误拦 | B 错误放行／误拦 | C 错误放行／误拦 |
| --- | ---: | ---: | ---: | ---: |
| clean | 6 | 0/6 | 0/6 | 0/6 |
| coverage-gap | 6 | 0/6 | 0/6 | 0/6 |
| stale-evidence | 6 | 4/6 | 4/6 | 3/6 |
| unsupported-conclusion | 5 | 1/5 | 0/5 | 0/5 |

## 业务内容与证据契约的分层解释

主分数保留执行前冻结的严格回执标准。研究、数学的 stale-evidence 产物及 result_ref 与 clean 相同，差异只在旧 Worker 回执；公开业务标准又允许 Orchestrator 重新检查当前产物。因此这四个计划单元的放行可能违反严格回执契约，却不能直接称为事实或证明错误。以下是运行后的解释性分层，不修改主标签，不选择性重判，也不作为新的预注册主要指标。

| 分层 | 完整缺陷配对 | A 放行 | B 放行 | C 放行 |
| --- | ---: | ---: | ---: | ---: |
| 业务内容缺陷：代码所有缺陷＋研究/数学覆盖缺口与无依据结论 | 13 | 1 | 0 | 0 |
| 仅旧回执契约：研究/数学 stale-evidence | 4 | 4 | 4 | 3 |

## 配对变化与归因

| 指标 | 数量 |
| --- | ---: |
| C 拦截 A 错误放行 | 2 |
| C 拦截 B 仍放行的缺陷 | 1 |
| B 拦截 C 仍放行的缺陷 | 0 |
| Auditor 对 A 已通过的合格交付新增误拦 | 0 |

C 的合取门禁会继承 A 的拒绝。以下仅比较 A 已通过的子集；不能把全部 C 误拦都归因于 Auditor。

| A 已通过子集 | 缺陷错误放行 | 合格误拦 |
| --- | ---: | ---: |
| B | 4/5 | 0/6 |
| Auditor 的原始审核决定 | 3/5 | 0/6 |

## 实际成本与阶段错误

成本包含所有尝试阶段；质量评分排除缺失阶段。输入 token 是 uncached、cache-read、cache-write 的互斥和；仅统计已返回 assistant message 的用量，失败流缺失用量不会被估算。B/C 为相对 A 的追加成本。

| 阶段 | 模型请求 | 输入 token | 输出 token | 时间（秒） | 未完整阶段 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A 初验 | 50 | 126962 | 15284 | 541.2 | 1 |
| B 追加自审（新增） | 49 | 270295 | 13175 | 570.0 | 0 |
| C 独立审核（新增） | 55 | 176110 | 13648 | 547.4 | 0 |

若部署其中一种流程，阶段成本的合计如下。它不包含一次性安装、主机启动和本报告的处理时间。

| 流程 | 模型请求 | 输入 token | 输出 token | 阶段时间合计（秒） |
| --- | ---: | ---: | ---: | ---: |
| 仅 A | 50 | 126962 | 15284 | 541.2 |
| A＋B | 99 | 397257 | 28459 | 1111.2 |
| A＋C | 105 | 303072 | 28932 | 1088.6 |

未完整阶段明细：

- research-unsupported-conclusion，重复 2，A 初验：Stage incomplete; native stop: {"kind":"max-tokens"}。该配对全部排除质量比较，不重试选中的样本。

## 逐单元决定

“C 放行”是合取门禁结果，“审核”是 Auditor 原始合规结论。失败阶段显示错误，不计为成功发现缺陷。

| 冻结交付 | 重复 | 应放行 | A | B | 审核 | C 放行 |
| --- | ---: | --- | --- | --- | --- | --- |
| code-clean | 1 | 是 | 通过 | 通过 | 通过 | 通过 |
| proof-clean | 1 | 是 | 通过 | 通过 | 通过 | 通过 |
| research-clean | 1 | 是 | 通过 | 通过 | 通过 | 通过 |
| code-coverage-gap | 1 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| proof-coverage-gap | 1 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| research-coverage-gap | 1 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| code-stale-evidence | 1 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| proof-stale-evidence | 1 | 否 | 通过 | 通过 | 通过 | 通过 |
| research-stale-evidence | 1 | 否 | 通过 | 通过 | 通过 | 通过 |
| code-unsupported-conclusion | 1 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| proof-unsupported-conclusion | 1 | 否 | 通过 | 拒绝 | 拒绝 | 拒绝 |
| research-unsupported-conclusion | 1 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| code-clean | 2 | 是 | 通过 | 通过 | 通过 | 通过 |
| proof-clean | 2 | 是 | 通过 | 通过 | 通过 | 通过 |
| research-clean | 2 | 是 | 通过 | 通过 | 通过 | 通过 |
| code-coverage-gap | 2 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| proof-coverage-gap | 2 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| research-coverage-gap | 2 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| code-stale-evidence | 2 | 否 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| proof-stale-evidence | 2 | 否 | 通过 | 通过 | 拒绝 | 拒绝 |
| research-stale-evidence | 2 | 否 | 通过 | 通过 | 通过 | 通过 |
| code-unsupported-conclusion | 2 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| proof-unsupported-conclusion | 2 | 否 | 拒绝 | 拒绝 | 通过 | 拒绝 |
| research-unsupported-conclusion | 2 | 否 | 阶段错误 | 拒绝 | 拒绝 | 阶段错误 |

## 结论边界

独立审核在冻结严格标签下比追加自审少放行 1 次，但该差异仅来自旧回执契约子集。业务内容缺陷子集未显示 Auditor 优于自审；不能据此宣称证明或事实准确率提高，也不能证明固定独立角色不可替代。
业务内容缺陷的错误放行由初验 1/13 降至独立审核 0/13，追加自审为 0/13。这表明至少一次追加检查有用。
Auditor 新增合格误拦为 0 次；其负面决定需要按原始 findings 检查是否有充分理由。

两次重复共享材料与模型，不是独立生产任务，没有报告统计显著性。代码、调研和数学 oracle 分别为真实边界测试、冻结官方事实/完整引用检查和特定初等证明证书校验。本轮未测开放检索、从零开发、复杂证明、Worker 返工或完整团队调度。

C 的五项治理规则与 B 的四项或七项业务标准具有不同的输出字段数量；相同上限不代表相同工作量。B 继承历史并重复读取材料，C 获得新的会话上下文，故成本差异不能只归因于身份。模型文件默认值与原生请求覆盖值分别保留：原生记录观察到 maxTokens=2048、reasoningEffort=off，配置快照不是服务内存状态或全部有效参数的证明。

## 原始证据与复现

- [原始 JSON](../../.artifacts/auditor-ablation-2026-10-11T22-46-58-130Z/report.json)（SHA256：`f75321d235b61ac1801119a578df04622853373ea6dff215f9962dc03c5bf769`）
- [冻结清单](../../.artifacts/auditor-ablation-2026-10-11T22-46-58-130Z/frozen-manifest.json)（SHA256：`4e218ebf197cb0f927374829192488189395d8d4eda50c5f5bc8eb17c441856f`）
- [模型配置快照](../../.artifacts/auditor-ablation-2026-10-11T22-46-58-130Z/model-recipe-before.json)
- 生产构建 commit：`0c49836e6fe0c60a9ccff73c132934305608f65c`，归档 SHA256：`c03628d0fa8fd8980951cb9d8dc09e63b34a4a3c8b63e66ceebcc769090d619e`。实验源码由冻结清单另行记录 SHA256。
- 漂移：build=false，experiment=false，protocol=false，recipe=false。
- 原生会话路径、每项检查的方法/观察/引用 IDs、native stop 与实际工具 read call IDs 保存在 JSON 中；原始压缩会话留在该轮 home/sessions。

```bash
pnpm experiment:auditor:check
pnpm experiment:auditor --pilot
# pilot complete_pairs 必须为 1，再运行正式轮
pnpm experiment:auditor
pnpm experiment:auditor:report .artifacts/<run-id>/report.json
```

运行目录由 Git 忽略；不包含可提交的模型密钥。先导错误另行保留，不混入正式样本。

[本轮结论、关键案例与解释限制](auditor-ablation-2026-10-11T22-46-58-130Z-analysis.md)

[原生记录复核](../../.artifacts/auditor-ablation-2026-10-11T22-46-58-130Z/native-verification.json)
