/** Real provider acceptance for saved plans, readable handoffs and independent governance. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DshHost, buildHostEnv, createRunLayout, ensureProfile, WEB_PROFILE_BUNDLES, PROJECT_ROOT, PLUGIN_ROOT } from '../../src/host/host.ts';
import { findSessionFile, readSessionEvents } from '../../src/host/session-scan.ts';
import { computeBuildHashes, buildDrift } from './build-fingerprint.ts';
import { ipcBridgePatchText, startAcceptanceHost } from './run.ts';
import { asObject, asString } from './context.ts';
import { isCurrentWorkerProducer } from './handoff-worker-identity.ts';

const cases = [
  { id: 'simple', objective: '请安排成员计算 2+3，由总协调实际校验，并让 Auditor 独立审核验收过程。一个执行者即可完成，无需分解。全程纯文本，不读写文件、不运行终端。最终交付结果、验收结论和审核结论。', criteria: ['计算结果为 5，包含简短计算依据', '全程纯文本，不读写文件或运行终端'] },
  { id: 'decompose', objective: '制作一份纯文本算术报告：分别计算 17×23 和 144÷12，两部分是独立交付，请拆分为两个工作单元，最后由总协调整合报告并检查两个结果及报告完整性。每份局部交付和最终整合均由对应总协调实际校验，Auditor 审核其验收。全程不读写文件、不运行终端。', criteria: ['第一部分给出 391 及乘法依据', '第二部分给出 12 及除法依据', '最终报告同时保留两个结果、计算依据及整体验收结论'] },
  { id: 'delegation', objective: '形成纯文本指标核验报告，并演示两层自主管理委派。结构应为根管理域→一级指标核验管理域→二级原始计算复核管理域→执行者：根总协调委派一级域，一级总协调自主规划并委派二级域，二级总协调自主规划一个执行者计算 2+3。每个管理者校验自己接收的下游交付并逐层整合；各层验收记录由本层 Auditor 独立审核后才能接受。根协调整合最终报告，保留计算依据与逐层交付关系。不得用 Worker 充当第二层管理域，也不得把独立计算交给 Auditor；全程不使用文件或终端。', criteria: ['最终计算结果为 5 且依据可核对', '存在两层真实子管理域，各自保存规划并逐层交接整合', '最终报告保留原始计算依据及逐层交付关系'] },
  { id: 'correction', objective: '这是明确的纠正流程演练：只用纯文本完成 2+3。首次执行者请提交候选 6，并说明这是演练中的错误候选；总协调必须实际检查并拒绝错误候选，然后正式修订任务，要求执行者提交正确结果与依据。最终总协调校验正确结果，Auditor 审核验收行为。不要把首次错误候选标为验收通过。全程不读写文件、不运行终端。', criteria: ['首次错误候选被总协调实际识别并记录拒绝及纠正', '最终提交正确结果 5 及计算依据', '最终交付区分首次错误候选与纠正后的正确结果'] },
  { id: 'recovery', objective: '请安排一个执行者计算 2+3 并解释依据，交付后由总协调实际校验并由 Auditor 独立审核验收。此运行可能发生宿主进程重启；请依据已保存计划及真实结果继续工作。全程纯文本，不读写文件、不运行终端。最终交付结果和验收结论。', criteria: ['结果为 5 且依据可核对', '重启后继续原正式任务，保留原任务与实际交付依据'] },
] as const;

const key = process.env.FLOW_MODEL_API_KEY;
if (!key) throw new Error('Configure FLOW_MODEL_API_KEY in the process environment.');
const reasoningEffort = process.env.FLOW_MODEL_REASONING_EFFORT ?? 'off';
assert(['off', 'high'].includes(reasoningEffort), 'FLOW_MODEL_REASONING_EFFORT must be off or high');
const timeout = Number(process.env.FLOW_LIVE_TIMEOUT_MS ?? 900_000);
const selected = process.argv[2];
if (selected && !cases.some(entry => entry.id === selected)) throw new Error(`Unknown scenario ${selected}`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const redact = (value: string): string => value.replaceAll(key, '[redacted]');
const results: unknown[] = [];

type Row = Record<string, unknown>;
function decoded(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : null; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = asObject(value);
  return record ? `{${Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value) ?? 'undefined';
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const nonempty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
const containsValue = (result: unknown, value: number): boolean => new RegExp(`\\b${value}\\b`).test(JSON.stringify(result) ?? '');

for (const scenario of cases.filter(entry => !selected || entry.id === selected)) {
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts'), `handoffs-${scenario.id}-${stamp}`);
  chmodSync(layout.root, 0o700);
  const profile = `flow-handoffs-${scenario.id}-${stamp}`;
  // Exercise the npm artifact that users install, with host services shared as
  // peer dependencies. Shipped bytes are checked before loading the profile.
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', layout.root],
    { cwd: PLUGIN_ROOT, encoding: 'utf8' })) as { filename: string }[];
  const archive = packed[0]?.filename;
  assert(archive, 'npm produces a package artifact');
  execFileSync('tar', ['-xzf', join(layout.root, archive), '-C', layout.root]);
  const packagePath = join(layout.root, 'package');
  for (const file of ['index.js', 'command.js', 'web.js', 'client.js', 'typert.host.js', 'typert.remote-client.js']) {
    assert.deepEqual(readFileSync(join(packagePath, 'lib', file)), readFileSync(join(PLUGIN_ROOT, 'lib', file)), `installed ${file} matches build`);
  }
  symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(packagePath, 'node_modules'), 'dir');
  ensureProfile(layout.home, profile, { bundles: WEB_PROFILE_BUNDLES, packagePath });
  const bridge = join(layout.root, 'ipc-bridge.patch.yml');
  writeFileSync(bridge, ipcBridgePatchText());
  const patches = [join(PROJECT_ROOT, 'examples/cluster.patch.yml'), join(PROJECT_ROOT, 'examples/deepseek.patch.yml'), bridge];
  const buildBefore = computeBuildHashes({ id: '' }, patches);
  const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { provider: 'deepseek', model: process.env.FLOW_MODEL_ID ?? 'deepseek-flash', baseURL: process.env.FLOW_MODEL_BASE_URL ?? 'https://api.deepseek.com' }, modelApiKey: key });
  env.FLOW_MODEL_REASONING_EFFORT = reasoningEffort;
  const makeHost = (suffix: string): DshHost => new DshHost({ profile, patches, cwd: layout.workspace, env,
    logPath: join(layout.logs, `host${suffix}.log`), sanitizeLog: redact });
  let host = makeHost('');
  let clusterId: string | undefined;
  let restarted = false;
  let restartInput: { id: string; agent_id: string; native_message_id: string; entries_before_restart: number } | undefined;
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  let error: string | undefined;
  const check = (name: string, predicate: unknown, detail?: string): void => {
    checks.push({ name, passed: Boolean(predicate), ...(detail === undefined ? {} : { detail }) });
  };
  try {
    await startAcceptanceHost(host);
    const started = asObject(await host.request('start', undefined, { objective: scenario.objective,
      workspace: layout.workspace, capabilities: [], acceptance_criteria: [...scenario.criteria],
      limits: { max_depth: 4, max_role_turns: 80, max_attempts: 4 },
      budget: { tool_calls: 1200, agents: 24, max_active_agents: 8, wall_time_ms: timeout } }, 120_000));
    clusterId = asString(asObject(started?.cluster)?.id) ?? undefined;
    assert(clusterId, 'native host creates a cluster');
    const deadline = Date.now() + timeout;
    for (;;) {
      const snapshot = asObject(await host.request('read', clusterId, { limit: 500 }, 30_000));
      const status = asString(asObject(snapshot?.cluster)?.status);
      const waiting = new DatabaseSync(join(layout.data, 'cluster.sqlite'), { readOnly: true });
      const awaitingUser = waiting.prepare('SELECT meta FROM agents WHERE cluster_id=?').all(clusterId)
        .some(row => asObject(JSON.parse(String(row.meta)))?.ui_state === 'waiting_user');
      waiting.close();
      if (awaitingUser) throw new Error('Synthetic task stopped for an unexpected human decision; inspect the native evidence.');
      if (scenario.id === 'recovery' && !restarted) {
        const db = new DatabaseSync(join(layout.data, 'cluster.sqlite'), { readOnly: true });
        const admitted = db.prepare("SELECT * FROM member_inputs WHERE cluster_id=? AND kind='initial' AND status='ADMITTED' ORDER BY created,id").all(clusterId);
        const ready = admitted.find(input => {
          const file = findSessionFile(join(layout.home, 'sessions'), String(input.session_id));
          const journal = file ? readSessionEvents(file) : null;
          const entries = journal?.events.filter(event => event.type === 'user/message' && asObject(event.data)?.id === input.native_message_id) ?? [];
          if (journal?.state !== 'READ' || entries.length !== 1 || !nonempty(input.content)) return false;
          restartInput = { id: String(input.id), agent_id: String(input.agent_id), native_message_id: String(input.native_message_id), entries_before_restart: entries.length };
          return true;
        });
        db.close();
        if (ready && restartInput) {
          await host.stop();
          host = makeHost('-restarted');
          await startAcceptanceHost(host);
          await host.request('recover', clusterId, {}, 120_000);
          restarted = true;
        }
      }
      if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(status ?? '')) {
        check('cluster-completed', status === 'COMPLETED', `status=${status}`);
        break;
      }
      if (Date.now() > deadline) throw new Error(`Timed out with cluster status ${status}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    writeFileSync(join(layout.root, 'snapshot.json'), redact(JSON.stringify(await host.request('read', clusterId, { limit: 500 }), null, 2)));
    writeFileSync(join(layout.root, 'execution-report.json'), redact(JSON.stringify(await host.request('report', clusterId, {}), null, 2)));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    check('live-execution', false, redact(error));
  } finally { await host.stop(); }

  if (clusterId) {
    const db = new DatabaseSync(join(layout.data, 'cluster.sqlite'), { readOnly: true });
    try {
      const agents = db.prepare('SELECT * FROM agents WHERE cluster_id=?').all(clusterId);
      const transactions = db.prepare('SELECT * FROM transactions WHERE cluster_id=?').all(clusterId);
      const plans = db.prepare('SELECT * FROM plans WHERE cluster_id=?').all(clusterId);
      const validations = db.prepare('SELECT * FROM validation_records WHERE cluster_id=?').all(clusterId);
      const publications = db.prepare('SELECT * FROM result_snapshots WHERE cluster_id=?').all(clusterId);
      const audits = db.prepare('SELECT * FROM audits WHERE cluster_id=?').all(clusterId);
      const inputs = db.prepare('SELECT * FROM member_inputs WHERE cluster_id=?').all(clusterId);
      const nodes = db.prepare('SELECT * FROM nodes WHERE cluster_id=?').all(clusterId);
      const allocations = db.prepare('SELECT * FROM allocations WHERE cluster_id=?').all(clusterId);
      const assignments = db.prepare('SELECT * FROM management_assignments WHERE transaction_id IN (SELECT id FROM transactions WHERE cluster_id=?)').all(clusterId);
      const events = db.prepare('SELECT * FROM events WHERE cluster_id=? ORDER BY seq').all(clusterId)
        .map(row => ({ seq: Number(row.seq), type: String(row.type), at: Number(row.at), data: asObject(decoded(row.data)) }));
      const commands = db.prepare('SELECT * FROM commands WHERE cluster_id=?').all(clusterId)
        .map(row => ({ command_id: String(row.command_id), action: String(row.action), at: Number(row.at), actor: asObject(decoded(row.actor)), result: asObject(decoded(row.result)) }));
      const unpack = (rows: readonly Row[]): Record<string, unknown>[] => rows.flatMap(row => {
        const record = asObject(decoded(row.data)); return record ? [record] : [];
      });
      const decodedPlans = unpack(plans), decodedValidations = unpack(validations), decodedResults = unpack(publications);
      const planFor = (tx: Row) => decodedPlans.find(row => same(row.ref, decoded(tx.current_plan_ref)));
      const resultFor = (tx: Row) => decodedResults.find(row => same(row.ref, decoded(tx.current_result_ref)));
      const validationFor = (tx: Row) => decodedValidations.find(row => same(row.ref, decoded(tx.current_validation_ref)));
      const acceptedRecord = (tx: Row): boolean => {
        const planRef = decoded(tx.current_plan_ref), resultRef = decoded(tx.current_result_ref), validationRef = decoded(tx.current_validation_ref);
        const plan = planFor(tx), result = resultFor(tx), validation = validationFor(tx);
        const author = agents.find(agent => agent.id === validation?.author_agent_id);
        const planner = agents.find(agent => agent.id === plan?.author_agent_id);
        const audit = audits.find(row => row.kind === 'validation' && row.decision === 'APPROVED'
          && same(decoded(row.validation_ref), validationRef) && same(decoded(row.plan_ref), planRef));
        const auditor = agents.find(agent => agent.id === audit?.auditor_agent_id);
        const contract = asObject(plan?.contract), planIdentity = asObject(planRef);
        const criteria = Array.isArray(contract?.acceptance_criteria) ? contract.acceptance_criteria : [];
        const checks = Array.isArray(validation?.checks) ? validation.checks.map(asObject) : [];
        const completeChecks = planIdentity !== null && criteria.length > 0 && criteria.every((_criterion, criterion_index) => checks.some(check =>
          same(check?.criterion_ref, { ...planIdentity, criterion_index }) && check?.passed === true
          && nonempty(check.method) && nonempty(check.observation) && nonempty(check.evidence)
          && Array.isArray(check.evidence_refs) && check.evidence_refs.length > 0));
        return tx.status === 'ACCEPTED' && plan !== undefined && result !== undefined && validation?.accepted === true
          && validation.author_role === 'orchestrator' && author?.role === 'orchestrator' && author.node_id === tx.node_id
          && plan.author_role === 'orchestrator' && planner?.role === 'orchestrator' && planner.node_id === tx.node_id
          && same(validation.result_ref, resultRef) && same(validation.plan_ref, planRef)
          && same(result.plan_ref, planRef) && same(result.result, decoded(tx.result))
          && audit !== undefined && auditor?.role === 'auditor' && auditor.node_id === tx.node_id
          && audit.auditor_agent_id !== validation.author_agent_id && completeChecks;
      };
      const currentDelivery = (parent: Row, child: Row): boolean => {
        const publication = resultFor(parent);
        return child.status === 'ACCEPTED' && Array.isArray(publication?.source_result_refs)
          && publication.source_result_refs.some(ref => same(ref, decoded(child.current_result_ref)))
          && Array.isArray(publication.source_validation_refs)
          && publication.source_validation_refs.some(ref => same(ref, decoded(child.current_validation_ref)));
      };
      const transcripts: unknown[] = [];
      const nativeInitialCounts = new Map<string, number>();
      for (const agent of agents) {
        const file = findSessionFile(join(layout.home, 'sessions'), String(agent.session_id));
        const journal = file ? readSessionEvents(file) : null;
        const nativeEvents = journal?.events ?? [];
        const userEvents = nativeEvents.filter(event => event.type === 'user/message');
        const texts = userEvents.map(event => {
          const data = asObject(event.data);
          const blocks = Array.isArray(data?.content) ? data.content : [];
          return blocks.map(block => asString(asObject(block)?.text) ?? '').join('\n');
        });
        const initials = inputs.filter(row => row.agent_id === agent.id && row.kind === 'initial');
        const actuallyRan = Number(agent.turns) > 0 || userEvents.length > 0;
        if (actuallyRan) {
          check(`${agent.role}:readable-input`, journal?.state === 'READ' && texts.length > 0
            && texts.every(text => nonempty(text) && !/Current domain state|pending_actions|^Role:|STATUS:/m.test(text)));
          check(`${agent.role}:initial-record-exists`, initials.length === 1, `${initials.length} initial records`);
        }
        for (const input of initials) {
          const entries = userEvents.filter(event => asObject(event.data)?.id === input.native_message_id);
          nativeInitialCounts.set(String(input.id), entries.length);
          check(`${agent.role}:initial-entered-once`, input.status === 'ADMITTED' && nonempty(input.content) && entries.length === 1,
            `${entries.length} entries; input=${input.id}`);
        }
        transcripts.push({ agent_id: agent.id, role: agent.role, session_id: agent.session_id, events: nativeEvents });
      }
      check('saved-manager-plans', plans.length > 0);
      check('immutable-validations', validations.length > 0);
      check('independent-audit-decisions', audits.some(audit => audit.kind === 'validation' && audit.decision === 'APPROVED'));
      check('all-formal-work-accepted', transactions.length > 0 && transactions.every(tx => ['ACCEPTED', 'SUPERSEDED', 'CANCELLED'].includes(String(tx.status))));
      const accepted = transactions.filter(tx => tx.status === 'ACCEPTED');
      check('accepted-current-records-and-authors', accepted.length > 0 && accepted.every(acceptedRecord));
      const acceptedText = accepted.map(tx => String(tx.result)).join('\n');
      check('expected-business-values', scenario.id === 'decompose'
        ? /\b391\b/.test(acceptedText) && /\b12\b/.test(acceptedText) : /\b5\b/.test(acceptedText));
      const roots = transactions.filter(tx => tx.parent_transaction_id === null);
      if (scenario.id === 'simple') {
        check('one-worker', agents.filter(agent => agent.role === 'worker').length === 1);
        check('no-artificial-decomposition', transactions.length === 1 && assignments.length === 0 && planFor(transactions[0]!)?.execution === 'worker');
        const publication = transactions[0] ? resultFor(transactions[0]) : undefined;
        check('native-worker-delivery', publication?.producer_role === 'worker'
          && agents.some(agent => agent.id === publication.producer_agent_id && agent.role === 'worker'));
      }
      if (scenario.id === 'decompose') {
        check('real-child-work', roots.some(parent => {
          const plan = planFor(parent);
          const ids = Array.isArray(plan?.child_transaction_ids) ? plan.child_transaction_ids : [];
          const children = ids.flatMap(id => transactions.filter(tx => tx.id === id && tx.parent_transaction_id === parent.id));
          return plan?.execution === 'decompose' && ids.length === 2 && new Set(ids).size === 2 && children.length === 2
            && children.every(child => acceptedRecord(child) && currentDelivery(parent, child)
              && resultFor(child)?.producer_role === 'worker')
            && children.some((first, index) => containsValue(resultFor(first)?.result, 391)
              && children.some((second, secondIndex) => secondIndex !== index && containsValue(resultFor(second)?.result, 12)));
        }));
      }
      if (scenario.id === 'delegation') {
        const sameDomainTasks = (entry: Row, execution: 'management' | 'worker', visited = new Set<unknown>()): Row[] => {
          if (visited.has(entry.id) || !acceptedRecord(entry)) return [];
          const plan = planFor(entry);
          if (plan?.execution === execution) return [entry];
          if (plan?.execution !== 'decompose' || !Array.isArray(plan.child_transaction_ids)) return [];
          const nextVisited = new Set(visited).add(entry.id);
          return plan.child_transaction_ids.flatMap(id => transactions.filter(tx => tx.id === id
            && tx.parent_transaction_id === entry.id && tx.node_id === entry.node_id && currentDelivery(entry, tx))
            .flatMap(tx => sameDomainTasks(tx, execution, nextVisited)));
        };
        const next = (entry: Row): { node: Row; tx: Row }[] => sameDomainTasks(entry, 'management').flatMap(parent =>
          assignments.flatMap(assignment => {
            if (assignment.transaction_id !== parent.id || !same(decoded(assignment.plan_ref), decoded(parent.current_plan_ref))) return [];
            const node = nodes.find(row => row.id === assignment.node_id), tx = transactions.find(row => row.id === assignment.delegated_transaction_id);
            return node && tx && node.kind === 'management' && node.parent_id === parent.node_id
              && node.delegated_transaction_id === tx.id && tx.node_id === node.id && tx.parent_transaction_id === parent.id
              && acceptedRecord(tx) && currentDelivery(parent, tx) ? [{ node, tx }] : [];
          }));
        check('two-management-levels', roots.some(root => next(root).some(level1 => Number(level1.node.depth) === 1
          && next(level1.tx).some(level2 => Number(level2.node.depth) === 2
            && sameDomainTasks(level2.tx, 'worker').some(tx => {
              const publication = resultFor(tx);
              return publication?.producer_role === 'worker' && containsValue(publication.result, 5)
                && isCurrentWorkerProducer(tx, publication, agents, nodes, allocations);
            })))));
      }
      if (scenario.id === 'correction') {
        const rejectionSequences = (wrong: Record<string, unknown>): number[] => {
          const identity = asObject(wrong.ref), transactionId = identity?.transaction_id;
          const negative = decodedValidations.filter(record => record.accepted === false && same(record.result_ref, wrong.ref));
          const negativeEvents = events.filter(event => event.type === 'validation-proposed' && event.data?.transaction_id === transactionId
            && event.data?.accepted === false && negative.some(record => asObject(record.ref)?.result_revision === event.data?.result_revision));
          const rejectedCommands = commands.filter(command => command.action === 'reject_result' && command.actor?.role === 'orchestrator'
            && command.result?.transaction_id === transactionId && command.result?.status === 'REJECTED');
          const issues = events.filter(event => event.type === 'issue-opened' && event.data?.transaction_id === transactionId
            && rejectedCommands.some(command => command.result?.issue_id === event.data?.issue_id));
          const rejectedEvents = events.filter(event => event.type === 'transaction-status' && event.data?.transaction_id === transactionId
            && event.data?.to === 'REJECTED' && issues.some(issue => Number(issue.seq) < Number(event.seq)));
          const entered = Number(identity?.publication_event_seq);
          const nextPublication = Math.min(Infinity, ...decodedResults.flatMap(record => {
            const ref = asObject(record.ref), seq = Number(ref?.publication_event_seq);
            return ref?.transaction_id === transactionId && seq > entered ? [seq] : [];
          }));
          return [...negativeEvents, ...rejectedEvents].map(event => Number(event.seq)).filter(seq => seq > entered && seq < nextPublication);
        };
        check('correction-recorded', decodedResults.some(wrong => {
          const wrongRef = asObject(wrong.ref), wrongPlan = asObject(wrong.plan_ref);
          if (wrong.producer_role !== 'worker' || !containsValue(wrong.result, 6)
            || decodedValidations.some(record => record.accepted === true && same(record.result_ref, wrong.ref))) return false;
          return rejectionSequences(wrong).some(rejectionSeq => Number(wrongRef?.publication_event_seq) < rejectionSeq
            && events.some(adjustment => adjustment.type === 'transaction-adjusted'
              && adjustment.data?.transaction_id === wrongRef?.transaction_id && Number(adjustment.seq) > rejectionSeq
              && accepted.some(tx => tx.id === wrongRef?.transaction_id && acceptedRecord(tx)
                && Number(asObject(tx.current_result_ref ? decoded(tx.current_result_ref) : null)?.publication_event_seq) > Number(adjustment.seq)
                && Number(asObject(planFor(tx)?.ref)?.prepared_revision) > Number(wrongPlan?.prepared_revision)
                && resultFor(tx)?.producer_role === 'worker' && containsValue(resultFor(tx)?.result, 5))));
        }));
      }
      if (scenario.id === 'recovery') {
        const preserved = restartInput;
        check('host-restarted', restarted);
        check('restart-initial-preserved-once', preserved !== undefined && preserved.entries_before_restart === 1
          && nativeInitialCounts.get(preserved.id) === 1
          && inputs.some(input => input.id === preserved.id && input.native_message_id === preserved.native_message_id && input.status === 'ADMITTED'),
        JSON.stringify(preserved));
      }
      writeFileSync(join(layout.root, 'native-evidence.json'), redact(JSON.stringify({ plans, publications, validations, audits, inputs, nodes, allocations, assignments, events, commands, restart_input: restartInput, transcripts }, null, 2)));
    } finally { db.close(); }
  }
  const buildAfter = computeBuildHashes({ id: '' }, patches);
  check('source-and-build-stable', buildDrift(buildBefore, buildAfter) === null, buildDrift(buildBefore, buildAfter) ?? undefined);
  const report = { scenario: scenario.id, status: checks.every(entry => entry.passed) ? 'PASSED' : 'FAILED',
    provider: 'deepseek', model: env.FLOW_QWEN_MODEL, reasoning_effort: reasoningEffort, checks, build_before: buildBefore, build_after: buildAfter,
    installed_package: { path: packagePath, archive, sha256: createHash('sha256').update(readFileSync(join(layout.root, archive))).digest('hex'), shipped_files_match_build: true },
    ...(error === undefined ? {} : { error: redact(error) }) };
  writeFileSync(join(layout.root, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
  results.push({ scenario: scenario.id, status: report.status, report: join(layout.root, 'report.json') });
  console.log(JSON.stringify(results.at(-1)));
  if (report.status !== 'PASSED') process.exitCode = 1;
}
console.log(JSON.stringify({ results }));
