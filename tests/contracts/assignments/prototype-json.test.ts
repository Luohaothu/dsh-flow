import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSchema } from '../../../packages/dsh-flow/src/assignments/schema.js';

const prototypeKeys = [
  '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__',
  '__lookupSetter__', 'toLocaleString',
];

for (const key of prototypeKeys) {
  test(`schema properties treats ${key} as an optional own JSON field`, () => {
    const schema = { type: 'object', properties: Object.fromEntries([[key, { type: 'number' }]]), additionalProperties: false };
    const values = [{}, Object.fromEntries([[key, 7]]), Object.fromEntries([[key, 'wrong']])];
    const schemaBefore = structuredClone(schema);
    const valuesBefore = structuredClone(values);
    const compiled = compileSchema(schema);
    const errors = values.map(value => compiled.validate(value));
    assert.deepEqual(errors.map(value => value.length === 0), [true, true, false]);
    assert.deepEqual(errors[2]!.map(error => error.path), [`/${key}`]);
    assert.ok(errors[2]!.every(error => error.message.length > 0));
    assert.deepEqual(schema, schemaBefore);
    assert.deepEqual(values, valuesBefore);
  });

  test(`schema required ${key} cannot be supplied by Object.prototype`, () => {
    const schema = { type: 'object', required: [key] };
    const compiled = compileSchema(schema);
    const errors = [{}, Object.fromEntries([[key, null]])].map(value => compiled.validate(value));
    assert.deepEqual(errors.map(value => value.length === 0), [false, true]);
    assert.deepEqual(errors[0]!.map(error => error.path), ['']);
    assert.ok(errors[0]!.every(error => error.message.length > 0));
  });

  test(`schema const and enum compare own ${key} fields structurally`, () => {
    const expected = Object.fromEntries([[key, { nested: [null, 1] }], ['ordinary', true]]);
    const equal = Object.fromEntries([['ordinary', true], [key, { nested: [null, 1] }]]);
    const changed = Object.fromEntries([['ordinary', true], [key, { nested: [null, 2] }]]);
    const values = [equal, changed, { ordinary: true }, { ...equal, extra: 0 }];
    const schemas = [{ const: expected }, { enum: [expected, null] }];
    const schemaBefore = structuredClone(schemas);
    const valuesBefore = structuredClone(values);
    const actual = schemas.map(schema => {
      const compiled = compileSchema(schema);
      return values.map(value => compiled.validate(value).length === 0);
    });
    assert.deepEqual(actual, [[true, false, false, false], [true, false, false, false]]);
    assert.deepEqual(schemas, schemaBefore);
    assert.deepEqual(values, valuesBefore);
  });
}

test('schema composes own JSON fields through nested objects, oneOf, tuples and additionalProperties', () => {
  const schema = {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: Object.fromEntries([['__proto__', {
          oneOf: [
            { type: 'array', items: [{ type: 'object', required: ['constructor'], properties: { constructor: { type: 'number' } }, additionalProperties: false }, { const: 'done' }] },
            { const: null },
          ],
        }]]),
        required: ['__proto__'],
        additionalProperties: { type: 'object', required: ['valueOf'], properties: { valueOf: { type: 'boolean' } }, additionalProperties: false },
      },
    },
    required: ['nested'],
    additionalProperties: false,
  };
  const values = [
    JSON.parse('{"nested":{"__proto__":[{"constructor":2},"done",true],"toString":{"valueOf":false}}}'),
    JSON.parse('{"nested":{"__proto__":null}}'),
    JSON.parse('{"nested":{"__proto__":[{},"done"]}}'),
    JSON.parse('{"nested":{"__proto__":[{"constructor":"2"},"done"]}}'),
    JSON.parse('{"nested":{"__proto__":null,"toString":{}}}'),
    JSON.parse('{"nested":{"__proto__":null,"toString":{"valueOf":"false"}}}'),
  ];
  const schemaBefore = structuredClone(schema);
  const valuesBefore = structuredClone(values);
  const compiled = compileSchema(schema);
  const errors = values.map(value => compiled.validate(value));
  assert.deepEqual(errors.map(value => value.length === 0), [true, true, false, false, false, false]);
  assert.deepEqual(errors[4]!.map(error => error.path), ['/nested/toString']);
  assert.deepEqual(errors[5]!.map(error => error.path), ['/nested/toString/valueOf']);
  assert.deepEqual(schema, schemaBefore);
  assert.deepEqual(values, valuesBefore);
});

