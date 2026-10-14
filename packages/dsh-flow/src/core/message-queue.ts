import type { FlowMessage } from '../types.ts';

export type MessageListener = (message: FlowMessage) => Promise<void>;

export interface MessageQueueOptions {
  pending: () => readonly FlowMessage[];
  acknowledge: (message: FlowMessage) => void;
  onError: (error: unknown) => void;
}

/** Durable communication handoff. Agent execution belongs to the receiver. */
export class MessageQueue {
  private readonly listeners = new Map<string, MessageListener>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly accepted = new Set<string>();
  private readonly acknowledgements = new Map<string, FlowMessage>();
  private readonly failed = new Map<string, number>();
  private generation = 0;
  private scheduled = false;
  private stopped = false;

  constructor(private readonly options: MessageQueueOptions) {}

  listen(address: string, listener: MessageListener): () => void {
    if (this.stopped) throw new Error('Message queue is disposed');
    if (!address) throw new Error('Message listener requires an address');
    // Each registration gets its own identity, even when the callback is reused.
    const registration: MessageListener = message => listener(message);
    this.listeners.set(address, registration);
    this.wake();
    return () => {
      if (this.listeners.get(address) === registration) this.listeners.delete(address);
    };
  }

  /** The caller persists the message in its transaction before submitting it. */
  async submit(_message: FlowMessage): Promise<void> {
    if (this.stopped) throw new Error('Message queue is disposed');
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    this.generation++;
    this.schedule();
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.listeners.clear();
    await Promise.allSettled(this.active.values());
  }

  private schedule(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.stopped) return;
      try { this.dispatch(); } catch (error) { this.options.onError(error); }
    });
  }

  private acknowledge(message: FlowMessage): void {
    try {
      this.options.acknowledge(message);
      this.acknowledgements.delete(message.id);
      this.failed.delete(message.id);
    } catch (error) {
      this.failed.set(message.id, this.generation);
      this.options.onError(error);
    }
  }

  private dispatch(): void {
    for (const message of this.acknowledgements.values()) {
      if (this.failed.get(message.id) !== this.generation) this.acknowledge(message);
    }
    const blocked = new Set([...this.acknowledgements.values()].map(message => message.to_session_id));
    for (const message of this.options.pending()) {
      if (message.state !== 'queued' || this.accepted.has(message.id)) continue;
      const address = message.to_session_id;
      if (blocked.has(address)) continue;
      // Preserve the persistent input order, including a failed first handoff.
      blocked.add(address);
      if (this.active.has(address) || this.failed.get(message.id) === this.generation) continue;
      const listener = this.listeners.get(address);
      if (!listener) continue;
      const handoff = Promise.resolve().then(async () => {
        if (this.stopped || this.listeners.get(address) !== listener) return;
        try {
          await listener(message);
          this.accepted.add(message.id);
          this.acknowledgements.set(message.id, message);
          this.acknowledge(message);
        } catch (error) {
          this.failed.set(message.id, this.generation);
          this.options.onError(error);
        }
      }).finally(() => {
        this.active.delete(address);
        this.schedule();
      });
      this.active.set(address, handoff);
    }
  }
}
