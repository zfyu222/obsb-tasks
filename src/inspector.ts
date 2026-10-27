import { Board, TaskNode, Tree } from './model';

/** A selected node's draft survives validation errors and is flushed before navigation.
 * One save at a time; input received during a write becomes the next write, not lost data.
 */
export class NodeDraft {
  value: TaskNode;
  private generation = 0;
  private saved = 0;
  private pending?: Promise<void>;
  private composing = 0;
  private compositionWaiters: (() => void)[] = [];
  error = '';
  busy = false;
  changed: () => void = () => {};
  constructor(node: TaskNode, public revision: string,
    private write: (node: TaskNode, revision: string) => Promise<Board>) { this.value = structuredClone(node); }
  get dirty(): boolean { return this.saved !== this.generation; }
  patch(patch: Partial<TaskNode>): void { Object.assign(this.value, patch); this.generation++; this.error = ''; this.changed(); }
  composition(start: boolean): void {
    this.composing += start ? 1 : -1; this.composing = Math.max(0, this.composing);
    if (!this.composing) for (const resolve of this.compositionWaiters.splice(0)) resolve();
  }
  async flush(): Promise<void> {
    if (this.composing) await new Promise<void>(resolve => this.compositionWaiters.push(resolve));
    if (this.pending) { await this.pending; if (this.dirty) await this.flush(); return; }
    if (!this.dirty) return;
    const run = async (): Promise<void> => {
      this.busy = true; this.error = ''; this.changed();
      try {
        while (this.dirty) {
          const version = this.generation, submitted = structuredClone(this.value);
          const board = await this.write(submitted, this.revision);
          this.revision = board.revision; this.saved = version;
          const saved = board.nodes.find(n => n.id === submitted.id)!;
          if (this.generation === version) this.value = structuredClone(saved);
          else if (this.value.status === submitted.status && this.value.completed === submitted.completed) this.value.completed = saved.completed;
        }
      } catch (e) { this.error = e instanceof Error ? e.message : String(e); throw e; }
      finally { this.busy = false; this.changed(); }
    };
    this.pending = run();
    try { await this.pending; } finally { this.pending = undefined; }
  }
}

