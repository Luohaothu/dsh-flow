export function snapshotData<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (item === null || (typeof item !== 'object' && typeof item !== 'function' && typeof item !== 'symbol')) return;
    if (typeof item !== 'object') throw new TypeError('Message data cannot contain functions or symbols');
    if (seen.has(item)) return;
    seen.add(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype === Object.prototype || prototype === null || Array.isArray(item)) {
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Snapshot properties must be enumerable data properties');
        visit(descriptor.value);
      }
    } else if (prototype === Map.prototype) {
      for (const [key, value] of item as Map<unknown, unknown>) { visit(key); visit(value); }
    } else if (prototype === Set.prototype) {
      for (const value of item as Set<unknown>) visit(value);
    } else if (ArrayBuffer.isView(item)) {
      if (Object.getPrototypeOf(item.buffer) !== ArrayBuffer.prototype) throw new TypeError('Shared buffers cannot be snapshotted');
    } else if (prototype !== Date.prototype && prototype !== ArrayBuffer.prototype) {
      throw new TypeError('Unsupported snapshot data prototype');
    }
  };
  visit(value);
  return structuredClone(value);
}

export function freezeData<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item)) throw new TypeError('Configuration must contain ordinary data records and arrays');
    for (const key of Object.keys(item)) freeze((item as Record<string, unknown>)[key]);
    Object.freeze(item);
  };
  freeze(value);
  return value;
}
