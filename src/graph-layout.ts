import Layout from './vendor/enhancing-mindmap/Layout';
import { Box, LayoutHost, LayoutNode } from './vendor/enhancing-mindmap/types';
import { TaskNode, Tree } from './model';

export interface Curve { owner: string; d: string; color: string; width: number; }
export interface GraphNode extends LayoutNode { parent?: GraphNode; children: GraphNode[]; task?: TaskNode; box: Box; level: number; }
export interface GraphGeometry { root: GraphNode; nodes: Map<string, GraphNode>; curves: Map<string, Curve[]>; bounds: Box; order: GraphNode[]; }
export const GRAPH_ROOT = '__task_root__';
const colors = ['#6585cc', '#41a390', '#ae85c7', '#d49a54', '#d27486', '#639eaf'];
export function bounds(nodes: LayoutNode[]): Box {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0, right: 0, bottom: 0 };
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) { const b = node.getBox(); x = Math.min(x, b.x); y = Math.min(y, b.y); right = Math.max(right, b.x + b.width); bottom = Math.max(bottom, b.y + b.height); }
  return { x, y, width: right - x, height: bottom - y, right, bottom };
}
export function titleSize(title: string, task = false, measure?: (text: string) => number): { width: number; height: number } {
  const textWidth = measure ? measure(title) : [...title].reduce((w, c) => w + (/[^\x00-\xff]/.test(c) ? 13 : 7), 0);
  return { width: Math.min(420, Math.max(44, textWidth + (task ? 32 : 14))), height: 24 };
}
export function layoutGraph(tree: Tree, include: Set<string>, collapsed: Set<string>, focus?: string,
  direction: 'mindmap' | 'right' = 'mindmap', measure?: (text: string) => number): GraphGeometry {
  const curves = new Map<string, Curve[]>(); let owner = '';
  const recorder = {
    clear() { curves.clear(); }, group() { return this; },
    path() {
      const curve: Curve = { owner, d: '', color: '', width: 2 };
      const shape = { stroke(style: { color: string; width: number }) { curve.color = style.color; curve.width = style.width; return shape; },
        fill(_value: string) { return shape; }, plot(d: string) { curve.d = d; const list = curves.get(curve.owner) ?? []; list.push(curve); curves.set(curve.owner, list); return shape; } };
      return shape;
    },
    line(x1: number, y1: number, x2: number, y2: number) { const shape = this.path(); shape.plot(`M${x1} ${y1} L${x2} ${y2}`); return shape; }
  };
  const order: GraphNode[] = [], nodes = new Map<string, GraphNode>();
  const host: LayoutHost = { edgeGroup: recorder,
    traverseDF(callback) {
      const pending: { node: LayoutNode; done: boolean }[] = [{ node: root, done: false }];
      while (pending.length) {
        const item = pending.pop()!;
        if (item.done) callback(item.node);
        else { pending.push({ node: item.node, done: true }); for (let i = item.node.children.length - 1; i >= 0; i--) pending.push({ node: item.node.children[i], done: false }); }
      }
    },
    getBoundingRect: bounds };
  const make = (task: TaskNode | undefined, parent?: GraphNode): GraphNode => {
    const id = task?.id ?? GRAPH_ROOT, classes = new Set<string>(), size = titleSize(task?.title ?? 'root', task?.kind === 'task', measure);
    const node: GraphNode = {
      id, task, parent, children: [], direct: '', stroke: '', isExpand: !collapsed.has(id), mindmap: host,
      level: parent ? parent.level + 1 : 0, box: { x: 0, y: 0, ...size },
      containEl: { classList: { add(...names) { names.forEach(n => classes.add(n)); }, remove(...names) { names.forEach(n => classes.delete(n)); }, contains(name) { return classes.has(name); } } },
      _barDom: { style: {} },
      isLeaf() { return !node.children.length; }, isShow() { return true; }, getLevel() { return node.level; }, refreshBox() {},
      getBox() { return { ...node.box }; }, getCBox() { return { ...node.box }; }, getPosition() { return { x: node.box.x, y: node.box.y }; },
      setPosition(x, y) { node.box.x = x; node.box.y = y; }, move(dx, dy) { node.box.x += dx; node.box.y += dy; },
      getChildren() { return node.children; }, getSiblings() { return node.parent?.children.filter(n => n !== node) ?? []; },
      getShowNodeList() { const result: LayoutNode[] = [], pending: LayoutNode[] = [node]; while (pending.length) { const next = pending.pop()!; result.push(next); if (next.isExpand) for (const child of next.children) pending.push(child); } return result; }
    };
    Object.defineProperty(node._barDom.style, 'backgroundColor', { set(_value) { owner = id; } });
    nodes.set(id, node); order.push(node); return node;
  };
  const root = make(focus ? tree.byId.get(focus) : undefined);
  const pending = [...(root.isExpand ? tree.children.get(focus ?? null) ?? [] : [])].reverse().map(task => ({ task, parent: root }));
  while (pending.length) {
    const { task, parent } = pending.pop()!; if (!include.has(task.id)) continue;
    const node = make(task, parent); parent.children.push(node);
    if (!node.isExpand) continue;
    const children = tree.children.get(task.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push({ task: children[i], parent: node });
  }
  // Fork's actual balanced layout and cubic connection implementation, behind a DOM-free host.
  new Layout(root, direction, colors, { levelDis: 24, nodeDis: 4, firstLevelDis: 40, firstNodeDis: 10 });
  return { root, nodes, curves, bounds: bounds(order), order };
}
