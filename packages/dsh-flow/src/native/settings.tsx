import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client';
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import { ModelMark } from '../ui/icons.js';
import type { FlowConfigurationStatus } from './protocol.js';
import { observationError } from './observer.js';

type Json = Extract<SettingsPathOpView, { op: 'set' }>['value'];
export interface SettingsPort {
  mirror: SettingsDescribeFace;
  describe: Context['remote']['settings']['describe'];
  mutate: Context['remote']['settings']['mutate'];
  configuration(): Promise<FlowConfigurationStatus>;
}
export interface DraftState {
  base: SettingsNamespaceView | undefined; latest: SettingsNamespaceView | undefined; ops: readonly SettingsPathOpView[];
  pending: boolean; message: string | null; conflict: boolean; saved: boolean; configuration: FlowConfigurationStatus | undefined;
  invalid: Readonly<Record<string, string>>;
  invalidText: Readonly<Record<string, string>>;
}
export function pathValue(value: unknown, path: readonly string[]): unknown {
  for (const key of path) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined; value = (value as Record<string, unknown>)[key]; }
  return value;
}
export function foldNamespace(mirror: SettingsDescribeFace, value: SettingsNamespaceView): boolean {
  const current = mirror.getSnapshot().view?.namespaces.find(candidate => candidate.ns === value.ns);
  if (current && current.revision > value.revision) return false;
  mirror.acceptView(value); return true;
}

