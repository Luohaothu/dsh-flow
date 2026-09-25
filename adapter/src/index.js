import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Worker, deterministic, executeAgent, ControllerClient } from './runtime.js';

export const name = 'dsh-flow-adapter';
export const inject = ['tools'];

export function apply(ctx) {
  const baseUrl = process.env.FLOW_URL || 'http://127.0.0.1:3090';
  const token = process.env.FLOW_TOKEN;
  const client = new ControllerClient({ baseUrl, token });
  const service = {
    submit: (workflow, key) => client.submit(workflow, key),
    read: id => client.read(id),
    client,
    workerFactory: (run, options) => new Worker(client, run, options),
  };
  ctx.provide('flow', service);

  ctx.tools.register(defineTool({
    name: 'flow_submit',
    description: 'Submit a workflow to the configured local flow controller.',
    parameters: { workflow_json: { type: 'string', required: true }, idempotency_key: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      return JSON.stringify(await service.submit(JSON.parse(args.workflow_json), args.idempotency_key));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'flow_read',
    description: 'Read a workflow by its controller ID.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { return JSON.stringify(await service.read(args.id)); },
  }));

  if (process.env.FLOW_WORKER_ENABLED === '1') {
    const workerId = process.env.WORKER_ID || `dsh-${randomUUID()}`;
    const worker = new Worker(client, async (node, signal) => {
      if (signal.aborted) throw signal.reason;
      if (node.kind !== 'tool') throw Error('agent nodes are disabled; worker supports deterministic tool nodes only');
      return deterministic(node.tool.name, node.tool.args);
    }, { workerId });
    worker.start();
    ctx.on('dispose', () => worker.stop());
  }
  return service;
}

export { Worker, deterministic, executeAgent, ControllerClient };
