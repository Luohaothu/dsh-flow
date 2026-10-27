import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSchema, schemaDialect } from '../../../packages/dsh-flow/src/assignments/schema.js';

const cases: { name: string; schema: unknown; valid: unknown[]; invalid: unknown[] }[] = [
  { name: 'type string', schema: { type: 'string' }, valid: ['', 'text'], invalid: [0, false, null, [], {}] },
  { name: 'type number', schema: { type: 'number' }, valid: [0, -2, 1.5], invalid: ['1', false, null] },
  { name: 'type integer', schema: { type: 'integer' }, valid: [0, -2], invalid: [1.5, '2'] },
  { name: 'type boolean', schema: { type: 'boolean' }, valid: [false, true], invalid: [0, 'false', null] },
  { name: 'type null', schema: { type: 'null' }, valid: [null], invalid: [false, 0, ''] },
  { name: 'type array', schema: { type: 'array' }, valid: [[], [null, false]], invalid: [{}, null] },
  { name: 'type object', schema: { type: 'object' }, valid: [{}, { x: false }], invalid: [[], null] },
  { name: 'type union', schema: { type: ['string', 'null'] }, valid: ['x', null], invalid: [0, false] },
  { name: 'oneOf exactly one', schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] }, valid: [1.5], invalid: [1, 'x'] },
  { name: 'properties', schema: { type: 'object', properties: { x: { type: 'boolean' } } }, valid: [{}, { x: false }, { y: 1 }], invalid: [{ x: 'false' }] },
  { name: 'required', schema: { type: 'object', required: ['x'] }, valid: [{ x: null }], invalid: [{}, { y: 1 }] },
  { name: 'additionalProperties false', schema: { type: 'object', properties: { x: {} }, additionalProperties: false }, valid: [{}, { x: 1 }], invalid: [{ y: 1 }] },
  { name: 'additionalProperties schema', schema: { type: 'object', additionalProperties: { type: 'number' } }, valid: [{}, { x: 1 }], invalid: [{ x: '1' }] },
  { name: 'items schema', schema: { type: 'array', items: { type: 'boolean' } }, valid: [[], [true, false]], invalid: [['false'], [null]] },
  { name: 'items tuple', schema: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] }, valid: [[], ['x', 1], ['x', 1, false]], invalid: [[1], ['x', '1']] },
  { name: 'enum structural equality', schema: { enum: [false, null, { x: [1] }] }, valid: [false, null, { x: [1] }], invalid: [true, 0, { x: [2] }] },
  { name: 'const structural equality', schema: { const: { x: [false, null] } }, valid: [{ x: [false, null] }], invalid: [{ x: [true, null] }, null] },
  { name: 'minimum inclusive', schema: { type: 'number', minimum: 2 }, valid: [2, 3], invalid: [1.9] },
  { name: 'maximum inclusive', schema: { type: 'number', maximum: 2 }, valid: [2, 1], invalid: [2.1] },
  { name: 'true schema', schema: true, valid: [null, false, 0, '', [], {}], invalid: [] },
  { name: 'false schema', schema: false, valid: [], invalid: [null, false, 0, '', [], {}] },
];

for (const entry of cases) {
  test(`schema validates ${entry.name} without coercing or mutating input`, () => {
    const originalSchema = structuredClone(entry.schema);
    const compiled = compileSchema(entry.schema as never);
    for (const value of entry.valid) {
      const before = structuredClone(value);
      assert.deepEqual(compiled.validate(value as never), [], `${entry.name}: ${JSON.stringify(value)}`);
      assert.deepEqual(value, before);
    }
    for (const value of entry.invalid) {
      const before = structuredClone(value);
      const errors = compiled.validate(value as never);
      assert.ok(errors.length > 0, `${entry.name}: ${JSON.stringify(value)}`);
      for (const error of errors) {
        assert.equal(typeof error.path, 'string');
        assert.ok(error.message.length > 0);
      }
      assert.deepEqual(value, before);
    }
    assert.deepEqual(entry.schema, originalSchema);
  });
}

test('schema exposes a versioned draft-07 dialect and repeatable content digest', () => {
  const schema = { type: 'number', minimum: 0 };
  const first = compileSchema(schema);
  assert.equal(first.dialect, schemaDialect);
  assert.match(first.dialect, /07/);
  assert.ok(first.digest.length > 0);
  assert.equal(first.digest, compileSchema(structuredClone(schema)).digest);
  assert.notEqual(first.digest, compileSchema({ ...schema, minimum: 1 }).digest);
});

test('schema rejects unknown keywords only at schema positions', () => {
  for (const schema of [
    { unknown: true },
    { properties: { x: { unknown: true } } },
    { oneOf: [{ unknown: true }] },
    { items: { unknown: true } },
    { items: [{ unknown: true }] },
    { additionalProperties: { unknown: true } },
  ]) assert.throws(() => compileSchema(schema as never));
  const data = { unknown: true, properties: { nested: { strangeKeyword: 42 } } };
  const schema = {
    type: 'object', properties: { unknown: { const: data }, const: { enum: [data] } },
    required: ['unknown', 'const'], additionalProperties: false,
    default: data, examples: [data],
  };
  assert.deepEqual(compileSchema(schema).validate({ unknown: data, const: data }), []);
});

test('draft-07 annotations do not impose result requirements or mutate results', () => {
  const schema = { title: 'Result', description: 'A result', $comment: 'annotation', default: { arbitrary: false }, examples: [null, { custom: true }], readOnly: true, writeOnly: false };
  const before = structuredClone(schema);
  const compiled = compileSchema(schema);
  for (const result of [null, false, 0, '', [], {}]) {
    const original = structuredClone(result);
    assert.deepEqual(compiled.validate(result), []);
    assert.deepEqual(result, original);
  }
  assert.deepEqual(schema, before);
});

test('schema rejects malformed keyword values and meta schemas before validation', () => {
  for (const schema of [
    null, [], 'string', 1, { type: 'unknown' }, { type: [] }, { type: ['string', 'string'] },
    { properties: [] }, { properties: { x: null } }, { required: 'x' }, { required: [1] }, { required: ['x', 'x'] },
    { additionalProperties: 1 }, { items: 1 }, { items: [null] }, { oneOf: [] }, { oneOf: {} },
    { enum: [] }, { minimum: '1' }, { maximum: null }, { title: 1 }, { description: false },
    { examples: {} }, { readOnly: 'yes' }, { writeOnly: null }, { $comment: false },
    { $schema: 'https://json-schema.org/draft/2020-12/schema' },
  ]) assert.throws(() => compileSchema(schema as never), JSON.stringify(schema));
});

test('schema rejects non-JSON schema data and non-JSON results', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const invalid = [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'), new Date(), cycle, { x: undefined }, [undefined], Array(1)];
  for (const value of invalid) {
    assert.throws(() => compileSchema({ const: value } as never));
    assert.ok(compileSchema({}).validate(value as never).length > 0);
  }
});
