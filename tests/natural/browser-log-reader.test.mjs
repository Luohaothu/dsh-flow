import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readPinnedBrowserLog} from './browser-log-reader.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
// Real filesystem controls use the actual caller UID/GID. They deliberately do
// not impersonate Linux Root0 or establish browser/process runtime provenance.
function fixture(t,{stdout=Buffer.alloc(0),stderr=Buffer.alloc(0)}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'natural-browser-log-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const owner={uid:process.getuid(),gid:process.getgid()},reference=(name,raw)=>{const file=path.join(root,name);fs.writeFileSync(file,raw,{mode:0o600});return{file,trustedRoot:root,expectedUid:owner.uid,expectedGid:owner.gid,expectedSha256:sha(raw),allowedModes:[0o600],ownerOnlyAncestors:true,forbiddenRoots:[],forbiddenFiles:[]};};
  const stdoutRef=reference('browser.stdout',stdout),stderrRef=reference('browser.stderr',stderr),value={schema:'root-wave02-owned-browser-closed/v1',stdoutRef,stderrRef},closedSource=reference('closed.json',Buffer.from(JSON.stringify(value)));
  const rewrite=()=>{const raw=Buffer.from(JSON.stringify(value));fs.writeFileSync(closedSource.file,raw);closedSource.expectedSha256=sha(raw);};
  return{root,owner,reference,stdoutRef,stderrRef,value,closedSource,rewrite,read:(stream,options={})=>readPinnedBrowserLog({closedSource,stream},{expectedOwner:owner,...options})};
}
for(const [name,stdout,stderr]of[['both empty',Buffer.alloc(0),Buffer.alloc(0)],['only stdout empty',Buffer.alloc(0),Buffer.from('diagnostic\n')],['only stderr empty',Buffer.from('output\n'),Buffer.alloc(0)],['both nonempty',Buffer.from('output\n'),Buffer.from('diagnostic\n')]])test('preserve exact raw bytes/SHA: '+name,t=>{const f=fixture(t,{stdout,stderr});for(const[stream,expected]of[['stdout',stdout],['stderr',stderr]]){const result=f.read(stream);assert.deepEqual(result.raw,expected);assert.equal(result.receipt.bytes,expected.length);assert.equal(result.receipt.sha256,sha(expected));assert.equal(result.receipt.role,'owned-browser-'+stream);assert.equal(result.receipt.closedSourceSha256,f.closedSource.expectedSha256);}});
test('production Root0 default is distinct from self-UID file controls',t=>{const f=fixture(t);const wrong={...f.closedSource,expectedUid:1,expectedGid:1};assert.throws(()=>readPinnedBrowserLog({closedSource:wrong,stream:'stdout'}),/owner policy/);if(f.owner.uid!==0||f.owner.gid!==0)assert.throws(()=>readPinnedBrowserLog({closedSource:f.closedSource,stream:'stdout'}),/owner policy/);});
for(const stream of['json','sdk','snapshot',''])test('empty allowance is unavailable to role '+JSON.stringify(stream),t=>{const f=fixture(t);assert.throws(()=>f.read(stream),/Only browser/);});
test('empty JSON close descriptor remains forbidden',t=>{const f=fixture(t);fs.writeFileSync(f.closedSource.file,Buffer.alloc(0));f.closedSource.expectedSha256=sha(Buffer.alloc(0));assert.throws(()=>f.read('stdout'),/Non-log original/);});
test('another nonempty JSON role cannot authorize an empty leaf',t=>{const f=fixture(t);f.value.schema='some-other-json/v1';f.rewrite();assert.throws(()=>f.read('stdout'));});
for(const key of['expectedUid','expectedGid'])test('wrong '+key+' is rejected',t=>{const f=fixture(t);f.value.stdoutRef[key]++;f.rewrite();assert.throws(()=>f.read('stdout'));});
test('declared nonprivate mode is rejected',t=>{const f=fixture(t);f.value.stdoutRef.allowedModes=[0o644];f.rewrite();assert.throws(()=>f.read('stdout'));});
test('actual nonprivate log mode is rejected',t=>{const f=fixture(t);fs.chmodSync(f.stdoutRef.file,0o644);assert.throws(()=>f.read('stdout'));});
test('actual nonprivate parent is rejected',t=>{const f=fixture(t);fs.chmodSync(f.root,0o755);assert.throws(()=>f.read('stdout'));});
test('soft link cannot substitute the original raw leaf',t=>{const f=fixture(t);const link=path.join(f.root,'linked.stdout');fs.symlinkSync(f.stdoutRef.file,link);f.value.stdoutRef.file=link;f.rewrite();assert.throws(()=>f.read('stdout'));});
test('hard linked leaf is rejected even with the correct SHA',t=>{const f=fixture(t);fs.linkSync(f.stdoutRef.file,path.join(f.root,'alias.stdout'));assert.throws(()=>f.read('stdout'));});
test('forbidden path and inode boundaries are retained',t=>{const f=fixture(t);f.value.stdoutRef.forbiddenFiles=[f.stdoutRef.file];f.rewrite();assert.throws(()=>f.read('stdout'));f.value.stdoutRef.forbiddenFiles=[];f.value.stdoutRef.forbiddenRoots=[f.root];f.rewrite();assert.throws(()=>f.read('stdout'));});
test('filesystem root forbids every descendant log original',t=>{const f=fixture(t);f.value.stdoutRef.forbiddenRoots=[path.parse(f.root).root];f.rewrite();assert.throws(()=>f.read('stdout'),/Candidate boundary overlaps log/);});
test('forbidden inode is rejected through an alias without hard-linking the log',t=>{const f=fixture(t),alias=path.join(f.root,'forbidden-alias');fs.symlinkSync(f.stdoutRef.file,alias);f.value.stdoutRef.forbiddenFiles=[alias];f.rewrite();assert.throws(()=>f.read('stdout'),/Forbidden inode alias/);});
for(const key of['uid','gid'])test('synthetic foreign actual '+key+' metadata fails after opening',t=>{const f=fixture(t),filesystem={...fs,fstatSync(fd){const row=fs.fstatSync(fd);row[key]++;return row;}};assert.throws(()=>f.read('stdout',{filesystem}));});
test('failed pinned read still closes the owned file descriptor',t=>{const f=fixture(t),opened=new Set(),closed=new Set(),filesystem={...fs,openSync(...args){const fd=fs.openSync(...args);opened.add(fd);return fd;},closeSync(fd){closed.add(fd);return fs.closeSync(fd);}};f.value.stdoutRef.expectedSha256='a'.repeat(64);f.rewrite();assert.throws(()=>f.read('stdout',{filesystem}));assert.deepEqual(closed,opened);});
test('missing explicit forbidden boundaries are rejected',t=>{const f=fixture(t);delete f.value.stdoutRef.forbiddenFiles;f.rewrite();assert.throws(()=>f.read('stdout'));});
test('changed raw bytes do not pass a pinned empty SHA',t=>{const f=fixture(t);fs.writeFileSync(f.stdoutRef.file,'changed');assert.throws(()=>f.read('stdout'));});
test('same-fd read detects an actual file mutation',t=>{const f=fixture(t),opened=new Map(),filesystem={...fs,openSync(file,...args){const fd=fs.openSync(file,...args);opened.set(fd,file);return fd;},readFileSync(fd,...args){const raw=fs.readFileSync(fd,...args);if(opened.get(fd)===f.stdoutRef.file)fs.writeFileSync(f.stdoutRef.file,'changed-during-read');return raw;}};assert.throws(()=>f.read('stdout',{filesystem}),/changed while reading/);});
test('path replacement after reading cannot reuse the pinned descriptor',t=>{const f=fixture(t),opened=new Map(),filesystem={...fs,openSync(file,...args){const fd=fs.openSync(file,...args);opened.set(fd,file);return fd;},readFileSync(fd,...args){const raw=fs.readFileSync(fd,...args);if(opened.get(fd)===f.stdoutRef.file){fs.renameSync(f.stdoutRef.file,f.stdoutRef.file+'.old');fs.writeFileSync(f.stdoutRef.file,Buffer.alloc(0),{mode:0o600});}return raw;}};assert.throws(()=>f.read('stdout',{filesystem}));});
test('noncanonical path cannot enter the log allowance',t=>{const f=fixture(t);f.value.stdoutRef.file=f.root+'/./browser.stdout';f.rewrite();assert.throws(()=>f.read('stdout'));});
test('stdout and stderr must remain two distinct raw originals',t=>{const f=fixture(t);f.value.stderrRef=f.value.stdoutRef;f.rewrite();assert.throws(()=>f.read('stdout'));});