export class SettingsDraft {
  private state: DraftState = { base: undefined, latest: undefined, ops: [], pending: false, message: null, conflict: false, saved: false, configuration: undefined, invalid: {}, invalidText: {} };
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  constructor(readonly entryId: string, private readonly port: SettingsPort) {}
  getSnapshot = (): DraftState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<DraftState>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  accept(view: SettingsNamespaceView | undefined): void {
    if (!view || view.ns !== this.entryId || (this.state.latest && view.revision < this.state.latest.revision)) return;
    this.update({ latest: view, ...this.state.ops.length || this.state.pending ? {} : { base: view } });
  }
  edit(path: string[], value?: Json): void {
    if (this.state.pending || !this.state.base) return;
    const op: SettingsPathOpView = value === undefined ? { op: 'unset', path: [...path] } : { op: 'set', path: [...path], value: structuredClone(value) };
    const invalid = { ...this.state.invalid }; delete invalid[path.join('.')];
    const invalidText = { ...this.state.invalidText }; delete invalidText[path.join('.')];
    this.update({ ops: [...this.state.ops.filter(item => JSON.stringify(item.path) !== JSON.stringify(path)), op], saved: false, message: null, invalid, invalidText });
  }
  invalid(path: readonly string[], reason: string, text = ''): void { this.update({ invalid: { ...this.state.invalid, [path.join('.')]: reason }, invalidText: { ...this.state.invalidText, [path.join('.')]: text }, saved: false }); }
  compareAndKeepDraft(): void { if (!this.state.pending && this.state.latest) this.update({ base: this.state.latest, conflict: false, message: '已采用最新修订号，请比较字段后保存。' }); }
  discard(): void { if (!this.state.pending) this.update({ ops: [], base: this.state.latest, conflict: false, message: null, saved: false, invalid: {}, invalidText: {} }); }
  async refresh(preserveIssue = false): Promise<void> {
    try {
      const result = await this.port.describe();
      if (!result.ok) throw result.error;
      const view = result.value.namespaces.find(candidate => candidate.ns === this.entryId);
      if (!view) throw new Error('宿主未提供该插件配置');
      foldNamespace(this.port.mirror, view); this.accept(view);
      this.update({ configuration: await this.port.configuration() });
    } catch (error) { this.update({ message: preserveIssue && this.state.message ? `${this.state.message}；刷新失败：${observationError(error)}` : observationError(error) }); }
  }
  async save(): Promise<void> {
    if (this.disposed || this.state.pending || !this.state.base || !this.state.ops.length || Object.keys(this.state.invalid).length) return;
    const baseRevision = this.state.base.revision, submitted = structuredClone(this.state.ops);
    this.update({ pending: true, message: null, saved: false });
    try {
      const result = await this.port.mutate(this.entryId, [...submitted], baseRevision);
      if (!result.ok) { this.update({ conflict: result.error.code === 'settings/conflict', message: observationError(result.error) }); await this.refresh(true); return; }
      foldNamespace(this.port.mirror, result.value);
      const latest = this.port.mirror.getSnapshot().view?.namespaces.find(candidate => candidate.ns === this.entryId) ?? result.value;
      this.update({ base: latest, latest, ops: [], conflict: false, saved: true, message: '已保存' });
      try { this.update({ configuration: await this.port.configuration() }); }
      catch (error) { this.update({ message: `配置已保存，运行状态读取失败：${observationError(error)}` }); }
    } catch (error) { this.update({ message: observationError(error) }); await this.refresh(true); }
    finally { this.update({ pending: false }); }
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
}

interface Field { path: string; label: string; kind?: 'number' | 'lines' | 'json' | 'permission'; group: number; effect?: 'restart' | 'admission' }
const fields: readonly Field[] = [
  { path: 'rootRole', label: '根职责', group: 0 }, { path: 'defaults.preset', label: '预设', group: 0 },
  { path: 'defaults.skills', label: '技能（每行一项）', kind: 'lines', group: 0 },
  { path: 'defaults.model.provider', label: '模型厂商', group: 0 }, { path: 'defaults.model.id', label: '模型', group: 0 },
  { path: 'defaults.params.reasoningEffort', label: '推理强度', group: 0 }, { path: 'defaults.params.temperature', label: '温度', kind: 'number', group: 0 },
  { path: 'defaults.params.maxTokens', label: '最大输出 tokens', kind: 'number', group: 0 },
  { path: 'cwd', label: '工作目录', group: 0 }, { path: 'defaults.permission', label: '初始权限', kind: 'permission', group: 0 },
  { path: 'patternSources', label: '模式目录（每行一项）', kind: 'lines', group: 1 },
  { path: 'maxConcurrentAgents', label: '共享执行容量', kind: 'number', group: 2, effect: 'admission' },
  { path: 'cleanup.gracefulTimeoutMs', label: '优雅收尾时限（毫秒）', kind: 'number', group: 2 },
  { path: 'cleanup.immediateTimeoutMs', label: '立即清理时限（毫秒）', kind: 'number', group: 2 },
  { path: 'connection.port', label: '服务端口', kind: 'number', group: 3, effect: 'restart' },
  { path: 'stateDirectory', label: '状态目录', group: 3, effect: 'restart' }, { path: 'connection.staticDirectory', label: '静态目录', group: 3, effect: 'restart' },
  { path: 'connection.allowedOrigins', label: '允许来源（每行一项）', kind: 'lines', group: 3, effect: 'restart' },
  { path: 'connection.prices', label: '价格表', kind: 'json', group: 3, effect: 'restart' },
];
function display(value: unknown, field: Field): string { return value === undefined ? '' : field.kind === 'lines' && Array.isArray(value) ? value.join('\n') : field.kind === 'json' ? JSON.stringify(value, null, 2) : String(value); }
function SettingsField({ field, state, editor }: { field: Field; state: DraftState; editor: SettingsDraft }) {
  const path = field.path.split('.'), edit = state.ops.find(item => JSON.stringify(item.path) === JSON.stringify(path));
  const effective = edit ? edit.op === 'set' ? edit.value : pathValue(state.base?.base, path) : pathValue(state.base?.value, path);
  const inherited = edit ? edit.op === 'unset' : pathValue(state.base?.user, path) === undefined;
  const pendingText = state.invalidText[field.path];
  const [text, setText] = useState(pendingText ?? display(effective, field)), [error, setError] = useState(state.invalid[field.path] ?? '');
  useEffect(() => { setText(pendingText ?? display(effective, field)); setError(state.invalid[field.path] ?? ''); }, [effective, field, pendingText, state.invalid]);
  const commit = (value: string) => {
    setText(value); try {
      if (value.trim() === '') { editor.edit(path); setError(''); return; }
      let parsed: Json = value;
      if (field.kind === 'number') { const number = Number(value); if (value.trim() === '' || !Number.isFinite(number)) throw new Error('请输入有效数字'); parsed = number; }
      else if (field.kind === 'json') parsed = JSON.parse(value) as Json;
      else if (field.kind === 'lines') parsed = value.split('\n').map(item => item.trim()).filter(Boolean);
      if (field.path.startsWith('defaults.params.') && pathValue(state.base?.value, ['defaults', 'params', 'version']) !== 1) editor.edit(['defaults', 'params', 'version'], 1);
      editor.edit(path, parsed); setError('');
    } catch (reason) { const message = observationError(reason); setError(message); editor.invalid(path, message, value); }
  };
  const timing = field.effect === 'restart' ? '重启生效' : field.effect === 'admission' ? '后续执行生效' : '新运行生效';
  return <div className={`flow-settings-field ${edit ? 'dirty' : ''}`}><label htmlFor={`flow-setting-${field.path}`}>{field.label}<span title={timing} tabIndex={0}>{timing}</span></label>
    <div>{field.kind === 'lines' || field.kind === 'json' ? <textarea id={`flow-setting-${field.path}`} value={text} onChange={event => commit(event.target.value)} disabled={state.pending} aria-invalid={!!error} />
      : field.kind === 'permission' ? <select id={`flow-setting-${field.path}`} value={text} onChange={event => commit(event.target.value)} disabled={state.pending}><option value="">继承</option><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="full-access">完整访问</option></select>
        : <input id={`flow-setting-${field.path}`} type={field.kind === 'number' ? 'number' : 'text'} value={text} onChange={event => commit(event.target.value)} disabled={state.pending} aria-invalid={!!error} />}
      <button type="button" title="恢复继承" aria-label={`${field.label}恢复继承`} onClick={() => editor.edit(path)} disabled={state.pending}>↶</button></div>
    <small>{inherited ? '🔗 继承' : '本地覆盖'}{edit ? ' · 未保存' : ''}</small>
    {state.conflict && <small>本地：{text || '（继承）'} · 最新：{display(pathValue(state.latest?.value, path), field)}</small>}
    {error && <small role="alert">{error}</small>}</div>;
}

function ModelPicker({ ctx, state, editor }: { ctx: Context; state: DraftState; editor: SettingsDraft }) {
  const [catalog, setCatalog] = useState<ModelCatalog>(), [failure, setFailure] = useState('');
  useEffect(() => { let active = true; void ctx.remote.session.modelCatalog().then(result => {
    if (!active) return; if (result.ok) setCatalog(result.value); else setFailure(observationError(result.error));
  }, error => { if (active) setFailure(observationError(error)); }); return () => { active = false; }; }, [ctx]);
  const op = state.ops.find(item => item.path.join('.') === 'defaults.model');
  const selected = op ? op.op === 'set' ? op.value : pathValue(state.base?.base, ['defaults', 'model']) : pathValue(state.base?.value, ['defaults', 'model']);
  const model = selected && typeof selected === 'object' && 'provider' in selected && 'id' in selected && typeof selected.provider === 'string' && typeof selected.id === 'string' ? { provider: selected.provider, id: selected.id } : undefined;
  return <div className="flow-settings-models"><label>模型 <small>新运行生效</small></label>
    <details onKeyDown={event => {
      if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=option]')];
        const index = options.indexOf(document.activeElement as HTMLButtonElement), delta = event.key === 'ArrowDown' ? 1 : -1;
        options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + delta + options.length) % options.length]?.focus();
      }
    }}><summary>{model ? <><ModelMark model={model} /> {model.provider} / {model.id}</> : '选择宿主可用模型'}</summary>
      <div role="listbox" aria-label="可用模型">{catalog?.groups.map(provider => <div key={provider.id} role="group" aria-label={provider.name}><strong>{provider.name}</strong>{provider.models.map(item => <button key={item.id} type="button" role="option" aria-selected={model?.provider === provider.id && model.id === item.id} disabled={state.pending} onClick={event => {
        editor.edit(['defaults', 'model'], { provider: provider.id, id: item.id }); const details = event.currentTarget.closest('details'); if (details) { details.open = false; details.querySelector('summary')?.focus(); }
      }}><ModelMark model={{ provider: provider.id, id: item.id }} />{item.name}<small>{item.id}</small></button>)}</div>)}</div>
      {catalog?.failures.map(item => <p key={item.id} role="status">{item.name}：{item.message}</p>)}
      {!catalog && <p role="status">{failure || '正在读取宿主模型…'}</p>}</details>
    <button type="button" disabled={state.pending} onClick={() => editor.edit(['defaults', 'model'])}>恢复模型继承</button>
    {(!catalog || !catalog.groups.length) && fields.filter(field => field.path.startsWith('defaults.model.')).map(field => <SettingsField key={field.path} field={field} state={state} editor={editor} />)}
  </div>;
}

