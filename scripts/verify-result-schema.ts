import { compileSchema } from '../packages/dsh-flow/src/assignments/schema.js';
import type { JsonSchema } from '../packages/dsh-flow/src/assignments/types.js';
const keys = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'toLocaleString'];
const actors: Record<string, { cases: number; mismatches: unknown[] }> = {};
function check(actor: string, id: string, schema: JsonSchema, result: unknown, expected: boolean) {
  const row = actors[actor] ??= { cases: 0, mismatches: [] }; row.cases++;
  try {
    const actual = compileSchema(schema).validate(result).length === 0;
    if (actual !== expected) row.mismatches.push({ id, expected, actual });
  } catch (error) { row.mismatches.push({ id, expected, error: String(error) }); }
}
for (const key of keys) {
  const properties = Object.fromEntries([[key, { type: 'number' }]]);
  const schema = { type: 'object', properties, additionalProperties: false };
  check('properties', `${key}:optional-absent`, schema, {}, true);
  check('properties', `${key}:own-valid`, schema, Object.fromEntries([[key, 1]]), true);
  check('properties', `${key}:own-invalid`, schema, Object.fromEntries([[key, 'wrong']]), false);
  check('required', `${key}:absent`, { type: 'object', required: [key] }, {}, false);
  check('required', `${key}:own`, { type: 'object', required: [key] }, Object.fromEntries([[key, null]]), true);
  const value = Object.fromEntries([[key, 'value']]);
  check('const', `${key}:same`, { const: value }, value, true);
  check('const', `${key}:different`, { const: value }, Object.fromEntries([[key, 'different']]), false);
  check('enum', `${key}:same`, { enum: [value] }, value, true);
  check('enum', `${key}:different`, { enum: [value] }, Object.fromEntries([[key, 'different']]), false);
}
const cases = Object.values(actors).reduce((total, row) => total + row.cases, 0);
const mismatches = Object.values(actors).reduce((total, row) => total + row.mismatches.length, 0);
console.log(JSON.stringify({ cases, mismatches, actors }, null, 2));
if (mismatches) process.exitCode = 1;
