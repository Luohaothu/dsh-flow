import { Agent } from './agent.js';
import { Group } from './group.js';
import { Mailbox } from './mailbox.js';
import { agentControl, contextControl, groupControl, mailboxControl, type ContextControl } from './internals.js';
import type { ContextObject, GroupID, HostAdaptor, HostContext, SessionID } from './types.js';

type Managed = Agent | Group | Mailbox;
export class Context {
  private adaptor?: HostAdaptor;
  private objects = new Set<Managed>();
  private releasing = new Set<Managed>();
  private releases = new Map<Managed, Promise<void>>();
  private releaseDependencies = new Set<Promise<void>>();
  private agents = new Map<SessionID, Agent>();
  private groups = new Map<GroupID, Group>();
  private closing = false;
  private disposed = false;
  private closePromise?: Promise<void>;
  private terminationListeners = new Set<(agent: Agent) => void>();
  private terminated = new WeakSet<Agent>();
  private creations = new Set<Promise<void>>();
  readonly [contextControl]: ContextControl;

  constructor() {
    this[contextControl] = {
      assertOpen: () => this.assertOpen(),
      assertAvailable: agent => this.assertAvailable(agent),
      beginCreation: () => {
        this.assertOpen();
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        this.creations.add(pending);
        return () => { this.creations.delete(pending); finish(); };
      },
      publish: (agent, mailbox, sources, attach) => {
        this.assertOpen();
        for (const source of sources) this.assertAvailable(source);
        this.validateRegistration(agent); this.validateRegistration(mailbox);
        this.register(agent); this.register(mailbox); attach();
      },
      rollback: (agent, mailbox) => { this.remove(agent); this.remove(mailbox); },
      terminated: agent => {
        if (this.terminated.has(agent)) return;
        this.terminated.add(agent);
        for (const listener of [...this.terminationListeners]) { try { listener(agent); } catch {} }
      },
      trackRelease: (agent, completion) => {
        if (!this.releases.has(agent)) this.releases.set(agent, completion);
        else if (this.releases.get(agent) !== completion) this.releaseDependencies.add(completion);
      },
      markReleasing: object => { if (this.objects.has(object)) this.releasing.add(object); },
    };
  }
  onAgentTerminated(listener: (agent: Agent) => void): () => void {
    this.assertOpen();
    if (typeof listener !== 'function') throw new TypeError('Termination listener must be a function');
    this.terminationListeners.add(listener);
    return () => { this.terminationListeners.delete(listener); };
  }
  registerHostAdaptor(adaptor: HostAdaptor): void {
    this.assertOpen();
    if (this.adaptor === adaptor) return;
    if (this.adaptor) throw new Error('Context already has a HostAdaptor');
    if (!adaptor || typeof adaptor.host !== 'object' || adaptor.host === null) throw new TypeError('Host context must be an object');
    this.adaptor = adaptor;
  }
  getHostAdaptor(): HostAdaptor {
    this.assertOpen();
    if (!this.adaptor) throw new Error('Context has no HostAdaptor');
    return this.adaptor;
  }
  getHostContext(): HostContext { return this.getHostAdaptor().host; }
  register(object: Managed): void {
    this.assertOpen(); this.validateRegistration(object);
    if (this.objects.has(object)) return;
    if (object instanceof Mailbox) object[mailboxControl].bind(this);
    this.objects.add(object);
    if (object instanceof Agent) this.agents.set(object.getProfile().sessionID, object);
    if (object instanceof Group) this.groups.set(object.getID(), object);
  }
  has(object: ContextObject): boolean {
    if (this.closing || this.disposed) return false;
    if (object === this.adaptor || object === this.adaptor?.host) return this.adaptor !== undefined;
    return this.objects.has(object as Managed) && !this.releasing.has(object as Managed);
  }
  getAgent(session: SessionID): Agent | null {
    const agent = this.agents.get(session);
    return agent && this.has(agent) ? agent : null;
  }
  getGroup(id: GroupID): Group | null {
    const group = this.groups.get(id);
    return group && this.has(group) ? group : null;
  }
  list(query?: (object: ContextObject) => boolean): ContextObject[] {
    const snapshot: ContextObject[] = this.closing ? [] : [...this.objects].filter(object => !this.releasing.has(object));
    if (!this.closing && this.adaptor) {
      if (!snapshot.includes(this.adaptor)) snapshot.push(this.adaptor);
      if (!snapshot.includes(this.adaptor.host)) snapshot.push(this.adaptor.host);
    }
    return snapshot.filter(object => !query || query(object)).filter(object => this.has(object));
  }
  release(object: Managed): Promise<void> {
    const existing = this.releases.get(object);
    if (existing) return existing;
    if (!this.objects.has(object)) return Promise.reject(new Error('Object is not managed by this Context'));
    this.releasing.add(object);
    if (object instanceof Agent) return object[agentControl].release('SIGTERM');
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.releases.set(object, result);
    try {
      const close = object instanceof Group ? object[groupControl].close() : object[mailboxControl].close();
      void close.then(() => { this.remove(object); resolve(); }, reject);
    } catch (error) { reject(error); }
    return result;
  }
  dispose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const close = async () => {
      const errors: unknown[] = [];
      const collect = (results: PromiseSettledResult<unknown>[]) => { for (const result of results) if (result.status === 'rejected') errors.push(result.reason); };
      const groupClosures = [...this.objects].filter((object): object is Group => object instanceof Group).map(group => this.release(group));
      const agentClosures = [...this.objects].filter((object): object is Agent => object instanceof Agent).map(agent => this.release(agent));
      await Promise.allSettled([...groupClosures, ...agentClosures]);
      await Promise.all([...this.creations]);
      collect(await Promise.allSettled(new Set([...this.releases.values(), ...this.releaseDependencies])));
      if (errors.length) throw new AggregateError(errors, 'Context object release failed');
      const mailboxes = [...this.objects].filter((object): object is Mailbox => object instanceof Mailbox);
      collect(await Promise.allSettled(mailboxes.map(mailbox => this.release(mailbox))));
      if (this.adaptor) collect(await Promise.allSettled([this.adaptor.dispose()]));
      this.disposed = true;
      this.terminationListeners.clear();
      if (errors.length) throw new AggregateError(errors, 'Context disposal failed');
    };
    void close().then(resolve, reject);
    return this.closePromise;
  }
  private assertOpen(): void { if (this.closing || this.disposed) throw new Error('Context is closing or disposed'); }
  private assertAvailable(agent: Agent): void {
    this.assertOpen();
    if (agent[agentControl].context !== this || !this.has(agent) || agent.getStatus() === 'terminated') throw new Error('Agent is unavailable in this Context');
    agent[agentControl].assertAvailable();
  }
  private validateRegistration(object: Managed): void {
    if (!(object instanceof Agent) && !(object instanceof Group) && !(object instanceof Mailbox)) throw new TypeError('Unsupported Context object');
    const owner = object instanceof Agent ? object[agentControl].context : object instanceof Group ? object[groupControl].context : object[mailboxControl].context;
    if (owner && owner !== this) throw new Error('Object belongs to another Context');
    if (this.releasing.has(object) || this.releases.has(object)) throw new Error('Object has entered release');
    if (object instanceof Agent) {
      if (object.getStatus() === 'terminated') throw new Error('Cannot register a terminated Agent');
      const occupied = this.agents.get(object.getProfile().sessionID);
      if (occupied && occupied !== object) throw new Error('SessionID is already registered');
    } else if (object instanceof Group) {
      if (object[groupControl].closed) throw new Error('Group is dissolved');
      const occupied = this.groups.get(object.getID());
      if (occupied && occupied !== object) throw new Error('GroupID is already registered');
    } else if (object[mailboxControl].closed) throw new Error('Mailbox is released');
  }
  private remove(object: Managed): void {
    this.objects.delete(object); this.releasing.delete(object);
    if (object instanceof Agent) for (const [session, agent] of this.agents) if (agent === object) this.agents.delete(session);
    if (object instanceof Group && this.groups.get(object.getID()) === object) this.groups.delete(object.getID());
  }
}
