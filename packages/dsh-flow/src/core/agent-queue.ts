/** A scheduling unit. Jobs for one Agent key execute in submission order. */
export interface Job {
  readonly key: string;
  run(): Promise<void>;
}

interface PendingJob {
  readonly key: string;
  readonly job: Job;
  readonly done: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

/** Fixed-capacity scheduling, independent of native Agents and collaboration state. */
export class AgentQueue {
  private readonly pending: PendingJob[] = [];
  private readonly active = new Set<PendingJob>();
  private readonly activeKeys = new Set<string>();
  private scheduled = false;
  private closed = false;
  private disposal?: Promise<void>;

  constructor(private readonly capacity: number, private readonly onError?: (error: unknown) => void) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('AgentQueue capacity must be a positive integer');
  }

  get activeCount(): number { return this.active.size; }

  submit(job: Job): Promise<void> {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Fire-and-forget submissions are safe; an awaiting caller still observes failure.
    void done.catch(() => {});
    if (this.closed) reject(new Error('AgentQueue is closed'));
    else {
      this.pending.push({ key: job.key, job, done, resolve, reject });
      this.schedule();
    }
    return done;
  }

  cancelPending(key: string): void {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (this.pending[index]!.key !== key) continue;
      this.pending.splice(index, 1)[0]!.resolve();
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    for (const entry of this.pending.splice(0)) entry.resolve();
    this.disposal = Promise.allSettled([...this.active].map(entry => entry.done)).then(() => {});
    return this.disposal;
  }

  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.dispatch(); });
  }

  private dispatch(): void {
    while (!this.closed && this.active.size < this.capacity) {
      const index = this.pending.findIndex(entry => !this.activeKeys.has(entry.key));
      if (index < 0) return;
      const entry = this.pending.splice(index, 1)[0]!;
      this.active.add(entry);
      this.activeKeys.add(entry.key);
      void Promise.resolve().then(() => entry.job.run()).then(
        () => this.finish(entry),
        error => {
          try { this.onError?.(error); } catch { /* Reporting cannot stop scheduling. */ }
          this.finish(entry, { error });
        },
      );
    }
  }

  private finish(entry: PendingJob, failure?: { error: unknown }): void {
    this.active.delete(entry);
    this.activeKeys.delete(entry.key);
    this.schedule();
    if (failure) entry.reject(failure.error);
    else entry.resolve();
  }
}
