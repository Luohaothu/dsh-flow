/** Verify archived native receipts and usage; never sends a model request. */
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Trial } from './types.ts';
import { readSessionEvents } from '../../../src/host/session-scan.ts';
assert(process.argv[2], 'Usage: verify.ts <report.json> [--path-map map.json] [--output verification.json] [--scan-key-env ENV_NAME]');
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  assert(process.argv[index + 1] && !process.argv[index + 1]!.startsWith('--'), `${name} requires a value`);
  return process.argv[index + 1];
};
const mapFile = option('--path-map');
const pathMap = mapFile ? JSON.parse(readFileSync(resolve(mapFile), 'utf8')) as { version: number; files: Record<string, { path: string; sha256: string }> } : null;
if (pathMap) assert.equal(pathMap.version, 1, 'Unsupported native path map version');
const nativePath = (original: string): string => {
  if (!pathMap || !mapFile) return original;
  const entry = pathMap.files[original];
  assert(entry, `Native trace missing from path map: ${original}`);
  const path = resolve(dirname(resolve(mapFile)), entry.path);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), entry.sha256, 'Archived native trace checksum mismatch');
  return path;
};
const root=dirname(resolve(process.argv[2]));
const report=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8')) as { trials: Trial[] };
const arms = ['baseline','self_review','auditor'] as const;
// Receipt/usage verification is offline. Credential scanning is an explicit, separate check.
const scanKeyEnv = option('--scan-key-env');
const key = scanKeyEnv ? process.env[scanKeyEnv] : undefined;
if (scanKeyEnv) assert(key, `Missing explicitly requested credential environment variable: ${scanKeyEnv}`);
const cache=new Map<string,any[]>();let decisions=0,usage=0,requests=0,stages=0,secretFound=false;
for(const trial of report.trials) for(const arm of arms) {
 const turn=trial[arm];stages++;
 assert(turn.native_file,'Each attempted stage must have a native session file');
 if(!cache.has(turn.native_file)) {const decoded=readSessionEvents(nativePath(turn.native_file));assert.equal(decoded.state,'READ');cache.set(turn.native_file,decoded.events);const leaked = (value:any, field=''):boolean => !key ? false : typeof value==='string' ? (value===key || value.includes('Bearer '+key) || (key.length>=12 && value.includes(key)) || (/api[_-]?key|authorization|password|secret/i.test(field) && value.includes(key))) : value && typeof value==='object' ? Object.entries(value).some(([name,item])=>leaked(item,name)) : false; secretFound ||= leaked(decoded.events);}
 const events:any[]=[];let activeTurn=0;for(const event of cache.get(turn.native_file)!){if(event.type==='turn/start')activeTurn=event.data.turn;if(activeTurn===(arm==='self_review'?2:1))events.push(event);}
 const sums={input:0,output:0};
 for(const e of events)if(e.type==='assistant/message' && e.data.usage){const u=e.data.usage;sums.input+=u.inputTokens+(u.cacheReadTokens??0)+(u.cacheWriteTokens??0);sums.output+=u.outputTokens;}
 assert.equal(sums.input,turn.input_tokens,`${trial.fixture_id}/${arm} input usage`);assert.equal(sums.output,turn.output_tokens,`${trial.fixture_id}/${arm} output usage`);usage++;
 assert.equal(events.filter(e=>e.type==='assistant/message').length,turn.model_requests,`${trial.fixture_id}/${arm} request count`);requests++;
 const records=events.filter(e=>e.type==='tool/result').flatMap(e=>e.data.message.content.flatMap((b:any)=>{if(b.type!=='text')return [];try{const v=JSON.parse(b.text);return v.recorded===true&&v.decision?[v]:[];}catch{return [];}}));
 if(turn.decision){assert(records.length>0,'A structured decision must have a successful native receipt');assert.deepEqual(records.at(-1).decision,turn.decision);decisions++;}
 else assert.equal(records.length,0,'A missing decision must not hide a recorded native decision');
 const readCalls=events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content.filter((b:any)=>b.type==='tool-call'&&b.name==='experiment_read_packet').map((b:any)=>b.id));
 for(const id of turn.read_packet_call_ids)assert(readCalls.includes(id),'Observed read ID must exist in the native trace');
}
assert.equal(secretFound,false,'Model credential found in native evidence');
const beforePath=join(root,'service-status-before.json');
const afterPath=join(root,'service-status-after.json');
const before=JSON.parse(readFileSync(beforePath,'utf8'));
const after=JSON.parse(readFileSync(afterPath,'utf8'));
const modelRequests=report.trials.reduce((total,trial)=>total+arms.reduce((sum,arm)=>sum+trial[arm].model_requests,0),0);
const serverRequestDelta=after.total_requests-before.total_requests;
assert(serverRequestDelta>=modelRequests,'Server generation counter cannot be smaller than logged requests');
const result={stages,decoded_sessions:cache.size,matching_native_decisions:decisions,matching_native_usage:usage,matching_model_message_counts:requests,credential_scan: key ? 'completed' : 'not_requested',model_key_found:key ? false : null,model_requests:modelRequests,server_request_delta:serverRequestDelta,extra_server_requests:serverRequestDelta-modelRequests};
const output = option('--output');
if (output) writeFileSync(resolve(output), JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
