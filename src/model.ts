export type Kind = 'task' | 'area';
export type Status = 'todo' | 'doing' | 'waiting' | 'done' | 'cancelled';
export interface TaskNode {
  id: string; parent: string | null; kind: Kind; title: string; notes: string;
  status: Status; importance: 'high' | 'medium' | 'low'; deadline: string;
  planned: string; estimate: number; actual: number; tags: string[];
  created: string; updated: string; completed: string;
  [key: string]: unknown;
}
export interface Board { version: 1; revision: string; nodes: TaskNode[]; }
export interface Batch {
  version: 1; id: string; kind: 'archive' | 'sleep'; time: string;
  state: 'prepared' | 'committed'; afterRevision: string;
  nodes: TaskNode[]; context: TaskNode[];
}
export const uid = (): string => `n-${crypto.randomUUID()}`;
export const now = (): string => new Date().toISOString();
export function emptyBoard(): Board { return { version: 1, revision: uid(), nodes: [] }; }
export function newNode(kind: Kind, parent: string | null = null): TaskNode {
  return { id: uid(), parent, kind, title: '', notes: '', status: 'todo', importance: 'medium',
    deadline: '', planned: '', estimate: 0, actual: 0, tags: [], created: now(), updated: now(), completed: '' };
}
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value: string): boolean {
  if (!value) return true;
  if (!datePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export class Tree {
  byId = new Map<string, TaskNode>();
  children = new Map<string | null, TaskNode[]>();
  order: TaskNode[] = [];
  constructor(nodes: TaskNode[]) {
    for (const node of nodes) {
      if (this.byId.has(node.id)) throw new Error(`重复节点 ID：${node.id}`);
      this.byId.set(node.id, node);
      const siblings = this.children.get(node.parent) ?? [];
      siblings.push(node); this.children.set(node.parent, siblings);
    }
    for (const node of nodes) {
      if (node.parent !== null) {
        const parent = this.byId.get(node.parent);
        if (!parent) throw new Error(`父节点不存在：${node.title}`);
        if (node.kind === 'area' && parent.kind === 'task') throw new Error('任务下不能挂领域');
      }
    }
    const stack = [...(this.children.get(null) ?? [])].reverse();
    while (stack.length) {
      const n = stack.pop()!; this.order.push(n);
      const children = this.children.get(n.id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    if (this.order.length !== nodes.length) throw new Error('节点存在循环');
  }
  descendants(id: string): TaskNode[] {
    const result: TaskNode[] = [], stack = [...(this.children.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!; result.push(n);
      for (const child of this.children.get(n.id) ?? []) stack.push(child);
    }
    return result;
  }
  ancestors(id: string): TaskNode[] {
    const result: TaskNode[] = []; let n = this.byId.get(id);
    while (n?.parent) { n = this.byId.get(n.parent); if (n) result.push(n); }
    return result;
  }
}
export function validate(board: Board): Tree {
  if (board.version !== 1 || typeof board.revision !== 'string' || !Array.isArray(board.nodes)) throw new Error('未知任务文件版本或格式');
  for (const n of board.nodes) {
    if (!n || typeof n.id !== 'string' || !/^n-[a-zA-Z0-9-]+$/.test(n.id) ||
      (n.parent !== null && typeof n.parent !== 'string') || !['task', 'area'].includes(n.kind) ||
      typeof n.title !== 'string' || !n.title.trim() || /[\r\n]/.test(n.title) ||
      typeof n.notes !== 'string' || n.notes.includes('<!-- obsb-') ||
      !['todo', 'doing', 'waiting', 'done', 'cancelled'].includes(n.status) ||
      !['high', 'medium', 'low'].includes(n.importance) ||
      typeof n.deadline !== 'string' || !validDate(n.deadline) ||
      typeof n.planned !== 'string' || !validDate(n.planned) ||
      !Number.isFinite(n.estimate) || n.estimate < 0 || !Number.isFinite(n.actual) || n.actual < 0 ||
      !Array.isArray(n.tags) || n.tags.some(t => typeof t !== 'string') ||
      [n.created, n.updated].some(t => typeof t !== 'string' || !Number.isFinite(Date.parse(t))) ||
      typeof n.completed !== 'string' || (n.completed !== '' && !Number.isFinite(Date.parse(n.completed))) ||
      (n.kind === 'task' && n.status === 'done' && !n.completed)) throw new Error(`节点属性无效：${n?.title ?? '未知'}`);
  }
  return new Tree(board.nodes);
}
export function upsert(board: Board, node: TaskNode, afterId?: string): Board {
  const oldTree = new Tree(board.nodes), old = oldTree.byId.get(node.id);
  if (old && node.kind === 'task' && node.status === 'done' && oldTree.descendants(node.id).some(n => n.kind === 'task' && n.status !== 'done')) {
    throw new Error('还有未完成子任务，请先处理后再完成父任务');
  }
  const next = { ...node, title: node.title.trim(), updated: now() };
  if (next.kind === 'task') {
    next.completed = next.status === 'done' ? (node.completed || now()) : '';
  }
  const nodes = board.nodes.filter(n => n.id !== node.id);
  // Preserve sibling order when editing.
  if (old) nodes.splice(board.nodes.indexOf(old), 0, next);
  else if (afterId && oldTree.byId.get(afterId)?.parent === node.parent) nodes.splice(nodes.findIndex(n => n.id === afterId) + 1, 0, next);
  else nodes.push(next);
  const result: Board = { ...board, revision: uid(), nodes }; validate(result); return result;
}
export function archivePlan(board: Board): { ids: Set<string>; skipped: number } {
  const tree = validate(board), eligible = new Set<string>(); let skipped = 0;
  for (let i = tree.order.length - 1; i >= 0; i--) {
    const n = tree.order[i];
    if (n.kind !== 'task' || n.status !== 'done') continue;
    if ((tree.children.get(n.id) ?? []).every(c => eligible.has(c.id))) eligible.add(n.id);
    else skipped++;
  }
  return { ids: eligible, skipped };
}
export function sleepPlan(board: Board, areaId: string): Set<string> {
  const tree = validate(board), area = tree.byId.get(areaId);
  if (!area || area.kind !== 'area') throw new Error('请选择领域');
  const branch = [area, ...tree.descendants(areaId)];
  if (branch.some(n => n.kind === 'task' && n.status !== 'done')) throw new Error('领域内仍有未完成任务，请先处理');
  return new Set(branch.map(n => n.id));
}
export function extract(board: Board, ids: Set<string>, kind: Batch['kind']): { next: Board; batch: Batch } {
  if (!ids.size) throw new Error('没有可移出的节点');
  const tree = validate(board), context = new Map<string, TaskNode>();
  for (const id of ids) {
    const node = tree.byId.get(id);
    if (!node) throw new Error('节点已变化，请重试');
    let parent = node.parent;
    // Removed ancestors already carry their own context. Visit each retained ancestor once.
    while (parent && !ids.has(parent) && !context.has(parent)) {
      const ancestor = tree.byId.get(parent)!; context.set(parent, ancestor); parent = ancestor.parent;
    }
  }
  const next: Board = { ...board, revision: uid(), nodes: board.nodes.filter(n => !ids.has(n.id)) };
  validate(next);
  return { next, batch: { version: 1, id: uid(), kind, time: now(), state: 'prepared', afterRevision: next.revision,
    nodes: board.nodes.filter(n => ids.has(n.id)), context: [...context.values()] } };
}
export function restore(board: Board, batch: Batch): Board {
  const current = new Tree(board.nodes), additions = new Map<string, TaskNode>();
  const sources = new Map([...batch.context, ...batch.nodes].map(n => [n.id, n]));
  for (const node of batch.nodes) {
    if (current.byId.has(node.id)) continue;
    let n: TaskNode | undefined = node;
    const seen = new Set<string>();
    while (n && !current.byId.has(n.id) && !additions.has(n.id)) {
      if (seen.has(n.id)) throw new Error('归档关系存在循环');
      seen.add(n.id); additions.set(n.id, { ...n });
      if (n.parent && !sources.has(n.parent) && !current.byId.has(n.parent)) throw new Error('归档缺少父节点');
      n = n.parent ? sources.get(n.parent) : undefined;
    }
  }
  if (!additions.size) throw new Error('这些节点已经在当前文件中');
  const result = { ...board, revision: uid(), nodes: [...board.nodes, ...additions.values()] };
  validate(result); return result;
}
export function periodNodes(nodes: TaskNode[], field: 'created' | 'completed', start: string, end: string): Set<string> {
  if (!validDate(start) || !validDate(end) || (start && end && start > end)) throw new Error('日期范围无效');
  return new Set(nodes.filter(n => n.kind === 'task' && n[field] &&
    (!start || localDay(n[field]) >= start) && (!end || localDay(n[field]) <= end)).map(n => n.id));
}
export function localDay(value: string): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function moveTasks(board: Board, ids: string[], targetId: string | null, placement: 'child' | 'before' | 'after'): Board {
  const tree = validate(board), selected = new Set(ids);
  const roots = ids.map(id => tree.byId.get(id)).filter((n): n is TaskNode => !!n && !tree.ancestors(n.id).some(a => selected.has(a.id)));
  if (!roots.length) throw new Error('没有可移动节点');
  const target = targetId ? tree.byId.get(targetId) : undefined;
  if (targetId && !target) throw new Error('目标节点已不存在');
  if (target && roots.some(n => n.id === target.id || tree.ancestors(target.id).some(a => a.id === n.id))) throw new Error('不能移动到自己的子树');
  const parent = placement === 'child' ? targetId : target?.parent ?? null;
  const rootIds = new Set(roots.map(n => n.id)), nodes = board.nodes.filter(n => !rootIds.has(n.id));
  const moved = roots.map(n => ({ ...n, parent, updated: now() }));
  let index = nodes.length;
  if (target && placement !== 'child') index = nodes.findIndex(n => n.id === target.id) + (placement === 'after' ? 1 : 0);
  nodes.splice(index, 0, ...moved);
  const result = { ...board, revision: uid(), nodes }; validate(result); return result;
}
export function deleteTasks(board: Board, ids: string[]): Board {
  const tree = validate(board), removed = new Set<string>();
  for (const id of ids) {
    if (!tree.byId.has(id)) continue; removed.add(id);
    for (const child of tree.descendants(id)) removed.add(child.id);
  }
  const result = { ...board, revision: uid(), nodes: board.nodes.filter(n => !removed.has(n.id)) }; validate(result); return result;
}