export function FlowSettings({ ctx, entryId }: { ctx: Context; entryId: string }) {
  const editor = useMemo(() => new SettingsDraft(entryId, {
    mirror: ctx.configForms.describe(), describe: () => ctx.remote.settings.describe(),
    mutate: (...args) => ctx.remote.settings.mutate(...args),
    async configuration() { const result = await ctx.remote.flowDashboard.connection(); if (!result.ok) throw result.error; return result.value.configuration; },
  }), [ctx, entryId]);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot), [group, setGroup] = useState(0);
  const mirror = ctx.configForms.describe();
  const mirrorState = useSyncExternalStore(listener => mirror.subscribe(listener), () => mirror.getSnapshot());
  useEffect(() => { void mirror.ensure().then(() => { editor.accept(mirror.getSnapshot().view?.namespaces.find(item => item.ns === entryId)); void editor.refresh(); }); return () => editor.dispose(); }, [editor, mirror, entryId]);
  useEffect(() => editor.accept(mirrorState.view?.namespaces.find(item => item.ns === entryId)), [editor, mirrorState, entryId]);
  const model = state.configuration?.requested.defaults.model;
  return <section className="flow-native-settings" aria-label="智能体团队设置"><nav aria-label="设置分组">{['运行与角色默认值', '模式包来源', '执行与清理', '服务连接'].map((label, index) => <button type="button" key={label} aria-current={index === group ? 'page' : undefined} onClick={() => setGroup(index)}>{label}</button>)}</nav>
    <div><h2>{['运行与角色默认值', '模式包来源', '执行与清理', '服务连接'][group]}</h2>
      {model && group === 0 && <p><ModelMark model={model} /> {model.provider} / {model.id}</p>}
      {!state.base ? <p role="status">{state.message ?? '正在读取宿主配置…'}</p> : <fieldset disabled={state.pending || !mirrorState.view?.writable}>{group === 0 && <ModelPicker ctx={ctx} state={state} editor={editor} />}{fields.filter(field => field.group === group && !field.path.startsWith('defaults.model.')).map(field => <SettingsField key={field.path} field={field} state={state} editor={editor} />)}</fieldset>}
      {group === 1 && state.configuration?.catalog && <div aria-label="模式加载结果"><h3>可用模式</h3>{state.configuration.catalog.patterns.length ? <ul>{state.configuration.catalog.patterns.map(pattern => <li key={pattern.id}><strong>{pattern.id}</strong><p>{pattern.description}</p></li>)}</ul> : <p>没有可用模式</p>}
        {!!state.configuration.catalog.diagnostics.length && <div role="status" aria-label="模式配置诊断">{state.configuration.catalog.diagnostics.map((item, index) => <p key={`${item.path}/${index}`}><code>{item.path}</code>：{item.message}</p>)}</div>}</div>}
      {state.configuration?.application.status === 'failed' && <p role="alert">配置已保存，运行态应用失败：{state.configuration.application.error?.message}</p>}
      {!!state.configuration?.restartRequired.length && <p role="status">重启生效：{state.configuration.restartRequired.join('、')}</p>}
      <footer><span role={state.message && !state.saved ? 'alert' : 'status'}>{state.pending ? '正在保存…' : state.message}</span>
        {state.conflict && <button type="button" onClick={() => editor.compareAndKeepDraft()} disabled={state.pending}>比较后采用最新修订号</button>}
        <button type="button" onClick={() => { void editor.refresh(); }} disabled={state.pending}>重新读取</button>
        <button type="button" onClick={() => editor.discard()} disabled={state.pending || !state.ops.length}>放弃修改</button>
        <button type="button" className="flow-primary" onClick={() => { void editor.save(); }} disabled={state.pending || !state.ops.length || !!Object.keys(state.invalid).length || !mirrorState.view?.writable}>{state.pending ? '保存中…' : state.saved ? '✓ 已保存' : '保存'}</button></footer>
    </div></section>;
}
