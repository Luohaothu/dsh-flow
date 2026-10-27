import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSkillContent, type SkillDefinition, type SkillRegistration } from '@deepseek-ai/dsh-skill';

async function bundled(name: 'team-strategy' | 'agent-team', description: string): Promise<SkillDefinition> {
  const path = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
  const markdown = await readFile(path, 'utf8');
  const content = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  if (!content) throw new Error(`Bundled ${name} skill has no content`);
  return { name, description, content, source: 'bundled', provider: 'dsh-flow', path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    invocation: { modelInvocable: name === 'team-strategy', userInvocable: name === 'agent-team' } };
}
export function loadTeamStrategySource(): Promise<SkillRegistration> {
  return bundled('team-strategy', '按任务自主选择组织、复用长期成员并通过作业交付结果。');
}
export function loadAgentTeamSource(): Promise<SkillDefinition> {
  return bundled('agent-team', '选择、复用或创建长期团队，再独立派发作业。');
}
export async function loadAgentTeamSkill(): Promise<string> { return renderSkillContent(await loadAgentTeamSource()); }
