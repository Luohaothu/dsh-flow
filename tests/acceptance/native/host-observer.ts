import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-compaction';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { fromAny } from '@total-typescript/shoehorn';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import { asObject, requiredString, messageOf } from '../context.ts';
import { startTeam } from '../../../packages/dsh-flow/src/core/team.ts';
import { runTurn } from '../../../packages/dsh-flow/src/core/runtime.ts';
import type { ClusterRuntime } from '../../../packages/dsh-flow/src/core/cluster.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'native-test': { kind: 'native-test' };
  }
}

export interface Config {
  evidencePath: string;
  workspace: string;
  provider: string;
  model: string;
  timeoutMs?: number;
}

export const name = 'flow-native-observer';
export const inject = ['flow', 'agents', 'agentLoop', 'tools', 'llm', 'commands', 'sessionController', 'sessions'];

/** Observes the real request waterfall and drives only fixture-owned Agents. */
export function apply(ctx: Context, config: Config): void {
  const pending = new Set<Promise<void>>();
  const handles = new Set<AgentHandle>();
  let closed = false;
  ctx.on('agent/created', ({ agent }) => {
    if (!ctx.flow.isTeamAgentSession(agent.id)) return;
    const fibers = [...ctx.registry.values()].filter(runtime => runtime.callback.name === 'BasicCompactionEngine').flatMap(runtime => [...runtime.fibers]);
    const owned = fibers.filter(fiber => scopeOf(fiber.ctx) === agent);
    appendFileSync(`${config.evidencePath}.compaction.jsonl`, `${JSON.stringify({
      session_id: agent.id, private_backends: owned.length,
      global_backends: fibers.filter(fiber => scopeOf(fiber.ctx) === undefined).length,
      config: owned[0]?._config,
    })}\n`);
  });
  ctx.on('llm/stream', async function* (options, next) {
    const before = JSON.stringify(options);
    try {
      yield* next();
    } finally {
      if (!closed) appendFileSync(config.evidencePath, `${JSON.stringify({
        session_id: options.sessionId ?? null,
        provider: options.provider,
        model: options.model,
        before,
        after: JSON.stringify(options),
        purpose: options.purpose ?? null,
      })}\n`);
    }
  });

  const receive = (value: unknown): void => {
    const message = asObject(value);
    if (!message || message.nativeObserver !== true) return;
    const requestId = requiredString(message.requestId, 'native observer request id');
    const operation = message.operation;
    const task = (async () => {
      try {
        if (closed) throw new Error('native observer disposed');
        if (operation === 'ownership') {
          // No Flow database record or owning driver claims this fixture. The
          // immutable composition identity must protect it independently.
          const id = SessionId(randomUUID());
          const member = await ctx.agents.create({sessionId:id,meta:{cwd:config.workspace,agentPreset:'dsh-flow/member'},agentOptions:{provider:config.provider,model:config.model}});
          handles.add(member);
          const probe = async (cold = false) => {
            const refused: string[] = [];
            const operations = {
              create: () => ctx.sessionController.create({sessionId:id,cwd:config.workspace}),
              fork: () => ctx.sessionController.fork({sessionId:id}),
              model: () => ctx.sessionController.selectModel({sessionId:id,provider:config.provider,model:config.model}),
              queue: () => ctx.sessionController.updateQueue({sessionId:id,itemId:MessageId('absent'),action:{kind:'remove'}}),
              prompt: () => ctx.sessionController.prompt({sessionId:id,requestId:randomUUID() as SessionRequestId,mode:'queue',content:[{type:'text',text:'must not execute'}]},new AbortController().signal),
              cancel: () => ctx.sessionController.cancel({sessionId:id}),
            };
            for (const [name,call] of Object.entries(operations)) {
              try { await call(); } catch (error) {
                const code = asObject(error)?.code;
                if (code !== 'session/agent-busy' && !(cold && name === 'cancel' && code === 'session/not-found')) throw error;
                refused.push(name);
              }
            }
            const resolved = await ctx.sessionController.resolveAgent(id);
            if ('error' in resolved && resolved.error.code === 'session/agent-busy') refused.push('resolve');
            return refused;
          };
          const live = await probe();
          await ctx.sessions.flush(member.agent.session);
          await member.dispose();handles.delete(member);
          const cold = await probe(true);
          const controller = new AbortController();
          const iterator = ctx.sessionController.follow({address:{kind:'session',sessionId:id}},controller.signal)[Symbol.asyncIterator]();
          let pending: ReturnType<typeof iterator.next> | undefined;
          try { await iterator.next(); pending=iterator.next();await new Promise(resolve=>setTimeout(resolve,100)); }
          finally { controller.abort();await pending?.catch(()=>{});await iterator.return?.(); }
          const history = await ctx.sessionController.inspect(id);
          process.send?.({nativeObserver:true,requestId,ok:true,value:{live,cold,agent_active:ctx.agents.get(id)!==undefined,marker:history.meta.agentPreset}});
          return;
        }
        if (operation === 'resume-compacted') {
          // This fixture owns the completed single-Agent session. Exercise the
          // production native resume seam without reopening its team or tools.
          const runtime = fromAny<ClusterRuntime, typeof ctx.flow>(ctx.flow);
          const sessionId = requiredString(message.sessionId, 'compacted session id');
          const agent = runtime.store.getAgentBySession(sessionId);
          if (!agent) throw new Error('compacted fixture agent was not found');
          const cold = ctx.sessions.get(SessionId(sessionId)) === undefined;
          const saved = await ctx.sessionController.inspect(SessionId(sessionId));
          let checkpointInHistory = false;
          const outcome = await runTurn(ctx, {
            agent, role: agent.role, prompt: 'NATIVE-RESUMED-COMPACTION: confirm the saved checkpoint is available and answer RESUMED-COMPACTION-OK.',
            model: runtime.modelFor(agent), allowedTools: [], globalTools: [],
            capabilities: [], cwd: config.workspace, resume: true, turnSeq: agent.turns + 1,
            flow: runtime,
            onAgentReady(live) {
              checkpointInHistory = JSON.stringify(live.session.deriveMessages()).includes('<compacted-summary>');
            },
          });
          const settled = runtime.store.usageSummary(agent.cluster_id);
          await runtime.replayNativeUsage();
          await runtime.replayNativeUsage();
          process.send?.({ nativeObserver: true, requestId, ok: true, value: {
            cold, checkpoint_in_history: checkpointInHistory,
            saved_summaries: saved.events.filter(event => event.type === 'compaction/summary').length,
            final_text: outcome.finalText, native_seq: outcome.native_seq,
            cursor: runtime.store.nativeUsageCursor(sessionId),
            replay_unchanged: JSON.stringify(runtime.store.usageSummary(agent.cluster_id)) === JSON.stringify(settled),
          } });
          return;
        }
        if (operation !== 'scopes' && operation !== 'ordinary' && operation !== 'team-launch' && operation !== 'agent-session') throw new Error('unknown native observer operation');
        const ordinary = await ctx.agents.create({
          sessionId: SessionId(randomUUID()),
          meta: { cwd: config.workspace },
          agentOptions: { provider: config.provider, model: config.model, maxTokens: 512 },
        });
        handles.add(ordinary);
        let disposed = false;
        try {
          if (closed) throw new Error('native observer disposed during creation');
          const ordinaryTools = ordinary.agent.ctx.tools.schemas(scopeOf(ordinary.agent.ctx)).map(tool => tool.name);
          if (operation === 'agent-session') {
            const objective = 'Sum [2,3] with flow_sum and independently verify the total 5.';
            const started = startTeam(fromAny<ClusterRuntime, typeof ctx.flow>(ctx.flow), ordinary.agent.id, randomUUID(), objective, config.workspace, undefined, { objective, assessment: { complexity: 'simple', rationale: 'One independently checked sum' }, acceptance_criteria: ['The real sum equals 5'], capabilities: [] });
            ctx.flow.control(started.cluster.id,'pause');
            const target=ctx.flow.teamRead(ordinary.agent.id,started.cluster.id).agents.find(agent=>agent.role==='orchestrator')!;
            const prompt={sessionId:SessionId(target.session_id),requestId:randomUUID() as SessionRequestId,mode:'queue' as const,content:[{type:'text' as const,text:'NATIVE-AGENT-CONTINUATION: independently check 5-3=2 as well.'}],clientTimeZone:'Asia/Shanghai'};
            const accepted=await ctx.sessionController.prompt(prompt,new AbortController().signal);
            await ctx.sessionController.prompt(prompt,new AbortController().signal);
            const ownership=await ctx.sessionController.resolveAgent(prompt.sessionId);
            let activeSent=false;
            const stopActive=ctx.on('llm/stream',async function*(options,next){
              for await (const chunk of next()) {
                if(options.sessionId===prompt.sessionId && options.purpose!=='session-title' && !activeSent){
                  activeSent=true;
                  await ctx.sessionController.prompt({...prompt,requestId:randomUUID() as SessionRequestId,mode:'steer',content:[{type:'text',text:'NATIVE-ACTIVE-CONTINUATION: keep the same acceptance criteria.'}]},new AbortController().signal);
                }
                yield chunk;
              }
            });
            ctx.flow.control(started.cluster.id,'resume');
            const deadline=Date.now()+(config.timeoutMs ?? 60_000);
            while(Date.now()<deadline && !['completed','failed','cancelled'].includes(ctx.flow.teamRead(ordinary.agent.id,started.cluster.id).run.state)) await new Promise(resolve=>setTimeout(resolve,100));
            let finalized;
            while(!finalized) {
              try {finalized=ctx.flow.finalizeTeam(ordinary.agent.id,started.cluster.id);}
              catch(error) {if(Date.now()>=deadline || !messageOf(error).includes('轮次'))throw error;await new Promise(resolve=>setTimeout(resolve,100));}
            }
            await ctx.sessionController.prompt(prompt,new AbortController().signal); // reconnect retry of an accepted RPC
            let refused=false;
            try {await ctx.sessionController.prompt({...prompt,requestId:randomUUID() as SessionRequestId},new AbortController().signal);} catch {refused=true;}
            const history=await ctx.sessionController.inspect(prompt.sessionId);
            stopActive();
            process.send?.({nativeObserver:true,requestId,ok:true,value:{accepted,owned:'error' in ownership,refused,run:finalized.run,session_id:target.session_id,events:history.events}});
          } else if (operation === 'team-launch') {
            const intent=randomUUID(),line='/agent-team Sum [2,3] with flow_sum and independently verify the total 5.';
            const [result,retry]=await Promise.all([
              ctx.commands.execute(ordinary.agent,line,[],intent,new AbortController().signal),
              ctx.commands.execute(ordinary.agent,line,[],intent,new AbortController().signal),
            ]);
            if(result?.result.kind!=='success')throw new Error('team skill command was not admitted');
            if(retry?.result.kind!=='success' || retry.commandId===result.commandId)throw new Error('command retry must keep a unique native lifecycle');
            await ordinary.agent.whenIdle();
            const sessionId = ordinary.agent.id;
            const runs = ctx.flow.teamRuns(sessionId);
            await ordinary.dispose();
            disposed = true;
            const reloaded = await ctx.sessionController.inspect(sessionId);
            const launch = reloaded.events.find(event => event.type === 'flow/team-launch');
            const resumed=await ctx.sessionController.resolveAgent(sessionId);
            if('error' in resumed)throw resumed.error;
            await ctx.commands.execute(resumed.agent,line,[],intent,new AbortController().signal);
            await ctx.sessions.flush(resumed.agent.session);
            const afterRetry=await ctx.sessionController.inspect(sessionId);
            process.send?.({nativeObserver:true,requestId,ok:true,value:{session_id:sessionId,runs,cold_reload:!!launch,launch_ignorable:launch?.ignorable===true,launches:afterRetry.events.filter(event=>event.type==='flow/team-launch').length,command_ids:afterRetry.events.filter(event=>event.type==='command/run').map(event=>event.data.commandId)}});
          } else if (operation === 'ordinary') {
            ordinary.agent.followup(createUserMessage({
              content: [{ type: 'text', text: 'NATIVE-ORDINARY: answer with OK; do not call a tool.' }],
              source: { kind: 'native-test' },
            }));
            await ordinary.agent.whenIdle();
            process.send?.({ nativeObserver: true, requestId, ok: true, value: { session_id: ordinary.agent.id, ordinary_tools: ordinaryTools, flow_compaction_backends: [...ctx.registry.values()].filter(runtime => runtime.callback.name === 'BasicCompactionEngine').flatMap(runtime => [...runtime.fibers]).filter(fiber => { const owner = scopeOf(fiber.ctx); return owner !== undefined && typeof owner === 'object' && 'id' in owner && typeof owner.id === 'string' && ctx.flow.isTeamAgentSession(owner.id); }).length } });
          } else {
            process.send?.({nativeObserver:true,requestId,ok:true,value:{ordinary_tools:ordinaryTools}});
          }
        } finally {
          if (!disposed) await ordinary.dispose();
          handles.delete(ordinary);
        }
      } catch (error) {
        process.send?.({ nativeObserver: true, requestId, ok: false, error: messageOf(error) });
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  };
  process.on('message', receive);
  ctx.effect(() => async () => {
    closed = true;
    process.off('message', receive);
    for (const handle of handles) handle.agent.cancel({ kind: 'hook', reason: 'native observer disposed' });
    await Promise.all(pending);
  });
}
