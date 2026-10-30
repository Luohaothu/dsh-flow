import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSdkCloseBinding} from './sdk-close-binding.mjs';

// Synthetic source fields only: no actual SDK, process or UID is represented.
function fixture(){const row=()=>({role:'sdk',pid:1,startTimeTicks:'31',observedState:'present',status:'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n'});return{expectedPid:1,expectedBirth:'31',nativePeer:{processes:[row()]},bridgeClosed:{sdk:{pid:1,uid:1000,gid:1000},sdkStartTimeTicks:'31'},peerExit:{processes:[{role:'technicalBridge',pid:20,observedState:'absent'},row()]}};}
test('all close sources bind the same SDK PID/birth and return no qualification',()=>{assert.equal(assertSdkCloseBinding(fixture()),undefined);});
for(const target of['nativePeer','peerExit'])for(const [name,change]of[
  ['PID',row=>{row.pid=999;}],['birth',row=>{row.startTimeTicks='9999';}],['missing PID',row=>{delete row.pid;}],['missing birth',row=>{delete row.startTimeTicks;}],['not present',row=>{row.observedState='absent';}],['UID',row=>{row.status=row.status.replace('Uid:\t1000','Uid:\t0');}],['malformed UID',row=>{row.status='Uid:\nGid:\t1000\t1000\t1000\t1000\n';}]
])test(target+' rejects '+name,()=>{const value=fixture();change(value[target].processes.find(row=>row.role==='sdk'));assert.throws(()=>assertSdkCloseBinding(value));});
for(const target of['nativePeer','peerExit'])test(target+' cannot select one SDK row out of duplicates',()=>{const value=fixture();value[target].processes.push({...value.nativePeer.processes[0]});assert.throws(()=>assertSdkCloseBinding(value));});
for(const [name,change]of[
  ['PID',value=>{value.sdk.pid=999;}],['birth',value=>{value.sdkStartTimeTicks='9999';}],['UID',value=>{value.sdk.uid=0;}],['GID',value=>{value.sdk.gid=0;}],['missing SDK',value=>{delete value.sdk;}],['missing birth',value=>{delete value.sdkStartTimeTicks;}]
])test('bridgeClosed requires '+name,()=>{const value=fixture();change(value.bridgeClosed);assert.throws(()=>assertSdkCloseBinding(value));});
for(const [name,change]of[['missing',value=>{delete value.expectedBirth;}],['numeric birth',value=>{value.expectedBirth=31;}],['zero PID',value=>{value.expectedPid=0;}]])test('expected initial identity cannot be '+name,()=>{const value=fixture();change(value);assert.throws(()=>assertSdkCloseBinding(value));});
