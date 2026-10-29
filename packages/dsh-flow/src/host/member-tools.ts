import type { Context as DshContext } from '@deepseek-ai/cordis';
import type { JsonSchemaNode, JsonSchemaType, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { Agent } from '../core/agent.js';
import { Group } from '../core/group.js';
import { agentControl, groupControl } from '../core/internals.js';
import { getAgentInstanceId } from '../core/observation.js';
import { sessionID } from '../core/message.js';
import { contextRun, runState } from '../run/internal.js';
import { applyPattern } from '../patterns/apply.js';
import { catalogControl } from '../patterns/internal.js';
import type { PatternAssets, PatternDocument, PatternApplyRequest } from '../patterns/types.js';
import type { AssignmentSpec, JsonValue } from '../assignments/types.js';
import { withTrustedCall } from '../assignments/internal.js';
import type { NativeFlowBinding, NativeFlowBindings } from './native-bindings.js';
import { NativeMaterials, renderMaterial, type MaterialValue } from './materials.js';
import { installFlowTools, registerJsonTool, rollbackTools } from './tools.js';

export const stringSchema: JsonSchemaNode = { type: 'string' };
export const objectSchema = (properties: Record<string, JsonSchemaNode>, required: string[] = []): JsonSchemaNode => ({ type: 'object', properties, required, additionalProperties: false });
export const assignmentSpecSchema: JsonSchemaNode = objectSchema({
  name: { type: 'string', description: 'Short name for this assignment.' },
  type: { type: 'string', description: 'Task category chosen by the sender.' },
  background: { type: 'string', description: 'Context and relevant prior findings.' },
  requirements: { type: 'string', description: 'Work the recipient must perform and constraints to preserve.' },
  acceptanceCriteria: { type: 'string', description: 'Evidence and outcomes the sender will check.' },
  resultSchema: {
    description: 'JSON Schema for the submitted result. Use an object with supported type, oneOf, properties, required, additionalProperties, items, enum, const, minimum, maximum and annotations, or a boolean schema.',
    oneOf: [{ type: 'boolean' }, { type: 'object' }],
  },
  materials: { type: 'array', description: 'Optional references to forward: copy complete items from the materials returned by flow_team_get or flow_team_read, unchanged. Put ordinary workspace paths and reading instructions in background. Omit this field or use [] when no references need forwarding.', items: objectSchema({
    id: { type: 'string', description: 'Opaque admitted reference identity; copy unchanged.' },
    sourceId: { type: 'string', description: 'Original Session or attachment source identity; copy unchanged.' },
    digest: { type: 'string', description: 'Digest of the admitted content block, not a workspace file checksum; copy unchanged.' },
    location: { type: 'string', description: 'Admitted content location, which may be a Session URI rather than a file path; copy unchanged.' },
    mediaType: { type: 'string', description: 'Admitted content media type; copy unchanged.' },
  }, ['id', 'sourceId', 'digest', 'location', 'mediaType']) },
  resumesAssignmentId: { type: 'string', description: 'Optional archived assignment continued by this new assignment.' },
}, ['name', 'type', 'background', 'requirements', 'acceptanceCriteria', 'resultSchema']);
export function teamRead(caller: Agent) {
  const context = caller[agentControl].context;
  return { agents: context.list(value => value instanceof Agent).map(value => {
    const agent = value as Agent;
    return { sessionID: agent.getProfile().sessionID, profile: agent.getProfile(), status: agent.getStatus(), parentSessionID: agent.getParent()?.getProfile().sessionID ?? null, children: agent.getChildren().map(child => child.getProfile().sessionID) };
  }), groups: context.list(value => value instanceof Group).map(value => {
    const group = value as Group;
    return { groupID: group.getID(), sessionIDs: group[groupControl].members().map(agent => agent.getProfile().sessionID) };
  }) };
}
export function installMemberTools(scope: DshContext, binding: NativeFlowBinding, bindings: NativeFlowBindings, materials: NativeMaterials,
  guard: (execution: ToolRunContext) => void, yieldCapacity: () => void): (() => void)[] {
  const caller = binding.flow, context = caller[agentControl].context;
  const disposers: (() => void)[] = [];
  const run = () => contextRun(context);
  const assignments = () => { const service = run().assignments; if (!service) throw new Error('Run assignments are not ready'); return service; };
  const assignment = (id: unknown) => assignments().resolve(id as string);
  const tool = (name: string, description: string, parameters: JsonSchemaNode, execute: (args: Record<string, unknown>, execution: ToolRunContext) => unknown, modelParameters?: () => JsonSchemaNode) => {
    disposers.push(registerJsonTool(scope, name, description, parameters, (args, execution) => { guard(execution); return execute(args, execution); }, modelParameters));
  };
  try {
    disposers.push(...installFlowTools(scope, context, caller, guard, yieldCapacity));
    tool('flow_team_read', 'Read your Run members, groups and your available material references.', objectSchema({}), async () => ({ ...teamRead(caller), materials: await materials.available(caller) }));
    tool('flow_patterns', 'Read this Run template catalog.', objectSchema({}), () => runState(run()).patternCatalog.list());
    tool('flow_pattern_define', 'Compile and register a candidate template in this Run.', objectSchema({ document: { oneOf: [{ type: 'string' }, { type: 'object' }] }, assets: { type: 'object' } }, ['document']), args => {
      const catalog = runState(run()).patternCatalog;
      const compiled = catalog.compile(args.document as PatternDocument, (args.assets ?? {}) as PatternAssets);
      if (!compiled.ok) return compiled;
      catalog[catalogControl].register(compiled.definition);
      return { ok: true, patternId: compiled.definition.id };
    });
    tool('flow_pattern_apply', 'Create members and groups from a Run template, rooted at yourself.', objectSchema({ patternId: stringSchema, parameters: { type: 'object' }, overrides: { type: 'object' }, requestId: stringSchema }, ['patternId', 'requestId']), async args => {
      const resolved = runState(run()).patternCatalog.resolve(args.patternId as string);
      if (!resolved.ok) return resolved;
      yieldCapacity();
      const created = await applyPattern(caller, { definition: resolved.definition,
        ...(args.parameters === undefined ? {} : { parameters: args.parameters as NonNullable<PatternApplyRequest['parameters']> }),
        ...(args.overrides === undefined ? {} : { overrides: args.overrides as NonNullable<PatternApplyRequest['overrides']> }) }, args.requestId as string);
      return { agents: Object.fromEntries(Object.entries(created.agents).map(([key, agent]) => [key, agent.getProfile().sessionID])),
        groups: Object.fromEntries(Object.entries(created.groups).map(([key, group]) => [key, group.getID()])), instructions: created.instructions };
    });
    tool('flow_assign', 'Prepare and deliver a formal assignment to your direct child.', objectSchema({ recipientSessionID: stringSchema, parentAssignmentId: stringSchema, spec: assignmentSpecSchema, requestId: stringSchema }, ['recipientSessionID', 'parentAssignmentId', 'spec', 'requestId']), async args => {
      const recipient = context.getAgent(sessionID(args.recipientSessionID as string));
      if (!recipient) throw new Error('Recipient is not active in this Run');
      await materials.admitSession(binding.native);
      const service = assignments();
      const handle = await service.prepare({ sender: caller, recipient, parentAssignment: assignment(args.parentAssignmentId), spec: args.spec as AssignmentSpec }, args.requestId as string);
      const snapshot = service.read(caller, handle);
      if (snapshot.status === 'pending') service.deliver(handle);
      return service.read(caller, handle);
    });
    tool('flow_assignment_read', 'Read an assignment in your Run.', objectSchema({ assignmentId: stringSchema }, ['assignmentId']), args => assignments().read(caller, assignment(args.assignmentId)));
    tool('flow_assignments', 'Query assignments in your Run.', objectSchema({ parentAssignmentId: { oneOf: [stringSchema, { type: 'null' }] }, status: { type: 'string', enum: ['pending', 'submitted', 'failed', 'cancelled'] } }), args => assignments().list(caller, args));
    tool('flow_assignment_archive_read', 'Read an archived formal assignment.', objectSchema({ assignmentId: stringSchema }, ['assignmentId']), args => assignments().readArchive(args.assignmentId as string));
    const resultDescription = 'The actual JSON value matching this assignment resultSchema. Pass objects and arrays directly, not as JSON-encoded strings. Use a string only when the assignment schema accepts a string.';
    const submitParameters = objectSchema({ assignmentId: stringSchema,
      result: {
        description: resultDescription,
        oneOf: [{ type: 'object', additionalProperties: true }, { type: 'array', items: {} }, { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
      },
      continuingChildren: { type: 'array', items: objectSchema({ assignmentId: stringSchema, reason: stringSchema }, ['assignmentId', 'reason']) } }, ['assignmentId', 'result', 'continuingChildren']);
    tool('flow_submit', 'Submit the actual result and reasons for continuing child assignments. accepted saves the result and completes this assignment. invalid-result returns field errors; after the first formatting failure only two corrections remain. terminal is already ended and cannot accept another result.', submitParameters, (args, execution) => {
      const transportKey = bindings.transportKey(binding, execution);
      return withTrustedCall({ actor: caller, transportKey }, () => assignments().submit(caller, assignment(args.assignmentId), {
        result: args.result as JsonValue, continuingChildren: (args.continuingChildren as { assignmentId: string; reason: string }[]).map(child => ({ assignment: assignment(child.assignmentId), reason: child.reason })),
      }));
    }, () => {
      const current = run(), service = current.assignments;
      if (!service) return submitParameters;
      const schemas = service.list(current, { status: 'pending' }).filter(item => item.recipientInstanceId === getAgentInstanceId(caller)).map(item => item.spec.resultSchema);
      const first = schemas[0], type = typeof first === 'object' ? first.type : undefined;
      if (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)
        || !schemas.every(schema => typeof schema === 'object' && schema.type === type)) return submitParameters;
      const result: JsonSchemaNode = { description: resultDescription, type: type as JsonSchemaType,
        ...(type === 'object' ? { additionalProperties: true } : type === 'array' ? { items: {} } : {}) };
      return { ...submitParameters, properties: { ...submitParameters.properties, result } };
    });
    tool('flow_assignment_cancel', 'Cancel assignments you dispatched, including their descendants.', objectSchema({ assignmentIds: { type: 'array', items: stringSchema }, reason: stringSchema }, ['assignmentIds', 'reason']), async args => {
      const outcomes = [];
      for (const id of args.assignmentIds as string[]) outcomes.push(...await assignments().cancel(caller, assignment(id), args.reason as string));
      return outcomes;
    });
    disposers.push(scope.tools.register({ name: 'flow_material_read', description: 'Read received material through your native execution permissions.', parameters: objectSchema({ materialId: stringSchema }, ['materialId']) as never,
      output: { schema: { type: 'object' }, render: (_args, value) => renderMaterial(value as unknown as MaterialValue) },
      async execute(args, execution) {
        guard(execution);
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || typeof (args as Record<string, unknown>).materialId !== 'string') throw new TypeError('materialId is required');
        return await materials.read(caller, (args as Record<string, string>).materialId!, execution.signal) as never;
      } }));
    return disposers;
  } catch (error) { rollbackTools(disposers, error); }
}
