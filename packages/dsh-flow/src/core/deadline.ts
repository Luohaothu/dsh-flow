export interface DeadlineTimer { cancel(): void }
export function deadlineAfter(timeout: number, startedAt = Date.now()): number { return Math.min(Number.MAX_VALUE, startedAt + timeout); }
export function scheduleDeadline(deadline: number, callback: () => void): DeadlineTimer {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const delay = Math.min(2_147_483_647, Math.max(1, Math.ceil(deadline - Date.now())));
    timer = setTimeout(() => {
      if (!active) return;
      if (Date.now() < deadline) schedule();
      else { active = false; callback(); }
    }, delay);
    timer.unref?.();
  };
  schedule();
  return { cancel() { active = false; clearTimeout(timer); } };
}
