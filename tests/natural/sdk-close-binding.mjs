import assert from 'node:assert/strict';

function sdkProcess(source,expectedPid,expectedBirth){
  assert.ok(Array.isArray(source.processes));
  const rows=source.processes.filter(row=>row.role==='sdk');assert.equal(rows.length,1,'Exactly one SDK process original is required');
  const row=rows[0];assert.equal(row.observedState,'present');assert.equal(row.pid,expectedPid);assert.equal(row.startTimeTicks,expectedBirth);
  for(const name of['Uid','Gid']){
    const line=row.status.split('\n').find(value=>value.startsWith(name+':'));assert.ok(line);
    const ids=line.trim().split(/\s+/).slice(1);assert.equal(ids.length,4);assert.ok(ids.every(value=>value==='1000'),'SDK process must retain its nonroot identity');
  }
}

// The consumer obtains expected identity from its pinned initial native/PID
// sources. This assertion neither reads schemas nor grants closure/F6 credit.
export function assertSdkCloseBinding({expectedPid,expectedBirth,nativePeer,bridgeClosed,peerExit}){
  assert.ok(Number.isSafeInteger(expectedPid)&&expectedPid>0);assert.match(expectedBirth,/^\d+$/u);
  sdkProcess(nativePeer,expectedPid,expectedBirth);
  assert.deepEqual([bridgeClosed.sdk.pid,bridgeClosed.sdk.uid,bridgeClosed.sdk.gid],[expectedPid,1000,1000]);
  assert.equal(bridgeClosed.sdkStartTimeTicks,expectedBirth);
  sdkProcess(peerExit,expectedPid,expectedBirth);
}
