const nativeCall = call => call?.type === 'tool/call' && Number.isSafeInteger(call.seq) && call.seq >= 0
  && Number.isSafeInteger(call.data?.turn) && call.data.turn >= 1 && Number.isSafeInteger(call.data.step) && call.data.step >= 1
  && typeof call.data.callId === 'string' && call.data.callId.length > 0 && typeof call.data.name === 'string' && call.data.name.length > 0
  && typeof call.data.arguments === 'string';

const nativeResultFor = (call, result) => nativeCall(call) && result?.type === 'tool/result' && Number.isSafeInteger(result.seq) && result.seq > call.seq
  && result.surfaceOp === 'append' && Array.isArray(result.sourceEventSeqs) && result.sourceEventSeqs.length === 1 && result.sourceEventSeqs[0] === call.seq
  && result.data?.turn === call.data.turn && result.data.step === call.data.step
  && result.data.message?.role === 'tool' && typeof result.data.message.id === 'string' && result.data.message.id.length > 0
  && result.data.message.source?.kind === 'tool' && result.data.message.source.callId === call.data.callId
  && result.data.message.toolCallId === call.data.callId && Array.isArray(result.data.message.content)
  && (result.data.error === undefined || result.data.message.isError === true);

export const nativeToolCallForResult = (events, result) => events.find(call => nativeResultFor(call, result));

export const assignmentReadBack = (assignment, events, afterUserSeq = -1) => events.some(call => {
  if (!nativeCall(call) || call.seq <= afterUserSeq) return false;
  const cancellation = call.data.name === 'flow_team_assignment_cancel' && assignment.status === 'cancelled';
  if (!cancellation && call.data.name !== 'flow_team_assignment_read') return false;
  let args;
  try { args = JSON.parse(call.data.arguments); } catch { return false; }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  if (args.assignmentId !== assignment.id || cancellation && args.runId !== assignment.runId) return false;
  return events.some(event => nativeResultFor(call, event) && !event.data.message.isError && event.data.message.content.some(part => {
    if (part.type !== 'text') return false;
    try {
      const value = JSON.parse(part.text);
      if (cancellation) return Array.isArray(value) && value.some(item => item?.assignmentId === assignment.id && item.status === 'cancelled');
      return value.id === assignment.id && value.runId === assignment.runId && value.status === assignment.status;
    }
    catch { return false; }
  }));
});
