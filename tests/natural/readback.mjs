export const assignmentReadBack = (assignment, events, afterUserSeq = -1) => events.some(call => {
  if (call.type !== 'tool/call' || !Number.isSafeInteger(call.seq) || call.seq <= afterUserSeq
    || !Number.isSafeInteger(call.data?.turn) || call.data.turn < 1 || !Number.isSafeInteger(call.data.step) || call.data.step < 1
    || typeof call.data.callId !== 'string' || !call.data.callId) return false;
  const cancellation = call.data.name === 'flow_team_assignment_cancel' && assignment.status === 'cancelled';
  if (!cancellation && call.data.name !== 'flow_team_assignment_read') return false;
  let args;
  try { args = JSON.parse(call.data.arguments); } catch { return false; }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  if (args.assignmentId !== assignment.id || cancellation && args.runId !== assignment.runId) return false;
  return events.some(event => event.type === 'tool/result' && Number.isSafeInteger(event.seq) && event.seq > call.seq
    && event.surfaceOp === 'append' && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length === 1 && event.sourceEventSeqs[0] === call.seq
    && event.data?.turn === call.data.turn && event.data.step === call.data.step && event.data.error === undefined
    && event.data.message?.role === 'tool' && typeof event.data.message.id === 'string' && event.data.message.id
    && event.data.message.source?.kind === 'tool' && event.data.message.source.callId === call.data.callId
    && event.data.message.toolCallId === call.data.callId && !event.data.message.isError && Array.isArray(event.data.message.content) && event.data.message.content.some(part => {
    if (part.type !== 'text') return false;
    try {
      const value = JSON.parse(part.text);
      if (cancellation) return Array.isArray(value) && value.some(item => item?.assignmentId === assignment.id && item.status === 'cancelled');
      return value.id === assignment.id && value.runId === assignment.runId && value.status === assignment.status;
    }
    catch { return false; }
  }));
});
