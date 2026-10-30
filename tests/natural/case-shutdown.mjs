import assert from 'node:assert/strict';

// The caller stops admission first. Native stop must finish before a model
// channel can close. null is an explicit never-started owner path, not a claim
// that a prepared SDK or an uncreated driver has no live resources.
export async function closeCaseInOrder({stopDriver,closeChannel}){
  assert.ok(stopDriver===null||typeof stopDriver==='function','Native stop or explicit never-started path required');
  assert.equal(typeof closeChannel,'function');
  const neverStarted=stopDriver===null;
  const nativeStopReceipt=neverStarted?{status:'never-started',nativeQualification:false}:await stopDriver();
  if(!neverStarted)assert.ok(nativeStopReceipt&&['completed','not-started'].includes(nativeStopReceipt.status),'Native stop remains pending or incomplete');
  const channelCloseReceipt=await closeChannel();
  assert.ok(channelCloseReceipt&&typeof channelCloseReceipt==='object','Explicit channel closure required');
  assert.equal(channelCloseReceipt.schema,'root-staged-model-socket/v1');
  assert.equal(channelCloseReceipt.state,'closed','Channel close remains pending or failed');
  assert.equal(channelCloseReceipt.normalClosure,true,'Channel closure was not normal');
  assert.notEqual(channelCloseReceipt.closed,false,'Contradictory channel closure');
  assert.ok(!Object.hasOwn(channelCloseReceipt,'status')||channelCloseReceipt.status==='closed','Contradictory channel status');
  return{nativeStopReceipt,channelCloseReceipt,gatewayClosed:true,neverStarted};
}
