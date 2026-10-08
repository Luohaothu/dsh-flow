/**
 * Shared boundary validators for command arguments and resolved deployment
 * configuration. Each validator narrows unknown input to a concrete type.
 * Client-safe imports keep validation independent of the store and scheduler.
 */
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { fail } from './errors.ts';
import type { FlowBudgetInput, FlowCapability, FlowJsonValue, FlowLimitsInput } from './types.ts';

/** Total length cap for one free-text field crossing a command boundary. */
const TEXT_MAX = 1 << 16;

/**
 * Narrow one enumerated integer.
 * @param value - candidate value.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param label - field name used in the refusal message.
 * @returns the value, once proven to be an integer inside the bounds.
 */
export function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(`Invalid ${label}: expected integer ${min}..${max}`);
  }
  return value;
}

/**
 * Narrow a non-empty bounded string.
 * @param value - candidate value.
 * @param label - field name used in the refusal message.
 * @param max - maximum accepted length.
 * @returns the value, once proven to be a non-empty string inside the length cap.
 */
export function textField(value: unknown, label: string, max = TEXT_MAX): string {
  if (typeof value !== 'string' || !value.length || value.length > max) fail(`Invalid ${label}`);
  return value;
}

/**
 * Narrow one JSON object.
 * @param value - candidate value.
 * @param label - field name used in the refusal message.
 * @returns the value, once proven to be a non-array object.
 */
export function objectField(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

/** The retained resource dimensions, in declaration order. */
export const BUDGET_KEYS = [
  'tool_calls', 'wall_time_ms', 'agents', 'max_active_agents',
] as const;

/**
 * Narrow a page size.
 * @param value - candidate value; an omitted value takes the fallback.
 * @param fallback - page size used when the caller named none.
 * @param max - largest accepted page size.
 * @returns the page size.
 */
export function normalizeLimit(value: unknown, fallback = 100, max = 500): number {
  if (value === undefined || value === null) return fallback;
  return integer(value, 1, max, 'limit');
}

/** Every worker capability the cluster can grant. */
export type { FlowCapability } from './types.ts';

/**
 * The capability inventory, in the order the cluster documents it.
 *
 * Kept as an explicit list rather than derived from the capability→tool map so
 * the union stays a hand-written literal: wire types may not depend on type
 * operators the Typert generator refuses. The unit suite asserts this list and
 * the capability→tool map cover exactly the same members.
 */
export const ALL_CAPABILITIES: readonly FlowCapability[] = [
  'fs_read',
  'fs_write',
  'shell',
  'web_fetch',
  'browser',
];

/**
 * Narrow a capability list.
 * @param value - candidate value; `undefined` means "the caller named none".
 * @param label - field name used in the refusal message.
 * @param options - `required` refuses an omitted list instead of returning empty.
 * @returns the deduplicated capability list.
 */
export function validateCapabilities(
  value: unknown,
  label = 'capabilities',
  { required = false }: { required?: boolean } = {},
): FlowCapability[] {
  if (value === undefined) {
    if (required) fail(`Missing ${label}`);
    return [];
  }
  if (!Array.isArray(value)) fail(`Invalid ${label}`);
  if (value.length > 32) fail(`${label} exceeds 32 entries`);
  for (const item of value) {
    if (typeof item !== 'string' || !ALL_CAPABILITIES.includes(item as FlowCapability)) {
      fail(`Unsupported capability: ${String(item)}`);
    }
  }
  return [...new Set(value as FlowCapability[])];
}

/**
 * Narrow a partial budget.
 *
 * Only the dimensions the caller actually set are returned: an omitted
 * dimension must stay omitted so the merge order (schema default, deployment
 * configuration, this request) can fill it, instead of being overwritten with a
 * value nobody asked for.
 * @param value - candidate value.
 * @param label - field name used in the refusal message.
 * @returns the budget dimensions that were present and in range.
 */
export function validateBudget(value: unknown, label = 'budget'): FlowBudgetInput {
  const source = objectField(value, label);
  const out: {
    tool_calls?: number
    wall_time_ms?: number
    agents?: number
    max_active_agents?: number
  } = {};
  rejectUnknownFields(source, BUDGET_KEYS, label);
  for (const key of BUDGET_KEYS) {
    if (source[key] === undefined) continue;
    out[key] = integer(source[key], 1, 2 ** 40, `${label}.${key}`);
  }
  return out;
}

/**
 * Test one value against the plugin's JSON vocabulary.
 *
 * A thin type-predicate adaptation over `@deepseek-ai/dsh-util-values`'
 * `isJsonValue`: that package owns the lossless-JSON rules and this package
 * reuses them without copying the value or re-implementing the check. The
 * predicate exists because `isJsonValue` returns a plain `boolean`, which cannot
 * narrow a boundary value.
 * @param value - any value.
 * @returns whether the value is a JSON value.
 */
export function isFlowJsonValue(value: unknown): value is FlowJsonValue {
  return isJsonValue(value);
}

/** Every declared limit key, in the order the protocol documents them. */
const LIMIT_KEYS = [
  'max_children', 'max_depth', 'max_agents', 'max_active_agents', 'max_llm_concurrency',
  'max_attempts', 'max_corrections', 'max_role_turns', 'max_tool_calls_per_turn',
  'max_scale_batch',
] as const satisfies readonly (keyof FlowLimitsInput)[];

/** The inclusive bounds each limit key must fall inside. */
const LIMIT_BOUNDS: { readonly [K in (typeof LIMIT_KEYS)[number]]: readonly [number, number] } = {
  max_children: [1, 4096],
  max_depth: [1, 32],
  max_agents: [1, 100000],
  max_active_agents: [1, 512],
  max_llm_concurrency: [1, 64],
  max_attempts: [1, 16],
  max_corrections: [0, 16],
  max_role_turns: [1, 512],
  max_tool_calls_per_turn: [1, 4096],
  max_scale_batch: [1, 100000],
};

/**
 * Narrow a partial cluster limit set.
 *
 * Only the keys the caller actually set are returned, so the merge order
 * (schema default, deployment configuration, this request) can still fill the
 * rest.
 * @param value - candidate value.
 * @param label - field name used in the refusal message.
 * @returns the limit keys that were present and in range.
 */
export function validateLimits(value: unknown, label = 'limits'): FlowLimitsInput {
  const source = objectField(value, label);
  rejectUnknownFields(source, LIMIT_KEYS, label);
  const out: { [K in (typeof LIMIT_KEYS)[number]]?: number } = {};
  for (const key of LIMIT_KEYS) {
    const current = source[key];
    if (current === undefined) continue;
    const [min, max] = LIMIT_BOUNDS[key];
    out[key] = integer(current, min, max, `${label}.${key}`);
  }
  return out;
}

/** Refuse unsupported fields at the boundary instead of silently dropping them. */
export function rejectUnknownFields(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) fail(`Unsupported ${label}.${key}`);
  }
}
