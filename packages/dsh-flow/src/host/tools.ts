import type { Context as DshContext } from '@deepseek-ai/cordis';
import { assertObjectJsonSchema, validateJsonSchemaValue, type JsonSchemaNode, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { Agent, Group,
  type AgentProfile, type Context, type MailboxQuery, type Message, type MessageSource } from '../core/index.js';
import { USER, SYSTEM, groupID, messageID, newSessionID, serializeMessage, serializeMeta, sessionID, sameSource, describeWait } from '../core/message.js';
import { agentControl } from '../core/internals.js';
import { getAgentInstanceId } from '../core/observation.js';
import { snapshotProfile } from '../core/profile.js';

const string: JsonSchemaNode = { type: 'string' };
const number: JsonSchemaNode = { type: 'number' };
const sourceSchema: JsonSchemaNode = { type: 'object', properties: { kind: { type: 'string', enum: ['user', 'system'] }, sessionID: string, groupID: string }, additionalProperties: false };
const querySchema: JsonSchemaNode = { type: 'object', properties: { source: sourceSchema, after: number, before: number,
  read: { type: 'boolean' }, summaryIncludes: string, priority: { type: 'string', enum: ['high', 'normal', 'low'] } }, additionalProperties: false };
const schema = (properties: Record<string, JsonSchemaNode>, required: string[] = []): JsonSchemaNode => ({ type: 'object', properties, required, additionalProperties: false });
const profileSchema: JsonSchemaNode = schema({
  role: { ...string, description: 'Nonempty identity instructions for the child.' },
  name: { ...string, description: 'Nonempty display name.' },
  permission: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'], description: 'Must not exceed the parent initial permission.' },
  model: schema({ provider: string, id: string }, ['provider', 'id']),
  params: schema({ version: { type: 'integer', enum: [1] }, temperature: number,
    reasoningEffort: { ...string, description: 'Nonempty host-supported reasoning effort when provided.' },
    maxTokens: { type: 'integer', description: 'Positive safe integer when provided.' } }, ['version']),
  hostExtras: { type: 'object', description: 'Optional extra configuration validated by the host adapter.' },
  sessionID: { description: 'Ignored input; always replaced with a fresh sessionID by this tool.' },
}, ['role', 'name', 'permission', 'model', 'params']);
/** A failed installer unwinds only the exact registrations it owns. */
export function rollbackTools(disposers: (() => void)[], error: unknown): never {
  const failures: unknown[] = [error];
  for (const dispose of disposers.splice(0).reverse()) try { dispose(); } catch (cleanup) { failures.push(cleanup); }
  if (failures.length > 1) throw new AggregateError(failures, 'Tool installation and rollback failed');
  throw error;
}
export function registerJsonTool(host: DshContext, name: string, description: string, parameters: JsonSchemaNode,
  run: (args: Record<string, unknown>, execution: ToolRunContext) => unknown | Promise<unknown>, modelParameters?: () => JsonSchemaNode): () => void {
  assertObjectJsonSchema(parameters);
  return host.tools.register({ name, description,
    get parameters() {
      const presented = modelParameters?.() ?? parameters;
      assertObjectJsonSchema(presented);
      return { ...presented };
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      execution.signal.throwIfAborted();
      const errors = validateJsonSchemaValue(parameters, args);
      if (errors.length) throw new TypeError(errors.join('\n'));
      const result = await run(args as Record<string, unknown>, execution);
      return result === undefined ? { ok: true } : result;
    },
  });
}

export function installFlowTools(host: DshContext, context: Context, caller: Agent,
  assertCaller: (execution: ToolRunContext) => void, yieldCapacity: () => void): (() => void)[] {
  const disposers: (() => void)[] = [];
  const mailbox = caller.getMailbox();
  let filters: Record<string, unknown>[] = [];
  function agent(value: unknown): Agent {
    if (typeof value !== 'string') throw new TypeError('sessionID is required');
    const found = context.getAgent(sessionID(value));
    if (!found) throw new Error(`Unknown active Agent ${value}`);
    return found;
  }
  function group(value: unknown): Group {
    if (typeof value !== 'string') throw new TypeError('groupID is required');
    const found = context.getGroup(groupID(value));
    if (!found) throw new Error(`Unknown active Group ${value}`);
    return found;
  }
  function source(value: unknown): MessageSource {
    const spec = value as Record<string, unknown>;
    if (spec.kind === 'user') return USER;
    if (spec.kind === 'system') return SYSTEM;
    const from = agent(spec.sessionID);
    return spec.groupID ? { agent: from, g: group(spec.groupID) } : from;
  }
  function query(value: unknown): MailboxQuery {
    const spec = (value ?? {}) as Record<string, unknown>;
    const from = spec.source ? source(spec.source) : undefined;
    return describeWait(message => (!from || sameSource(message.source, from))
      && (spec.after === undefined || message.timestamp > (spec.after as number))
      && (spec.before === undefined || message.timestamp < (spec.before as number))
      && (spec.read === undefined || message.read === spec.read)
      && (spec.priority === undefined || message.priority === spec.priority)
      && (spec.summaryIncludes === undefined || message.summary.includes(spec.summaryIncludes as string)), JSON.stringify(spec));
  }
  const outgoing = (args: Record<string, unknown>): Message => ({ source: caller, timestamp: Date.now(), read: false,
    read_timestamp: null, summary: args.summary as string, payload: args.payload });
  const info = (value: Agent) => ({ instanceId: getAgentInstanceId(value), profile: value.getProfile(), status: value.getStatus(), parent: value.getParent()?.getProfile().sessionID ?? null,
    children: value.getChildren().map(child => child.getProfile().sessionID) });
  function tool(name: string, description: string, parameters: JsonSchemaNode,
    run: (args: Record<string, unknown>, execution: ToolRunContext) => unknown | Promise<unknown>) {
    disposers.push(registerJsonTool(host, name, description, parameters, (args, execution) => { assertCaller(execution); return run(args, execution); }));
  }
  const messageFields = { summary: string, payload: {} };
  try {
    tool('flow_self', 'Read your profile, state and direct logical relations.', schema({}), () => info(caller));
    tool('flow_agents', 'List active Agents in your Flow Context.', schema({}), () => context.list(value => value instanceof Agent).map(value => info(value as Agent)));
    tool('flow_send', 'Send a message; the receiver chooses its priority.', schema({ sessionID: string, ...messageFields }, ['sessionID', 'summary', 'payload']), args => agent(args.sessionID).recvMessage(outgoing(args)));
    tool('flow_wait', 'Register a mailbox condition and end this turn immediately, or return an existing match. timeout is milliseconds.',
      schema({ query: querySchema, timeout: number }, ['timeout']), (args, execution) => {
        const result = caller.wait(query(args.query), args.timeout as number);
        if (result.kind === 'registered') { yieldCapacity(); execution.concludeTurn(); return result; }
        return { kind: 'matched', message: serializeMeta(result.message) };
      });
    tool('flow_mailbox', 'Query your own mailbox; get reads payloads, peak only reads metadata.', schema({ query: querySchema, mode: { type: 'string', enum: ['get', 'peak'] } }), args =>
      args.mode === 'get' ? mailbox.query(query(args.query), 'get').map(serializeMessage) : mailbox.query(query(args.query), 'peak').map(serializeMeta));
    tool('flow_read', 'Read your own message by ID.', schema({ messageID: string }, ['messageID']), args => { const value = mailbox.get(messageID(args.messageID as string)); return value ? serializeMessage(value) : null; });
    tool('flow_peak', 'Read your own message metadata by ID.', schema({ messageID: string }, ['messageID']), args => { const value = mailbox.peak(messageID(args.messageID as string)); return value ? serializeMeta(value) : null; });
    tool('flow_last_unread', 'Read the latest unread message.', schema({}), () => { const value = mailbox.getLastUnread(); return value ? serializeMessage(value) : null; });
    tool('flow_unread', 'Read all unread messages.', schema({}), () => [...mailbox.getUnread()].map(serializeMessage));
    tool('flow_count', 'Count matching messages.', schema({ query: querySchema }), args => ({ count: mailbox.count(query(args.query)) }));
    tool('flow_set_filters', 'Replace future-message drop filters.', schema({ rules: { type: 'array', items: querySchema } }, ['rules']), args => {
      const next = structuredClone(args.rules) as Record<string, unknown>[]; mailbox.setFilters(next.map(query)); filters = next;
    });
    tool('flow_get_filters', 'Read filters installed through this tool.', schema({}), () => ({ rules: structuredClone(filters), totalCount: mailbox.getFilters().length }));
    tool('flow_set_source_priority', 'Rate the priority of future messages from a source.', schema({ source: sourceSchema, priority: { type: 'string', enum: ['high', 'normal', 'low'] } }, ['source', 'priority']), args => mailbox.setSourcePriority(source(args.source), args.priority as 'high' | 'normal' | 'low'));
    tool('flow_get_source_priority', 'Read your current rating for a source.', schema({ source: sourceSchema }, ['source']), args => ({ priority: mailbox.getSourcePriority(source(args.source)) }));
    tool('flow_fork', 'Create your direct child from an independent history snapshot.', schema({}), async () => info(await caller.fork()));
    tool('flow_herb', 'Summarize and merge two contexts into your direct child.', schema({ sessionID: string }, ['sessionID']), async args => { yieldCapacity(); return info(await caller.herb(agent(args.sessionID))); });
    tool('flow_create', 'Create an idle direct child with a complete explicit profile; no fields default from the parent. Reuse actual configuration from flow_self, flow_agents or another known Profile when appropriate. sessionID is always replaced with a fresh identity. Optional initmsg supplies its first input. retryOf records the exact instanceId of your failed terminated child; it creates a new instance.', schema({ profile: profileSchema, initmsg: schema(messageFields, ['summary', 'payload']), history: string, retryOf: string }, ['profile']), async args => {
      const profile = snapshotProfile({ ...(args.profile as AgentProfile), sessionID: newSessionID() });
      const initmsg = args.initmsg === undefined ? undefined : outgoing(args.initmsg as Record<string, unknown>), history = args.history as string | undefined;
      return info(await (args.retryOf === undefined ? Agent.create(context, profile, caller, initmsg, history)
        : caller[agentControl].retry(profile, args.retryOf as string, initmsg, history)));
    });
    tool('flow_resume', 'Cold-resume a persisted session as your direct child.', schema({ sessionID: string }, ['sessionID']), async args => info(await Agent.resume(context, caller, sessionID(args.sessionID as string))));
    tool('flow_kill', 'Release your direct child after its current turn.', schema({ sessionID: string }, ['sessionID']), async args => { yieldCapacity(); await caller.kill(agent(args.sessionID)); });
    tool('flow_signal', 'Signal your lifecycle: SIGTERM lets this turn finish, SIGKILL cancels it.', schema({ signal: { type: 'string', enum: ['SIGTERM', 'SIGKILL'] } }, ['signal']), args => {
      const signal = args.signal;
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new TypeError('Unknown signal');
      void caller[agentControl].release(signal, 'self').catch(() => {}); return { accepted: true };
    });
    tool('flow_transfer', 'Transfer your direct child to another active Agent.', schema({ childSessionID: string, adoptSessionID: string }, ['childSessionID', 'adoptSessionID']), args => caller.transfer(agent(args.childSessionID), agent(args.adoptSessionID)));
    tool('flow_group_create', 'Create a Group with fixed membership.', schema({ sessionIDs: { type: 'array', items: string } }, ['sessionIDs']), args => ({ groupID: new Group(context, (args.sessionIDs as string[]).map(agent)).getID() }));
    tool('flow_group_post', 'Post to a Group you belong to.', schema({ groupID: string, ...messageFields }, ['groupID', 'summary', 'payload']), args => group(args.groupID).postMessage(caller, outgoing(args)));
    tool('flow_group_dissolve', 'Dissolve an active Group in the current Context.', schema({ groupID: string }, ['groupID']), args => context.release(group(args.groupID)));
    tool('flow_blackboard_post', 'Append to your Group blackboard.', schema({ groupID: string, ...messageFields }, ['groupID', 'summary', 'payload']), args => group(args.groupID).postToBlackboard(caller, outgoing(args)));
    tool('flow_blackboard_read', 'Read a Group blackboard snapshot.', schema({ groupID: string, after: number }, ['groupID']), args => group(args.groupID).readBlackboard(args.after as number | undefined).map(serializeMessage));
    tool('flow_blackboard_has_new', 'Check for newer Group blackboard entries.', schema({ groupID: string, after: number }, ['groupID', 'after']), args => ({ hasNew: group(args.groupID).hasNewMsgOnboard(args.after as number) }));
    return disposers;
  } catch (error) { rollbackTools(disposers, error); }
}
