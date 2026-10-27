import type { Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Agent } from '../core/agent.js';
import { agentControl } from '../core/internals.js';
import { digestJson } from '../assignments/schema.js';
import type { NativePlan } from './native-types.js';
import { installFlowTools } from './tools.js';

export interface NativeFlowBinding { readonly native: NativeAgent; readonly flow: Agent; readonly plan: NativePlan }
const flowNatives = new WeakMap<NativeAgent, NativeFlowBinding>();
export function isFlowNative(native: NativeAgent): boolean { return flowNatives.has(native); }

/** Correlates SDK-minted tokens with a durable model call in this exact Session. */
export class NativeCallAuthority {
  private readonly calls = new Map<ToolExecutionToken, { sequence: number; turn: number }>();
  private readonly disposers: (() => void)[];
  constructor(private readonly host: DshContext, readonly native: NativeAgent) {
    this.disposers = [native.ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === native) {
        const parent = execution.parent && this.calls.get(execution.parent);
        const event = [...native.session.snapshotEvents()].reverse().find(event => event.type === 'tool/call'
          && event.data.callId === execution.callId && event.data.name === execution.name);
        if (parent) this.calls.set(execution.token, parent);
        else if (event?.type === 'tool/call') {
          const events = native.session.snapshotEvents();
          const ended = events.some(item => item.seq > event.seq && item.type === 'turn/end' && item.data.turn === event.data.turn);
          if (!ended && digestJson(JSON.parse(event.data.arguments)) === digestJson(execution.arguments)) {
            this.calls.set(execution.token, { sequence: event.seq, turn: event.data.turn });
          }
        }
      }
      return next();
    }), native.ctx.on('tools/result', execution => { this.calls.delete(execution.token); })];
  }
  assert(execution: ToolExecution): string {
    if (execution.agent !== this.native || this.host.agents.get(this.native.session.id) !== this.native) throw new Error('Tool caller does not match the bound live native Agent');
    const call = this.calls.get(execution.token);
    if (!call || typeof execution.token !== 'symbol') throw new Error('Flow requires an admitted native tool execution');
    return JSON.stringify([this.native.session.id, call.sequence, execution.callId]);
  }
  dispose(): void { for (const dispose of this.disposers) dispose(); this.calls.clear(); }
}

export interface NativeFlowBindingsOptions {
  installMember?(scope: DshContext, binding: NativeFlowBinding, guard: (execution: ToolRunContext) => void, yieldCapacity: () => void): (() => void)[];
}
export class NativeFlowBindings {
  private readonly bindings = new Map<Agent, NativeFlowBinding>();
  private readonly authorities = new Map<NativeFlowBinding, NativeCallAuthority>();
  constructor(private readonly host: DshContext, private readonly options: NativeFlowBindingsOptions = {}) {}
  bind(native: NativeAgent, flow: Agent, plan: NativePlan): NativeFlowBinding {
    if (flowNatives.has(native) || this.bindings.has(flow)) throw new Error('Native Flow identity is already bound');
    const binding = Object.freeze({ native, flow, plan });
    flowNatives.set(native, binding); this.bindings.set(flow, binding);
    this.authorities.set(binding, new NativeCallAuthority(this.host, native));
    return binding;
  }
  get(flow: Agent): NativeFlowBinding | undefined { return this.bindings.get(flow); }
  transportKey(binding: NativeFlowBinding, execution: ToolRunContext): string {
    if (this.bindings.get(binding.flow) !== binding) throw new Error('Flow native binding is released');
    return this.authorities.get(binding)!.assert(execution);
  }
  installMember(scope: DshContext, binding: NativeFlowBinding, guard: (execution: ToolRunContext) => void, yieldCapacity: () => void): (() => void)[] {
    const checked = (execution: ToolRunContext) => { this.transportKey(binding, execution); guard(execution); };
    return this.options.installMember?.(scope, binding, checked, yieldCapacity)
      ?? installFlowTools(scope, binding.flow[agentControl].context, binding.flow, checked, yieldCapacity);
  }
  release(binding: NativeFlowBinding): void {
    if (this.bindings.get(binding.flow) !== binding) return;
    this.bindings.delete(binding.flow); this.authorities.get(binding)?.dispose(); this.authorities.delete(binding);
  }
  dispose(): void { for (const binding of [...this.bindings.values()]) this.release(binding); }
}
