/** Render measurements without treating a failed run as a quality result. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { sha256 } from './fixtures.ts';
import { complete, release, summarize } from './score.ts';
import type { Trial } from './types.ts';

const input = resolve(process.argv[2] ?? '');
assert(process.argv[2], 'Usage: report.ts <report.json> [output.md]');
const output = resolve(process.argv[3] ?? 'docs/experiments/auditor-ablation-results.md');
const raw = readFileSync(input, 'utf8');
const report = JSON.parse(raw) as { status: string; pilot: boolean; run_id: string; model: string; baseURL: string; source_commit: string;
  output_token_ceiling: number; build_drift: unknown; experiment_code_drift: boolean; model_recipe_drift: boolean; protocol_drift: boolean;
  runtime_identity: { commit: string; archive_sha256: string }; frozen_manifest_sha256: string; failure: string | null; trials: Trial[] };
const valid = !report.pilot && ['COMPLETED', 'COMPLETED_WITH_STAGE_ERRORS'].includes(report.status)
  && !report.build_drift && !report.experiment_code_drift && !report.model_recipe_drift && !report.protocol_drift;
const summary = summarize(report.trials);
const trials = valid ? report.trials : [];
const names = { code: '代码开发', research: '深度调研', proof: '数学证明' };
const arms = ['baseline', 'self_review', 'auditor'] as const;
const labels = { baseline: 'A 初验', self_review: 'B 追加自审', auditor: 'C 初验＋审核门禁' };
const paired = trials.filter(t => complete(t.baseline) && complete(t.self_review) && complete(t.auditor));
const completedStages = report.trials.reduce((total, trial) => total + arms.filter(arm => complete(trial[arm])).length, 0);
const link = (path: string) => relative(dirname(output), path).split(' ').join('%20');
const lines = [
  '# Auditor 三场景消融实验：实测报告', '',
  `运行：\`${report.run_id}\`；状态：\`${report.status}\`；正式质量比较有效：${valid ? '是' : '否'}。`, '',
  valid ? `实际运行 ${report.trials.length} 个配对单元，${summary.complete_pairs} 个三阶段均完整，可用于质量比较。样本是冻结交付的局部验收测试，不能等同于从零完成三类任务。`
    : '该轮是先导、发生漂移或未完成，不能用于推断 Auditor 的质量收益。以下仅列运行诊断。', '',
  `有效结构化阶段：${completedStages}/${report.trials.length * 3}。失败阶段和整组排除不会被计作成功拦截。`, '',
  '## 实验设计', '',
  'A：Orchestrator 业务初验。B：同一 Orchestrator 恢复原会话追加业务复核。C：新的 Auditor 会话审核 A 的验收行为和证据；放行要求 A 与审核均通过。B/C 共享同一冻结交付和初验记录，交换执行顺序，预算上限相同。角色规则来自当前 Flow，实验工具不修改生产状态。', '',
  `模型：\`${report.model}\`，本地服务 \`${report.baseURL}\`，每请求输出上限 ${report.output_token_ceiling} token。具体协议见 [执行前协议](./auditor-ablation-protocol.md)。`, '',
  '## 按场景的错误放行与误拦', '',
  '错误放行的分母是存在缺陷的交付；误拦的分母是合格交付。只纳入三阶段均完整的配对单元。', '',
  '| 场景 | 完整配对 | 对照 | 缺陷错误放行 | 合格误拦 |',
  '| --- | ---: | --- | ---: | ---: |',
];
for (const scenario of ['code', 'research', 'proof'] as const) {
  const s = summarize(trials.filter(t => t.scenario === scenario));
  for (const arm of arms) { const a = s.arms[arm]!; lines.push(`| ${names[scenario]} | ${s.complete_pairs} | ${labels[arm]} | ${a.false_accepts}/${a.flawed} | ${a.false_blocks}/${a.clean} |`); }
}
lines.push('', '## 按缺陷类型的比较', '',
  '| 交付类型 | 完整配对 | A 错误放行／误拦 | B 错误放行／误拦 | C 错误放行／误拦 |',
  '| --- | ---: | ---: | ---: | ---: |');
for (const variant of ['clean', 'coverage-gap', 'stale-evidence', 'unsupported-conclusion'] as const) {
  const s = summarize(trials.filter(t => t.variant === variant));
  const rate = (arm: typeof arms[number]) => { const a = s.arms[arm]!; return variant === 'clean' ? `${a.false_blocks}/${a.clean}` : `${a.false_accepts}/${a.flawed}`; };
  lines.push(`| ${variant} | ${s.complete_pairs} | ${rate('baseline')} | ${rate('self_review')} | ${rate('auditor')} |`);
}
lines.push('', '## 业务内容与证据契约的分层解释', '',
  '主分数保留执行前冻结的严格回执标准。研究、数学的 stale-evidence 产物及 result_ref 与 clean 相同，差异只在旧 Worker 回执；公开业务标准又允许 Orchestrator 重新检查当前产物。因此这四个计划单元的放行可能违反严格回执契约，却不能直接称为事实或证明错误。以下是运行后的解释性分层，不修改主标签，不选择性重判，也不作为新的预注册主要指标。', '',
  '| 分层 | 完整缺陷配对 | A 放行 | B 放行 | C 放行 |', '| --- | ---: | ---: | ---: | ---: |');
for (const [label, items] of [
  ['业务内容缺陷：代码所有缺陷＋研究/数学覆盖缺口与无依据结论', trials.filter(t => !t.oracle.releasable && (t.scenario === 'code' || t.variant !== 'stale-evidence'))],
  ['仅旧回执契约：研究/数学 stale-evidence', trials.filter(t => t.variant === 'stale-evidence' && t.scenario !== 'code')],
] as const) {
  const s = summarize(items);
  lines.push(`| ${label} | ${s.complete_pairs} | ${s.arms.baseline!.false_accepts} | ${s.arms.self_review!.false_accepts} | ${s.arms.auditor!.false_accepts} |`);
}
lines.push('', '## 配对变化与归因', '',
  '| 指标 | 数量 |', '| --- | ---: |',
  `| C 拦截 A 错误放行 | ${valid ? summary.discordances.auditor_repairs_baseline_false_accept : '不可评分'} |`,
  `| C 拦截 B 仍放行的缺陷 | ${valid ? summary.discordances.auditor_blocks_self_accept : '不可评分'} |`,
  `| B 拦截 C 仍放行的缺陷 | ${valid ? summary.discordances.self_blocks_auditor_accept : '不可评分'} |`,
  `| Auditor 对 A 已通过的合格交付新增误拦 | ${valid ? summary.discordances.auditor_adds_clean_false_block : '不可评分'} |`, '',
  'C 的合取门禁会继承 A 的拒绝。以下仅比较 A 已通过的子集；不能把全部 C 误拦都归因于 Auditor。', '',
  '| A 已通过子集 | 缺陷错误放行 | 合格误拦 |', '| --- | ---: | ---: |');
const subset = summarize(trials).baseline_accepted_subset;
lines.push(`| B | ${subset.self_false_accepts}/${subset.flawed} | ${subset.self_false_blocks}/${subset.clean} |`,
  `| Auditor 的原始审核决定 | ${subset.auditor_false_accepts}/${subset.flawed} | ${subset.auditor_false_blocks}/${subset.clean} |`, '',
  '## 实际成本与阶段错误', '',
  '成本包含所有尝试阶段；质量评分排除缺失阶段。输入 token 是 uncached、cache-read、cache-write 的互斥和；仅统计已返回 assistant message 的用量，失败流缺失用量不会被估算。B/C 为相对 A 的追加成本。', '',
  '| 阶段 | 模型请求 | 输入 token | 输出 token | 时间（秒） | 未完整阶段 |', '| --- | ---: | ---: | ---: | ---: | ---: |');
for (const arm of arms) { const a = summary.arms[arm]!; const label = arm === 'auditor' ? 'C 独立审核（新增）' : arm === 'self_review' ? 'B 追加自审（新增）' : labels[arm]; lines.push(`| ${label} | ${a.model_requests} | ${a.input_tokens} | ${a.output_tokens} | ${(a.duration_ms / 1000).toFixed(1)} | ${a.stage_errors} |`); }
lines.push('', '若部署其中一种流程，阶段成本的合计如下。它不包含一次性安装、主机启动和本报告的处理时间。', '',
  '| 流程 | 模型请求 | 输入 token | 输出 token | 阶段时间合计（秒） |', '| --- | ---: | ---: | ---: | ---: |');
for (const [label, stages] of [['仅 A', ['baseline']], ['A＋B', ['baseline', 'self_review']], ['A＋C', ['baseline', 'auditor']]] as const) {
  const sum = (key: 'model_requests' | 'input_tokens' | 'output_tokens' | 'duration_ms') => stages.reduce((total, arm) => total + summary.arms[arm]![key], 0);
  lines.push(`| ${label} | ${sum('model_requests')} | ${sum('input_tokens')} | ${sum('output_tokens')} | ${(sum('duration_ms') / 1000).toFixed(1)} |`);
}
lines.push('', '未完整阶段明细：', '');
for (const t of report.trials) for (const arm of arms) if (!complete(t[arm])) lines.push(`- ${t.fixture_id}，重复 ${t.repetition}，${labels[arm]}：${(t[arm].error ?? 'Native stage incomplete').replaceAll('|', '\\|').replaceAll('\n', ' ')}。该配对全部排除质量比较，不重试选中的样本。`);
if (completedStages === report.trials.length * 3) lines.push('无。');
lines.push('', '## 逐单元决定', '',
  '“C 放行”是合取门禁结果，“审核”是 Auditor 原始合规结论。失败阶段显示错误，不计为成功发现缺陷。', '',
  '| 冻结交付 | 重复 | 应放行 | A | B | 审核 | C 放行 |', '| --- | ---: | --- | --- | --- | --- | --- |');
const word = (t: Trial, arm: typeof arms[number]) => complete(t[arm]) ? t[arm].decision!.accepted ? '通过' : '拒绝' : '阶段错误';
for (const t of report.trials) lines.push(`| ${t.fixture_id} | ${t.repetition} | ${t.oracle.releasable ? '是' : '否'} | ${word(t, 'baseline')} | ${word(t, 'self_review')} | ${word(t, 'auditor')} | ${complete(t.baseline) && complete(t.auditor) ? release(t, 'auditor') ? '通过' : '拒绝' : '阶段错误'} |`);
lines.push('', '## 结论边界', '');
if (!valid || !paired.length) lines.push('当前没有可用于质量结论的正式完整配对，不能论证 Auditor 必要或无效。');
else {
  const a = summarize(paired).arms;
  const content = summarize(paired.filter(t => t.scenario === 'code' || t.variant !== 'stale-evidence')).arms;
  if (a.baseline!.false_accepts === 0 && a.self_review!.false_accepts === 0 && a.auditor!.false_accepts === 0) lines.push('本样本未观察到 Auditor 减少错误放行的增量质量收益：三个对照均未错误放行缺陷交付。不能据此宣称独立审核不可替代，也不能据此推断所有生产任务均可取消审核。');
  else if (a.auditor!.false_accepts < a.self_review!.false_accepts && content.auditor!.false_accepts >= content.self_review!.false_accepts) lines.push(`独立审核在冻结严格标签下比追加自审少放行 ${a.self_review!.false_accepts - a.auditor!.false_accepts} 次，但该差异仅来自旧回执契约子集。业务内容缺陷子集未显示 Auditor 优于自审；不能据此宣称证明或事实准确率提高，也不能证明固定独立角色不可替代。`);
  else if (content.auditor!.false_accepts < content.self_review!.false_accepts) lines.push('业务内容缺陷子集中，独立审核比追加自审少放行错误；这支持本压力样本的局部收益，但仍须结合误拦和成本，不能证明普遍必要。');
  else lines.push('本样本未证明独立审核门禁优于等预算追加自审。若 C 只优于 A，则只能说明追加检查有益，不能说明 Auditor 身份不可替代。');
  if (content.baseline!.false_accepts > content.auditor!.false_accepts) lines.push(`业务内容缺陷的错误放行由初验 ${content.baseline!.false_accepts}/${content.baseline!.flawed} 降至独立审核 ${content.auditor!.false_accepts}/${content.auditor!.flawed}，追加自审为 ${content.self_review!.false_accepts}/${content.self_review!.flawed}。这表明至少一次追加检查有用。`);
  lines.push(`Auditor 新增合格误拦为 ${summary.discordances.auditor_adds_clean_false_block} 次；其负面决定需要按原始 findings 检查是否有充分理由。`);
}
lines.push('', '两次重复共享材料与模型，不是独立生产任务，没有报告统计显著性。代码、调研和数学 oracle 分别为真实边界测试、冻结官方事实/完整引用检查和特定初等证明证书校验。本轮未测开放检索、从零开发、复杂证明、Worker 返工或完整团队调度。', '',
  'C 的五项治理规则与 B 的四项或七项业务标准具有不同的输出字段数量；相同上限不代表相同工作量。B 继承历史并重复读取材料，C 获得新的会话上下文，故成本差异不能只归因于身份。模型文件默认值与原生请求覆盖值分别保留：原生记录观察到 maxTokens=2048、reasoningEffort=off，配置快照不是服务内存状态或全部有效参数的证明。', '',
  '## 原始证据与复现', '',
  `- [原始 JSON](${link(input)})（SHA256：\`${sha256(raw)}\`）`,
  `- [冻结清单](${link(resolve(dirname(input), 'frozen-manifest.json'))})（SHA256：\`${report.frozen_manifest_sha256}\`）`,
  `- [模型配置快照](${link(resolve(dirname(input), 'model-recipe-before.json'))})`,
  `- 生产构建 commit：\`${report.runtime_identity.commit}\`，归档 SHA256：\`${report.runtime_identity.archive_sha256}\`。实验源码由冻结清单另行记录 SHA256。`,
  `- 漂移：build=${Boolean(report.build_drift)}，experiment=${report.experiment_code_drift}，protocol=${report.protocol_drift}，recipe=${report.model_recipe_drift}。`,
  '- 原生会话路径、每项检查的方法/观察/引用 IDs、native stop 与实际工具 read call IDs 保存在 JSON 中；原始压缩会话留在该轮 home/sessions。',
  '', '```bash', 'pnpm experiment:auditor:check', 'pnpm experiment:auditor --baseline /path/to/restored-frozen-environment --pilot', '# pilot complete_pairs 必须为 1，再运行正式轮', 'pnpm experiment:auditor --baseline /path/to/restored-frozen-environment', 'pnpm experiment:auditor:report .artifacts/<run-id>/report.json', '```', '',
  '运行目录由 Git 忽略；不包含可提交的模型密钥。先导错误另行保留，不混入正式样本。', '');
const analysis=resolve(dirname(output), `${report.run_id}-analysis.md`);
if (existsSync(analysis)) lines.push(`[本轮结论、关键案例与解释限制](${link(analysis)})`, '');
lines.push(`[原生记录复核](${link(resolve(dirname(input), 'native-verification.json'))})`, '');
writeFileSync(output, lines.join('\n'));
console.log(JSON.stringify({ output, valid, complete_pairs: paired.length, report_sha256: sha256(raw) }));
