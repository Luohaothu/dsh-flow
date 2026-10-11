import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('installed rc2 provider bytes match the recorded extension baseline',()=>{
  const root=fileURLToPath(new URL('../..',import.meta.url));
  const require=createRequire(join(root,'package.json'));
  const cliRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
  const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const baseline=JSON.parse(readFileSync(join(root,'docs/design/development/provider-baseline.json'),'utf8')) as {
    baseline:string;extensions:number;records:{name:string;version:string;patch:string|null;patch_sha256:string|null;package_json_sha256:string;entries:Record<string,string>}[];
  };
  assert.equal(baseline.baseline,'0.2.0-rc.2');
  assert.equal(baseline.extensions,14);
  assert.equal(baseline.records.filter(record=>record.patch).length,14);
  const workspace=readFileSync(join(root,'pnpm-workspace.yaml'),'utf8');
  const lockfile=readFileSync(join(root,'pnpm-lock.yaml'),'utf8');
  for(const record of baseline.records){
    const manifest=cliRequire.resolve(`${record.name}/package.json`);
    assert.equal(JSON.parse(readFileSync(manifest,'utf8')).version,record.version,record.name);
    assert.equal(record.version,baseline.baseline,record.name);
    assert.equal(hash(manifest),record.package_json_sha256,record.name);
    if(record.patch){
      assert.equal(hash(join(root,record.patch)),record.patch_sha256,record.patch);
      assert(workspace.includes(`'${record.name}@${record.version}': ${record.patch}`));
      assert(lockfile.includes(`'${record.name}@${record.version}': ${record.patch_sha256}`));
    }
    for(const [file,digest] of Object.entries(record.entries))assert.equal(hash(join(dirname(manifest),file)),digest,`${record.name}/${file}`);
  }
  for(const retired of ['dsh-api-gateway','dsh-session-format-v3-to-v4']){
    assert.equal(baseline.records.find(record=>record.name===`@deepseek-ai/${retired}`)?.patch,null);
  }
});