test('schema preserves empty, Unicode, lone-surrogate and escaped JSON field paths', () => {
  const keys = ['', '中文🧪', '\ud800', '~', '/', 'a~/b'];
  const expectedPaths = [['//1'], ['/中文🧪/1'], ['/\ud800/1'], ['/~0/1'], ['/~1/1'], ['/a~0~1b/1']];
  const results = keys.map(key => {
    const schema = { properties: Object.fromEntries([[key, { type: 'array', items: { type: 'number' } }]]) };
    const compiled = compileSchema(schema);
    const value = Object.fromEntries([[key, [1, 'wrong']]]);
    const before = structuredClone(value);
    return { errors: compiled.validate(value), value, before };
  });
  assert.deepEqual(results.map(result => result.errors.map(error => error.path)), expectedPaths);
  assert.ok(results.every(result => result.errors.every(error => error.message.length > 0)));
  assert.deepEqual(results.map(result => result.value), results.map(result => result.before));
});

test('schema additionalProperties reports the escaped own field and required reports its container', () => {
  const compiled = compileSchema({ properties: { 'a~/b': { type: 'object', required: ['__proto__'] } }, additionalProperties: false });
  const extra = compiled.validate(JSON.parse('{"__proto__":1,"~/":2}'));
  const missing = compiled.validate({ 'a~/b': {} });
  assert.deepEqual(extra.map(error => error.path).sort(), ['/__proto__', '/~0~1']);
  assert.deepEqual(missing.map(error => error.path), ['/a~0~1b']);
  assert.ok([...extra, ...missing].every(error => error.message.length > 0));
});

test('schema accepts null-prototype JSON records without treating their fields as methods', () => {
  const data = Object.assign(Object.create(null) as Record<string, unknown>, JSON.parse('{"__proto__":null,"constructor":1,"toString":"text","valueOf":false}'));
  const schema = { const: data };
  const before = structuredClone(data);
  const errors = compileSchema(schema as never).validate(data);
  assert.deepEqual(errors, []);
  assert.deepEqual(structuredClone(data), before);
  assert.equal(Object.getPrototypeOf(data), null);
});

test('schema rejects prototype-named keywords only in schema positions', () => {
  const outcomes = ['__proto__', 'constructor', 'toString', 'valueOf'].map(key => {
    try {
      compileSchema(Object.fromEntries([[key, true]]));
      return 'accepted';
    } catch (error) {
      return error instanceof TypeError ? 'TypeError' : String(error);
    }
  });
  assert.deepEqual(outcomes, ['TypeError', 'TypeError', 'TypeError', 'TypeError']);
  const data = JSON.parse('{"__proto__":{"unknown":1},"constructor":2,"toString":false,"valueOf":null}');
  const schema = { const: data, default: data, examples: [data] };
  const schemaBefore = structuredClone(schema);
  assert.deepEqual(compileSchema(schema).validate(structuredClone(data)), []);
  assert.deepEqual(schema, schemaBefore);
});

test('schema meta rules reject empty tuples and duplicate enum values by JSON equality', () => {
  const invalid = [
    { items: [] },
    { enum: [0, -0] },
    { enum: [{ x: 1, y: [false] }, { y: [false], x: 1 }] },
    { enum: [JSON.parse('{"__proto__":1,"toString":2}'), JSON.parse('{"toString":2,"__proto__":1}')] },
    { enum: [JSON.parse('{"constructor":[{"valueOf":0}]}'), JSON.parse('{"constructor":[{"valueOf":0}]}')] },
    { type: 'constructor' },
    { type: ['number', 'toString'] },
    { properties: null },
    { oneOf: [true, 1] },
    { additionalProperties: [] },
  ];
  const before = structuredClone(invalid);
  const outcomes = invalid.map(schema => {
    try {
      compileSchema(schema as never);
      return 'accepted';
    } catch (error) {
      return error instanceof TypeError ? 'TypeError' : String(error);
    }
  });
  assert.deepEqual(outcomes, ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError']);
  assert.deepEqual(invalid, before);
});

test('schema meta rules preserve distinct JSON strings, object shapes and array order', () => {
  const schemas = [
    { type: 'object', required: [], properties: {} },
    { required: ['é', 'e\u0301'] },
    { enum: [JSON.parse('{"__proto__":1}'), JSON.parse('{"__proto__":2}'), {}] },
    { enum: [[1, 2], [2, 1]] },
    { items: [true, false] },
  ];
  const values = [{}, { 'é': null, 'e\u0301': null }, JSON.parse('{"__proto__":2}'), [2, 1], [null]];
  const before = structuredClone(schemas);
  const actual = schemas.map((schema, index) => compileSchema(schema as never).validate(values[index]).length === 0);
  assert.deepEqual(actual, [true, true, true, true, true]);
  assert.deepEqual(schemas, before);
  assert.ok(compileSchema({ items: [true, false] }).validate([null, null]).length > 0);
});
