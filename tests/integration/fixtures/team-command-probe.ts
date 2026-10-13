/** Real host/Agent/Flow probe. Only generated model text/tool arguments are scripted. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '../../../packages/dsh-flow/src/service.ts';

export const inject = ['flow', 'llm', 'agents', 'sessionController', 'attachments', 'skills'];
interface Config { root: string; phase: string }
interface Control { owner?: string; ordinary?: string; release?: boolean }
function readControl(config: Config): Control {
  const path = join(config.root, 'control.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}
function save(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2)); renameSync(`${path}.tmp`, path);
}

export function apply(ctx: Context, config: Config): void {
  ctx.skills.register({name:'role-probe',description:'Role composition verification',source:'runtime',content:'ROLE-SKILL-LOADED: preserve the task artifact exactly.'});
  const requests: unknown[] = [];
  class Scripted extends LlmAdapter {
    override async listModels(provider: string) { return [{ provider, id: 'scripted', name: 'Isolated scripted command probe' }]; }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      assert.equal(options.provider, 'team-command-probe');
      options.signal?.throwIfAborted();
      requests.push({ session_id: options.sessionId, purpose: options.purpose ?? 'agent', provider: options.provider,
        model: options.model, messages: options.messages, tools: options.tools?.map(tool => tool.name) ?? [] });
      save(join(config.root, `${config.phase}-requests.json`), requests);
      let call: { name: string; args: object } | undefined;
      let text = 'PROBE-TITLE';
      if (!options.purpose) {
        const control = readControl(config);
        const priorCalls = options.messages.flatMap(message => message.role === 'assistant'
          ? message.content.filter(block => block.type === 'tool-call') : []);
        const called = (name: string) => priorCalls.some(block => block.name === name);
        const textOf = (message: GenerateOptions['messages'][number]) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
        const input = options.messages.filter(message => message.role === 'user').map(textOf).join('\n');
        if (options.sessionId === control.ordinary) {
          assert.match(input, /PROBE-ORDINARY/u); text = 'ORDINARY-DONE';
        } else if (options.sessionId === control.owner) {
          assert.match(input, /\/agent-team PROBE-OWNER/u);
          const system = options.messages.filter(message => message.role === 'system').map(textOf).join('\n');
          const teamId = /"team_id":"([^"]+)"/u.exec(system)?.[1];
          const rootId = /"root_task_id":"([^"]+)"/u.exec(system)?.[1];
          // Completed teams disappear from live guidance, but previous tool calls
          // carry the already submitted root identity on the final model step.
          if (!called('flow_result')) { assert.ok(teamId); assert.ok(rootId); }
          if (!called('flow_task')) {
            const deadline = Date.now() + 15_000;
            while (!readControl(config).release && Date.now() < deadline) { options.signal?.throwIfAborted(); await delay(20); }
            assert.equal(readControl(config).release, true, 'the test observed automatic root creation before delegation');
            assert.match(system, /协调者（Orchestrator）/u);
            call = { name: 'flow_task', args: { action: 'delegate', team_id: teamId,
              profile: {name:'产物执行',role:'worker',instructions:'ROLE-PROFILE-APPLIED: deliver the requested artifact.',skills:['role-probe'],model:{provider:'team-command-probe',model:'scripted'}},
              objective: 'PROBE-MEMBER: Write command-member.txt containing exactly NATIVE-COMMAND-ARTIFACT and a newline. Return naturally with the path; do not call flow_result.' } };
          } else {
            const resultId = /Result ready: (\S+)/u.exec(input)?.[1];
            if (resultId && !called('read')) call = { name: 'read', args: { file_path: 'command-member.txt' } };
            else if (resultId && !called('flow_review')) {
              const receipt = options.messages.filter(message => message.role === 'tool').map(textOf).join('\n');
              assert.match(receipt, /NATIVE-COMMAND-ARTIFACT/u, 'the owner saw the real read receipt before reviewing');
              call = { name: 'flow_review', args: { result_id: resultId, accepted: true, notes: 'Native read matched the required file content.', evidence: ['read command-member.txt: NATIVE-COMMAND-ARTIFACT'] } };
            } else if (called('flow_review') && !called('flow_result')) call = { name: 'flow_result', args: { task_id: rootId,
              summary: 'Checked command-member.txt with the native read tool and accepted the child delivery.', artifacts: ['command-member.txt'], outcome: 'complete' } };
            text = called('flow_result') ? 'OWNER-DONE: verified command-member.txt' : 'OWNER-WAITING';
          }
        } else {
          assert.match(input, /PROBE-MEMBER/u);
          const system=options.messages.filter(message=>message.role==='system').map(textOf).join('\n');
          assert.match(system,/团队角色：执行者/u);
          assert.match(system,/ROLE-PROFILE-APPLIED/u);
          assert.match(system,/ROLE-SKILL-LOADED/u);
          for(const name of ['read','write','bash','flow_task','flow_review']) assert.ok(options.tools?.some(tool=>tool.name===name),`${name} remains available to the execution role`);
          if (!called('write')) call = { name: 'write', args: { file_path: 'command-member.txt', content: 'NATIVE-COMMAND-ARTIFACT\n' } };
          text = 'MEMBER-DONE: command-member.txt contains NATIVE-COMMAND-ARTIFACT; the native write succeeded.';
        }
      }
      const block: ContentBlock = call ? { type: 'tool-call', id: ToolCallId(randomUUID()), name: call.name, arguments: JSON.stringify(call.args) } : { type: 'text', text };
      yield { type: 'block-start', index: 0, blockType: block.type };
      if (block.type === 'tool-call') yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      else yield { type: 'text-delta', index: 0, text: block.text };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['team-command-probe'], new Scripted());
  save(join(config.root, `${config.phase}-requests.json`), requests);
  let busy = false;
  const observe = async () => {
    if (busy) return; busy = true;
    try {
      const control = readControl(config);
      const runs = control.owner ? ctx.flow.teamRuns(control.owner) : [];
      const teams = runs.map(run => ctx.flow.teamRead(run.owner_session_id, run.id));
      const ids = new Set([control.owner, control.ordinary, ...teams.flatMap(team => team.members.map(member => member.id))].filter((id): id is string => !!id));
      const sessions = [];
      for (const id of ids) {
        const view = await ctx.sessionController.inspect(SessionId(id));
        const agent = ctx.agents.get(SessionId(id));
        const images = [];
        for (const event of view.events) if (event.type === 'user/message') {
          for (const block of event.data.content) if (block.type === 'image' && 'attachment' in block) {
            const stored = await ctx.attachments.readImage(block.attachment);
            images.push({ reference: block.attachment, stored: stored !== undefined });
          }
        }
        sessions.push({ id, live: !!agent, running: agent?.status === 'running', events: view.events, images });
      }
      save(join(config.root, `${config.phase}-state.json`), { status: 'OBSERVED', teams, sessions, ordinary_teams: control.ordinary ? ctx.flow.teamRuns(control.ordinary) : [], request_count: requests.length });
    } catch (error) {
      // An in-flight read may settle after Host disposal; preserve the last
      // active snapshot instead of replacing evidence with teardown noise.
      if (String(error).includes('inactive context')) { clearInterval(timer); return; }
      save(join(config.root, `${config.phase}-observation-error.json`), { status: 'OBSERVATION_FAILED', error: String(error), stack: error instanceof Error ? error.stack : null });
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void observe(); }, 50);
  ctx.events.on('dispose', () => clearInterval(timer));
}
