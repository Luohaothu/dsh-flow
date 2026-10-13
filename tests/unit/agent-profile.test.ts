/** Profiles change responsibilities/native composition, never the collaboration protocol. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromPartial, fromAny } from '@total-typescript/shoehorn';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-skill';
import type { SkillViewOptions } from '@deepseek-ai/dsh-skill';
import type { FlowAgentProfile } from '../../packages/dsh-flow/src/types.ts';
import { agentProfile, composeMemberProfile } from '../../packages/dsh-flow/src/core/profile.ts';
import { fixture, until } from './native-fixture.ts';

test('declared roles and native settings survive delegation, member reuse and cold recovery', async t => {
  const f = fixture(t), {team} = await f.startTeam();
  const profile: FlowAgentProfile = { name: '资源统筹', role: 'orchestrator', instructions: '按任务需要分配工作。', preset: 'standard',
    model: { provider: 'configured', model: 'local', reasoningEffort: 'high' }, skills: ['resource-planning'] };
  const request = { action: 'delegate' as const, team_id: team, objective: '确定两项互补工作', profile };
  const task = await f.flow.task('owner', request, 'profile-delegate');
  assert.equal((await f.flow.task('owner', request, 'profile-delegate')).id, task.id);
  await until(() => f.handles.get(task.assignee_session_id)?.running() === true);
  for (const [key, value] of Object.entries(profile)) {
    assert.deepEqual(Reflect.get(f.flow.store.getMember(task.assignee_session_id)!, key), value);
    assert.deepEqual(Reflect.get(f.handles.get(task.assignee_session_id)!.options, key), value);
  }
  assert.equal(f.created.length, 1, 'a role does not create helper agents');
  const member = f.flow.store.getMember(task.assignee_session_id)!;
  await assert.rejects(f.flow.task('owner', { ...request, member_id: member.id }), /retains its profile/);
  await assert.rejects(f.flow.task('owner', { action:'update',team_id:team,task_id:task.id,version:1,profile }), /profile/);
  assert.equal(f.flow.store.tasks(team).length, 2, 'invalid reconfiguration has no task side effects');
  await f.reopen();
  await until(() => f.created.length === 2);
  assert.equal(f.handles.get(member.id)!.options.role, profile.role);
  assert.deepEqual(f.handles.get(member.id)!.options.skills, profile.skills);
  assert.deepEqual(f.flow.store.getMember(member.id)?.model, profile.model);
  // A configured orchestrator uses the same delegate and result rules as any Agent.
  const child = await f.flow.task(member.id, { action:'delegate',team_id:team,objective:'完成具体产物',profile:{role:'worker'} });
  assert.equal(child.parent_id, task.id);
  assert.equal(child.owner_session_id, member.id);
});

test('optional role configuration is validated before durable mutation', async t => {
  const f=fixture(t),{team}=await f.startTeam();
  for (const profile of [{role:'研究员'},{skills:['not a skill']},{capabilities:['read']},{model:{budget:1}}]) {
    await assert.rejects(f.flow.task('owner',{action:'delegate',team_id:team,objective:'x',profile:fromAny<FlowAgentProfile, unknown>(profile)}));
  }
  assert.equal(f.flow.store.members(team).length,0);
  assert.equal(f.flow.store.tasks(team).length,1);
  assert.deepEqual(agentProfile({role:'worker',name:'  研究员 ',skills:['analysis','analysis']}),{role:'worker',name:'研究员',skills:['analysis']});
});

test('role skills use the scoped native registry and reject unavailable or user-only skills', async () => {
  const sections: unknown[]=[];const lookups: unknown[]=[];
  const agent=fromPartial<Agent>({session:{header:{cwd:'/workspace'}}});
  const ctx=fromPartial<Context>({
    skills:{get:async(name: string,options?: SkillViewOptions)=>{lookups.push(options);return name==='missing'?undefined:{name,description:'probe',source:'runtime',provider:'probe',content:'ROLE-SKILL-CONTENT',invocation:{modelInvocable:name!=='human-only',userInvocable:true}};}},
    systemPrompt:{getSectionOrder:()=>1,section:(section: unknown)=>{sections.push(section);return()=>{};}},
  });
  await composeMemberProfile(ctx,agent,{role:'orchestrator',instructions:'ROLE-INSTRUCTIONS',skills:['analysis']},ctx.skills);
  assert.equal(sections.length,1);
  assert.match(JSON.stringify(sections),/协调者.*ROLE-INSTRUCTIONS.*ROLE-SKILL-CONTENT/);
  assert.deepEqual(lookups,[{scope:agent,cwd:'/workspace'}]);
  await assert.rejects(composeMemberProfile(ctx,agent,{skills:['missing']},ctx.skills),/unavailable/);
  await assert.rejects(composeMemberProfile(ctx,agent,{skills:['human-only']},ctx.skills),/unavailable/);
  assert.equal(sections.length,1,'failed composition installs no partial role prompt');
});
