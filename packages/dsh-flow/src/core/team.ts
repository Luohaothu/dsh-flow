/** Main-conversation ownership and read-only projections over the existing ledger. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { ClusterRuntime } from './cluster.ts';
import type { FlowModelSelection } from './model.ts';
import { prepareModelSelection } from './model-selection.ts';
import { budgetView } from './budget.ts';
import { fail } from '../errors.ts';
import { agentGivenName, ROLE_LABELS as ROLES } from '../identity.ts';
import { communicationCategory, communicationContent } from '../messages.ts';
import { projectAgentSession } from '../agent-session.ts';
import type { FlowJsonValue, FlowAgentSession, FlowTeamAgent, FlowTeamAllowance, FlowTeamCreateRequest, FlowTeamMetric, FlowTeamRun, FlowTeamSnapshot, FlowTeamState } from '../types.ts';
import { validateBudget, validateCapabilities, textField, isFlowJsonValue } from '../validation.ts';
import { validateLimits } from './protocol.ts';

/** Validate at the service boundary too; callers cannot bypass the model schema. */
function createRequest(request: FlowTeamCreateRequest): FlowTeamCreateRequest {
  const complexity = request.assessment?.complexity;
  if (!['simple', 'moderate', 'complex'].includes(complexity)) fail('请提供任务复杂度评估', 400);
  const rationale = textField(request.assessment.rationale, 'assessment.rationale', 4096).trim();
  if (!rationale) fail('请提供复杂度评估依据', 400);
  const criteria = request.acceptance_criteria;
  if (!criteria?.length || criteria.length > 64) fail('请提供 1 至 64 项验收标准', 400);
  return {
    objective: textField(textField(request.objective, 'objective', 16384).trim(), 'objective', 16384),
    assessment: { complexity, rationale },
    acceptance_criteria: criteria.map(item => textField(textField(item, 'acceptance_criteria', 4096).trim(), 'acceptance_criteria', 4096)),
    ...(request.workspace === undefined ? {} : { workspace: textField(request.workspace, 'workspace', 4096) }),
    ...(request.capabilities === undefined ? {} : { capabilities: validateCapabilities(request.capabilities) }),
    ...(request.budget === undefined ? {} : { budget: validateBudget(request.budget, 'budget') }),
    ...(request.limits === undefined ? {} : { limits: validateLimits(request.limits, 'limits') }),
  };
}

export function createTeam(runtime: ClusterRuntime, sessionId: string, launchId: string, input: FlowTeamCreateRequest, model?: FlowModelSelection): FlowTeamSnapshot {
  const request = createRequest(input);
  return runtime.store.tx(() => {
    const binding = runtime.store.get('SELECT run_id FROM team_runs WHERE main_session_id=? AND intent_id=?', sessionId, launchId);
    if (binding) {
      const saved = runtime.store.get("SELECT data FROM events WHERE cluster_id=? AND type='team-created' ORDER BY seq LIMIT 1", String(binding.run_id));
      if (!isDeepStrictEqual(saved && field(json(saved.data), 'request'), request)) fail('同一启动意图的参数已确定，请读取已有团队；新的任务使用新的 /agent-team 请求', 409);
      return readTeam(runtime, sessionId, String(binding.run_id));
    }
    const run = startTeam(runtime, sessionId, launchId, request.objective, request.workspace, model, request);
    const metadata = { launch_id: launchId, request };
    if (!isFlowJsonValue(metadata)) fail('启动参数必须是 JSON 数据', 400);
    runtime.store.appendEvent(run.cluster.id, 'team-created', metadata);
    return readTeam(runtime, sessionId, run.cluster.id);
  });
}

