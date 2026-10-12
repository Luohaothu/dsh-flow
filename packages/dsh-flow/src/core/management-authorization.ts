/** Durable execution authority for managers, independent of Worker allocations. */
import type { FlowCapability, FlowJsonValue } from '../types.ts';
import type { ClusterRecord, NodeRecord } from './model.ts';
import { validateCapabilities } from '../validation.ts';
import { validateWriteScope } from './protocol.ts';
import { canonicalScope, canonicalScopeEntry, withinScope } from './scope.ts';
import { fail } from '../errors.ts';

export const MANAGEMENT_CAPABILITIES: readonly FlowCapability[] = ['fs_read', 'fs_write', 'shell', 'web_fetch', 'browser'];
export interface ManagementAuthorization {
  readonly version: number;
  readonly capabilities: readonly FlowCapability[];
  readonly write_scope: readonly string[];
  readonly write_scope_canonical: readonly string[];
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function managementAuthorization(workspace: string, capabilities: unknown = MANAGEMENT_CAPABILITIES, writeScope: unknown = ['.'], version = 1): ManagementAuthorization {
  const selected = validateCapabilities(capabilities, 'managementCapabilities');
  const paths = validateWriteScope(writeScope, 'managementWriteScope');
  const canonical = canonicalScope(workspace, paths);
  const root = canonicalScopeEntry(workspace, '.');
  if (!root || !canonical || canonical.some(path => !withinScope(path, root))) fail('management write scope must resolve inside the team workspace', 403);
  if (!Number.isSafeInteger(version) || version < 1) fail('management authorization version must be a positive integer');
  return { version, capabilities: selected, write_scope: paths, write_scope_canonical: canonical };
}
export function resolveManagementAuthorization(cluster: ClusterRecord, node: NodeRecord, lookupNode?: (id: string) => NodeRecord | null, seen = new Set<string>()): ManagementAuthorization {
  if (seen.has(node.id)) fail('management authorization ancestry contains a cycle', 409);
  seen.add(node.id);
  if (node.cluster_id !== cluster.id || node.kind !== 'management') fail('management authorization belongs to a different domain', 403);
  const saved = record(node.scope?.execution_authorization);
  if (!saved) fail('management domain has no durable execution authorization', 409);
  const parsed = managementAuthorization(cluster.workspace, saved.capabilities, saved.write_scope, Number(saved.version));
  if (JSON.stringify(parsed.write_scope_canonical) !== JSON.stringify(saved.write_scope_canonical)) fail('management authorization paths changed since their grant', 409);
  if (node.parent_id && lookupNode) {
    const parent = lookupNode(node.parent_id) ?? fail('management authorization parent is missing', 409);
    const ceiling = resolveManagementAuthorization(cluster, parent, lookupNode, seen);
    if (parsed.capabilities.some(capability => !ceiling.capabilities.includes(capability))
      || parsed.write_scope_canonical.some(path => !ceiling.write_scope_canonical.some(allowed => withinScope(path, allowed)))) fail('management authorization exceeds its current ancestor grant', 403);
  }
  return parsed;
}
/** A delegated manager inherits the exact grant unless an explicit subset is supplied. */
export function childManagementAuthorization(cluster: ClusterRecord, parent: NodeRecord, requested: { managementCapabilities?: unknown; managementWriteScope?: unknown } = {}): ManagementAuthorization {
  const authority = resolveManagementAuthorization(cluster, parent);
  const child = managementAuthorization(cluster.workspace,
    requested.managementCapabilities === undefined ? authority.capabilities : requested.managementCapabilities,
    requested.managementWriteScope === undefined ? authority.write_scope : requested.managementWriteScope,
    authority.version);
  if (child.capabilities.some(capability => !authority.capabilities.includes(capability))) fail('child management capabilities cannot widen the parent authorization', 403);
  if (child.write_scope_canonical.some(path => !authority.write_scope_canonical.some(allowed => withinScope(path, allowed)))) fail('child management write scope cannot widen the parent authorization', 403);
  return child;
}
export function managementAuthorizationJson(authority: ManagementAuthorization): FlowJsonValue {
  return { version: authority.version, capabilities: [...authority.capabilities], write_scope: [...authority.write_scope], write_scope_canonical: [...authority.write_scope_canonical] };
}
