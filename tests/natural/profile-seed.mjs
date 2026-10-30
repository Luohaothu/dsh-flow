import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {serialize,deserialize} from 'node:v8';
import {isCanonicalAbsolutePath} from './archive-paths.mjs';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const token=value=>typeof value==='string'&&value!=='.'&&value!=='..'&&/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value);
// Root prepare/install use the same canonical module and live plan object.
// Keep an unexposed copy before the caller can alter files or rehash declarations.
const retainedSeeds=new WeakMap();
const workspaceRaw=Buffer.from('packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
function sourceFor(file,source,modes=[0o444,0o644]) {
  assert.ok(isCanonicalAbsolutePath(file)&&source,'Explicit anchor and source required');
  assert.equal(source.file,file,'Anchor source belongs to another file');
  assert.deepEqual([source.expectedUid,source.expectedGid],[0,0]);
  assert.match(source.expectedSha256,/^[a-f0-9]{64}$/u);
  assert.ok(isCanonicalAbsolutePath(source.trustedRoot));
  const relative=path.posix.relative(source.trustedRoot,file);assert.ok(relative&&relative!=='..'&&!relative.startsWith('../')&&!path.posix.isAbsolute(relative));
  assert.ok(Array.isArray(source.allowedModes)&&source.allowedModes.length>0&&source.allowedModes.every(mode=>modes.includes(mode)));
  assert.ok(Array.isArray(source.forbiddenRoots)&&Array.isArray(source.forbiddenFiles));
  return structuredClone(source);
}
function validateSeed(plan){
  assert.deepEqual(plan.directories,['profiles','profiles/'+plan.profileName]);
  assert.deepEqual(plan.directoryOwner,{uid:1000,gid:1000,mode:0o700});
  assert.equal(plan.files.length,3,'Exact three-file seed required');assert.equal(new Set(plan.files.map(row=>row.relative)).size,3,'Duplicate seed member');
  const expected=[['profile-package','package.json',1000,0o600],['primary-working-patch','cordis.patch.yml',0,0o444],['workspace-definition','pnpm-workspace.yaml',1000,0o600]];
  for(const[index,[role,name,uid,mode]]of expected.entries()){
    const row=plan.files[index],relative='profiles/'+plan.profileName+'/'+name;
    assert.equal(row.relative,relative);assert.equal(row.role,role);assert.equal(row.file,plan.profileRoot+'/'+relative);assert.equal(row.guestFile,plan.guestProfileRoot+'/'+relative);
    assert.ok(row.relative&&!path.posix.isAbsolute(row.relative)&&!row.relative.split('/').some(part=>part==='.'||part==='..'||!part));assert.ok(!row.relative.includes('node_modules'),'Seed cannot contain node_modules');
    assert.ok(isCanonicalAbsolutePath(row.file)&&isCanonicalAbsolutePath(row.guestFile));
    assert.deepEqual([row.uid,row.gid,row.mode],[uid,uid,mode]);assert.ok(Buffer.isBuffer(row.raw)&&row.raw.length>0);assert.equal(row.bytes,row.raw.length);assert.equal(row.sha256,sha(row.raw));
  }
  const primary=plan.files[1],reference=plan.primaryPatchSource?.rootReference;assert.ok(reference,'Independent Root primary input source required');sourceFor(reference.file,reference,[0o444,0o600,0o644]);assert.equal(primary.sha256,plan.primaryPatchSource.sha256);assert.equal(primary.sha256,reference.expectedSha256,'Working seed differs from Root initial pin');
  for(const root of[plan.profileRoot,plan.guestProfileRoot]){const relative=path.posix.relative(root,reference.file);assert.ok(relative==='..'||relative.startsWith('../')||path.posix.isAbsolute(relative),'Root original must be outside the replaceable profile');}
  assert.deepEqual(plan.files[2].raw,workspaceRaw);
}
export function prepareFreshProfileSeed({caseId,imageId,profileName,profileRoot,guestProfileRoot,installationAnchor,installationAnchorSource,installationLookupAnchor,installationLookupAnchorSource,sdkOwningSources,primaryPatchRaw,primaryPatchSource}) {
  assert.ok(token(caseId)&&token(profileName));assert.match(imageId,/^sha256:[a-f0-9]{64}$/u);
  assert.ok(isCanonicalAbsolutePath(profileRoot)&&isCanonicalAbsolutePath(guestProfileRoot));
  const sdkSource=sourceFor(installationAnchor,installationAnchorSource),lookupSource=sourceFor(installationLookupAnchor,installationLookupAnchorSource);
  assert.ok(Buffer.isBuffer(primaryPatchRaw)&&primaryPatchRaw.length>0);assert.equal(primaryPatchSource?.sha256,sha(primaryPatchRaw),'Root frozen primary patch bytes required');
  for(const name of['profileBoot','appBoot']){const pin=sdkOwningSources?.[name];assert.ok(pin&&isCanonicalAbsolutePath(pin.path),'Actual image source path required');assert.match(pin.sha256,/^[a-f0-9]{64}$/u);}
  const profileDirectory=guestProfileRoot+'/profiles/'+profileName,packageFile=profileDirectory+'/package.json',lookupDirectory=path.posix.dirname(installationLookupAnchor);
  assert.ok(createRequire(packageFile).resolve.paths('dsh-flow').includes(lookupDirectory+'/node_modules'),'File-only profile must naturally resolve the workspace installation packages');
  assert.ok(!guestProfileRoot.startsWith(lookupDirectory+'/node_modules/'));
  const files=[
    {role:'profile-package',relative:'profiles/'+profileName+'/package.json',raw:Buffer.from(JSON.stringify({name:'dsh-profile-'+profileName,private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}},null,2)+'\n')},
    {role:'primary-working-patch',relative:'profiles/'+profileName+'/cordis.patch.yml',raw:Buffer.from(primaryPatchRaw)},
    {role:'workspace-definition',relative:'profiles/'+profileName+'/pnpm-workspace.yaml',raw:Buffer.from(workspaceRaw)},
  ].map(row=>({...row,file:profileRoot+'/'+row.relative,guestFile:guestProfileRoot+'/'+row.relative,uid:row.relative.endsWith('/cordis.patch.yml')?0:1000,gid:row.relative.endsWith('/cordis.patch.yml')?0:1000,mode:row.relative.endsWith('/cordis.patch.yml')?0o444:0o600,bytes:row.raw.length,sha256:sha(row.raw)}));
  const plan={schema:'root-wave02-fresh-profile-seed/v2',caseId,imageId,profileName,profileRoot,guestProfileRoot,installationAnchor,installationAnchorSource:sdkSource,installationLookupAnchor,installationLookupAnchorSource:lookupSource,sdkOwningSources:structuredClone(sdkOwningSources),primaryPatchSource:structuredClone(primaryPatchSource),files,directories:['profiles','profiles/'+profileName],directoryOwner:{uid:1000,gid:1000,mode:0o700},noNodeModulesOrLinks:true,actualInstalled:false};
  validateSeed(plan);retainedSeeds.set(plan,serialize(plan));return plan;
}
export function installFreshProfileSeed(plan,{platform=process.platform,uid=process.getuid(),gid=process.getgid(),save,filesystem=fs}={}) {
  assert.equal(platform,'linux');assert.deepEqual([uid,gid],[0,0]);assert.equal(plan.schema,'root-wave02-fresh-profile-seed/v2');assert.equal(typeof save,'function');
  const original=retainedSeeds.get(plan);assert.ok(original,'No retained Root seed input in this module');assert.deepEqual(serialize(plan),original,'Prepared seed changed after Root input capture');
  // Use only the private original after comparison, including during filesystem callbacks.
  plan=deserialize(original);validateSeed(plan);
  sourceFor(plan.installationAnchor,plan.installationAnchorSource);sourceFor(plan.installationLookupAnchor,plan.installationLookupAnchorSource);
  const root=filesystem.lstatSync(plan.profileRoot);assert.ok(root.isDirectory()&&!root.isSymbolicLink());assert.equal(filesystem.realpathSync(plan.profileRoot),plan.profileRoot);assert.deepEqual([root.uid,root.gid,root.mode&0o777],[1000,1000,0o700]);
  assert.equal(filesystem.readdirSync(plan.profileRoot).length,0,'Fresh profile volume must be empty');
  for(const relative of plan.directories){assert.ok(relative&&!relative.split('/').some(part=>part==='.'||part==='..'||!part)&&!path.posix.isAbsolute(relative));const file=plan.profileRoot+'/'+relative;filesystem.mkdirSync(file,{mode:0o700});filesystem.chownSync(file,1000,1000);filesystem.chmodSync(file,0o700);}
  const after=[];
  for(const row of plan.files){assert.equal(row.file,plan.profileRoot+'/'+row.relative);assert.ok(row.relative&&!row.relative.split('/').some(part=>part==='.'||part==='..'||!part));assert.ok(!row.relative.includes('node_modules'));assert.equal(row.sha256,sha(row.raw));assert.equal(row.bytes,row.raw.length);assert.deepEqual([row.uid,row.gid,row.mode],row.relative.endsWith('/cordis.patch.yml')?[0,0,0o444]:[1000,1000,0o600]);
    const fd=filesystem.openSync(row.file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,row.mode);
    try{filesystem.writeFileSync(fd,row.raw);filesystem.fchownSync(fd,row.uid,row.gid);filesystem.fchmodSync(fd,row.mode);filesystem.fsyncSync(fd);}finally{filesystem.closeSync(fd);}
    const stat=filesystem.lstatSync(row.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.deepEqual([stat.uid,stat.gid,stat.mode&0o777,stat.nlink],[row.uid,row.gid,row.mode,1]);const raw=filesystem.readFileSync(row.file);assert.equal(sha(raw),row.sha256);after.push({file:row.file,guestFile:row.guestFile,uid:stat.uid,gid:stat.gid,mode:stat.mode&0o777,dev:stat.dev,ino:stat.ino,bytes:raw.length,sha256:sha(raw)});
  }
  return save('profile-seed-root-stat.json',{schema:'root-wave02-profile-seed-install-readback/v2',caseId:plan.caseId,imageId:plan.imageId,installationAnchor:plan.installationAnchor,installationAnchorSource:plan.installationAnchorSource,installationLookupAnchor:plan.installationLookupAnchor,installationLookupAnchorSource:plan.installationLookupAnchorSource,sourcePins:plan.sdkOwningSources,files:after,primaryInput:{rootSource:plan.primaryPatchSource.rootReference,sha256:plan.primaryPatchSource.sha256,workingGuestFile:plan.files[1].guestFile,workingRootFile:plan.files[1].file,initialReadbackOnly:true,sdkSettingsMayAtomicallyReplaceWorkingCopy:true,workingParentOwner:plan.directoryOwner},guestSameSourceReadback:null,profileOwnerResolution:null,actualSdkQualified:false});
}
