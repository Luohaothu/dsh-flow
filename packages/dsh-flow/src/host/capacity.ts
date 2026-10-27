/** One service-wide execution budget. Idle handles never reserve capacity. */
export class ExecutionCapacity {
  private readonly active = new Set<object>();
  private readonly queue: { owner: object; signal: AbortSignal; resolve(): void; reject(reason: unknown): void; abort(): void }[] = [];
  private maximum: number;
  constructor(maximum = 4) { this.maximum = this.validate(maximum); }
  get limit(): number { return this.maximum; }
  get executing(): number { return this.active.size; }
  resize(maximum: number): void { this.maximum = this.validate(maximum); this.drain(); }
  acquire(owner: object, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active.has(owner)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const request = { owner, signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(request);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      } };
      signal.addEventListener('abort', request.abort, { once: true });
      this.queue.push(request); this.drain();
    });
  }
  release(owner: object): void { this.active.delete(owner); this.drain(); }
  private drain(): void {
    while (this.active.size < this.maximum && this.queue.length) {
      const request = this.queue.shift()!;
      request.signal.removeEventListener('abort', request.abort);
      if (request.signal.aborted) request.reject(request.signal.reason);
      else { this.active.add(request.owner); request.resolve(); }
    }
  }
  private validate(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Execution capacity must be a positive integer');
    return value;
  }
}
