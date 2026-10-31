import assert from 'node:assert/strict';
import path from 'node:path';
import {assertContainerScope,assertContainerIdentity} from './container-identity.mjs';
import {rootOwnedFileCopy,assertRootOwnedFileReadback} from './root-owned-copy.mjs';

const canonical=value=>typeof value==='string'&&value.startsWith('/')&&path.posix.resolve(value)===value&&!/[\\\x00-\x1f\x7f]/u.test(value);
const inside=(root,file)=>{const relative=path.posix.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith('../')&&!path.posix.isAbsolute(relative);};

/** Read a Root-owned control file in the exact created container's namespace. */
export async function readCreatedContainerControlReference({scope,identity,controlDirectory,reference},{inspect,command,parseTar}) {
  const expected=structuredClone(identity),bound=structuredClone(scope),ref=structuredClone(reference),directory=controlDirectory;
  assertContainerScope(bound);assertContainerScope(expected);
  for(const key of ['caseId','namespaceId','containerId','imageId','nonce'])assert.equal(expected[key],bound[key],'Control reference identity '+key+' differs');
  assert.ok(typeof bound.nonce==='string'&&bound.nonce.length>=32,'Creation nonce required');
  assert.ok(canonical(directory)&&directory!=='/'&&canonical(ref.file));
  assert.equal(ref.trustedRoot,directory);assert.equal(path.posix.dirname(ref.file),directory,'Control reference must be a direct child of the owned control directory');
  assert.deepEqual([ref.expectedUid,ref.expectedGid,ref.allowedModes],[0,0,[0o444]]);
  assert.ok(Array.isArray(ref.forbiddenRoots)&&Array.isArray(ref.forbiddenFiles));
  for(const root of ref.forbiddenRoots){assert.ok(canonical(root));assert.equal(inside(root,ref.file),false,'Control reference is excluded');}
  for(const file of ref.forbiddenFiles){assert.ok(canonical(file));assert.notEqual(file,ref.file,'Control reference is excluded');}
  assert.equal(typeof inspect,'function');assert.equal(typeof command,'function');assert.equal(typeof parseTar,'function');
  const copy=rootOwnedFileCopy({containerId:bound.containerId,directory,fileName:path.posix.basename(ref.file),sha256:ref.expectedSha256});
  const check=value=>{
    assertContainerIdentity(expected,{id:value.Id,image:value.Image,user:value.Config.User,network:value.HostConfig.NetworkMode,privileged:value.HostConfig.Privileged,labels:value.Config.Labels});
    assert.equal(value.State.Status,'created');assert.equal(value.State.Running,false);assert.equal(value.State.Pid,0);assert.equal(value.RestartCount,0);assert.equal(value.State.OOMKilled,false);
    assert.match(value.State.StartedAt,/^0001-01-01T00:00:00(?:\.0+)?Z$/u);
  };
  const before=await inspect();check(before.value);
  const result=await command('read-created-root-control',copy.readArgs);assert.equal(result.code,0,'Created control read failed');assert.ok(Buffer.isBuffer(result.stdout));
  const raw=Buffer.from(assertRootOwnedFileReadback(parseTar(result.stdout),copy.expected).data);
  if(ref.bytes!==undefined)assert.equal(raw.length,ref.bytes);
  if(ref.maximumBytes!==undefined){assert.ok(Number.isSafeInteger(ref.maximumBytes)&&ref.maximumBytes>0);assert.ok(raw.length<=ref.maximumBytes);}
  const after=await inspect();check(after.value);
  return {raw,reference:ref,inspectionSources:[before.source,after.source],rawSources:result.refs};
}
