import History from './vendor/enhancing-mindmap/History';
import { Board, TaskNode, uid, validate } from './model';
interface Entry { node: TaskNode; index: number; }
export interface TaskCommand {
  before: Entry[]; after: Entry[];
  execute(): boolean; undo(): void; redo(): void;
}
/** Fork's unified command history, with persistence completed before stack changes. */
export class TaskHistory {
  private history = new History(50);
  record(before: Board, after: Board): void {
    const old = new Map(before.nodes.map((node, index) => [node.id, { node, index }]));
    const next = new Map(after.nodes.map((node, index) => [node.id, { node, index }]));
    const changed = new Set<string>();
    for (const [id, entry] of old) if (!next.has(id) || JSON.stringify(entry.node) !== JSON.stringify(next.get(id)!.node)) changed.add(id);
    for (const id of next.keys()) if (!old.has(id)) changed.add(id);
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
    const nodes = board.nodes.filter(n => !ids.has(n.id));
    const entries = [...(redo ? command.after : command.before)].sort((a, b) => a.index - b.index);
    for (const { node, index } of entries) nodes.splice(index, 0, structuredClone(node));
    const result = { ...board, revision: uid(), nodes }; validate(result); return result;
  }
  accept(redo = false): void { if (redo) this.history.redo(); else this.history.undo(); }
  clear(): void { this.history.clear(); }
}
