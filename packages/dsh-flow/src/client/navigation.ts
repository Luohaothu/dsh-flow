/** Defer actual provider navigation until the settings draft has been resolved. */
interface SettingsDraft {
  getSnapshot(): {dirty:boolean;saving:boolean}
  save():Promise<boolean>
  cancel():void
}

export class PreferenceNavigation {
  private pending: (() => void) | null = null;
  private listeners = new Set<() => void>();
  constructor(private store: SettingsDraft) {}
  getSnapshot = (): boolean => this.pending !== null;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(): void { for (const listener of this.listeners) listener(); }
  request = (commit: () => void): boolean => {
    const state = this.store.getSnapshot();
    if (!state.dirty && !state.saving) return false;
    this.pending = commit;
    this.publish();
    // A save already in progress owns the outcome. Never abandon its result.
    if (state.saving) void this.saveAndLeave();
    return true;
  };
  continueEditing = (): void => { this.pending = null; this.publish(); };
  private leave(): void {
    const commit = this.pending;
    this.pending = null;
    this.publish();
    commit?.();
  }
  saveAndLeave = async (): Promise<void> => { if (await this.store.save()) this.leave(); };
  discardAndLeave = (): void => {
    if (this.store.getSnapshot().saving) return;
    this.store.cancel();
    this.leave();
  };
}
