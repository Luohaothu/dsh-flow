// Historical schema-4 driver. Excluded from current production compilation; run only in the frozen baseline.
/** Experimental stage driver, isolated from the interactive host and its gate. */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ClusterRuntime } from '../../../packages/dsh-flow/src/core/cluster.ts';
import { ROLE_SYSTEM_INSTRUCTIONS } from '../../../packages/dsh-flow/src/core/briefing.ts';
import { runTurn } from '../../../packages/dsh-flow/src/core/runtime.ts';
import { coerceParams } from '../../../packages/dsh-flow/src/core/role-tools.ts';
import { findSessionFile } from '../../../src/host/session-scan.ts';
import type { AgentRecord } from '../../../packages/dsh-flow/src/core/model.ts';
import type { Decision, Finding, Packet, TrialTurn } from './types.ts';

export const name = 'auditor-ablation-fixture';
export const inject = ['agents', 'tools', 'sessions', 'llm', 'flow'];
interface Config { workspace: string; home: string; database: string; requestsPath: string; provider: string; model: string }
const RULES = ['standard_coverage', 'checks_performed', 'evidence_applicability', 'conclusion_support', 'authority'];
interface Pair { manager: AgentRecord; auditor: AgentRecord; packet: Packet; baseline?: TrialTurn }
const object = (value: unknown): Record<string, unknown> => coerceParams(value);

