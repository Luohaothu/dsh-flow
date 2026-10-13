/** Relationship projection is deterministic and does not create runtime members. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentNodes,treeRows,visibleRows,topologyLayout,NODE_WIDTH} from '../../packages/dsh-flow/src/client/tree.ts';
import type {AgentNode} from '../../packages/dsh-flow/src/client/tree.ts';
import type {FlowTeamSnapshot} from '../../packages/dsh-flow/src/types.ts';
function node(id:string,parent_id:string|null,state:AgentNode['state']='idle'):AgentNode {
  return {id,parent_id,name:id,state,task:'task',created:0,member:id==='root'?null:{id,session_id:id,parent_id,state:'idle',team_id:'team',name:id,preset:null,active_task_id:null,error:null,created:0,updated:0}};
}
test('owner projection adds only the existing Session and uses real member parent Session ids',()=>{
  const team:FlowTeamSnapshot={run:{id:'team',owner_session_id:'root',root_task_id:'task-root',title:'Team',objective:'Goal',intent_id:'intent',workspace:'/tmp',preset:null,model:null,state:'running',version:1,deadline:null,created:0,updated:0},members:[node('child','root').member!,node('grandchild','child').member!],tasks:[],results:[],reviews:[],messages:[],events:[],usage:{responses:null,input_tokens:null,output_tokens:null,cache_read_tokens:null,total_tokens:null}};
  const before=JSON.stringify(team),nodes=agentNodes(team);
  assert.equal(nodes[0]?.id,'root');assert.equal(nodes[0]?.member,null);
  assert.deepEqual(treeRows(nodes).map(row=>[row.agent.id,row.depth]),[['root',0],['child',1],['grandchild',2]]);
  assert.equal(JSON.stringify(team),before);
});
test('folds hide descendants without losing orphan and cyclic records or inventing edges',()=>{
  const nodes=[node('root',null),node('child','root'),node('grandchild','child'),node('orphan','missing'),node('cycle-a','cycle-b'),node('cycle-b','cycle-a')];
  const rows=treeRows(nodes,new Set(['child']));
  assert.deepEqual(rows.map(row=>row.agent.id),['root','child','orphan','cycle-a','cycle-b']);
  assert.deepEqual(rows.filter(row=>row.incomplete).map(row=>row.agent.id),['orphan','cycle-a','cycle-b']);
  const layout=topologyLayout(rows);
  assert.deepEqual([...layout.parents],[['child','root']]);
  assert.equal(layout.positions.size,rows.length);
});
test('closed filter keeps the main Session and closed ancestors of live grandchildren',()=>{
  const nodes=[node('root',null,'completed'),node('child','root','closed'),node('live','child'),node('closed','root','closed')];
  const rows=treeRows(nodes);
  assert.deepEqual(visibleRows(rows,nodes,false).map(row=>row.agent.id),['root','child','live']);
  assert.equal(visibleRows(rows,nodes,true),rows);
  nodes[2]!.state='closed';
  assert.deepEqual(visibleRows(rows,nodes,false).map(row=>row.agent.id),['root']);
});
test('topology separates sibling subtrees and centers their common parent',()=>{
  const layout=topologyLayout(treeRows([node('root',null),node('a','root'),node('b','root'),node('a1','a'),node('a2','a')]));
  const root=layout.positions.get('root')!,a=layout.positions.get('a')!,b=layout.positions.get('b')!,a1=layout.positions.get('a1')!,a2=layout.positions.get('a2')!;
  assert.ok(a.x+NODE_WIDTH<b.x);assert.ok(a1.x+NODE_WIDTH<a2.x);
  assert.equal(root.x,(a1.x+b.x)/2);assert.equal(a.x,(a1.x+a2.x)/2);
  assert.ok(root.y<a.y&&a.y<a1.y);
});
