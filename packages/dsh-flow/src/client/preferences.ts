/** Current-user display preferences; drafts never affect the running task or the saved display. */
export interface DisplayPreferences {
  readonly view: 'graph' | 'list'
  readonly ended: 'show' | 'collapse'
  readonly communications: 'related' | 'all' | 'hidden'
  readonly motion: 'system' | 'reduce'
  readonly summaries: boolean
  readonly tokens: 'short' | 'exact'
  readonly follow: boolean
}
export const DEFAULT_PREFERENCES: DisplayPreferences = {
  view: 'graph', ended: 'show', communications: 'related', motion: 'system', summaries: true, tokens: 'short', follow: true,
};
export interface PreferenceStorage { read(): string | null; write(value: string): Promise<void> }
export interface PreferenceSnapshot {
  readonly saved: DisplayPreferences
  readonly draft: DisplayPreferences
  readonly dirty: boolean
  readonly saving: boolean
  readonly readError: string | null
  readonly error: string | null
  readonly notice: string | null
}
function equal(a: DisplayPreferences, b: DisplayPreferences): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function decode(raw: string | null): DisplayPreferences {
  if (raw === null) return DEFAULT_PREFERENCES;
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object') throw new Error('保存的显示设置格式无效');
  const field = (key: string) => Reflect.get(value, key);
  const view = field('view'), ended = field('ended'), communications = field('communications'), motion = field('motion'), summaries = field('summaries'), tokens = field('tokens'), follow = field('follow');
  if ((view !== 'graph' && view !== 'list') || (ended !== 'show' && ended !== 'collapse')
    || (communications !== 'related' && communications !== 'all' && communications !== 'hidden')
    || (motion !== 'system' && motion !== 'reduce') || typeof summaries !== 'boolean'
    || (tokens !== 'short' && tokens !== 'exact') || typeof follow !== 'boolean') throw new Error('保存的显示设置格式无效');
  return { view, ended, communications, motion, summaries, tokens, follow };
}
/** Saving is serialized; failures retain the entire draft and never publish success. */
export class PreferenceStore {
  private value: PreferenceSnapshot;
  private listeners = new Set<() => void>();
  private pending: Promise<boolean> | null = null;
  constructor(private storage: PreferenceStorage) {
    let saved = DEFAULT_PREFERENCES, readError = null;
    try { saved = decode(storage.read()); } catch (error) { readError = String(error); }
    this.value = { saved, draft: saved, dirty: false, saving: false, readError, error: null, notice: null };
  }
  getSnapshot = (): PreferenceSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(value: PreferenceSnapshot): void { this.value = value; for (const listener of this.listeners) listener(); }
  edit<Key extends keyof DisplayPreferences>(key: Key, value: DisplayPreferences[Key]): void {
    if (this.value.saving) return;
    const draft = { ...this.value.draft, [key]: value };
    this.publish({ ...this.value, draft, dirty: !equal(draft, this.value.saved), error: null, notice: null });
  }
  cancel(): void { if (!this.value.saving) this.publish({ ...this.value, draft: this.value.saved, dirty: false, error: null, notice: null }); }
  defaults(): void {
    if (this.value.saving) return;
    this.publish({ ...this.value, draft: DEFAULT_PREFERENCES, dirty: !equal(DEFAULT_PREFERENCES, this.value.saved), error: null, notice: '已恢复为默认值，保存后生效' });
  }
  isDefault(): boolean { return equal(this.value.draft, DEFAULT_PREFERENCES); }
  save(): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!this.value.dirty && this.value.readError === null) return Promise.resolve(true);
    const draft = this.value.draft;
    this.publish({ ...this.value, saving: true, error: null, notice: null });
    this.pending = Promise.resolve().then(() => this.storage.write(JSON.stringify(draft))).then(() => {
      this.publish({ saved: draft, draft, dirty: false, saving: false, readError: null, error: null, notice: '显示设置已保存。' });
      return true;
    }, error => {
      this.publish({ ...this.value, saving: false, error: `未能保存显示设置，你的更改已保留。${String(error)}` });
      return false;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