/** Finalization is a terminal resource operation, independent of task acceptance. */
export function finalizeTeam(runtime: ClusterRuntime, sessionId: string, runId: string): FlowTeamSnapshot {
  const team = readTeam(runtime, sessionId, runId);
  if (!TERMINAL.has(team.run.raw_state)) fail('团队尚未结束；请先读取状态，运行中的取消使用 agent_team_control', 409);
  if (runtime.inFlight(runId)) fail('团队正在结束最后的轮次，请稍后读取状态并重试收尾', 409);
  if (team.run.finalized_at) return team;
  runtime.terminateClusterJobs(runId, 'team finalized');
  return runtime.store.tx(() => {
    for (const allocation of runtime.store.allocationsInSubtree(runId, null, { status: 'ACTIVE' })) runtime.store.updateAllocation(allocation.id, { status: 'RELEASED' });
    for (const agent of runtime.store.agentsInSubtree(runId, null)) {
      if (agent.status === 'TERMINATED') continue;
      runtime.store.recordTeamEnd(agent, team.run.raw_state === 'COMPLETED' ? 'COMPLETED' : team.run.raw_state === 'FAILED' ? 'FAILED' : 'CANCELLED');
      runtime.store.updateAgent(agent.id, { status: 'TERMINATED' });
    }
    runtime.store.appendEvent(runId, 'team-finalized', { main_session_id: sessionId });
    return readTeam(runtime, sessionId, runId);
  });
}

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function json(value: unknown): FlowJsonValue { return typeof value === 'string' ? JSON.parse(value) as FlowJsonValue : null; }
function field(value: FlowJsonValue | object | null, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}
function state(raw: string): FlowTeamState {
  switch (raw) {
    case 'CREATED': case 'READY': return 'pending';
    case 'RUNNING': return 'running';
    case 'PAUSED': return 'paused';
    case 'BLOCKED': return 'blocked';
    case 'COMPLETED': return 'completed';
    case 'CANCELLED': return 'cancelled';
    case 'FAILED': return 'failed';
    default: return 'unknown';
  }
}
/** Translate controller diagnostics; expose the concrete request failure for stalls. */
function reasonOf(runtime:ClusterRuntime,runId:string,reason:string|null,code:string|null,nodeId:string|null,before:number):string|null {
  if(!reason)return null;
  if(/made no state change across \d+ turns/.test(reason)) {
    const role=reason.match(/^(orchestrator|allocator|auditor) /)?.[1];
    const latest=role&&nodeId?runtime.store.get("SELECT e.data FROM events e JOIN agents a ON a.id=json_extract(e.data,'$.agent_id') WHERE e.cluster_id=? AND e.type='turn-end' AND a.node_id=? AND a.role=? AND e.seq<=? ORDER BY e.seq DESC LIMIT 1",runId,nodeId,role,before):undefined;
    const data=latest?json(latest.data):null;
    const detail=field(data,'stop_detail');
    const errorCode=typeof detail==='object'&&detail!==null?Reflect.get(detail,'code'):null;
    if(field(data,'stop_reason')==='error') {
      if(errorCode==='TRANSPORT')return '模型服务连接失败';
      if(errorCode==='AUTHENTICATION')return '模型服务认证失败';
      return '模型请求失败';
    }
    return `${ROLES[role as keyof typeof ROLES]??'智能体'}连续多轮未取得进展`;
  }
  const exhausted=reason.match(/^role (orchestrator|allocator|auditor|worker) exhausted its turn budget \((\d+)\)$/);
  if(exhausted)return `${ROLES[exhausted[1] as keyof typeof ROLES]}已达到运行轮次上限（${exhausted[2]}）`;
  if(reason.includes('cluster wall-time deadline passed'))return '已达到团队运行时限';
  if(code==='BUDGET_EXHAUSTED')return reason.replace(/^BUDGET: /,'');
  return reason.replace(/^orchestrator\b/,'总协调').replace(/^allocator\b/,'资源协调').replace(/^auditor\b/,'质量审核');
}