const statuses = { todo: '待办', doing: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消' };
const importance = { high: '高', medium: '中', low: '低' };
// datetime-local takes wall-clock time, while Markdown stores an absolute ISO instant.
function localDateTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${date.getMilliseconds() ? `.${pad(date.getMilliseconds(), 3)}` : ''}`;
}
function completionInstant(local: string): string {
  if (!local) return '';
  const date = new Date(local);
  return Number.isFinite(date.getTime()) ? date.toISOString() : local;
}
function append<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); e.textContent = text; parent.append(e); return e;
}
export function inspector(parent: HTMLElement, draft: NodeDraft, board: Board, preview: () => void, discard: () => void): void {
  const form = append(parent, 'form'); form.className = 'obsb-task-properties';
  form.addEventListener('submit', e => { e.preventDefault(); void draft.flush().catch(() => {}); });
  const fields = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const text = (container: HTMLElement, name: string, key: string, value: string, change: (v: string) => void, type = 'text'): HTMLInputElement => {
    const label = append(container, 'label', name), input = append(label, 'input'); input.type = type; input.value = value;
    input.dataset.field = key; input.setAttribute('aria-label', name); fields.set(key, input);
    input.addEventListener('input', () => change(input.value));
    input.addEventListener('change', () => { void draft.flush().catch(() => {}); });
    input.addEventListener('compositionstart', () => draft.composition(true));
    input.addEventListener('compositionend', () => draft.composition(false)); return input;
  };
  const select = (container: HTMLElement, name: string, key: string, values: Record<string, string>, change: (v: string) => void): HTMLSelectElement => {
    const label = append(container, 'label', name), input = append(label, 'select'); input.dataset.field = key; input.setAttribute('aria-label', name);
    fields.set(key, input);
    for (const [value, title] of Object.entries(values)) { const option = append(input, 'option', title); option.value = value; }
    input.value = String(draft.value[key]);
    input.addEventListener('change', () => { change(input.value); void draft.flush().catch(() => {}); }); return input;
  };
  text(form, '名称', 'title', draft.value.title, title => draft.patch({ title })).required = true;
  select(form, '节点类型', 'kind', { task: '任务', area: '领域' }, kind => draft.patch({ kind: kind as TaskNode['kind'] }));
  const taskFields = append(form, 'div');
  select(taskFields, '状态', 'status', statuses, status => draft.patch({ status: status as TaskNode['status'] }));
  select(taskFields, '重要程度', 'importance', importance, value => draft.patch({ importance: value as TaskNode['importance'] }));
  text(taskFields, '截止日期', 'deadline', draft.value.deadline, deadline => draft.patch({ deadline }), 'date');
  text(taskFields, '计划执行日期', 'planned', draft.value.planned, planned => draft.patch({ planned }), 'date');
  for (const [key, name] of [['estimate', '预计工作量（小时）'], ['actual', '实际工作量（小时）']] as const) {
    const input = text(taskFields, name, key, String(draft.value[key] / 60), v => draft.patch({ [key]: v === '' ? 0 : Number(v) * 60 }), 'number');
    input.min = '0'; input.step = '0.25';
  }
  const completed = text(taskFields, '完成时间', 'completed', localDateTime(draft.value.completed),
    value => draft.patch({ completed: completionInstant(value) }), 'datetime-local');
  completed.step = '0.001';
  append(taskFields, 'small', '按本机时区选择日期和时间；标记已完成时自动填写，可修改。');
  text(form, '标签（逗号分隔）', 'tags', draft.value.tags.join(', '), v => draft.patch({ tags: v.split(/[,，]/).map(t => t.trim()).filter(Boolean) }));
  const tree = new Tree(board.nodes), forbidden = new Set([draft.value.id, ...tree.descendants(draft.value.id).map(n => n.id)]);
  const searchLabel = append(form, 'label', '查找父节点'), search = append(searchLabel, 'input'); search.type = 'search'; search.placeholder = '搜索名称'; search.setAttribute('aria-label', '查找父节点');
  const parentLabel = append(form, 'label', '父节点'), parentSelect = append(parentLabel, 'select'); parentSelect.dataset.field = 'parent'; parentSelect.setAttribute('aria-label', '父节点');
  const populate = (): void => {
    parentSelect.replaceChildren(); const root = append(parentSelect, 'option', 'root（不属于领域）'); root.value = '';
    const matches = board.nodes.filter(n => !forbidden.has(n.id) && (draft.value.kind === 'task' || n.kind === 'area') && n.title.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).slice(0, 100);
    const old = draft.value.parent ? tree.byId.get(draft.value.parent) : undefined;
    if (old && !matches.some(n => n.id === old.id)) matches.unshift(old);
    for (const n of matches) { const option = append(parentSelect, 'option', `${n.kind === 'area' ? '领域' : '任务'} · ${n.title}`); option.value = n.id; }
    parentSelect.value = draft.value.parent ?? '';
  };
  populate(); search.addEventListener('input', populate);
  parentSelect.addEventListener('change', () => { draft.patch({ parent: parentSelect.value || null }); void draft.flush().catch(() => {}); });
  const noteLabel = append(form, 'label', '注释（Obsidian Markdown）'), notes = append(noteLabel, 'textarea');
  notes.rows = 6; notes.value = draft.value.notes; notes.dataset.field = 'notes'; notes.setAttribute('aria-label', '注释（Obsidian Markdown）'); fields.set('notes', notes);
  notes.addEventListener('input', () => draft.patch({ notes: notes.value }));
  notes.addEventListener('blur', () => { void draft.flush().catch(() => {}); });
  notes.addEventListener('compositionstart', () => draft.composition(true));
  notes.addEventListener('compositionend', () => draft.composition(false));
  const state = append(form, 'p'); state.className = 'obsb-task-save-state'; state.setAttribute('role', 'status');
  const error = append(form, 'p'); error.className = 'obsb-task-error'; error.setAttribute('role', 'alert');
  const retry = append(form, 'button', '重试保存'); retry.type = 'button'; retry.hidden = true;
  retry.addEventListener('click', () => { void draft.flush().catch(() => {}); });
  const copy = append(form, 'button', '复制未保存内容'); copy.type = 'button'; copy.hidden = true;
  copy.addEventListener('click', () => { void navigator.clipboard.writeText(JSON.stringify(draft.value, null, 2)).catch(e => { error.textContent = String(e); }); });
  const reload = append(form, 'button', '重新加载（放弃草稿）'); reload.type = 'button'; reload.hidden = true;
  reload.addEventListener('click', discard);
  let lastKind = draft.value.kind;
  draft.changed = () => {
    taskFields.hidden = draft.value.kind !== 'task';
    state.textContent = draft.busy ? '保存中…' : draft.error ? '保存失败，草稿仍保留；可修正或复制后重新加载' : draft.dirty ? '修改后离开输入框自动保存' : '已保存';
    error.textContent = draft.error; retry.hidden = copy.hidden = reload.hidden = !draft.error;
    // Preserve focus/caret while normalizing auto-generated completion timestamps.
    for (const [key, input] of fields) if (document.activeElement !== input) {
      const value = draft.value[key]; input.value = key === 'completed' ? localDateTime(draft.value.completed) : key === 'tags' ? draft.value.tags.join(', ') : key === 'estimate' || key === 'actual' ? String(Number(value) / 60) : String(value);
    }
    if (lastKind !== draft.value.kind) { lastKind = draft.value.kind; populate(); }
    if (!draft.dirty && !draft.busy && !draft.error) preview();
  };
  draft.changed();
}
