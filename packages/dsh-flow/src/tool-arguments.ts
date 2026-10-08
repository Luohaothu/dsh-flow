/** The host's implicit tool parameter object is open; Flow rejects undeclared input before projection. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { fail } from './errors.ts';

export function strictTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    parameters: { ...tool.parameters, additionalProperties: false },
    execute(args, exec) {
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        for (const key of Object.keys(args)) {
          if (!Object.hasOwn(tool.parameters.properties ?? {}, key)) fail(`Unsupported ${tool.name} argument: ${key}`, 400);
        }
      }
      return tool.execute(args, exec);
    },
  };
}