/** Start and bind atomically; a lost command acknowledgment never starts a second run. */
export function startTeam(runtime: ClusterRuntime, sessionId: string, intentId: string, objective: string, workspace?: string, model?:FlowModelSelection, request?: FlowTeamCreateRequest) {
  if (!sessionId.trim() || !intentId.trim()) fail('主会话与提交标识不能为空', 400);
  if (!objective.trim()) fail('请描述希望团队完成的任务', 400);
  return runtime.store.tx(() => {
    const existing = runtime.store.get('SELECT run_id FROM team_runs WHERE main_session_id=? AND intent_id=?', sessionId, intentId);
    const id = text(existing?.run_id);
    if (id) {
      const saved = runtime.store.getCluster(id);
      if (saved?.objective !== objective.trim()) fail('同一提交标识不能用于不同任务', 409);
      return runtime.read(id, { include_events: false });
    }
    const run = runtime.start({ ...request, id: randomUUID(), objective: objective.trim(), ...(workspace ? { workspace } : {}) });
    if(model?.provider&&model.model) {
      const root=runtime.store.nodesInSubtree(run.cluster.id,null).find(node=>node.parent_id===null)!;
      if(root.scope?.team_model_fixed!==true)runtime.store.updateNode(root.id,{scope:{...root.scope,team_model:{...model}}});
    }
    runtime.store.run('INSERT INTO team_runs(run_id,main_session_id,intent_id) VALUES(?,?,?)', run.cluster.id, sessionId, intentId);
    runtime.store.appendEvent(run.cluster.id, 'team-bound', { main_session_id: sessionId, intent_id: intentId });
    return run;
  });
}
/** List only runs explicitly bound to this main session. */
export function teamRuns(runtime: ClusterRuntime, sessionId: string): readonly FlowTeamRun[] {
  return runtime.store.all('SELECT c.id FROM clusters c JOIN team_runs t ON t.run_id=c.id WHERE t.main_session_id=? ORDER BY c.created DESC,c.id', sessionId)
    .map(row => runOf(runtime, sessionId, String(row.id)));
}
function runOf(runtime: ClusterRuntime, sessionId: string, runId: string): FlowTeamRun {
  const binding = runtime.store.get('SELECT main_session_id,intent_id FROM team_runs WHERE run_id=?', runId);
  if (binding?.main_session_id !== sessionId) fail('此运行不属于当前主会话', 404);
  const cluster = runtime.store.getCluster(runId);
  if (!cluster) fail('团队运行已不可用', 404);
  const terminal = runtime.store.get("SELECT at FROM events WHERE cluster_id=? AND type IN ('cluster-completed','cluster-failed','cluster-cancel','subtree-cancelled') ORDER BY seq DESC LIMIT 1", runId);
  const summary = runtime.store.latestSummary(runId, {});
  const block=cluster.status==='BLOCKED'?runtime.store.get("SELECT seq,data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1",runId):undefined;
  const blockData=block?json(block.data):null;
  const blockReason=text(field(blockData,'reason')),blockCode=text(field(blockData,'code'));
  return {
    id: runId, main_session_id: sessionId, name: cluster.objective,
    state: cluster.status==='RUNNING' && runtime.store.get("SELECT id FROM agents WHERE cluster_id=? AND status NOT IN ('TERMINATED','COMPLETED','FAILED','CANCELLED') AND NOT EXISTS (SELECT 1 FROM team_observations o WHERE o.agent_id=agents.id AND o.run_id=agents.cluster_id) AND json_extract(meta,'$.ui_state')='waiting_user' LIMIT 1",runId) ? 'waiting_user' : state(cluster.status), raw_state: cluster.status,
    reason:reasonOf(runtime,runId,blockReason,blockCode,text(field(blockData,'node_id')),number(block?.seq)??0),
    created: cluster.created, ended: TERMINAL.has(cluster.status) ? number(terminal?.at) ?? cluster.updated : null,
    updated: cluster.updated, version: runtime.store.latestEventSeq(runId), result: summary?.data ?? null,
    launch_id: String(binding.intent_id),
    finalized_at: number(runtime.store.get("SELECT at FROM events WHERE cluster_id=? AND type='team-finalized' ORDER BY seq LIMIT 1", runId)?.at),
  };
}
function metric(value: number | null): FlowTeamMetric { return { value, unit: 'Token', scope: 'self', estimated: false }; }
/** Read in one SQLite transaction, using stable agent ids and authoritative resource records. */
export function readTeam(runtime: ClusterRuntime, sessionId: string, runId: string): FlowTeamSnapshot {
  return runtime.store.tx(() => {
    const store = runtime.store;
    const run = runOf(runtime, sessionId, runId);
    const identities: ReturnType<typeof store.listAgents> = [];
    for (let offset = 0; ; offset += 500) {
      const page = store.listAgents(runId, { limit: 500, offset });
      identities.push(...page);
      if (page.length < 500) break;
    }
    const nodes = new Map(store.nodesInSubtree(runId, null).map(node => [node.id, node]));
    const root = [...nodes.values()].find(node => node.parent_id === null);
    const modelFor = prepareModelSelection(runtime.config.model, root?.scope,
      store.getCluster(runId)?.limits.worker_max_tokens);
    const allowances = store.listBudgets(runId).flatMap(row => {
      const view = budgetView(row);
      if (!view) return [];
      const shared = row.scope_kind !== 'agent';
      const entries: FlowTeamAllowance[] = [
        { id: `${row.id}:tokens`, name: 'Token 额度', unit: 'Token', scope_id: row.scope_id, shared, total: view.tokens.limit, used: view.tokens.spent, remaining: view.tokens.available },
        { id: `${row.id}:requests`, name: '模型请求额度', unit: '次', scope_id: row.scope_id, shared, total: view.model_requests.limit, used: view.model_requests.spent, remaining: view.model_requests.available },
        { id: `${row.id}:tools`, name: '工具调用额度', unit: '次', scope_id: row.scope_id, shared, total: view.tool_calls.limit, used: view.tool_calls.spent, remaining: view.tool_calls.available },
      ];
      return [{ row, entries }];
    });
    const usages = new Map(store.all(`SELECT agent_id,SUM(total_tokens) AS tokens,
      SUM(CASE WHEN status='UNKNOWN' THEN 1 ELSE 0 END) AS uncertain,
      SUM(CASE WHEN status='SETTLED' THEN 1 ELSE 0 END) AS settled
      FROM usage_receipts WHERE cluster_id=? GROUP BY agent_id`, runId).map(row => [text(row.agent_id), row]));
    const models = new Map(store.all(`SELECT agent_id,model,reasoning_effort FROM usage_receipts
      WHERE cluster_id=? AND model IS NOT NULL AND model<>'' AND kind<>'compaction' AND status<>'NOT_SENT' ORDER BY created,rowid`, runId)
      .map(row => [text(row.agent_id),row]));
    const contexts = new Map(store.all(`SELECT json_extract(data,'$.agent_id') AS agent_id,data FROM events
      WHERE cluster_id=? AND type='context-step' ORDER BY seq`, runId).map(row => [text(row.agent_id), json(row.data)]));
    // context-step.compacted_at is the post-compaction token pressure anchor,
    // not a wall-clock time. Only a recorded native summary proves compaction.
    const compactions = new Map(store.all(`SELECT json_extract(data,'$.agent_id') AS agent_id,MAX(at) AS at FROM events
      WHERE cluster_id=? AND type='context-step' AND json_type(data,'$.summary_seq') IN ('integer','real')
      GROUP BY json_extract(data,'$.agent_id')`, runId).map(row => [text(row.agent_id), number(row.at)]));
    const ended = new Map(store.all('SELECT * FROM team_observations WHERE run_id=?', runId).map(row => [text(row.agent_id), row]));
    const allocations = new Map(store.all('SELECT agent_id,status FROM allocations WHERE cluster_id=? ORDER BY created', runId).map(row => [text(row.agent_id), text(row.status)]));
    const dependencies=store.all(`SELECT t.id,t.owner_management_id,t.status,t.updated,a.agent_id FROM transactions t LEFT JOIN allocations a ON a.transaction_id=t.id AND a.status='ACTIVE' WHERE t.cluster_id=? AND t.status IN ('RUNNING','VALIDATING') ORDER BY t.updated DESC`,runId);
    const blocks=new Map(store.all("SELECT seq,data FROM events WHERE cluster_id=? AND type='node-blocked' ORDER BY seq",runId).map(row=>{const data=json(row.data);return [text(field(data,'node_id')),{data,seq:number(row.seq)??0}];}));
    const agents: FlowTeamAgent[] = identities.map(agent => {
      const node = nodes.get(agent.node_id);
      const meta = agent.meta;
      const observation = ended.get(agent.id);
      const raw = agent.status === 'TERMINATED' ? text(observation?.state) ?? (node?.status === 'CANCELLED' ? 'CANCELLED' : 'UNKNOWN') : node?.status==='BLOCKED'&&!['COMPLETED','FAILED','CANCELLED'].includes(agent.status)?'BLOCKED':agent.status;
      const blockRow=raw==='BLOCKED'?blocks.get(agent.node_id):null;
      const block=blockRow?.data;
      const blockReason=text(field(block??null,'reason')),blockCode=text(field(block??null,'code'));
      const reported = text(field(meta, 'ui_state'));
      const dependency=agent.role==='orchestrator'&&raw==='READY'?dependencies.find(row=>row.owner_management_id===agent.node_id):undefined;
      const collaborator=dependency?.status==='VALIDATING'?identities.find(candidate=>candidate.node_id===agent.node_id&&candidate.role==='auditor'&&candidate.status!=='TERMINATED')?.id:text(dependency?.agent_id);
      const awaitingWork = raw === 'READY' && agent.turns > 0;
      const waiting = reported === 'waiting_user' || reported === 'waiting_agent' ? reported : collaborator?'waiting_agent':null;
      const context = contexts.get(agent.id) ?? null;
      const usage = usages.get(agent.id);
      const tokens = usage && number(usage.uncertain) === 0 && (number(usage.settled) ?? 0) > 0 ? number(usage.tokens) : null;
      // These edges are recorded by the actual creator, never reconstructed from names or task domains.
      const parent = text(field(meta, 'parent_agent_id')) ?? text(field(meta, 'allocated_by'));
      const relationKnown = Reflect.has(meta, 'parent_agent_id') || Reflect.has(meta, 'allocated_by');
      const model=models.get(agent.id);
      const recordedModel = text(model?.model);
      const selectedModel = recordedModel === null ? modelFor(agent) : null;
      const session=runtime.ctx.get('sessions')?.get(SessionId(agent.session_id));
      const lastUsed=session?runtime.ctx.get('sessionProjections')?.stateOf(session,'modelSelection')?.lastUsed:null;
      return {
        id: agent.id, run_id: runId, role:agent.role, parent_id: relationKnown ? parent : `unresolved:${agent.id}`, session_id: agent.session_id,
        name: text(field(meta, 'display_name')) ?? agentGivenName(agent.id),
        responsibility: text(field(meta, 'responsibility')) ?? text(field(node?.scope ?? null, 'objective')) ?? '',
        state: observation||TERMINAL.has(raw)||raw==='BLOCKED' ? state(raw) : waiting ?? (awaitingWork?'ready':state(raw)), raw_state: raw,
        reason: blockReason?reasonOf(runtime,runId,blockReason,blockCode,agent.node_id,blockRow?.seq??0):text(field(meta, 'status_reason'))??(collaborator?(dependency?.status==='VALIDATING'?'等待质量审核确认任务结果':'等待执行智能体提交任务结果'):awaitingWork?'等待调度':null), waiting_for: text(field(meta, 'waiting_for'))??collaborator??null,
        waiting_since: number(field(meta, 'waiting_since'))??(collaborator?number(dependency?.updated):null),
        recycled: agent.status === 'TERMINATED' || allocations.get(agent.id) === 'RELEASED',
        created: agent.created, ended: number(observation?.ended), version: run.version,
        tokens: metric(tokens),
        model: recordedModel ?? selectedModel?.model ?? null,
        reasoning_effort: model ? text(model.reasoning_effort) ?? lastUsed?.reasoningEffort ?? null : selectedModel?.reasoningEffort ?? null,
        allowances: allowances.filter(({row}) => row.scope_kind === 'agent' ? row.scope_id === agent.id : row.scope_kind === 'node' && row.scope_id === agent.node_id).flatMap(({entries}) => entries),
        context_used: number(field(context, 'after')), context_limit: number(field(context, 'context_limit')),
        compacted_at: compactions.get(agent.id) ?? null,
      };
    });
    const communications = store.all(`SELECT m.*,r.recipient,r.status,r.acked FROM messages m JOIN recipients r ON r.message_id=m.id
      WHERE m.cluster_id=? ORDER BY m.created,m.id,r.recipient`, runId).map(row => ({
      id: `${String(row.id)}:${String(row.recipient)}`, run_id: runId,
      sender_id: text(row.from_agent), recipient_id: String(row.recipient),
      at: number(row.created) ?? 0, content: json(row.content), delivery_state: String(row.status), version: run.version,
      category: communicationCategory(json(row.content)), transaction_id: text(communicationContent(json(row.content)).transaction_id),
    }));
    const hasUsage = usages.size > 0;
    const uncertain = [...usages.values()].some(row => (number(row.uncertain) ?? 0) > 0);
    const hasSettled=[...usages.values()].some(row=>(number(row.settled)??0)>0);
    const total = hasUsage && hasSettled && !uncertain ? number(store.get("SELECT SUM(total_tokens) AS total FROM usage_receipts WHERE cluster_id=? AND status='SETTLED'", runId)?.total) : null;
    return { run, agents, communications, tokens: metric(total) };
  });
}

