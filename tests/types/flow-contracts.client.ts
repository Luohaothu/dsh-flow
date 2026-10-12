/** Browser DTOs contain collaboration facts, independently of the Host Context. */
import type { FlowTeamSnapshot, FlowAgentSession } from '../../packages/dsh-flow/src/types.ts';
export function activeSession(snapshot: FlowTeamSnapshot, memberId: string): Pick<FlowAgentSession, 'session_id' | 'team_id'> | null {
  const member = snapshot.members.find(value => value.id === memberId);
  return member ? { session_id: member.session_id, team_id: snapshot.run.id } : null;
}
