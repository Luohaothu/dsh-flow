import type { Agent as NativeAgent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { RunService } from '../run/run.js';
import type { RunDefaults } from '../run/types.js';
import type { AssignmentSpec } from '../assignments/types.js';
import type { DshNativeBridge } from './native-bridge.js';
import { registerJsonTool, rollbackTools } from './tools.js';
import { assignmentSpecSchema, objectSchema, stringSchema } from './member-tools.js';

/** Every definition closes over one ordinary native instance and its own scope. */
export function installMainTools(native: NativeAgent, bridge: DshNativeBridge, service: RunService,
  guard: (execution: ToolRunContext) => void): (() => void)[] {
  const disposers: (() => void)[] = [];
  const tool = (name: string, description: string, parameters: ReturnType<typeof objectSchema>, body: (args: Record<string, unknown>, execution: ToolRunContext) => unknown) => {
    disposers.push(registerJsonTool(native.ctx, name, description, parameters, (args, execution) => { guard(execution); return body(args, execution); }));
  };
  const runFields = { runId: stringSchema }, assignmentFields = { ...runFields, assignmentId: stringSchema };
  try {
    tool('flow_team_create', 'Create an idle Flow team; returns starting immediately. Dispatch tasks separately after it becomes active.', objectSchema({ defaults: { type: 'object' }, requestId: stringSchema }, ['requestId']), (args, execution) => {
      const origin = bridge.createOrigin(native, execution), run = service.create(origin, (args.defaults ?? {}) as RunDefaults, args.requestId as string);
      bridge.rememberRun(run, origin); return { runId: run.id, status: run.status };
    });
    tool('flow_teams', 'List your Flow team runs.', objectSchema({}), (_args, execution) => service.list(bridge.createOrigin(native, execution)));
    tool('flow_team_get', 'Read your Flow team state and native input or artifact material references.', objectSchema(runFields, ['runId']), async (args, execution) => {
      const origin = bridge.createOrigin(native, execution); return { ...service.read(origin, bridge.resolveRun(origin, args.runId as string)), materials: await bridge.materials.admitSession(native) };
    });
    tool('flow_team_assign', 'Save and deliver a top-level assignment to your active team root.', objectSchema({ ...runFields, spec: assignmentSpecSchema, requestId: stringSchema }, ['runId', 'spec', 'requestId']), async (args, execution) => {
      const origin = bridge.createOrigin(native, execution);
      await bridge.materials.admitSession(native);
      return service.assign(origin, bridge.resolveRun(origin, args.runId as string), args.spec as AssignmentSpec, args.requestId as string);
    });
    tool('flow_team_assignment_read', 'Read an assignment belonging to your team.', objectSchema(assignmentFields, ['runId', 'assignmentId']), (args, execution) => {
      const origin = bridge.createOrigin(native, execution), run = bridge.resolveRun(origin, args.runId as string);
      if (!run.assignments) throw new Error('Run assignments are not ready');
      return service.readAssignment(origin, run, run.assignments.resolve(args.assignmentId as string));
    });
    tool('flow_team_assignment_cancel', 'Cancel your top-level assignment and its descendant assignments.', objectSchema({ ...assignmentFields, reason: stringSchema }, ['runId', 'assignmentId', 'reason']), (args, execution) => {
      const origin = bridge.createOrigin(native, execution), run = bridge.resolveRun(origin, args.runId as string);
      if (!run.assignments) throw new Error('Run assignments are not ready');
      return service.cancelAssignment(origin, run, run.assignments.resolve(args.assignmentId as string), args.reason as string);
    });
    tool('flow_team_release', 'Cancel unfinished assignments and release your whole Flow team.', objectSchema(runFields, ['runId']), async (args, execution) => {
      const origin = bridge.createOrigin(native, execution), run = bridge.resolveRun(origin, args.runId as string);
      await service.release(origin, run); return { runId: run.id, status: run.status };
    });
    return disposers;
  } catch (error) { rollbackTools(disposers, error); }
}
