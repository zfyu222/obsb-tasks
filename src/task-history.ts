import History from './vendor/enhancing-mindmap/History';
import { Board, TaskNode, uid, validate } from './model';
interface Entry { node: TaskNode; index: number; siblingIndex: number; }
export interface TaskCommand {
  before: Entry[]; after: Entry[];
  execute(): boolean; undo(): void; redo(): void;
}
/** Fork's unified command history, with persistence completed before stack changes. */
export class TaskHistory {
  private history = new History(50);
  record(before: Board, after: Board): void {
    const entries = (board: Board): Map<string, Entry> => {
      const counts = new Map<string | null, number>();
      return new Map(board.nodes.map((node, index) => {
        const siblingIndex = counts.get(node.parent) ?? 0; counts.set(node.parent, siblingIndex + 1);
        return [node.id, { node, index, siblingIndex }];
      }));
    };
    const old = entries(before), next = entries(after);
    const changed = new Set<string>();
    for (const [id, entry] of old) if (!next.has(id) || JSON.stringify(entry.node) !== JSON.stringify(next.get(id)!.node)) changed.add(id);
    for (const id of next.keys()) if (!old.has(id)) changed.add(id);
    // Ignore global index shifts caused by a moved subtree. Still detect pure
    // reorders when timestamps happen to be identical within one millisecond.
    const groups = (map: Map<string, Entry>): Map<string | null, string[]> => {
      const result = new Map<string | null, string[]>();
      for (const [id, { node }] of map) if (!changed.has(id)) {
        const siblings = result.get(node.parent) ?? []; siblings.push(id); result.set(node.parent, siblings);
      }
      return result;
    };
    const oldGroups = groups(old), nextGroups = groups(next);
    for (const [parent, ids] of oldGroups) {
      const afterIds = nextGroups.get(parent) ?? [];
      for (let i = 0; i < ids.length; i++) if (ids[i] !== afterIds[i]) {
        changed.add(ids[i]); if (afterIds[i]) changed.add(afterIds[i]);
      }
    }
    if (!changed.size) return;
    const command: TaskCommand = {
      before: [...changed].filter(id => old.has(id)).map(id => structuredClone(old.get(id)!)),
      after: [...changed].filter(id => next.has(id)).map(id => structuredClone(next.get(id)!)),
      execute: () => true, undo() {}, redo() {}
    };
    this.history.execute(command);
  }
  peek(redo = false): TaskCommand | undefined { const stack = redo ? this.history.redos : this.history.undos; return stack[stack.length - 1] as TaskCommand | undefined; }
  apply(board: Board, command: TaskCommand, redo = false): Board {
    const ids = new Set([...command.before, ...command.after].map(e => e.node.id));
    const groups = new Map<string | null, TaskNode[]>(), additions = new Map<string | null, Entry[]>();
    for (const node of board.nodes) if (!ids.has(node.id)) {
      const siblings = groups.get(node.parent) ?? []; siblings.push(node); groups.set(node.parent, siblings);
    }
    for (const entry of redo ? command.after : command.before) {
      const siblings = additions.get(entry.node.parent) ?? []; siblings.push(entry); additions.set(entry.node.parent, siblings);
    }
    for (const [parent, entries] of additions) {
      const remaining = groups.get(parent) ?? [], byPosition = new Map(entries.map(e => [e.siblingIndex, e]));
      const total = remaining.length + entries.length, siblings: TaskNode[] = []; let cursor = 0;
      for (let index = 0; index < total; index++) siblings.push(byPosition.has(index) ? structuredClone(byPosition.get(index)!.node) : remaining[cursor++]);
      if (cursor !== remaining.length || siblings.some(n => !n)) throw new Error('撤销的同级位置不一致，请重新加载');
      groups.set(parent, siblings);
    }
    const result = { ...board, revision: uid(), nodes: [...groups.values()].flat() };
    result.nodes = validate(result).order; return result;
  }
  accept(redo = false): void { if (redo) this.history.redo(); else this.history.undo(); }
  clear(): void { this.history.clear(); }
}
