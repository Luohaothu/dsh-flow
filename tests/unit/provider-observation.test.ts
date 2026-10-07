import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TYPERT as hostContract} from '@deepseek-ai/dsh-api-session-controller/typert';
import clientContract from '@deepseek-ai/dsh-api-session-controller/remote';
import type {InvocationDescriptor} from '@deepseek-ai/dsh-typert-protocol';

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
