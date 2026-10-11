import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TYPERT as hostContract} from '@deepseek-ai/dsh-api-session-controller/typert';
import clientContract from '@deepseek-ai/dsh-api-session-controller/remote';
import type {InvocationDescriptor} from '@deepseek-ai/dsh-typert-protocol';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {runInNewContext} from 'node:vm';

assert.ok(hostContract&&typeof hostContract==='object'&&'invocations' in hostContract);
assert.ok(Array.isArray(hostContract.invocations));
const contracts: readonly [string,readonly InvocationDescriptor[]][]=[['host',hostContract.invocations],['client',clientContract.descriptors]];
for (const [side,invocations] of contracts) {
  test(`${side} follow codec preserves observation-only cold reading`,()=>{
    const invocation=invocations.find(item=>item.namespace==='session'&&item.method==='follow');
    assert.ok(invocation);
    const descriptor=invocation.parameters[0]!.codec;
    assert.equal(descriptor.mode,'strict');
    assert.ok('create' in descriptor);
    const codec=descriptor.create();
    const request={address:{kind:'session',sessionId:'cold-history'},assistantStream:true,observationOnly:true};
    assert.deepEqual(codec.parse(request),request);
    assert.throws(()=>codec.parse({...request,observationOnly:false}));
  });
}

test('installed api-remotes aggregate preserves command intent and cold observation',async()=>{
  const rootRequire=createRequire(import.meta.url);
  const harnessRequire=createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'));
  const webRequire=createRequire(harnessRequire.resolve('@deepseek-ai/dsh-web-app/package.json'));
  const clientPath=join(dirname(webRequire.resolve('@deepseek-ai/dsh-api-remotes/package.json')),'lib/client.js');
  let aggregate:{apply(context:unknown):Promise<()=>void>}|undefined;
  runInNewContext(readFileSync(clientPath,'utf8'),{TextEncoder,TextDecoder,window:{__ModuleLoader__:{
    load(definition:{factory(require:(id:string)=>never):typeof aggregate}){
      aggregate=definition.factory(id=>{throw new Error(`unexpected external require: ${id}`);});
    },
  }}},{filename:clientPath});
  assert.ok(aggregate);
  const contributions:{descriptors:InvocationDescriptor[]}[]=[];
  const dispose=await aggregate.apply({remote:{async $mount(contribution:{descriptors:InvocationDescriptor[]}){
    contributions.push(contribution);return ()=>{};
  }}});
  try {
    const descriptors=contributions.flatMap(item=>item.descriptors);
    const execute=descriptors.find(item=>item.namespace==='commands'&&item.method==='execute');
    assert.ok(execute);
    assert.deepEqual(Array.from(execute.parameters,item=>item.wire),['agentId','line','submittedAttachments','submissionId']);
    assert.equal(execute.scope?.context,'agent');assert.equal(execute.scope?.wire,'agentId');
    assert.equal(execute.cancellation?.parameter,'signal');
    const intent=execute.parameters[3]!.codec;assert.ok('create' in intent);
    assert.equal(execute.parameters[3]!.acceptsUndefined,true,'JSON omits an undefined command intent');
    assert.equal(intent.create().parse(undefined),undefined);
    assert.equal(intent.create().parse('intent'),'intent');
    assert.throws(()=>intent.create().parse(new AbortController().signal));
    const follow=descriptors.find(item=>item.namespace==='session'&&item.method==='follow');assert.ok(follow);
    const descriptor=follow.parameters[0]!.codec;assert.ok('create' in descriptor);
    const codec=descriptor.create();
    const request={address:{kind:'session',sessionId:'cold-history'},assistantStream:true,observationOnly:true};
    assert.deepEqual(JSON.parse(JSON.stringify(codec.parse(request))),request);
    assert.throws(()=>codec.parse({...request,observationOnly:false}));
  } finally {await dispose();}
});
