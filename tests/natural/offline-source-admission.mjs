import assert from 'node:assert/strict';
import {readCreatedContainerControlReference} from './container-root-reference.mjs';
import {readCanonicalUstar} from './archive-paths.mjs';

const issues=Object.freeze([42,43,45,47,49]);

/** Default offline stage: preserve the five guest admission originals in Root's store. */
export async function readOfflineSourceAdmissions(config,{inspect,command,save}) {
  assert.equal(config.schema,'root-offline-controller-barrier/v1');
  const {scope,identity,controlDirectory,references}=structuredClone({scope:config.scope,identity:config.platform.containerIdentity,controlDirectory:config.platform.control.runtime,references:issues.map(issue=>config.guestBoot['sdkSourceAdmission'+issue])});
  assert.equal(scope.accountingScope,'qualification-offline');assert.equal(typeof save,'function');
  for(let index=0;index<issues.length;index++)assert.ok(references[index],'Merged harness/source admission required: '+issues[index]);
  const readbacks=[];
  for(let index=0;index<issues.length;index++){
    const issue=issues[index],loaded=await readCreatedContainerControlReference({scope,identity,controlDirectory,reference:references[index]},{inspect,command,parseTar:readCanonicalUstar});
    const metadata=structuredClone({reference:loaded.reference,inspectionSources:loaded.inspectionSources,rawSources:loaded.rawSources});
    const source=structuredClone(await save('offline-source-admission-'+issue+'.json',Buffer.from(loaded.raw)));
    assert.ok(source&&typeof source==='object','Saved original reference required');assert.equal(source.expectedSha256,metadata.reference.expectedSha256,'Saved admission bytes differ');
    readbacks.push({issue,reference:metadata.reference,source,inspectionSources:metadata.inspectionSources,rawSources:metadata.rawSources});
  }
  return readbacks;
}
