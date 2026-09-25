#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { ControllerClient, Worker, deterministic } from '../src/runtime.js';

const baseUrl = process.env.FLOW_URL;
const token = process.env.FLOW_TOKEN;
if (!baseUrl || !token) {
  console.error('FLOW_URL and FLOW_TOKEN are required');
  process.exit(1);
}
const workerId = process.env.WORKER_ID || `worker-${randomUUID()}`;
const client = new ControllerClient({ baseUrl, token });
const execute = async (node) => {
  if (node.kind !== 'tool') throw Error('agent nodes require a DSH harness; worker CLI supports tool nodes only');
  return deterministic(node.tool.name, node.tool.args);
};
const worker = new Worker(client, execute, { workerId });
console.log(`worker started: ${workerId}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  worker.stop().finally(() => process.exit(0));
});
worker.start();
