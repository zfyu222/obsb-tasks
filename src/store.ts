import { Batch, Board, Tree, emptyBoard, extract, restore, uid } from './model';
import { Document, batchFrom, boardFrom, decode, encodeBatch, encodeBoard } from './codec';

export const ROOT = 'Raw/任务管理';
export const CURRENT = `${ROOT}/当前任务.md`;
export const ARCHIVE = `${ROOT}/归档`;
export const SLEEP = `${ROOT}/休眠领域`;
export const TRANSACTION = `${ROOT}/归档事务.md`;
export const BACKUP = `${ROOT}/格式备份`;
const journal = (path: string): string => `---\nnightly_maintenance: skip\n---\n\n<!-- obsb-transaction ${JSON.stringify({ version: 1, path })} -->\n`;
function journalPath(raw: string): string {
  const match = /<!-- obsb-transaction (.+) -->/.exec(raw);
  if (!match) throw new Error('归档事务文件损坏，请保留文件并检查');
  const data = JSON.parse(match[1]);
  if (data.version !== 1 || typeof data.path !== 'string' || (data.path &&
    !new RegExp(`^Raw/任务管理/(归档|休眠领域)/[^/]+\\.md$`).test(data.path))) throw new Error('归档事务路径无效');
  return data.path;
}
export interface Files {
  read(path: string): Promise<string>;
  create(path: string, text: string): Promise<void>;
  exists(path: string): boolean;
  list(folder: string): string[];
  compareWrite(path: string, before: string, after: string): Promise<void>;
}
export interface SavedBatch { path: string; batch: Batch; }
export class TaskStore {
  private queue: Promise<unknown> = Promise.resolve();
  private recovered = false;
  private cached?: { raw: string; board: Board; doc: Document };
  constructor(private files: Files) {}
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job); this.queue = next.catch(() => {}); return next;
  }
  invalidate(): void { this.cached = undefined; this.recovered = false; }
  private async write(path: string, before: string, after: string, format: Document['format']): Promise<void> {
    if (format === 1) {
      // Preserve exact bytes before migration; content-addressed backups deduplicate retries.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(before));
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const backup = `${BACKUP}/旧格式-${hash}.md`;
      if (!this.files.exists(backup)) {
        try { await this.files.create(backup, before); }
        catch (error) { if (!this.files.exists(backup)) throw error; }
      }
      if (await this.files.read(backup) !== before) throw new Error('格式迁移备份不一致，未覆盖原文件');
    }
    await this.files.compareWrite(path, before, after);
  }
  private async snapshot(board: Board, raw: string): Promise<Board> {
    // Native Markdown edits need not change the embedded revision. Include exact bytes
    // in the optimistic concurrency token so a stale editor cannot overwrite those edits.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    return { ...board, revision: `${board.revision}:${hash}` };
  }
  async load(): Promise<Board> {
    return this.serial(async () => {
      if (!this.files.exists(CURRENT)) await this.files.create(CURRENT, encodeBoard(emptyBoard()));
      if (!this.recovered) { await this.recover(); this.recovered = true; }
      const { raw, board } = await this.read();
      return this.snapshot(board, raw);
    });
  }
  private async read(): Promise<{ raw: string; board: Board; doc: Document }> {
    const raw = await this.files.read(CURRENT);
    if (this.cached?.raw === raw) return this.cached;
    const doc = decode(raw), board = boardFrom(doc);
    this.cached = { raw, board, doc }; return this.cached;
  }
  async change(expected: string, edit: (board: Board) => Board): Promise<Board> {
    return this.serial(async () => {
      if (!this.recovered) { await this.recover(); this.recovered = true; }
      const { raw, board, doc } = await this.read();
      if ((await this.snapshot(board, raw)).revision !== expected) throw new Error('任务文件已被其他窗口或设备修改，请重新加载后再操作');
      const next = edit(structuredClone(board));
      if (next.revision === board.revision) next.revision = uid();
      const after = encodeBoard(next, doc.preamble);
      await this.write(CURRENT, raw, after, doc.format);
      this.cached = undefined; return this.snapshot({ ...next, nodes: new Tree(next.nodes).order }, after);
    });
  }
  async removeToBatch(expected: string, ids: Set<string>, kind: Batch['kind']): Promise<Batch> {
    return this.serial(async () => {
      if (!this.recovered) { await this.recover(); this.recovered = true; }
      const { raw, board, doc } = await this.read();
      if ((await this.snapshot(board, raw)).revision !== expected) throw new Error('任务已变化，请重新预览归档');
      const { next, batch } = extract(board, ids, kind);
      const folder = kind === 'archive' ? ARCHIVE : SLEEP;
      const path = `${folder}/${batch.time.replace(/[:.]/g, '-')}-${batch.id}.md`;
      const prepared = encodeBatch(batch);
      // Copy first, then CAS current; no note move/delete, and a crash never loses the only copy.
      await this.files.create(path, prepared);
      if (!this.files.exists(TRANSACTION)) await this.files.create(TRANSACTION, journal(''));
      const priorJournal = await this.files.read(TRANSACTION);
      if (journalPath(priorJournal)) throw new Error('尚有未处理的归档事务，请重新加载');
      const pendingJournal = journal(path);
      await this.files.compareWrite(TRANSACTION, priorJournal, pendingJournal);
      try {
        await this.write(CURRENT, raw, encodeBoard(next, doc.preamble), doc.format);
        batch.state = 'committed';
        await this.files.compareWrite(path, prepared, encodeBatch(batch));
        await this.files.compareWrite(TRANSACTION, pendingJournal, journal(''));
      } finally {
        this.cached = undefined; this.recovered = false;
      }
      return batch;
    });
  }
  private batchPaths(): string[] { return [...this.files.list(ARCHIVE), ...this.files.list(SLEEP)].sort(); }
  private async recover(): Promise<void> {
    // Default workflow reads at most the journal and its one pending batch, never
    // every historical Markdown file. Catalogs are loaded only by explicit queries.
    if (!this.files.exists(CURRENT) || !this.files.exists(TRANSACTION)) return;
    const transaction = await this.files.read(TRANSACTION), path = journalPath(transaction);
    if (!path) return;
    const { board } = await this.read();
    const raw = await this.files.read(path), doc = decode(raw), batch = batchFrom(doc);
    if (batch.state === 'prepared') {
      if (batch.afterRevision === board.revision) {
        batch.state = 'committed'; await this.write(path, raw, encodeBatch(batch, doc.preamble), doc.format);
      } else {
        const present = new Set(board.nodes.map(n => n.id));
        if (!batch.nodes.every(n => present.has(n.id))) throw new Error('归档中断且当前文件已变化，副本已保留；请检查归档事务后再继续，未自动覆盖');
        // Source write did not apply: preserve the prepared copy but do not expose it as archive.
      }
    }
    await this.files.compareWrite(TRANSACTION, transaction, journal(''));
  }
  async batches(kind?: Batch['kind']): Promise<SavedBatch[]> {
    return this.serial(async () => {
      if (!this.recovered) { await this.recover(); this.recovered = true; }
      const result: SavedBatch[] = [];
      for (const path of this.batchPaths()) {
        const batch = batchFrom(decode(await this.files.read(path)));
        if (batch.state === 'committed' && (!kind || batch.kind === kind)) result.push({ path, batch });
      }
      return result;
    });
  }
  async restore(expected: string, path: string): Promise<Board> {
    if (!this.batchPaths().includes(path)) throw new Error('归档路径无效');
    const batch = batchFrom(decode(await this.files.read(path)));
    if (batch.state !== 'committed') throw new Error('该批次未完成，保留供人工恢复');
    return this.change(expected, board => restore(board, batch));
  }
  async migrate(): Promise<number> {
    return this.serial(async () => {
      if (!this.recovered) { await this.recover(); this.recovered = true; }
      let count = 0;
      for (const path of [CURRENT, ...this.batchPaths()]) {
        if (!this.files.exists(path)) continue;
        const raw = await this.files.read(path), doc = decode(raw);
        if (doc.format === 2) continue;
        const after = doc.meta.type === 'current' ? encodeBoard(boardFrom(doc), doc.preamble) : encodeBatch(batchFrom(doc), doc.preamble);
        const converted = decode(after);
        // Flat array order can change; node fields, sibling order and context identity cannot.
        const canonical = (document: typeof doc): string => {
          const context = document.meta.type === 'batch' ? document.meta.context : [];
          const nodes = new Map([...context, ...document.nodes].map(n => [n.id, n]));
          return JSON.stringify({ nodes: new Tree([...nodes.values()]).order.map(n => Object.fromEntries(Object.entries(n).sort(([a], [b]) => a.localeCompare(b)))),
            context: context.map(n => n.id).sort() });
        };
        if (canonical(doc) !== canonical(converted)) throw new Error(`迁移校验失败，未覆盖 ${path}`);
        try { await this.write(path, raw, after, doc.format); count++; }
        finally { this.cached = undefined; }
      }
      return count;
    });
  }
}
