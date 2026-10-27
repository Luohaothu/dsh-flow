import type { AgentPermission, AgentProfile } from './types.js';
import { sessionID } from './message.js';
import { freezeData, snapshotData } from './snapshot-data.js';

const permissions: Record<AgentPermission, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}
function keys(value: object, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown ${name} field ${key}`);
}
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
}
export function snapshotProfile(value: AgentProfile): Readonly<AgentProfile> {
  record(value, 'Profile');
  keys(value, ['role', 'sessionID', 'permission', 'name', 'model', 'params', 'hostExtras'], 'Profile');
  text(value.role, 'role'); text(value.name, 'name'); sessionID(value.sessionID);
  if (!Object.hasOwn(permissions, value.permission)) throw new TypeError('Unknown initial permission');
  record(value.model, 'model'); keys(value.model, ['provider', 'id'], 'model');
  text(value.model.provider, 'model.provider'); text(value.model.id, 'model.id');
  record(value.params, 'params'); keys(value.params, ['version', 'temperature', 'reasoningEffort', 'maxTokens'], 'params');
  if (value.params.version !== 1) throw new TypeError('Unsupported reasoning params version');
  if (value.params.temperature !== undefined && !Number.isFinite(value.params.temperature)) throw new TypeError('temperature must be finite');
  if (value.params.reasoningEffort !== undefined) text(value.params.reasoningEffort, 'reasoningEffort');
  if (value.params.maxTokens !== undefined && (!Number.isSafeInteger(value.params.maxTokens) || value.params.maxTokens <= 0)) throw new TypeError('maxTokens must be a positive integer');
  if (value.hostExtras !== undefined) record(value.hostExtras, 'hostExtras');
  return freezeData(snapshotData(value));
}
export function checkPermission(profile: Readonly<AgentProfile>, parent: Readonly<AgentProfile> | null): void {
  if (parent && permissions[profile.permission] > permissions[parent.permission]) throw new Error('Child initial permission exceeds parent initial permission');
}
