/** Display fields inside the provider-owned plugin details page. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Modal, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PreferenceNavigation } from './navigation.ts';
import type { PreferenceStore } from './preferences.ts';
import { EXECUTION_FIELDS, type ExecutionSettings, type SettingsCoordinator } from './execution-settings.ts';

export function SettingsPage({store,execution,settings,catalog,view,onLeave,guard}: {store:PreferenceStore;execution:ExecutionSettings;settings:SettingsCoordinator;catalog:()=>Promise<{value:string;label:string}[]>;view:'summary'|'page';onLeave:()=>void;guard:(active:boolean)=>()=>void}) {
  const state = useSyncExternalStore(store.subscribe,store.getSnapshot);
  const exec = useSyncExternalStore(execution.store.subscribe,execution.store.getSnapshot);
  const [models,setModels]=useState<{value:string;label:string}[]>([]),[catalogError,setCatalogError]=useState(false);
  useEffect(()=>{let active=true;if(view==='page')void catalog().then(value=>{if(active){setModels(value);setCatalogError(false);}},()=>{if(active)setCatalogError(true);});return()=>{active=false;};},[catalog,view]);
  useEffect(()=>guard(view==='page'),[guard,view]);
  useEffect(()=> {
    const guard = (event: BeforeUnloadEvent) => { if (settings.getSnapshot().dirty || settings.getSnapshot().saving) {event.preventDefault();event.returnValue='';} };
    window.addEventListener('beforeunload',guard);
    return ()=>window.removeEventListener('beforeunload',guard);
  },[settings]);
  if (view==='summary') return <>智能体团队</>;
  const value = state.draft;
  const disabled=!exec.writable||exec.saving||state.saving;
  const field=(key:string)=>exec.fields[key]!;
  const numeric=(key:string)=>{const spec=EXECUTION_FIELDS.find(spec=>spec.key===key)!;return <SettingsValueField key={key} id={`flow-default-${key}`} label={spec.label} numeric {...field(key)} disabled={disabled} {...(spec.hint?{hint:spec.hint}:{})} overriddenLabel="已自定义" resetLabel="恢复默认" invalidLabel={`请输入 ${spec.min}–${spec.max} 的整数`} onEdit={text=>execution.actions.edit(key,text)} onReset={()=>execution.actions.resetField(key)}/>;};
  const mode=field('mode').text;
  return <section className="flow-settings">
    <SettingsForm labels={{unavailable:'执行设置暂不可用',readOnly:'当前实例设置为只读',saveFailed:'保存失败，更改已保留',save:'保存',saving:'正在保存…'}} state={{...exec,dirty:exec.dirty||state.dirty,saving:exec.saving||state.saving,failed:exec.failed||!!state.error}} onSave={()=>void settings.save()} onDiscard={settings.cancel}>
    <fieldset disabled={disabled}><legend>团队默认值</legend><small>用于之后新建的团队。</small>
      <div className="flow-settings-grid">{['depth','children','agents','minutes'].map(numeric)}</div>
      <label>子代理派发模式<select aria-label="子代理派发模式" value={mode} onChange={e=>execution.actions.edit('mode',e.target.value)}><option value="parallel">并行</option><option value="serial">串行</option></select></label>
      {mode==='parallel'?<div className="flow-settings-grid">{['active','llm'].map(numeric)}</div>:<small>每次运行一个代理，由宿主执行模型请求。</small>}
    </fieldset>
    <fieldset disabled={disabled}><legend>模型与用量</legend>
      <label>团队默认模型<select aria-label="团队默认模型" value={field('model').text} onChange={e=>execution.actions.edit('model',e.target.value)}><option value="inherit">跟随主会话</option>{models.map(model=><option key={model.value} value={model.value}>{model.label}</option>)}{field('model').text!=='inherit'&&!models.some(model=>model.value===field('model').text)&&<option value={field('model').text}>已保存的模型（当前不可用）</option>}</select></label>
      {catalogError&&<small role="status">模型目录加载失败。<Button size="sm" onClick={()=>void catalog().then(value=>{setModels(value);setCatalogError(false);},()=>setCatalogError(true))}>重试</Button></small>}
      <label>推理等级<select aria-label="团队推理等级" value={field('effort').text} onChange={e=>execution.actions.edit('effort',e.target.value)}><option value="inherit">跟随主会话</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      <div className="flow-settings-grid">{['tools'].map(numeric)}</div>
    </fieldset>
    <details className="flow-settings-advanced"><summary>更多执行限制</summary><div className="flow-settings-grid">{['turns','attempts','corrections'].map(numeric)}</div></details>
    {state.readError && <p role="status">设置读取失败：{state.readError}。当前为临时默认值。<Button onClick={()=>void store.save()}>保存临时默认值</Button></p>}
    <fieldset disabled={disabled}><legend>显示方式</legend>
      <label>默认团队视图<select aria-label="默认团队视图" value={value.view} onChange={e=>store.edit('view',e.target.value==='list'?'list':'graph')}><option value="graph">拓扑图</option><option value="list">列表</option></select></label>
      <label>已结束节点<select aria-label="已结束节点" value={value.ended} onChange={e=>store.edit('ended',e.target.value==='show'?'show':'collapse')}><option value="show">显示</option><option value="collapse">折叠</option></select></label>
      <label>动态效果<select aria-label="动态效果" value={value.motion} onChange={e=>store.edit('motion',e.target.value==='reduce'?'reduce':'system')}><option value="system">跟随系统</option><option value="reduce">减少</option></select></label>
      <label>用量显示<select aria-label="用量显示" value={value.tokens} onChange={e=>store.edit('tokens',e.target.value==='exact'?'exact':'short')}><option value="short">简写</option><option value="exact">精确</option></select></label>
    </fieldset>
    <fieldset disabled={disabled}><legend>阅读偏好</legend><label>对话自动跟随<select aria-label="对话自动跟随" value={String(value.follow)} onChange={e=>store.edit('follow',e.target.value==='true')}><option value="true">开</option><option value="false">关</option></select></label></fieldset>
    {state.error&&<p role="status">{state.error}</p>}
    <div className="flow-actions"><Button disabled={!settings.getSnapshot().dirty||disabled} onClick={settings.cancel}>取消更改</Button><Button disabled={disabled} onClick={()=>{store.defaults();for(const key of Object.keys(exec.fields))execution.actions.resetField(key);}}>恢复默认</Button><Button onClick={onLeave}>返回会话</Button></div>
    </SettingsForm>

  </section>;
}

/** The shell overlay is provider-owned and covers every guarded navigation route. */
export function SettingsLeaveOverlay({store,execution,navigation}: {store:PreferenceStore;execution:ExecutionSettings;navigation:PreferenceNavigation}) {
  const display=useSyncExternalStore(store.subscribe,store.getSnapshot);
  const exec=useSyncExternalStore(execution.store.subscribe,execution.store.getSnapshot);
  const state={...display,saving:display.saving||exec.saving};
  const open=useSyncExternalStore(navigation.subscribe,navigation.getSnapshot);
  return <Modal open={open} onClose={navigation.continueEditing} title={state.saving?'正在等待保存结果':'有未保存的更改'} closeLabel="继续编辑" footer={<><Button disabled={state.saving||exec.invalid} onClick={()=>void navigation.saveAndLeave()}>保存并离开</Button><Button disabled={state.saving} onClick={navigation.discardAndLeave}>放弃更改</Button><Button onClick={navigation.continueEditing}>继续编辑</Button></>}><p>{state.saving?'保存成功后离开；保存失败会保留你的更改。':'保存设置后离开，或放弃本次更改。'}</p>{(state.error||exec.failed)&&<p role="status">{state.error??'执行设置保存失败，更改已保留'}</p>}</Modal>;
}
