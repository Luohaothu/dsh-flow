import type { AgentCard, GroupView } from '../dashboard/protocol.js';
import { visibleAncestor, type VisibleNode } from './derive.js';
import type { Viewport } from './types.js';

export interface Rect { x: number; y: number; width: number; height: number }
export interface TreeGeometry { cards: Map<string, Rect>; width: number; height: number }
export interface Relation { id: string; from: string; to: string; path: string; firstLevel: boolean }
export interface GroupSegment { key: string; group: GroupView; rect: Rect; hidden: number; labelX?: number }
export function union(rects: readonly Rect[]): Rect { if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 }; const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y)); return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y }; }
export function layoutTree(visible: readonly VisibleNode[], heights: ReadonlyMap<string, number>, availableWidth: number, groups: readonly GroupView[], list = false): TreeGeometry {
  const cards = new Map<string, Rect>(), height = (id: string) => heights.get(id) ?? 170;
  const activeGroups = groups.filter(group => !group.dissolved), memberships = (id: string) => activeGroups.filter(group => group.members.includes(id)).map(group => group.id);
  const gap = (previous: string | undefined, id: string) => previous && (memberships(previous).some(g => !memberships(id).includes(g)) || memberships(id).some(g => !memberships(previous).includes(g))) ? 60 : 12;
  if (availableWidth < 560 || list) {
    let y = 32, previous: string | undefined;
    for (const item of visible) { if (previous) y += gap(previous, item.node.id); cards.set(item.node.id, { x: 32 + item.depth * 32, y, width: 216, height: height(item.node.id) }); y += height(item.node.id); previous = item.node.id; }
    const bounds = union([...cards.values()]); return { cards, width: Math.max(availableWidth, bounds.x + bounds.width + 32), height: y + 32 };
  }
  const roots = visible.filter(item => item.depth === 0), branches = new Map<string, VisibleNode[]>();
  for (const item of visible) if (item.depth > 0) { const branch = branches.get(item.branchId) ?? []; branch.push(item); branches.set(item.branchId, branch); }
  const widths = [...branches].map(([id, items]) => ({ id, width: Math.max(248, ...items.map(item => 248 + (item.depth - 1) * 32)) }));
  const totalWidth = widths.reduce((value, branch) => value + branch.width, 0) + Math.max(0, widths.length - 1) * 56;
  const width = Math.max(availableWidth, totalWidth + 64, roots.length * 248 + 64), topHeight = Math.max(0, ...roots.map(root => height(root.node.id)));
  roots.forEach((root, index) => cards.set(root.node.id, { x: width / 2 - roots.length * 248 / 2 + index * 248 + 16, y: 32, width: 216, height: height(root.node.id) }));
  let x = (width - totalWidth) / 2, bottom = topHeight + 64;
  for (const branch of widths) { let y = 32 + topHeight + 40, previous: string | undefined; for (const item of branches.get(branch.id)!) { if (previous) y += gap(previous, item.node.id); cards.set(item.node.id, { x: x + 16 + (item.depth - 1) * 32, y, width: 216, height: height(item.node.id) }); y += height(item.node.id); previous = item.node.id; } bottom = Math.max(bottom, y + 32); x += branch.width + 56; }
  return { cards, width, height: bottom };
}
export function relationPath(parent: Rect, child: Rect, firstLevel: boolean): string {
  if (firstLevel) { const x1 = parent.x + parent.width / 2, y1 = parent.y + parent.height, x2 = child.x + child.width / 2, y2 = child.y, middle = y1 + (y2 - y1) / 2; return `M ${x1} ${y1} V ${middle} H ${x2} V ${y2}`; }
  const x = child.x - 16, y = child.y + 24; return `M ${parent.x + 16} ${parent.y + parent.height} V ${y - 8} Q ${parent.x + 16} ${y} ${x + 8} ${y} H ${child.x}`;
}
export function relations(visible: readonly VisibleNode[], cards: ReadonlyMap<string, Rect>, wide: boolean): Relation[] { return visible.flatMap(item => { const parent = item.parentId ? cards.get(item.parentId) : undefined, child = cards.get(item.node.id); return parent && child ? [{ id: `${item.parentId}/${item.node.id}`, from: item.parentId!, to: item.node.id, path: relationPath(parent, child, wide && item.depth === 1), firstLevel: wide && item.depth === 1 }] : []; }); }
export function groupSegments(groups: readonly GroupView[], visible: readonly VisibleNode[], cards: ReadonlyMap<string, Rect>, nodes: readonly AgentCard[], wide: boolean): GroupSegment[] {
  const result: GroupSegment[] = [], visibleIds = new Set(visible.map(item => item.node.id));
  for (const group of groups.filter(group => !group.dissolved)) {
    const hidden = group.members.filter(id => !visibleIds.has(id) && visibleAncestor(id, visibleIds, nodes)).length;
    const members = new Set(group.members);
    const memberRects = visible.flatMap(item => { const rect = cards.get(item.node.id); return members.has(item.node.id) && rect ? [rect] : []; });
    if (memberRects.length) {
      const box = union(memberRects), frame = { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 };
      const obstructed = visible.some(item => {
        const rect = cards.get(item.node.id);
        return !members.has(item.node.id) && rect !== undefined
          && frame.x < rect.x + rect.width + 8 && frame.x + frame.width + 8 > rect.x
          && frame.y < rect.y + rect.height + 8 && frame.y + frame.height + 8 > rect.y;
      });
      if (!obstructed) {
        const top = memberRects.reduce((first, rect) => rect.y < first.y || rect.y === first.y && rect.x < first.x ? rect : first);
        result.push({ key: `${group.id}/0`, group, hidden, rect: frame, labelX: top.x - 12 });
        continue;
      }
    }
    const buckets = new Map<string, VisibleNode[]>();
    for (const item of visible) { const key = wide ? item.branchId : 'all', list = buckets.get(key) ?? []; list.push(item); buckets.set(key, list); }
    let segment = 0;
    for (const items of buckets.values()) { let run: Rect[] = []; const flush = () => { if (!run.length) return; const box = union(run); result.push({ key: `${group.id}/${segment++}`, group, hidden, rect: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } }); run = []; }; for (const item of items) { if (members.has(item.node.id)) { const rect = cards.get(item.node.id); if (rect) run.push(rect); } else flush(); } flush(); }
  }
  return result;
}
export function deliveryPath(from: string, to: string, nodes: readonly AgentCard[], geometry: TreeGeometry, edges: readonly Relation[]): { path: string; direct: boolean; from: string; to: string } | null {
  const visible = new Set(geometry.cards.keys()), start = visibleAncestor(from, visible, nodes), end = visibleAncestor(to, visible, nodes); if (!start || !end) return null;
  const edge = edges.find(item => item.from === start && item.to === end || item.from === end && item.to === start);
  if (edge) { const parent = geometry.cards.get(edge.from)!, child = geometry.cards.get(edge.to)!; const path = start === edge.from ? edge.path : reverseRelation(parent, child, edge.firstLevel); return { path, direct: true, from: start, to: end }; }
  const a = geometry.cards.get(start)!, b = geometry.cards.get(end)!;
  return { path: routeAroundCards(a, b, [...geometry.cards.values()]), direct: false, from: start, to: end };
}
interface Point { x: number; y: number }
export function routeAroundCards(from: Rect, to: Rect, cards: readonly Rect[]): string {
  const ports = (rect: Rect) => [
    { point: { x: rect.x + rect.width + 8, y: rect.y + rect.height / 2 }, edge: { x: rect.x + rect.width, y: rect.y + rect.height / 2 } },
    { point: { x: rect.x - 8, y: rect.y + rect.height / 2 }, edge: { x: rect.x, y: rect.y + rect.height / 2 } },
    { point: { x: rect.x + rect.width / 2, y: rect.y - 8 }, edge: { x: rect.x + rect.width / 2, y: rect.y } },
    { point: { x: rect.x + rect.width / 2, y: rect.y + rect.height + 8 }, edge: { x: rect.x + rect.width / 2, y: rect.y + rect.height } },
  ];
  if (from === to) { const x = from.x + from.width, y = from.y + from.height / 2; return `M ${x} ${y - 8} C ${x + 32} ${y - 32} ${x + 32} ${y + 32} ${x} ${y + 8}`; }
  const starts = ports(from), ends = ports(to), obstacles = cards.map(rect => ({ x: rect.x - 4, y: rect.y - 4, width: rect.width + 8, height: rect.height + 8 }));
  const xs = [...new Set([...obstacles.flatMap(rect => [rect.x, rect.x + rect.width]), ...starts.map(port => port.point.x), ...ends.map(port => port.point.x)])].sort((a, b) => a - b);
  const ys = [...new Set([...obstacles.flatMap(rect => [rect.y, rect.y + rect.height]), ...starts.map(port => port.point.y), ...ends.map(port => port.point.y)])].sort((a, b) => a - b);
  const key = (point: Point) => xs.indexOf(point.x) * ys.length + ys.indexOf(point.y), point = (index: number): Point => ({ x: xs[Math.floor(index / ys.length)]!, y: ys[index % ys.length]! });
  const inside = (p: Point, rect: Rect) => p.x > rect.x && p.x < rect.x + rect.width && p.y > rect.y && p.y < rect.y + rect.height;
  const clear = (a: Point, b: Point) => !obstacles.some(rect => inside(a, rect) || inside(b, rect) || (a.x === b.x ? a.x > rect.x && a.x < rect.x + rect.width && Math.max(a.y, b.y) > rect.y && Math.min(a.y, b.y) < rect.y + rect.height : a.y > rect.y && a.y < rect.y + rect.height && Math.max(a.x, b.x) > rect.x && Math.min(a.x, b.x) < rect.x + rect.width));
  const targets = new Map(ends.filter(port => !obstacles.some(rect => inside(port.point, rect))).map(port => [key(port.point), port.edge]));
  const distance = new Map<number, number>(), previous = new Map<number, number>(), beginnings = new Map<number, Point>(), queue: { index: number; cost: number; score: number }[] = [];
  const heuristic = (p: Point) => Math.min(...ends.map(end => Math.abs(p.x - end.point.x) + Math.abs(p.y - end.point.y)));
  const push = (entry: { index: number; cost: number; score: number }) => { let index = queue.length; queue.push(entry); while (index > 0) { const parent = (index - 1) >> 1; if (queue[parent]!.score <= entry.score) break; queue[index] = queue[parent]!; index = parent; } queue[index] = entry; };
  const pop = () => { const first = queue[0]!, last = queue.pop()!; if (queue.length) { let index = 0; while (true) { let child = index * 2 + 1; if (child >= queue.length) break; if (child + 1 < queue.length && queue[child + 1]!.score < queue[child]!.score) child++; if (last.score <= queue[child]!.score) break; queue[index] = queue[child]!; index = child; } queue[index] = last; } return first; };
  for (const start of starts) if (!obstacles.some(rect => inside(start.point, rect))) { const index = key(start.point); distance.set(index, 0); beginnings.set(index, start.edge); push({ index, cost: 0, score: heuristic(start.point) }); }
  while (queue.length) {
    const current = pop(); if (current.cost !== distance.get(current.index)) continue;
    const end = targets.get(current.index);
    if (end) { const path = [end, point(current.index)]; let index = current.index; while (previous.has(index)) { index = previous.get(index)!; path.push(point(index)); } path.push(beginnings.get(index)!); path.reverse(); return path.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '); }
    const x = Math.floor(current.index / ys.length), y = current.index % ys.length, a = point(current.index);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) { if (nx === undefined || ny === undefined || nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue; const index = nx * ys.length + ny, b = point(index); if (!clear(a, b)) continue; const cost = current.cost + Math.abs(a.x - b.x) + Math.abs(a.y - b.y); if (cost >= (distance.get(index) ?? Infinity)) continue; distance.set(index, cost); previous.set(index, current.index); push({ index, cost, score: cost + heuristic(b) }); }
  }
  const bounds = union(cards), x = bounds.x + bounds.width + 24;
  return `M ${from.x + from.width} ${from.y + from.height / 2} H ${x} V ${to.y + to.height / 2} H ${to.x + to.width}`;
}
function reverseRelation(parent: Rect, child: Rect, wide: boolean): string {
  const x1 = parent.x + parent.width / 2, y1 = parent.y + parent.height, x2 = child.x + child.width / 2, y2 = child.y;
  if (wide) { const middle = y1 + (y2 - y1) / 2; return `M ${x2} ${y2} V ${middle} H ${x1} V ${y1}`; }
  const x = child.x - 16, y = child.y + 24; return `M ${child.x} ${y} H ${x + 8} Q ${parent.x + 16} ${y} ${parent.x + 16} ${y - 8} V ${parent.y + parent.height}`;
}
export function fitViewport(bounds: Rect, width: number, height: number): Viewport { const scale = Math.max(0.2, Math.min(1.5, (width - 64) / Math.max(1, bounds.width), (height - 64) / Math.max(1, bounds.height))); return { scale, x: (width - bounds.width * scale) / 2 - bounds.x * scale, y: (height - bounds.height * scale) / 2 - bounds.y * scale }; }
