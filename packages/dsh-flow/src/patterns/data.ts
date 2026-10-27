/** These walks keep template nesting independent of the JavaScript call stack. */
export function copyPatternData<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const root = (Array.isArray(value) ? [] : Object.create(null)) as Record<string, unknown>;
  const stack = [{ source: value as Record<string, unknown>, target: root }];
  while (stack.length) {
    const { source, target } = stack.pop()!;
    for (const key of Object.keys(source)) {
      const item = source[key];
      if (item !== null && typeof item === 'object') { const child = Array.isArray(item) ? [] : Object.create(null); target[key] = child; stack.push({ source: item as Record<string, unknown>, target: child }); }
      else target[key] = item;
    }
  }
  return root as T;
}
export function freezePatternData<T>(value: T): T {
  const stack: unknown[] = [value]; const seen = new Set<object>();
  while (stack.length) {
    const item = stack.pop(); if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item); for (const key of Object.keys(item)) stack.push((item as Record<string, unknown>)[key]); Object.freeze(item);
  }
  return value;
}
export function stringifyPatternData(value: unknown): string {
  const chunks: string[] = []; const stack: ({ value: unknown } | { literal: string })[] = [{ value }];
  while (stack.length) {
    const task = stack.pop()!;
    if ('literal' in task) { chunks.push(task.literal); continue; }
    const item = task.value;
    if (!item || typeof item !== 'object') { chunks.push(JSON.stringify(item)); continue; }
    const array = Array.isArray(item); const entries = Object.entries(item);
    chunks.push(array ? '[' : '{'); stack.push({ literal: array ? ']' : '}' });
    for (let i = entries.length - 1; i >= 0; --i) { const [key, entry] = entries[i]!; if (i < entries.length - 1) stack.push({ literal: ',' }); stack.push({ value: entry }); if (!array) stack.push({ literal: `${JSON.stringify(key)}:` }); }
  }
  return chunks.join('');
}
