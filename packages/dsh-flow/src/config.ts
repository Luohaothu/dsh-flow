/** Deployment chooses a native preset and one Agent capacity, not a tool policy. */
import Schema from '@deepseek-ai/schemastery';
import { resolve } from 'node:path';
export interface Config { dataDir?: string | null; workspace?: string | null; preset?: string | null; maxConcurrentAgents?: number | null }
export interface ResolvedConfig { dataDir: string; workspace: string; preset: string | null; maxConcurrentAgents: number }
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  dataDir: Schema.string().default('.dsh-flow'), workspace: Schema.string().default('.'),
  preset: Schema.union([Schema.string(), Schema.const(null)]).default(null),
  maxConcurrentAgents: Schema.number().step(1).min(1).default(4),
});
export function resolveConfig(input: Config): ResolvedConfig {
  const allowed = new Set(["dataDir", "workspace", "preset", "maxConcurrentAgents"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported Flow configuration field: ${key}`);
  const config = Config(input);
  return { ...config, dataDir: resolve(config.dataDir), workspace: resolve(config.workspace) };
}
