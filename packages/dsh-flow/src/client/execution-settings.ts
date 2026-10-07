/** Staged execution defaults over the official Host configuration form. */
import { SettingsFormModel, type SettingsFieldSpec, type SettingsFormScope, type SettingsFieldState, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PreferenceStore } from './preferences.ts';
import type { FlowJsonValue } from '../types.ts';
function json(value:unknown):FlowJsonValue {
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return value;
  if(Array.isArray(value))return value.map(json);
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,json(item)]));
  throw new Error('Invalid execution setting value');
}

export interface ExecutionField {
  readonly key: string
  readonly label: string
  readonly path: readonly string[]
  readonly min: number
  readonly max: number
  readonly factor?: number
  readonly step?: number
  readonly mirror?: readonly string[]
  readonly hint?: string
}
export const EXECUTION_FIELDS: readonly ExecutionField[] = [
  { key:'depth',label:'最大子代理层数',path:['defaultLimits','max_depth'],min:1,max:32,hint:'总协调为第 0 层；1 层允许直接派发任务执行代理。' },
  { key:'children',label:'每个节点最多子代理',path:['defaultLimits','max_children'],min:1,max:4096 },
  { key:'agents',label:'团队代理总数上限',path:['defaultLimits','max_agents'],mirror:['defaultBudget','agents'],min:3,max:100000,hint:'包含总协调、资源协调和质量审核。' },
  { key:'minutes',label:'最长运行时间（分钟）',path:['defaultBudget','wall_time_ms'],factor:60000,min:1,max:10080 },
  { key:'active',label:'同时运行代理上限',path:['defaultLimits','max_active_agents'],mirror:['defaultBudget','max_active_agents'],min:1,max:512 },
  { key:'llm',label:'同时请求模型上限',path:['defaultLimits','max_llm_concurrency'],min:1,max:64 },
  { key:'tokens',label:'团队 Token 总预算',path:['defaultBudget','tokens'],min:1,max:2**40 },
  { key:'requests',label:'团队模型请求上限',path:['defaultBudget','model_requests'],min:1,max:2**40 },
  { key:'tools',label:'团队工具调用上限',path:['defaultBudget','tool_calls'],min:1,max:2**40 },
  { key:'output',label:'单次最大输出 Token',path:['maxTokens'],min:1,max:2**31 },
  { key:'workerOutput',label:'任务代理最大输出 Token',path:['defaultLimits','worker_max_tokens'],min:64,max:32768,step:64,hint:'填写 64 的倍数。' },
  { key:'workerRequests',label:'每个任务代理模型请求上限',path:['defaultLimits','worker_model_requests'],min:1,max:64 },
  { key:'turns',label:'管理代理轮数上限',path:['defaultLimits','max_role_turns'],min:1,max:512 },
  { key:'attempts',label:'任务尝试次数',path:['defaultLimits','max_attempts'],min:1,max:16 },
  { key:'corrections',label:'审核修正次数',path:['defaultLimits','max_corrections'],min:0,max:16 },
];
const scalarPaths = { mode:['defaultDispatchMode'], model:['defaultModel'], effort:['defaultReasoningEffort'] };
function at(value:unknown,path:readonly string[]):unknown {
  for(const part of path) { if(value===null||typeof value!=='object')return undefined;value=Reflect.get(value,part); }
  return value;
}
function project(value:unknown):Record<string,unknown> {
  const result:Record<string,unknown>={};
  for(const field of EXECUTION_FIELDS) { const found=at(value,field.path);if(found!==undefined)result[field.key]=found; }
  for(const [key,path] of Object.entries(scalarPaths)) { const found=at(value,path);if(found!==undefined)result[key]=found; }
  return result;
}
function numberSpec(field:ExecutionField):SettingsFieldSpec {
  return { field:field.key,format:value=>typeof value==='number'?String(value/(field.factor??1)):'',parse:text=>{
    if(!text.trim())return {kind:'clear'};
    const value=Number(text);
    return Number.isSafeInteger(value)&&value>=field.min&&value<=field.max&&value%(field.step??1)===0?{kind:'set',value:value*(field.factor??1)}:undefined;
  } };
}
function choiceSpec(field:string,choices:readonly string[]):SettingsFieldSpec {
  return {field,format:value=>typeof value==='string'?value:'',parse:text=>choices.includes(text)?{kind:'set',value:text}:undefined};
}
const modelSpec:SettingsFieldSpec={field:'model',format:value=>value===null?'inherit':JSON.stringify(value)??'inherit',parse:text=>{
  if(text==='inherit')return {kind:'set',value:null};
  try {const route:unknown=JSON.parse(text);const provider=at(route,['provider']),model=at(route,['model']);
    return typeof provider==='string'&&provider.trim()&&typeof model==='string'&&model.trim()?{kind:'set',value:{provider,model}}:undefined;
  }catch{return undefined;}
}};
export interface ExecutionSettingsSnapshot extends SettingsFormShell { readonly fields:Record<string,SettingsFieldState> }

/** Reuses native draft parsing, revision fences, accepted-value reconciliation and reset semantics. */
export class ExecutionSettings {
  readonly form:SettingsFormModel<Record<string,unknown>>;
  readonly store:{getSnapshot:()=>ExecutionSettingsSnapshot;subscribe:(listener:()=>void)=>()=>void};
  readonly actions;
  constructor(source:ConfigForm<Record<string,unknown>>) {
    const scope:SettingsFormScope<Record<string,unknown>>={
      getSnapshot:()=>{const state=source.getSnapshot();return {...state,value:state.value===undefined?undefined:project(state.value),base:project(state.base),user:project(state.user)};},
      subscribe:listener=>source.subscribe(listener),
      mutate:(ops,revision)=>source.mutate(ops.flatMap(op=>{
        const key=op.path[0];const field=EXECUTION_FIELDS.find(field=>field.key===key);
        const path=field?.path??Object.entries(scalarPaths).find(([name])=>name===key)?.[1];
        if(!path)throw new Error('Unknown execution setting');
        const paths=[path,...(field?.mirror?[field.mirror]:[])];
        return paths.map(path=>op.op==='unset'?{op:'unset' as const,path:[...path]}:{op:'set' as const,path:[...path],value:json(op.value)});
      }),revision),
    };
    const specs=[...EXECUTION_FIELDS.map(numberSpec),choiceSpec('mode',['parallel','serial']),choiceSpec('effort',['inherit','off','low','medium','high']),modelSpec];
    this.form=new SettingsFormModel(scope,specs);
    this.actions=this.form.actions();
    this.store=this.form.bind(():ExecutionSettingsSnapshot=>({...this.form.shell(),fields:Object.fromEntries(specs.map(spec=>[spec.field,this.form.field(spec.field)]))}));
  }
  dispose():void {this.form.dispose();}
}

/** Both sections participate in the existing provider navigation guard. */
export class SettingsCoordinator {
  constructor(readonly display:PreferenceStore,readonly execution:ExecutionSettings) {}
  getSnapshot=()=>{const d=this.display.getSnapshot(),e=this.execution.store.getSnapshot();return {...d,dirty:d.dirty||e.dirty,saving:d.saving||e.saving};};
  save=async():Promise<boolean>=>{const e=this.execution.store.getSnapshot();if(e.invalid)return false;
    if(e.dirty){await this.execution.form.save();const saved=this.execution.store.getSnapshot();if(saved.dirty||saved.failed)return false;}
    return this.display.save();
  };
  cancel=():void=>{if(this.getSnapshot().saving)return;this.display.cancel();this.execution.actions.discard();};
}
