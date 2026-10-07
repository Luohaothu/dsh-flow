import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** Execute the installed provider classification rather than a copied model. */
function messageProbe() {
  const require = createRequire(new URL('../../packages/dsh-flow/package.json', import.meta.url));
  const file = join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-chat/package.json')), 'lib/client.js');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let definition = '';
  const independent: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'messageDefinition') definition = node.initializer.getText(source);
      if (['TURN_PROCESS_INDEPENDENT_KINDS', 'INDEPENDENT'].includes(node.name.text)) independent.push(node.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(definition);
  assert.equal(independent.length, 2);
  for (const expression of independent) assert.equal(runInNewContext(expression).has('communication'), true);
  const probe: { classify(source: object, nextStep: boolean): string } = runInNewContext(`
    const isAppendSurfaceEvent=()=>true,isCompactionCheckpoint=()=>false;
    const contextMessage=(event,message)=>({kind:'context',seq:event.seq,source:message.source,content:message.content});
    const chatNode=(_context,kind)=>kind;
    const definition=${definition};
    ({classify(source,nextStep){
      const event={type:'user/message',seq:10,time:100,data:{id:'message',source,content:[]}};
      const match={event,location:{kind:'step',turn:{start:{seq:2}},step:{step:1}}};
      const reader={previous(name){return {state:{currentClaimed:new Set((name==='inbox-next-step')===nextStep?['message']:[]),claimSeq:3,claimedHuman:false}};}};
      const state=definition.start({},match,reader);
      return definition.buildViewNode({state,start:{event}});
    }})
  `);
  return probe;
}

test('native Chat renders the first task as user and classified communication outside process groups', () => {
  const probe = messageProbe();
  assert.equal(probe.classify({ kind: 'user' }, false), 'user');
  assert.equal(probe.classify({ kind: 'user' }, true), 'steering', 'ordinary human steering stays native');
  assert.equal(probe.classify({ kind: 'flow-message', presentation: 'communication', category: 'review_feedback' }, true), 'communication');
  assert.equal(probe.classify({ kind: 'flow-message', presentation: 'communication' }, false), 'communication', 'the hint also wins over a waking trigger');
  assert.equal(probe.classify({ kind: 'flow' }, false), 'turn-trigger', 'other producer notifications retain native presentation');
});