/** Forward ordinary main-conversation input once, leaving state confirmation to execution. */
export function replyTeam(runtime: ClusterRuntime, sessionId: string, messageId: string, content: string, runId?: string): void {
  const active = teamRuns(runtime, sessionId).filter(run => !['completed', 'cancelled', 'failed'].includes(run.state));
  const run = runId ? runOf(runtime, sessionId, runId) : active[0];
  if (!run) return;
  if (TERMINAL.has(run.raw_state)) fail('团队已结束，不能继续发送执行指令', 409);
  const root = runtime.store.nodesInSubtree(run.id, null).find(node => node.parent_id === null);
  const lead = root && runtime.store.listAgents(run.id, { node_id: root.id, role: 'orchestrator' })[0];
  if (!lead) fail('总协调尚不可用，请稍后在主会话重试', 409);
  runtime.store.tx(()=>{
    const waiting=runtime.store.all("SELECT id FROM agents WHERE cluster_id=? AND status NOT IN ('TERMINATED','COMPLETED','FAILED','CANCELLED') AND NOT EXISTS (SELECT 1 FROM team_observations o WHERE o.agent_id=agents.id AND o.run_id=agents.cluster_id) AND json_extract(meta,'$.ui_state')='waiting_user'",run.id).flatMap(row=>{const agent=runtime.store.getAgent(String(row.id));return agent?[agent]:[];});
    const recipients=new Map([lead,...waiting].map(agent=>[agent.id,agent]));
    for(const agent of recipients.values()) {
      runtime.communicateFrom({cluster_id:run.id,agent_id:null,node_id:root?.id??null,role:'orchestrator'},
        'send',{message_id:`main:${messageId}:${agent.id}`,agent:agent.id,category:'task_instruction',content:{subject:'主会话指令',text:content}});
      if(agent.meta.ui_state==='waiting_user') runtime.store.updateAgent(agent.id,{meta:{...agent.meta,reply_pending:true}});
    }
  });
}