function decisionOf(value: unknown, mode: string, packet: Packet, evidenceIds: readonly string[]): Decision {
  const payload = object(value);
  if (typeof payload.accepted !== 'boolean' || !Array.isArray(payload.checks) || !Array.isArray(payload.issues) || typeof payload.notes !== 'string') throw new Error('Decision requires accepted:boolean, checks:array, issues:string[], notes:string');
  const fields = mode === 'auditor' ? RULES : packet.criteria.map(item => item.id);
  const key = mode === 'auditor' ? 'rule' : 'criterion_id';
  const checks = payload.checks.map(value => {
    const check = object(value);
    if (typeof check[key] !== 'string' || !fields.includes(String(check[key]))) throw new Error(`Invalid ${key}; use one of ${fields.join(', ')}`);
    if (typeof check.passed !== 'boolean') throw new Error(`Finding ${String(check[key])} requires passed:true or passed:false; this field cannot be omitted`);
    if (typeof check.method !== 'string' || !check.method.trim()) throw new Error(`Finding ${String(check[key])} requires a nonempty method`);
    if (typeof check.observation !== 'string' || !check.observation.trim()) throw new Error(`Finding ${String(check[key])} requires a nonempty observation`);
    if (!Array.isArray(check.evidence_ids) || !check.evidence_ids.length || check.evidence_ids.some(id => typeof id !== 'string' || !evidenceIds.includes(id))) throw new Error(`Finding ${String(check[key])} evidence_ids must be a nonempty array using ${evidenceIds.join(', ')}`);
    return check as unknown as Finding;
  });
  if (new Set(checks.map(check => check[key])).size !== fields.length || checks.length !== fields.length) throw new Error('Cover every criterion/rule exactly once');
  if (payload.accepted && checks.some(check => !check.passed)) throw new Error('Positive decision cannot contain a failing check');
  if (payload.issues.some(value => typeof value !== 'string')) throw new Error('issues must contain strings');
  return { accepted: payload.accepted, checks, issues: payload.issues as string[], notes: payload.notes };
}
export function apply(ctx: Context, config: Config): void {
  const runtime = new ClusterRuntime(ctx, { path: config.database, autoTick: false, model: { provider: config.provider, model: config.model, reasoningEffort: 'off' } });
  const pairs = new Map<string, Pair>();
  const requests = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  ctx.on('llm/stream', async function* (options, next) {
    const sessionId = String(options.sessionId ?? '');
    if (options.purpose !== 'session-title') requests.set(sessionId, (requests.get(sessionId) ?? 0) + 1);
    appendFileSync(config.requestsPath, `${JSON.stringify({ session_id: sessionId, provider: options.provider, model: options.model, purpose: options.purpose ?? null,
      // Provider secret resolution occurs downstream; save only explicit sampling settings.
      parameters: Object.fromEntries(Object.entries(options).filter(([key]) => ['temperature', 'topP', 'maxTokens', 'reasoningEffort'].includes(key))) })}\n`);
    yield* next();
  });
  const stage = async (pair: Pair, mode: 'baseline' | 'self_review' | 'auditor'): Promise<TrialTurn> => {
    const agent = mode === 'auditor' ? pair.auditor : pair.manager;
    const role = mode === 'auditor' ? 'auditor' : 'orchestrator';
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error('Experimental stage exceeded 120 seconds')), 120_000);
    let decision: Decision | null = null;
    let error: string | null = null;
    let outcome: Awaited<ReturnType<typeof runTurn>> | undefined;
    let calls = 0;
    const readIds: string[] = [];
    const ids = ['current-result', 'artifact', ...pair.packet.receipts.map(item => item.id), ...(pair.packet.sources ?? []).map(item => item.id), ...(mode === 'baseline' ? [] : ['validation-record', 'manager-native-observations'])];
    const started = Date.now();
    const countBefore = requests.get(agent.session_id) ?? 0;
    const submitName = mode === 'auditor' ? 'experiment_submit_audit' : 'experiment_submit_validation';
    const instruction = mode === 'auditor'
      ? `审核先前 Orchestrator 验收记录与实际观察是否合规。accepted 表示审核合规（不是你的业务验收）；最终放行仍要求 Orchestrator 的 accepted 为 true。不要补做业务校验，也不要把阅读材料说成运行了代码。逐项覆盖规则 ${RULES.join(', ')}，使用 rule 字段。`
      : `${mode === 'self_review' ? '这是你自己的追加业务复核。允许纠正初验结论，独立审核职责在本消融对照中被移除，但不要假称获得 Auditor 的批准。' : '作为业务验收负责人，基于本次交付及实际证据进行初验。'} accepted 表示业务验收通过。逐项覆盖 formal criteria，使用 criterion_id 字段。不得声称进行了证据包未记载的实际工具执行；可明确记录你的源码/数学/文献推理检查。`;
    try {
      outcome = await runTurn(ctx, {
        agent, role, prompt: `${instruction}\n先调用 experiment_read_packet，读取完整材料、引用与前序验收（如果有）；然后通过 ${submitName} 提交 payload={accepted:boolean,checks:[{${mode === 'auditor' ? 'rule' : 'criterion_id'}:string,passed:boolean,method:string,observation:string,evidence_ids:[string]}],issues:[string],notes:string}。所有标准/规则恰好一项；每项使用实际可用 evidence_ids，正面决定只能在全部 passed=true 时提交。用中文简短记录，每项 method 一短句、observation 不超过 60 字、notes 不超过 80 字；不要复述整份材料。最多 6 次工具调用，120 秒。只提交当前实验阶段，不调用生产工具、不创建其他工作。`,
        systemInstructions: `${ROLE_SYSTEM_INSTRUCTIONS[role]}\n这是隔离的局部消融实验；工具 experiment_* 替代正式状态变更，结果是实验观察，不授权生产验收。正式对象使用冻结 result_ref，外部实验 oracle 不提供给模型。`,
        allowedTools: ['experiment_read_packet', submitName], globalTools: [], capabilities: [],
        model: runtime.modelFor(agent), resume: mode === 'self_review', turnSeq: mode === 'self_review' ? 2 : 1,
        cwd: config.workspace, flow: runtime, signal: controller.signal,
        setup(agentCtx) {
          const admit = () => { if (++calls > 6) { controller.abort(new Error('Experimental tool-call ceiling reached')); throw new Error('Tool-call ceiling reached'); } };
          agentCtx.tools.register(defineTool({ name: 'experiment_read_packet', description: 'Read the immutable current task, Worker artifact, capture receipts and earlier manager validation, when present. This is a read, not execution of any described checks.',
            parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(_args, exec) {
              admit(); readIds.push(String(exec.callId));
              return JSON.stringify({ packet: pair.packet, evidence_ids: ids, ...(mode === 'baseline' ? {} : { validation_record: pair.baseline?.decision ? { result_ref: pair.packet.result_ref, author_role: 'orchestrator', ...pair.baseline.decision } : null,
                manager_native_observations: { session_id: pair.baseline?.session_id, read_packet_call_ids: pair.baseline?.read_packet_call_ids, model_requests: pair.baseline?.model_requests,
                  stage_completed: pair.baseline?.native_completed === true && pair.baseline.error === null, error: pair.baseline?.error } }) });
            } }));
          agentCtx.tools.register(defineTool({ name: submitName, description: 'Publish only the current experimental decision with complete findings and actual evidence IDs. This is not a production approval.',
            parameters: { payload: { type: 'json', required: true, description: 'The complete decision object described in the task.' } },
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args, exec) {
              admit(); if (!readIds.length) throw new Error('Read the current immutable packet before publishing');
              decision = decisionOf(args.payload, mode === 'auditor' ? 'auditor' : 'validation', pair.packet, ids);
              exec.concludeTurn(); return JSON.stringify({ recorded: true, result_ref: pair.packet.result_ref, decision });
            } }));
        },
      });
      if (!decision || !outcome.completed || controller.signal.aborted) error = `Stage incomplete; native stop: ${JSON.stringify(outcome.stopDetail)}`;
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { clearTimeout(timeout); controllers.delete(controller); }
    // Count each completed native assistant message once. Attempt usage and
    // final-message usage can describe the same request and must not be added.
    const usage = (outcome?.events ?? []).flatMap(event => event.type === 'assistant/message' && event.data.usage ? [event.data.usage] : []);
    return { session_id: agent.session_id, role, decision, error, duration_ms: Date.now() - started, model_requests: (requests.get(agent.session_id) ?? 0) - countBefore,
      input_tokens: usage.reduce((total, item) => total + item.inputTokens + (item.cacheReadTokens ?? 0) + (item.cacheWriteTokens ?? 0), 0),
      uncached_input_tokens: usage.reduce((total, item) => total + item.inputTokens, 0), cache_read_tokens: usage.reduce((total, item) => total + (item.cacheReadTokens ?? 0), 0), cache_write_tokens: usage.reduce((total, item) => total + (item.cacheWriteTokens ?? 0), 0),
      output_tokens: usage.reduce((total, item) => total + item.outputTokens, 0), tool_calls: calls, native_completed: outcome?.completed === true, native_stop: outcome?.stopDetail ?? null,
      native_file: findSessionFile(join(config.home, 'sessions'), agent.session_id) ?? null, read_packet_call_ids: readIds };
  };
  const receive = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('ablation' in value) || value.ablation !== true) return;
    if (!('requestId' in value) || typeof value.requestId !== 'string' || !('operation' in value) || typeof value.operation !== 'string') return;
    const message = value as unknown as { requestId: string; operation: string; pairId?: string; packet?: Packet; mode?: 'baseline' | 'self_review' | 'auditor' };
    const task = (async () => {
      try {
        let reply: unknown;
        if (message.operation === 'create') {
          if (!message.packet) throw new Error('No experimental packet');
          const started = runtime.start({ objective: message.packet.task, workspace: config.workspace, capabilities: [], budget: { tool_calls: 100, agents: 8, max_active_agents: 2, wall_time_ms: 600_000 } });
          const agents = runtime.store.listAgents(started.cluster.id);
          const pairId = randomUUID();
          pairs.set(pairId, { packet: message.packet, manager: agents.find(agent => agent.role === 'orchestrator')!, auditor: agents.find(agent => agent.role === 'auditor')! });
          reply = { pair_id: pairId, cluster_id: started.cluster.id };
        } else {
          const pair = pairs.get(message.pairId ?? ''); if (!pair) throw new Error('Unknown experimental pair');
          if (!message.mode) throw new Error('No stage mode');
          reply = await stage(pair, message.mode);
          if (message.mode === 'baseline') pair.baseline = reply as TrialTurn;
        }
        process.send?.({ ablation: true, requestId: message.requestId, ok: true, value: reply });
      } catch (caught) { process.send?.({ ablation: true, requestId: message.requestId, ok: false, error: caught instanceof Error ? caught.message : String(caught) }); }
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  process.on('message', receive);
  ctx.effect(() => async () => { process.off('message', receive); for (const controller of controllers) controller.abort(); await Promise.allSettled(pending); await runtime.dispose(); });
}
