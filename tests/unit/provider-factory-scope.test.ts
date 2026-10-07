import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Execute the installed provider's actual outlet and identity allocator. The
// surrounding React/slot seats are inert so this regression has no browser.
function factoryProbe() {
  const require=createRequire(new URL('../../packages/dsh-flow/package.json',import.meta.url));
  const root=dirname(require.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json'));
  const source=ts.createSourceFile('client.js',readFileSync(join(root,'lib/client.js'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const declarations=new Map<string,string>();
  const visit=(node:ts.Node):void=>{
    if(ts.isFunctionDeclaration(node)&&node.name&&['FactoryOutlet','sessionGenerationKeyOf'].includes(node.name.text)) declarations.set(node.name.text,node.getText(source));
    if(ts.isVariableStatement(node)) for(const item of node.declarationList.declarations) {
      if(ts.isIdentifier(item.name)&&['nextSessionGenerationKey','sessionGenerationKeys'].includes(item.name.text)) declarations.set(item.name.text,node.getText(source));
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
  assert.equal(declarations.size,4);
  interface Binding {key?:string;ctx?:object}
  interface Probe {
    render(scope:'root'|'session'|'session-maybe',binding:Binding,ancestors?:ReadonlySet<string>):ReadonlySet<string>;
  }
  const probe:Probe=runInNewContext(`
    let scope, binding, ancestors;
    const EMPTY_FACTORY_SELECTION = {};
    const FactoryAncestryContext = {Provider:'ancestry'};
    const FactoryErrorBoundary='boundary',FactoryOccurrence='occurrence';
    const react={useContext:()=>ancestors,useSyncExternalStore:(_subscribe,read)=>read()};
    const react_jsx_runtime={Fragment:'fragment',jsx:(type,props)=>({type,props})};
    const _deepseek_ai_dsh_client_ui_slots={SlotOwnershipError:Error};
    const useHost=()=>({getFactoryVersion:()=>1,factoryOf:()=>({scope})});
    const useScopeBinding=()=>binding;
    const useMaybeIncarnation=()=>0;
    ${Array.from(declarations.values()).join('\n')}
    ({render(nextScope,nextBinding,nextAncestors=new Set()){
      scope=nextScope;binding=nextBinding;ancestors=nextAncestors;
      return FactoryOutlet({name:'conversation.content',inputProps:{},caller:{}}).props.children.props.value;
    }})
  `);
  return probe;
}

test('the official Conversation factory nests across Session identities and rejects cycles back to an ancestor',()=>{
  const probe=factoryProbe();
  const parent={key:'main',ctx:{}},child={key:'coordinator',ctx:{}};
  const ancestry=probe.render('session-maybe',parent);
  const nested=probe.render('session-maybe',child,ancestry);
  assert.equal(nested.size,2);
  assert.throws(()=>probe.render('session-maybe',parent,nested),/recursive render/);
  assert.throws(()=>probe.render('session-maybe',child,nested),/recursive render/);
  // Different wrappers retaining the same Session still share its generation.
  assert.throws(()=>probe.render('session-maybe',{...child},nested),/recursive render/);
});

test('root and absent Session factories retain their original recursion guard',()=>{
  const probe=factoryProbe();
  const ancestry=probe.render('root',{key:'main',ctx:{}});
  assert.throws(()=>probe.render('root',{key:'child',ctx:{}},ancestry),/recursive render/);
  const absent=probe.render('session-maybe',{});
  assert.throws(()=>probe.render('session-maybe',{},absent),/recursive render/);
});
