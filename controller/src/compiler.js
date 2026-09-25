export class FlowError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export const bad=(message,status=400)=>{throw new FlowError(message,status);};
export function object(v,label='object'){if(!v||Array.isArray(v)||typeof v!=='object')bad(`Invalid ${label}`);}
export function shape(v,allowed,required=allowed){object(v);for(const k of Object.keys(v))if(!allowed.includes(k))bad(`Unknown field: ${k}`);for(const k of required)if(!Object.hasOwn(v,k))bad(`Missing field: ${k}`);}
export function safeId(v){if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v))bad('Invalid identifier');return v;}
export function integer(v,min,max,label){if(!Number.isInteger(v)||v<min||v>max)bad(`Invalid ${label}: expected ${min}..${max}`);}
export function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
function walk(v,fn,depth=0){if(depth>32)bad('JSON nesting limit exceeded');if(!v||typeof v!=='object')return;for(const [k,x] of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k))bad('Unsafe JSON property');if(x!==undefined&&typeof x==='number'&&!Number.isFinite(x))bad('Invalid number');}if(Object.hasOwn(v,'$ref')){shape(v,['$ref']);fn(v.$ref);return;}for(const x of Object.values(v))walk(x,fn,depth+1);}
export function parseRef(ref){if(typeof ref!=='string'||!/^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.output(?:\.[A-Za-z0-9_-]+)*$/.test(ref))bad('Invalid output reference');const [id,,...path]=ref.split('.');if(path.some(k=>['__proto__','prototype','constructor'].includes(k)))bad('Unsafe output reference');return {id,path};}
export function compileWorkflow(w){
 shape(w,['apiVersion','kind','metadata','spec']);if(w.apiVersion!=='flow.dsh/v1alpha1'||w.kind!=='Workflow')bad('Unsupported workflow version/kind');
 shape(w.metadata,['id','revision']);safeId(w.metadata.id);if(w.metadata.revision!==1)bad('Only revision 1 supported');shape(w.spec,['nodes','limits']);shape(w.spec.limits,['maxConcurrency','maxAttempts']);integer(w.spec.limits.maxConcurrency,1,32,'maxConcurrency');integer(w.spec.limits.maxAttempts,1,10,'maxAttempts');
 if(!Array.isArray(w.spec.nodes)||!w.spec.nodes.length||w.spec.nodes.length>256)bad('nodes must contain 1..256 entries');
 walk(w,()=>{});const map=new Map();
 for(const n of w.spec.nodes){shape(n,['id','kind','needs','tool','agent','inputs','maxAttempts'],['id','kind','needs']);safeId(n.id);if(map.has(n.id))bad('Duplicate node id');if(!Array.isArray(n.needs)||n.needs.length>256||new Set(n.needs).size!==n.needs.length)bad('Invalid dependencies');n.needs.forEach(safeId);if(n.inputs!==undefined)object(n.inputs,'inputs');if(n.maxAttempts!==undefined)integer(n.maxAttempts,1,w.spec.limits.maxAttempts,'node maxAttempts');
 if(n.kind==='tool'){if(n.agent!==undefined)bad('Tool cannot contain agent');shape(n.tool,['name','args']);if(!['echo','sum','fail'].includes(n.tool.name))bad('Unknown tool capability');object(n.tool.args,'tool args');}
 else if(n.kind==='agent'){if(n.tool!==undefined)bad('Agent cannot contain tool');shape(n.agent,['objective']);if(typeof n.agent.objective!=='string'||!n.agent.objective.trim()||n.agent.objective.length>32768)bad('Invalid agent objective');}
 else bad('Unknown node kind');map.set(n.id,n);}
 const order=[],visiting=new Set(),done=new Set(),ancestors=new Map();
 function visit(id){if(done.has(id))return;if(visiting.has(id))bad('Dependency cycle');const n=map.get(id);if(!n)bad(`Unknown dependency: ${id}`);visiting.add(id);const all=new Set();for(const d of n.needs){visit(d);all.add(d);for(const a of ancestors.get(d))all.add(a);}ancestors.set(id,all);visiting.delete(id);done.add(id);order.push(id);}
 for(const id of map.keys())visit(id);
 for(const n of map.values())walk(n,ref=>{const {id}=parseRef(ref);if(!ancestors.get(n.id).has(id))bad('Output reference must target a dependency ancestor');});
 return {apiVersion:'flow.ir/v1alpha1',workflowId:w.metadata.id,revision:1,limits:{...w.spec.limits},nodes:order.map(id=>({...structuredClone(map.get(id)),maxAttempts:map.get(id).maxAttempts??w.spec.limits.maxAttempts}))};
}
export function resolveNode(node,states){function resolve(v){if(!v||typeof v!=='object')return v;if(Object.hasOwn(v,'$ref')){const {id,path}=parseRef(v.$ref);let out=states.find(n=>n.id===id)?.output;for(const k of path){if(out===null||typeof out!=='object'||!Object.hasOwn(out,k))bad(`Unresolved reference: ${v.$ref}`,409);out=out[k];}if(out===undefined)bad(`Unresolved reference: ${v.$ref}`,409);return structuredClone(out);}if(Array.isArray(v))return v.map(resolve);return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)]));}return resolve(node);}
