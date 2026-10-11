import {asObject} from './context.ts';

/** `projection` flags field selection; native receipts live under `evidence`. */
export function readNativeToolReceipts(value: unknown): Record<string, unknown>[] {
  const tools=asObject(asObject(asObject(value)?.evidence)?.native_tools);
  return Array.isArray(tools?.items) ? tools.items.flatMap(item=>{
    const receipt=asObject(item);return receipt ? [receipt] : [];
  }) : [];
}
