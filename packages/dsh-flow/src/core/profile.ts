/** Role/persona and skills are native prompt composition, independent of collaboration authority. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { isModelInvocable, isSkillName, renderSkillContent, type SkillRegistry } from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { z } from 'zod';
import type { FlowAgentProfile } from '../types.ts';

const text = z.string().trim().min(1);
const profileSchema = z.object({
  name: text.optional(), role: z.enum(['orchestrator', 'worker']).optional(), instructions: text.optional(), preset: text.optional(),
  model: z.object({ provider: text.optional(), model: text.optional(), reasoningEffort: text.optional() }).strict().optional(),
  skills: z.array(text.refine(isSkillName, 'Invalid native skill name')).transform(names => [...new Set(names)]).optional(),
}).strict();

export function agentProfile(value: FlowAgentProfile | undefined): FlowAgentProfile {
  const parsed = profileSchema.parse(value ?? {}), profile: FlowAgentProfile = {};
  for (const key of ['name', 'instructions', 'preset'] as const) if (parsed[key] !== undefined) profile[key] = parsed[key];
  if (parsed.role !== undefined) profile.role = parsed.role;
  if (parsed.skills !== undefined) profile.skills = parsed.skills;
  if (parsed.model !== undefined) {
    profile.model = {};
    for (const key of ['provider', 'model', 'reasoningEffort'] as const) if (parsed.model[key] !== undefined) profile.model[key] = parsed.model[key];
  }
  return profile;
}

/** Resolve once per native creation/resume, not once per turn or tool call. */
export async function composeMemberProfile(ctx: Context, agent: Agent, profile: FlowAgentProfile, skills: Pick<SkillRegistry, 'get'>, signal?: AbortSignal): Promise<void> {
  const responsibility = profile.role === 'orchestrator'
    ? '协调者（Orchestrator）。负责所派目标的规划、资源选择、任务分配、验收和汇总，也可亲自执行工作。'
    : '执行者（Worker）。负责受派任务与交付，也可按需要委派并协调子任务。';
  const sections = [`团队角色：${responsibility} 角色描述职责；原生工具按宿主配置使用，验收权来自实际委派关系。`];
  if (profile.instructions) sections.push(profile.instructions);
  for (const name of profile.skills ?? []) {
    const skill = await skills.get(name, { scope: agent, cwd: agent.session.header.cwd, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (!skill || !isModelInvocable(skill)) throw new Error(`Role skill ${name} is unavailable for model delegation`);
    sections.push(renderSkillContent(skill));
  }
  ctx.systemPrompt.section({
    name: 'dsh-flow:member-role', order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
    interpolate: false, text: sections.join('\n\n'),
  });
}
