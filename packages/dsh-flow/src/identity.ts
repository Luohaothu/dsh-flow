/** A random agent id seeds a stable two-character given name and emoji. */
import type { FlowAgentRole } from './types.ts';
const FIRST=Array.from('子亦若思清明云星景知沐安予书嘉语初简昭承');
const LAST=Array.from('宁然安言远舟夏辰月禾诺墨歌岚溪桐珩宇澄昕');
export const ROLE_LABELS:Record<FlowAgentRole,string>={orchestrator:'总协调',allocator:'资源协调',auditor:'质量审核',worker:'任务执行'};
const AVATARS:Record<FlowAgentRole,readonly string[]>={orchestrator:['🧭','🦉','🦁','🐬'],allocator:['🌿','🌱','🐼','🦊'],auditor:['🔎','🦋','🐧','🦌'],worker:['🛠️','🐝','🐻','🐱','🐰','🐨']};
function seed(id:string):number {let value=2166136261;for(const char of id)value=Math.imul(value^char.charCodeAt(0),16777619);return value>>>0;}
export function agentGivenName(id:string):string {const value=seed(id);return FIRST[value%FIRST.length]!+LAST[Math.floor(value/FIRST.length)%LAST.length]!;}
export function agentEmoji(id:string,role:FlowAgentRole):string {const choices=AVATARS[role];return choices[seed(id)%choices.length]!;}
/** Cosmetic brand inference never changes routing or credentials. */
export function modelBrand(model:string):'DeepSeek'|'OpenAI'|'Anthropic'|'Google'|'Alibaba'|'Meta'|'Mistral'|'xAI'|'Moonshot'|'Zhipu'|'unknown' {
  const name=model.toLowerCase();
  if(name.includes('deepseek'))return 'DeepSeek';
  if(/(?:^|[/\s-])(gpt|chatgpt|o[1-9])(?:[-.\s]|$)/.test(name)||name.includes('openai'))return 'OpenAI';
  if(/claude|anthropic/.test(name))return 'Anthropic';if(/gemini|gemma/.test(name))return 'Google';
  if(/qwen|qwq/.test(name))return 'Alibaba';if(/llama/.test(name))return 'Meta';
  if(/mistral|mixtral|codestral/.test(name))return 'Mistral';if(/grok/.test(name))return 'xAI';
  if(/kimi|moonshot/.test(name))return 'Moonshot';if(/(?:chat)?glm|zhipu/.test(name))return 'Zhipu';
  return 'unknown';
}
export function reasoningLabel(effort:string|null):string|null {
  if(!effort||effort==='off'||effort==='none')return null;
  return ({low:'低',medium:'中',high:'高',max:'最高',xhigh:'极高',minimal:'最低'} as Record<string,string>)[effort]??effort;
}