/** Lookup never creates, resumes or retains a native Agent. */
export function agentSession(runtime: ClusterRuntime, sessionId: string): FlowAgentSession | null {
  const identity = runtime.store.getAgentBySession(sessionId);
  if (!identity) return null;
  const owner = runtime.store.get('SELECT main_session_id FROM team_runs WHERE run_id=?', identity.cluster_id);
  if (!owner) return null;
  const team = readTeam(runtime, String(owner.main_session_id), identity.cluster_id);
  const agent = team.agents.find(agent => agent.id === identity.id);
  if (!agent) return null;
  return projectAgentSession(team.run, agent);
}
/** Human input targets only the selected Agent and stays under Flow scheduling. */
export function promptAgent(runtime: ClusterRuntime, sessionId: string, requestId: string, content: string, clientTimeZone?: string, mode: 'queue' | 'steer' = 'queue'): void {
  runtime.store.tx(() => {
    const target = agentSession(runtime, sessionId);
    if (!target) fail('智能体会话不存在',404);
    if (!content.trim()) fail('消息不能为空',400);
    const messageId=`human:${requestId}`;
    const envelope={category:'task_instruction',subject:'用户消息',text:content,human_prompt:{rpc_id:requestId,mode,...(clientTimeZone ? {client_time_zone:clientTimeZone} : {})}};
    const existing=runtime.store.getMessage(messageId);
    if(existing) {
      if(existing.cluster_id!==target.run.id || existing.from_agent!==null || existing.kind!=='direct'
        || !runtime.store.deliveryFor(messageId,target.agent.id)
        || !isDeepStrictEqual(communicationContent(existing.content),envelope)) fail('请求标识已用于另一条消息',409);
      return; // An accepted RPC remains accepted after finalization or reconnection.
    }
    if (!target.can_message) fail(target.message_block_reason ?? '智能体不可继续对话',409);
    runtime.communicateFrom({cluster_id:target.run.id,agent_id:null,node_id:null,role:'orchestrator'},'send',{
      message_id:messageId,agent:target.agent.id,category:'task_instruction',content:envelope,
    });
    const record=runtime.store.getAgent(target.agent.id)!;
    runtime.store.updateAgent(record.id,{meta:{...record.meta,reply_pending:true}});
  });
  runtime.wake();
}
