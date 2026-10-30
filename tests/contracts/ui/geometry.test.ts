import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleTree } from '../../../packages/dsh-flow/src/ui/derive.js';
import { deliveryPath, fitViewport, groupSegments, layoutTree, relations, routeAroundCards, union } from '../../../packages/dsh-flow/src/ui/geometry.js';
import { card, group } from './fixtures.js';

test('a lone root is centered in the measured canvas without reserving a details column', () => {
  const visible = visibleTree([card('root')], new Set()), heights = new Map([['root', 147]]);
  for (const width of [560, 1080, 1440]) { const geometry = layoutTree(visible, heights, width, []), root = geometry.cards.get('root')!; assert.equal(geometry.width, width); assert.equal(root.x + root.width / 2, width / 2); assert.equal(root.height, 147); }
});

test('560px uses measured-height branches, 559px uses preorder and 32px indentation', () => {
  const nodes = [card('r'), card('a', 'r'), card('deep', 'a'), card('b', 'r')], visible = visibleTree(nodes, new Set()), heights = new Map([['r', 150], ['a', 210], ['deep', 160], ['b', 120]]);
  const wide = layoutTree(visible, heights, 560, []), narrow = layoutTree(visible, heights, 559, []);
  assert.equal(wide.cards.get('a')!.y, 222); assert.equal(wide.cards.get('b')!.y, 222); assert.equal(wide.cards.get('deep')!.y, 444); assert.equal(wide.cards.get('deep')!.x - wide.cards.get('a')!.x, 32);
  assert.equal(narrow.cards.get('a')!.x - narrow.cards.get('r')!.x, 32); assert.equal(narrow.cards.get('deep')!.x - narrow.cards.get('a')!.x, 32); assert.ok(narrow.cards.get('b')!.y > narrow.cards.get('deep')!.y);
  const resized = layoutTree(visible, new Map([...heights, ['a', 300]]), 560, []); assert.equal(resized.cards.get('deep')!.y, wide.cards.get('deep')!.y + 90);
});
test('one group spanning a root and three branches has one padded frame', () => {
  const nodes = [card('r'), card('a', 'r'), card('b', 'r'), card('c', 'r')], groups = [group('g', ['r', 'a', 'b', 'c'])];
  const visible = visibleTree(nodes, new Set()), heights = new Map([['r', 160], ['a', 180], ['b', 190], ['c', 200]]);
  const geometry = layoutTree(visible, heights, 1080, groups), frames = groupSegments(groups, visible, geometry.cards, nodes, true);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]!.rect, { x: 104, y: 8, width: 872, height: 448 });
  assert.equal(frames[0]!.hidden, 0);
});
test('a clear cross-branch group merges even when other visible Agents are not members', () => {
  const nodes = [card('r'), card('a', 'r'), card('b', 'r'), card('c', 'r')], groups = [group('g', ['a', 'b'])];
  const visible = visibleTree(nodes, new Set()), geometry = layoutTree(visible, new Map([['r', 160], ['a', 180], ['b', 190], ['c', 200]]), 1080, groups);
  const frames = groupSegments(groups, visible, geometry.cards, nodes, true);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]!.rect, { x: 104, y: 208, width: 568, height: 238 });
});
test('a combined group frame requires at least 8px clearance from nonmembers', () => {
  const nodes = [card('r'), card('a', 'r'), card('b', 'r')], groups = [group('g', ['a', 'b'])], visible = visibleTree(nodes, new Set());
  const cards = new Map([['r', { x: 200, y: -132, width: 100, height: 100 }], ['a', { x: 0, y: 0, width: 100, height: 100 }], ['b', { x: 300, y: 300, width: 100, height: 100 }]]);
  const clear = groupSegments(groups, visible, cards, nodes, true);
  assert.equal(clear.length, 1);
  assert.deepEqual(clear[0]!.rect, { x: -24, y: -24, width: 448, height: 448 });
  cards.set('r', { x: 200, y: -131, width: 100, height: 100 });
  const obstructed = groupSegments(groups, visible, cards, nodes, true);
  assert.equal(obstructed.length, 2);
});
test('cross-branch groups split around nonmembers with 24px padding and preserve hidden membership labels', () => {
  const nodes = [card('r'), card('a', 'r'), card('gap', 'a'), card('c', 'gap'), card('b', 'r')], groups = [group('g', ['a', 'c', 'b'])], visible = visibleTree(nodes, new Set()), geometry = layoutTree(visible, new Map(), 800, groups), frames = groupSegments(groups, visible, geometry.cards, nodes, true);
  assert.equal(frames.length, 3); for (const frame of frames) { assert.equal(frame.rect.width, 264); const member = ['a', 'c', 'b'].map(id => geometry.cards.get(id)!).find(rect => rect.x - 24 === frame.rect.x && rect.y - 24 === frame.rect.y); assert.ok(member); }
  const folded = visibleTree(nodes, new Set(['a'])), foldedGeometry = layoutTree(folded, new Map(), 800, groups); assert.ok(groupSegments(groups, folded, foldedGeometry.cards, nodes, true).every(frame => frame.hidden === 1));
  const nonmember = geometry.cards.get('gap')!; assert.ok(frames.every(frame => frame.rect.y + frame.rect.height + 8 <= nonmember.y || frame.rect.y >= nonmember.y + nonmember.height + 8 || frame.rect.x + frame.rect.width + 8 <= nonmember.x || frame.rect.x >= nonmember.x + nonmember.width + 8));
});
test('delivery follows direct relation in both directions and falls back to visible ancestors', () => {
  const nodes = [card('r'), card('a', 'r'), card('hidden', 'a'), card('b', 'r')], visible = visibleTree(nodes, new Set(['a'])), geometry = layoutTree(visible, new Map(), 800, []), edges = relations(visible, geometry.cards, true);
  const forward = deliveryPath('r', 'a', nodes, geometry, edges), backward = deliveryPath('a', 'r', nodes, geometry, edges), folded = deliveryPath('hidden', 'r', nodes, geometry, edges), temporary = deliveryPath('a', 'b', nodes, geometry, edges);
  assert.equal(forward?.path, edges.find(edge => edge.to === 'a')!.path); assert.equal(backward?.direct, true); assert.notEqual(backward?.path, forward?.path); assert.equal(folded?.from, 'a'); assert.equal(temporary?.direct, false);
});
test('fit bounds includes every visible measured card with padding at the chosen scale', () => {
  const rect = union([{ x: 20, y: 50, width: 216, height: 200 }, { x: 800, y: 900, width: 216, height: 160 }]), viewport = fitViewport(rect, 700, 500);
  assert.ok(rect.x * viewport.scale + viewport.x >= 31); assert.ok((rect.x + rect.width) * viewport.scale + viewport.x <= 669); assert.ok(rect.y * viewport.scale + viewport.y >= 31); assert.ok((rect.y + rect.height) * viewport.scale + viewport.y <= 469);
});
test('temporary routes avoid a card between sender and recipient instead of crossing its content', () => {
  const from = { x: 0, y: 0, width: 216, height: 160 }, middle = { x: 260, y: 0, width: 216, height: 160 }, to = { x: 520, y: 0, width: 216, height: 160 };
  const path = routeAroundCards(from, to, [from, middle, to]); assert.ok(!path.includes('C'));
  const coordinates = [...path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) })); assert.ok(coordinates.length >= 4);
  for (let index = 1; index < coordinates.length; index++) { const a = coordinates[index - 1]!, b = coordinates[index]!; const crosses = a.x === b.x ? a.x > middle.x && a.x < middle.x + middle.width && Math.max(a.y, b.y) > middle.y && Math.min(a.y, b.y) < middle.y + middle.height : a.y > middle.y && a.y < middle.y + middle.height && Math.max(a.x, b.x) > middle.x && Math.min(a.x, b.x) < middle.x + middle.width; assert.equal(crosses, false); }
});
