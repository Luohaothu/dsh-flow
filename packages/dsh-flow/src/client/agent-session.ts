/** Native Session identity and continuation policy, independent of the team inspector. */
import type { FlowAgentSession } from '../types.ts';

export interface AgentSessionSnapshot { readonly value: FlowAgentSession | null; readonly error: string | null }
export class AgentSessionSource {
  private value: AgentSessionSnapshot = {value:null,error:null};
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | null = null;
  private disposed = false;
  constructor(readonly id: string, private read: (id:string) => Promise<FlowAgentSession|null>, private policy: (value:FlowAgentSession|null,error:string|null) => void) {}
  getSnapshot = () => this.value;
  subscribe = (listener:()=>void):(()=>void) => {
    this.listeners.add(listener);void this.refresh();
    return()=>{this.listeners.delete(listener);if(!this.listeners.size){clearTimeout(this.timer);this.timer=undefined;}};
  };
  seed(value: FlowAgentSession): void { this.publish({value,error:null}); }
  private publish(value:AgentSessionSnapshot):void { this.value=value;this.policy(value.value,value.error);for(const listener of this.listeners)listener(); }
  refresh = ():Promise<void> => {
    if(this.disposed)return Promise.resolve();
    if(this.loading)return this.loading;
    clearTimeout(this.timer);
    this.loading=(async()=>{
      try {const value=await this.read(this.id);if(!this.disposed)this.publish({value,error:null});}
      catch(error) {if(!this.disposed)this.publish({...this.value,error:error instanceof Error?error.message:String(error)});}
    })().finally(()=>{
      this.loading=null;
      if(!this.disposed&&this.listeners.size&&(this.value.value||this.value.error))this.timer=setTimeout(()=>void this.refresh(),1500);
    });
    return this.loading;
  };
  dispose():void {this.disposed=true;clearTimeout(this.timer);this.listeners.clear();}
}
