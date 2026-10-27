import { createHash } from 'node:crypto';
import type { JsonSchema, JsonValue, SchemaError } from './types.js';

export const schemaDialect = 'draft-07/flow-subset-2';
const keywords = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'title', 'description', 'default', 'examples', 'readOnly', 'writeOnly', '$comment']);
const simpleTypes = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);

type SchemaNode = boolean | Readonly<{
  types: ReadonlySet<string> | undefined;
  oneOf: readonly SchemaNode[] | undefined;
  properties: ReadonlyMap<string, SchemaNode>;
  required: ReadonlySet<string>;
  additionalProperties: SchemaNode;
  items: SchemaNode | readonly SchemaNode[];
  enumValues: ReadonlySet<string> | undefined;
  constValue: string | undefined;
  minimum: number | undefined;
  maximum: number | undefined;
}>;

export function assertJson(value: unknown, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value) throw new TypeError('Value is not legal JSON');
  if (ancestors.has(value)) throw new TypeError('JSON must not contain cycles');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('JSON objects must be plain records');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('JSON must not contain symbol properties');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('JSON array entries must be enumerable values');
      assertJson(descriptor.value, ancestors);
    }
    if (Object.keys(value).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new TypeError('JSON arrays must not contain named properties');
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('JSON properties must be enumerable values');
      assertJson(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}
export function canonicalJson(value: unknown): string {
  assertJson(value);
  const encode = (item: JsonValue): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item !== null && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key]!)}`).join(',')}}`;
    return JSON.stringify(item);
  };
  return encode(value);
}
export function digestJson(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}
function invalidSchema(path: string, reason: string): never {
  throw new TypeError(`Invalid result schema at ${JSON.stringify(path)}: ${reason}`);
}
function compileNode(schema: JsonValue, path: string): SchemaNode {
  if (typeof schema === 'boolean') return schema;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return invalidSchema(path, 'expected an object or boolean schema');
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new TypeError(`Unsupported schema keyword ${pointer(path, key)}`);
  for (const key of ['title', 'description', '$comment']) {
    if (Object.hasOwn(schema, key) && typeof schema[key] !== 'string') invalidSchema(pointer(path, key), 'expected a string annotation');
  }
  for (const key of ['readOnly', 'writeOnly']) {
    if (Object.hasOwn(schema, key) && typeof schema[key] !== 'boolean') invalidSchema(pointer(path, key), 'expected a boolean annotation');
  }
  if (Object.hasOwn(schema, 'examples') && !Array.isArray(schema.examples)) invalidSchema(pointer(path, 'examples'), 'expected an array annotation');

  let types: ReadonlySet<string> | undefined;
  if (Object.hasOwn(schema, 'type')) {
    const value = schema.type;
    const entries = Array.isArray(value) ? value : [value];
    const selected = new Set<string>();
    if (!entries.length) invalidSchema(pointer(path, 'type'), 'expected at least one type');
    for (const entry of entries) {
      if (typeof entry !== 'string' || !simpleTypes.has(entry) || selected.has(entry)) invalidSchema(pointer(path, 'type'), 'expected unique JSON type names');
      selected.add(entry);
    }
    types = selected;
  }
  const compileArray = (value: JsonValue | undefined, key: string): readonly SchemaNode[] => {
    if (!Array.isArray(value) || !value.length) return invalidSchema(pointer(path, key), 'expected a nonempty schema array');
    return Object.freeze(value.map((child, index) => compileNode(child, pointer(pointer(path, key), index))));
  };
  const oneOf = Object.hasOwn(schema, 'oneOf') ? compileArray(schema.oneOf, 'oneOf') : undefined;
  const properties = new Map<string, SchemaNode>();
  if (Object.hasOwn(schema, 'properties')) {
    const value = schema.properties;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidSchema(pointer(path, 'properties'), 'expected a schema mapping');
    for (const [key, child] of Object.entries(value)) properties.set(key, compileNode(child, pointer(pointer(path, 'properties'), key)));
  }
  const required = new Set<string>();
  if (Object.hasOwn(schema, 'required')) {
    const value = schema.required;
    if (!Array.isArray(value)) invalidSchema(pointer(path, 'required'), 'expected an array of unique strings');
    for (const key of value) {
      if (typeof key !== 'string' || required.has(key)) invalidSchema(pointer(path, 'required'), 'expected an array of unique strings');
      required.add(key);
    }
  }
  const additionalProperties = Object.hasOwn(schema, 'additionalProperties') ? compileNode(schema.additionalProperties!, pointer(path, 'additionalProperties')) : true;
  let items: SchemaNode | readonly SchemaNode[] = true;
  if (Object.hasOwn(schema, 'items')) {
    items = Array.isArray(schema.items) ? compileArray(schema.items, 'items') : compileNode(schema.items!, pointer(path, 'items'));
  }
  let enumValues: ReadonlySet<string> | undefined;
  if (Object.hasOwn(schema, 'enum')) {
    const value = schema.enum;
    if (!Array.isArray(value) || !value.length) invalidSchema(pointer(path, 'enum'), 'expected a nonempty array of unique JSON values');
    const selected = new Set<string>();
    for (const entry of value) {
      const encoded = canonicalJson(entry);
      if (selected.has(encoded)) invalidSchema(pointer(path, 'enum'), 'expected unique JSON values');
      selected.add(encoded);
    }
    enumValues = selected;
  }
  for (const key of ['minimum', 'maximum']) {
    if (Object.hasOwn(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) invalidSchema(pointer(path, key), 'expected a finite number');
  }
  return Object.freeze({
    types, oneOf, properties, required, additionalProperties, items, enumValues,
    constValue: Object.hasOwn(schema, 'const') ? canonicalJson(schema.const) : undefined,
    minimum: Object.hasOwn(schema, 'minimum') ? schema.minimum as number : undefined,
    maximum: Object.hasOwn(schema, 'maximum') ? schema.maximum as number : undefined,
  });
}
function matchesType(value: JsonValue, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}
function validateNode(node: SchemaNode, value: JsonValue, path: string, errors: SchemaError[]): void {
  if (node === true) return;
  if (node === false) { errors.push({ path, message: 'Boolean schema forbids this value' }); return; }
  if (node.types && !Array.from(node.types).some(type => matchesType(value, type))) errors.push({ path, message: `Expected type ${Array.from(node.types).join(' or ')}` });
  if (node.constValue !== undefined && canonicalJson(value) !== node.constValue) errors.push({ path, message: 'Value must equal const' });
  if (node.enumValues && !node.enumValues.has(canonicalJson(value))) errors.push({ path, message: 'Value must equal one of enum' });
  if (node.oneOf) {
    let matches = 0;
    for (const branch of node.oneOf) {
      const branchErrors: SchemaError[] = [];
      validateNode(branch, value, path, branchErrors);
      if (!branchErrors.length) matches++;
    }
    if (matches !== 1) errors.push({ path, message: `Expected exactly one matching oneOf branch; matched ${matches}` });
  }
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) errors.push({ path, message: `Value must be >= ${node.minimum}` });
    if (node.maximum !== undefined && value > node.maximum) errors.push({ path, message: `Value must be <= ${node.maximum}` });
  } else if (Array.isArray(value)) {
    const items = node.items;
    if (Array.isArray(items)) {
      for (let index = 0; index < Math.min(items.length, value.length); index++) validateNode(items[index]!, value[index]!, pointer(path, index), errors);
    } else {
      for (let index = 0; index < value.length; index++) validateNode(items as SchemaNode, value[index]!, pointer(path, index), errors);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of node.required) if (!Object.hasOwn(value, key)) errors.push({ path, message: `Missing required property ${JSON.stringify(key)}` });
    for (const key of Object.keys(value)) {
      const child = node.properties.get(key) ?? node.additionalProperties;
      validateNode(child, value[key]!, pointer(path, key), errors);
    }
  }
}
export function compileSchema(schema: JsonSchema): { dialect: string; digest: string; validate(result: unknown): SchemaError[] } {
  assertJson(schema);
  const node = compileNode(schema, '');
  return {
    dialect: schemaDialect, digest: digestJson({ dialect: schemaDialect, schema }),
    validate(result) {
      try { assertJson(result); }
      catch (error) { return [{ path: '', message: error instanceof Error ? error.message : String(error) }]; }
      const errors: SchemaError[] = [];
      validateNode(node, result, '', errors);
      return errors;
    },
  };
}
