import { Component, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from 'obsidian';
import TaskPlugin, { button, ConfirmModal, el, IMPORTANCE, report, STATUS } from './main';
import { inspector, NodeDraft } from './inspector';
import { archivePlan, Board, Kind, newNode, periodNodes, sleepPlan, TaskNode, Tree, upsert, moveTasks, deleteTasks } from './model';
import { CURRENT, SavedBatch } from './store';
import { GraphCanvas } from './graph-canvas';
import { GRAPH_ROOT, GraphGeometry, GraphNode, layoutGraph } from './graph-layout';
import { Camera } from './graph-viewport';
import { TaskHistory } from './task-history';

type Source = 'current' | 'archive' | 'sleep' | 'period';
const ROW = 56;
export class TaskView extends ItemView {
  ready: Promise<void> = Promise.resolve();
  board!: Board;
  private source: Source = 'current';
  private mode: 'map' | 'list' = 'map';
  private selected: string | null = null;
  private collapsed = new Set<string>();
  private query = ''; private status = ''; private sorting = 'manual';
  private periodField: 'created' | 'completed' = 'completed';
  private start = ''; private end = '';
  private batches: SavedBatch[] = [];
  private nodes: TaskNode[] = []; private tree = new Tree([]);
  private paths = new Map<string, string>();
  private contexts = new Set<string>();
  private textIndex = new Map<string, string>();
  private panel!: HTMLElement; private stage!: HTMLElement; private statusEl!: HTMLElement;
  private markdown?: Component; private detailEpoch = 0;
  private changeTimer?: number; private queryTimer?: number;
  private renderEpoch = 0;
  private dirty = false;
  private draft?: NodeDraft;
  private inlineId: string | null = null;
  private inlineOriginal = '';
  private actions: Promise<unknown> = Promise.resolve();
  private closed = false;
  private listScroll = 0;
  private graph?: GraphCanvas;
  private camera: Camera = { x: 0, y: 0, scale: 1, initialized: false };
  private selectedIds = new Set<string>();
  private focusId?: string;
  private direction: 'mindmap' | 'right' = 'mindmap';
  private history = new TaskHistory();
  private revealNext = false;
  private measure?: (text: string) => number;
  constructor(leaf: WorkspaceLeaf, public plugin: TaskPlugin) { super(leaf); }
  getViewType(): string { return 'obsb-tasks-view'; }
  getDisplayText(): string { return '任务管理'; }
  getIcon(): string { return 'list-tree'; }
  async onOpen(): Promise<void> { this.closed = false; this.ready = this.reload(); await this.ready; }
  async onClose(): Promise<void> {
    this.closed = true;
    try { await this.flush(); } catch (e) {
      report(e);
      if (this.draft?.dirty) await this.plugin.keepDraft?.(this.draft.value);
    }
    window.clearTimeout(this.changeTimer); window.clearTimeout(this.queryTimer);
    this.graph?.destroy(); this.graph = undefined;
    this.markdown?.unload(); this.detailEpoch++; this.renderEpoch++;
  }
  private run(action: () => Promise<void>): Promise<void> {
    const next = this.actions.then(async () => { if (!this.closed) await action(); });
    this.actions = next.catch(() => {}); return next;
  }
  private async flush(): Promise<void> { await this.draft?.flush(); }
  private async finishTitle(id = this.inlineId): Promise<void> {
    if (id && this.inlineId !== id) return;
    await this.flush();
    if (!id || this.inlineId !== id) return;
    this.inlineId = null;
    // Only replace this node's editor. Rebuilding the viewport on blur would
    // cancel the pointer gesture that is selecting the next node or blank area.
    this.graph?.refreshNode(id);
  }
  async prepareMigration(): Promise<void> { await this.run(async () => { await this.flush(); }); }
  private async select(id: string | null): Promise<void> {
    await this.finishTitle(); this.selected = id;
    this.selectedIds = new Set(id ? [id] : []);
    await this.detail(); this.markSelected(); this.stage.focus({ preventScroll: true });
  }
  private async selectMany(ids: string[], primary?: string): Promise<void> {
    await this.finishTitle(); this.selectedIds = new Set(ids.filter(id => this.tree.byId.has(id)));
    this.selected = primary && this.selectedIds.has(primary) ? primary : [...this.selectedIds][this.selectedIds.size - 1] ?? null;
    await this.detail(); this.markSelected(); this.stage.focus({ preventScroll: true });
  }
  private markSelected(): void {
    for (const card of this.stage.querySelectorAll<HTMLElement>('[data-node-id]')) card.classList.toggle('is-selected', this.selectedIds.has(card.dataset.nodeId ?? '') || !this.selectedIds.size && !card.dataset.nodeId);
    this.graph?.paint();
  }
  private async commit(edit: (board: Board) => Board, revision = this.board.revision): Promise<Board> {
    const before = this.board, next = await this.plugin.store.change(revision, edit);
    this.history.record(before, next); this.board = next; return next;
  }
  private async undo(redo = false): Promise<void> {
    await this.flush(); const command = this.history.peek(redo); if (!command) return;
    this.board = await this.plugin.store.change(this.board.revision, b => this.history.apply(b, command, redo)); this.history.accept(redo);
    this.inlineId = null;
    if (this.selected && !this.board.nodes.some(n => n.id === this.selected)) this.selected = command.after[0]?.node.parent ?? null;
    this.selectedIds = new Set(this.selected ? [this.selected] : []);
    this.revealNext = true;
    this.prepare(); this.draw(); await this.detail(); this.stage.focus({ preventScroll: true });
  }
  private async move(ids: string[], target: string | null, placement: 'child' | 'before' | 'after'): Promise<void> {
    await this.flush(); await this.commit(b => moveTasks(b, ids, target, placement));
    this.selectedIds = new Set(ids); this.selected = ids[0] ?? null;
    this.revealNext = true;
    this.inlineId = null; this.prepare(); this.draw(); await this.detail(); this.stage.focus({ preventScroll: true });
  }
  private async removeSelection(): Promise<void> {
    await this.flush(); if (!this.selectedIds.size) return;
    await this.commit(b => deleteTasks(b, [...this.selectedIds])); this.selected = null; this.selectedIds.clear(); this.inlineId = null;
    this.prepare(); this.draw(); await this.detail(); this.stage.focus({ preventScroll: true });
  }
  private async toggleComplete(id: string): Promise<void> {
    if (this.source !== 'current') return;
    await this.finishTitle();
    const node = this.tree.byId.get(id); if (!node || node.kind !== 'task') return;
    const status = node.status === 'done' ? 'todo' : 'done';
    // Reject an invalid completion before touching a draft, so child tasks can
    // still be selected and completed without discarding a failed parent edit.
    if (status === 'done' && this.tree.descendants(id).some(n => n.kind === 'task' && n.status !== 'done')) throw new Error('还有未完成子任务，请先处理后再完成父任务');
    if (this.selected !== id) await this.select(id);
    this.draft!.patch({ status }); await this.draft!.flush();
    this.stage.querySelector<HTMLButtonElement>(`[data-node-id="${id}"] [data-map-complete]`)?.focus({ preventScroll: true });
  }
  private updateVisibleNode(node: TaskNode): void {
    for (const card of this.stage.querySelectorAll<HTMLElement>('[data-node-id]')) {
      if (card.dataset.nodeId !== node.id) continue;
      if (card.classList.contains('obsb-task-row')) {
        const title = card.querySelector('strong'), info = card.querySelector('span');
        if (title) title.textContent = `${node.status === 'done' ? '✓ ' : ''}${node.title}`;
        if (info) info.textContent = `${STATUS[node.status]} · ${IMPORTANCE[node.importance]} · 截止 ${node.deadline || '未设置'} · ${node.estimate / 60}h · 上级 ${node.parent ? this.tree.byId.get(node.parent)?.title : 'root'}`;
      } else {
        card.classList.toggle('area', node.kind === 'area'); card.classList.toggle('task', node.kind === 'task'); card.classList.toggle('done', node.status === 'done');
        const title = card.querySelector('[data-map-title]');
        // Keep an active inline editor and pointer target mounted during asynchronous saves.
        if (!card.querySelector('.obsb-task-inline-title') && title) title.textContent = node.title;
        card.querySelector('small')?.remove();
        this.mapAppearance(card, node);
      }
    }
    this.statusEl.textContent = `当前：${this.nodes.filter(n => n.kind === 'task').length} 个任务 · 归档和休眠不参与当前流程`;
  }
  private mapAppearance(card: HTMLElement, node: TaskNode): void {
    if (node.kind === 'task') card.dataset.importance = node.importance;
    else delete card.dataset.importance;
    card.dataset.status = node.status;
    const title = card.querySelector('[data-map-title]');
    title?.setAttribute('aria-label', (node.kind === 'task' ? node.status === 'done' ? '✓ ' : '○ ' : '') + node.title);
    let complete = card.querySelector<HTMLButtonElement>('[data-map-complete]');
    if (node.kind === 'task') {
      if (!complete) {
        complete = button(card, '', () => this.run(() => this.toggleComplete(node.id)));
        complete.className = 'obsb-map-complete'; complete.dataset.mapComplete = 'true'; card.prepend(complete);
      }
      complete.textContent = node.status === 'done' ? '✓' : '○';
      complete.title = (node.status === 'done' ? '恢复待办：' : '标记已完成：') + node.title;
      complete.setAttribute('aria-label', complete.title); complete.setAttribute('aria-pressed', String(node.status === 'done'));
      complete.disabled = this.source !== 'current';
    } else complete?.remove();
    card.title = node.title + (node.kind === 'task' ? `\n${STATUS[node.status]} · 重要程度：${IMPORTANCE[node.importance]}${node.deadline ? ` · 截止：${node.deadline}` : ''}` : '\n领域') + (node.notes ? '\n有注释，选中后在右侧查看' : '');
  }
  private diagramKey(event: KeyboardEvent): void {
    if (this.source !== 'current' || this.mode !== 'map' || event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) void this.run(() => this.undo(event.key.toLowerCase() === 'y' || event.shiftKey)).catch(report); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,.obsb-map-fold,.obsb-map-complete,[contenteditable="true"]') || target.closest('button') && !target.closest('[data-node-id]')) return;
    if (!['Tab', 'Insert', 'Enter', 'F2', ' ', 'Home', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); if (event.repeat) return;
    void this.run(async () => {
      if (event.key === 'F2' || event.key === ' ') { await this.beginTitle(); return; }
      if (event.key === 'Home') { this.graph?.center(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { await this.removeSelection(); return; }
      if (event.key.startsWith('Arrow')) { await this.navigate(event.key); return; }
      await this.createRelative(event.key === 'Tab' || event.key === 'Insert');
    }).catch(report);
  }
  private async createRelative(child: boolean): Promise<void> {
    await this.flush();
    const current = this.selected ? this.tree.byId.get(this.selected) : undefined;
    const parent = child ? current?.id ?? null : current?.parent ?? null;
    const kind = child ? 'task' : current?.kind ?? 'task';
    await this.create(kind, parent, child ? undefined : current?.id);
  }
  private async create(kind: Kind, parent: string | null = null, afterId?: string): Promise<void> {
    if (this.source !== 'current') return;
    await this.flush();
    const node = { ...newNode(kind, parent), title: kind === 'area' ? '新领域' : '新任务' };
    await this.commit(b => upsert(b, node, afterId));
    this.selected = node.id; this.selectedIds = new Set([node.id]); this.inlineId = null; this.revealNext = true;
    // The newly created node must remain visible even when the old query would hide it.
    this.query = ''; this.status = ''; this.mode = 'map';
    this.prepare(); for (const ancestor of this.tree.ancestors(node.id)) this.collapsed.delete(ancestor.id);
    this.render(); await this.beginTitle();
  }
  private async beginTitle(): Promise<void> {
    if (!this.selected || this.source !== 'current') return;
    if (!this.draft || this.draft.value.id !== this.selected) await this.detail();
    this.inlineId = this.selected; this.inlineOriginal = this.draft!.value.title; this.revealNext = true;
    this.draw(); const input = this.stage.querySelector<HTMLInputElement>('.obsb-task-inline-title'); input?.focus(); input?.select();
  }
  private titleInput(card: HTMLElement, node: TaskNode): void {
    const input = el(card, 'input'); input.className = 'obsb-task-inline-title'; input.setAttribute('aria-label', '节点名称');
    const draft = this.draft;
    input.value = draft?.value.title ?? node.title;
    input.addEventListener('input', () => draft?.patch({ title: input.value }));
    input.addEventListener('compositionstart', () => draft?.composition(true));
    input.addEventListener('compositionend', () => draft?.composition(false));
    input.addEventListener('change', () => { void draft?.flush().catch(report); });
    input.addEventListener('blur', event => {
      // Keep the clicked completion button mounted until its click is delivered.
      const next = (event as FocusEvent).relatedTarget as HTMLElement | null;
      if (next?.closest?.('[data-map-complete]') && card.contains(next)) return;
      void this.run(() => this.finishTitle(node.id)).catch(report);
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['Enter', 'Tab', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); if (event.repeat) return;
      void this.run(async () => {
        if (this.inlineId !== node.id || this.draft !== draft) return;
        if (event.key === 'Escape') draft?.patch({ title: this.inlineOriginal });
        await this.finishTitle(node.id);
        if (event.key === 'Tab') await this.createRelative(true);
        else this.stage.focus({ preventScroll: true });
      }).catch(report);
    });
  }
  externalChange(): void {
    this.dirty = true;
    window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => {
      if (this.dirty && this.statusEl) this.statusEl.textContent = '文件有变更；操作前请刷新（未保存的编辑不会被覆盖）';
    }, 200);
  }
  async reload(): Promise<void> {
    try {
      this.board = await this.plugin.store.load(); this.dirty = false;
      this.history.clear();
      this.batches = this.source === 'current' ? [] : await this.plugin.store.batches(this.source === 'sleep' ? 'sleep' : this.source === 'archive' ? 'archive' : undefined);
      this.prepare(); this.render();
    } catch (e) {
      this.contentEl.replaceChildren(); el(this.contentEl, 'p', '任务文件无法加载，未覆盖任何内容。', 'obsb-task-error');
      el(this.contentEl, 'pre', e instanceof Error ? e.message : String(e));
      button(this.contentEl, '重试', () => this.reload()); report(e);
      throw e;
    }
  }
  private prepare(): void {
    const currentIds = new Set(this.board.nodes.map(n => n.id));
    const merged = new Map<string, TaskNode>(); this.paths.clear(); this.contexts.clear();
    if (this.source === 'current' || this.source === 'period') {
      for (const n of this.board.nodes) { merged.set(n.id, n); this.paths.set(n.id, CURRENT); }
    }
    // Latest explicit archive data wins over older context snapshots; current nodes always win.
    const actual = new Set<string>();
    for (const saved of this.batches) {
      for (const n of saved.batch.context) if (!merged.has(n.id)) { merged.set(n.id, n); this.contexts.add(n.id); this.paths.set(n.id, saved.path); }
    }
    for (const saved of this.batches) for (const n of saved.batch.nodes) {
      if (this.source !== 'period' && currentIds.has(n.id)) continue;
      if (!currentIds.has(n.id) || !merged.has(n.id)) { merged.set(n.id, n); this.paths.set(n.id, saved.path); }
      actual.add(n.id); this.contexts.delete(n.id);
    }
    if (this.source !== 'current' && this.source !== 'period') {
      const keep = new Set(actual);
      for (const id of actual) {
        let n = merged.get(id); const seen = new Set<string>();
        while (n?.parent && !seen.has(n.parent)) { seen.add(n.parent); keep.add(n.parent); n = merged.get(n.parent); }
      }
      for (const id of merged.keys()) if (!keep.has(id)) merged.delete(id);
    }
    this.nodes = [...merged.values()]; this.tree = new Tree(this.nodes);
    this.selectedIds = new Set([...this.selectedIds].filter(id => this.tree.byId.has(id)));
    if (this.selected && !this.tree.byId.has(this.selected)) { this.selected = null; this.inlineId = null; }
    this.textIndex = new Map(this.nodes.map(n => [n.id, `${n.title}\n${n.notes}\n${n.tags.join(' ')}`.toLocaleLowerCase()]));
  }
  private render(): void {
    this.graph?.destroy(); this.graph = undefined;
    this.markdown?.unload(); this.detailEpoch++; this.renderEpoch++;
    this.contentEl.replaceChildren(); this.contentEl.classList.add('obsb-tasks');
    const bar = el(this.contentEl, 'div', '', 'obsb-task-toolbar');
    for (const [value, name] of [['current', '当前'], ['archive', '任务归档'], ['sleep', '休眠领域'], ['period', '时间回顾']] as const) {
      const b = button(bar, name, () => this.run(async () => { await this.flush(); this.draft = undefined; this.inlineId = null; this.source = value; this.selected = null; this.selectedIds.clear(); this.focusId = undefined; this.camera.initialized = false; await this.reload(); }));
      b.classList.toggle('is-active', this.source === value);
    }
    const switchView = button(bar, this.mode === 'map' ? '切换列表' : '切换导图', () => this.run(async () => {
      await this.flush(); this.inlineId = null; this.mode = this.mode === 'map' ? 'list' : 'map';
      switchView.textContent = this.mode === 'map' ? '切换列表' : '切换导图'; this.draw();
    }));
    button(bar, '刷新', () => this.run(async () => { await this.flush(); this.draft = undefined; this.inlineId = null; await this.reload(); }));
    if (this.source === 'current') {
      button(bar, '+ 任务', () => this.run(() => this.create('task')));
      button(bar, '+ 领域', () => this.run(() => this.create('area')));
      button(bar, '全局归档已完成', () => this.archive());
      button(bar, '空领域', () => this.emptyAreas());
    }
    const filters = el(this.contentEl, 'div', '', 'obsb-task-toolbar');
    const search = el(filters, 'input'); search.type = 'search'; search.placeholder = '搜索名称、注释、标签'; search.value = this.query;
    search.setAttribute('aria-label', '搜索任务');
    search.addEventListener('input', () => {
      this.query = search.value; window.clearTimeout(this.queryTimer);
      this.queryTimer = window.setTimeout(() => this.draw(), 140);
    });
    const status = el(filters, 'select'); status.setAttribute('aria-label', '状态');
    for (const [value, title] of Object.entries({ '': '所有状态（含已完成）', ...STATUS })) { const o = el(status, 'option', title); o.value = value; }
    status.value = this.status; status.addEventListener('change', () => { this.status = status.value; this.draw(); });
    const sort = el(filters, 'select'); sort.setAttribute('aria-label', '列表排序');
    for (const [value, title] of [['manual', '原顺序'], ['deadline', '截止日期'], ['importance', '重要程度']]) { const o = el(sort, 'option', title); o.value = value; }
    sort.value = this.sorting; sort.addEventListener('change', () => { this.sorting = sort.value; this.draw(); });
    if (this.source === 'period') {
      const field = el(filters, 'select'); field.setAttribute('aria-label', '时间口径');
      for (const [value, title] of [['completed', '按完成时间'], ['created', '按创建时间']]) { const o = el(field, 'option', title); o.value = value; }
      field.value = this.periodField; field.addEventListener('change', () => { this.periodField = field.value as typeof this.periodField; this.draw(); });
      for (const [key, title] of [['start', '开始日期'], ['end', '结束日期']] as const) {
        const input = el(filters, 'input'); input.type = 'date'; input.setAttribute('aria-label', title); input.value = this[key];
        input.addEventListener('change', () => { this[key] = input.value; this.draw(); });
      }
      el(this.contentEl, 'p', '按日期筛选，补充祖先上下文；不是当时状态回放。当前节点优先，其余采用最近归档记录。', 'obsb-task-hint');
    }
    this.statusEl = el(this.contentEl, 'div', '', 'obsb-task-hint');
    const body = el(this.contentEl, 'div', '', 'obsb-task-body');
    this.stage = el(body, 'div', '', 'obsb-task-stage'); this.panel = el(body, 'aside', '', 'obsb-task-detail');
    this.stage.tabIndex = 0; this.stage.setAttribute('aria-label', '任务思维导图');
    this.stage.addEventListener('keydown', event => this.diagramKey(event));
    this.draw(); void this.detail();
  }
  private matches(): Set<string> {
    const q = this.query.toLocaleLowerCase().trim();
    const period = this.source === 'period' ? periodNodes(this.nodes, this.periodField, this.start, this.end) : undefined;
    return new Set(this.nodes.filter(n => !this.contexts.has(n.id) && (!q || this.textIndex.get(n.id)?.includes(q)) &&
      (!this.status || n.kind === 'task' && n.status === this.status) && (!period || period.has(n.id))).map(n => n.id));
  }
  private draw(): void {
    const priorViewport = this.stage.querySelector<HTMLElement>('.obsb-task-viewport');
    if (priorViewport && !this.graph) this.listScroll = priorViewport.scrollTop;
    const editing = this.stage.querySelector<HTMLInputElement>('.obsb-task-inline-title');
    const caret = editing && document.activeElement === editing ? [editing.selectionStart, editing.selectionEnd] : undefined;
    this.graph?.destroy(); this.graph = undefined;
    const epoch = ++this.renderEpoch; this.stage.replaceChildren();
    try {
      const matches = this.matches();
      this.statusEl.textContent = `${this.source === 'current' ? '当前' : '查询'}：${[...matches].filter(id => this.tree.byId.get(id)?.kind === 'task').length} 个任务 · ${this.source === 'current' ? '归档和休眠不参与当前流程' : '只读；恢复操作会写入当前文件'}`;
      if (this.mode === 'list') this.list(matches, epoch); else this.map(matches, epoch);
      this.markSelected();
      if (caret) { const input = this.stage.querySelector<HTMLInputElement>('.obsb-task-inline-title'); input?.focus({ preventScroll: true }); input?.setSelectionRange(caret[0], caret[1]); }
    } catch (e) { el(this.stage, 'p', e instanceof Error ? e.message : String(e), 'obsb-task-error'); }
  }
  private list(matches: Set<string>, epoch: number): void {
    const rows = this.tree.order.filter(n => n.kind === 'task' && matches.has(n.id));
    if (this.sorting === 'deadline') rows.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    if (this.sorting === 'importance') { const rank = { high: 0, medium: 1, low: 2 }; rows.sort((a, b) => rank[a.importance] - rank[b.importance]); }
    const viewport = el(this.stage, 'div', '', 'obsb-task-viewport');
    const space = el(viewport, 'div', '', 'obsb-task-list-space'); space.style.height = `${rows.length * ROW}px`;
    const paint = (): void => {
      if (epoch !== this.renderEpoch) return;
      const start = Math.max(0, Math.floor(viewport.scrollTop / ROW) - 5), end = Math.min(rows.length, start + Math.ceil((viewport.clientHeight || 600) / ROW) + 12);
      space.replaceChildren();
      for (let i = start; i < end; i++) {
        const n = rows[i], row = el(space, 'button', '', 'obsb-task-row'); row.type = 'button';
        row.style.top = `${i * ROW}px`; row.style.height = `${ROW}px`;
        el(row, 'strong', `${n.status === 'done' ? '✓ ' : ''}${n.title}`);
        const parent = n.parent ? this.tree.byId.get(n.parent)?.title : 'root';
        el(row, 'span', `${STATUS[n.status]} · ${IMPORTANCE[n.importance]} · 截止 ${n.deadline || '未设置'} · ${n.estimate / 60}h · 上级 ${parent}`, 'obsb-task-hint');
        row.dataset.nodeId = n.id;
        row.addEventListener('click', () => { void this.run(() => this.select(n.id)).catch(report); });
      }
    };
    let queued = false;
    viewport.addEventListener('scroll', () => {
      if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); }
    });
    viewport.scrollTop = this.listScroll;
    if (this.selected) {
      const selectedIndex = rows.findIndex(n => n.id === this.selected);
      if (selectedIndex >= 0 && (selectedIndex * ROW < viewport.scrollTop || selectedIndex * ROW + ROW > viewport.scrollTop + (viewport.clientHeight || 600))) viewport.scrollTop = selectedIndex * ROW;
    }
    paint();
    if (!rows.length) el(this.stage, 'p', '没有匹配任务。');
  }
  private geometry(matches: Set<string>): GraphGeometry {
    if (this.revealNext && this.selected) for (const ancestor of this.tree.ancestors(this.selected)) this.collapsed.delete(ancestor.id);
    const include = new Set(matches);
    for (let i = this.tree.order.length - 1; i >= 0; i--) {
      const n = this.tree.order[i]; if (include.has(n.id) && n.parent) include.add(n.parent);
    }
    if (this.focusId && !this.tree.byId.has(this.focusId)) { this.focusId = undefined; this.camera.initialized = false; }
    if (this.focusId && this.selected && this.selected !== this.focusId && !this.tree.ancestors(this.selected).some(n => n.id === this.focusId)) {
      this.focusId = undefined; this.camera.initialized = false;
    }
    if (!this.measure && typeof CanvasRenderingContext2D !== 'undefined') {
      const context = this.stage.ownerDocument.createElement('canvas').getContext('2d');
      if (context) { context.font = '13px ' + (getComputedStyle(this.stage).fontFamily || 'sans-serif'); this.measure = text => context.measureText(text).width; }
    }
    const filtered = !!this.query || !!this.status || this.source === 'period';
    return layoutGraph(this.tree, include, filtered ? new Set() : this.collapsed, this.focusId, this.direction, this.measure);
  }
  private async navigate(key: string): Promise<void> {
    if (!this.graph) return;
    const g = this.graph.geometry, node = g.nodes.get(this.selected ?? g.root.id) ?? g.root;
    let next: GraphNode | undefined;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const siblings = (node.parent?.children ?? [node]).filter(n => n.direct === node.direct) as GraphNode[];
      const index = siblings.indexOf(node); next = siblings[index + (key === 'ArrowDown' ? 1 : -1)];
    } else {
      const outwards = node === g.root || (node.direct === 'left' ? key === 'ArrowLeft' : key === 'ArrowRight');
      if (outwards) next = (node.children.find(n => node !== g.root || n.direct === (key === 'ArrowLeft' ? 'left' : 'right')) ?? node.children[0]) as GraphNode | undefined;
      else next = node.parent as GraphNode | undefined;
    }
    if (next) { await this.select(next.task?.id ?? null); this.graph?.reveal(next.id); }
  }
  private map(matches: Set<string>, _epoch: number): void {
    const controls = el(this.stage, 'div', '', 'obsb-task-map-controls');
    controls.setAttribute('aria-label', '导图工具栏');
    const tool = (text: string, title: string, action: () => unknown): HTMLButtonElement => {
      const b = button(controls, text, action); b.title = title; b.setAttribute('aria-label', title); return b;
    };
    let pan = false;
    const panButton = tool('✋', '切换左键平移模式；右键始终可以平移', () => {
      pan = !pan; if (this.graph) this.graph.gestures.panMode = pan; panButton.classList.toggle('is-active', pan);
    });
    const undo = tool('↶', '撤销 Ctrl/Cmd+Z', () => this.run(() => this.undo()));
    const redo = tool('↷', '重做 Ctrl/Cmd+Y', () => this.run(() => this.undo(true)));
    if (this.source !== 'current') undo.hidden = redo.hidden = true;
    tool('−', '缩小', () => this.graph?.gestures.zoom(this.camera.scale / 1.15));
    const scale = tool('100%', '恢复 100%', () => this.graph?.gestures.zoom(1));
    tool('+', '放大', () => this.graph?.gestures.zoom(this.camera.scale * 1.15));
    tool('⌾', '回到中心 Home', () => this.graph?.center());
    tool('⤢', '适应画布', () => this.graph?.fit());
    const layout = el(controls, 'select'); layout.setAttribute('aria-label', '导图布局');
    for (const [value, title] of [['mindmap', '双侧导图'], ['right', '向右展开']]) { const o = el(layout, 'option', title); o.value = value; }
    layout.value = this.direction; layout.addEventListener('change', () => { this.direction = layout.value as typeof this.direction; this.camera.initialized = false; this.draw(); });
    tool('聚焦', '只看选中节点及其子树', () => this.run(async () => {
      await this.flush(); if (this.selected) { this.focusId = this.selected; this.camera.initialized = false; this.draw(); }
    }));
    if (this.focusId) tool('返回 root', '返回完整任务图', () => { this.focusId = undefined; this.camera.initialized = false; this.draw(); });
    tool('收起全部', '收起全部分支', () => this.run(async () => { await this.flush(); this.collapsed = new Set(this.nodes.map(n => n.id)); this.draw(); }));
    tool('展开全部', '展开全部分支', () => this.run(async () => { await this.flush(); this.collapsed.clear(); this.draw(); }));
    el(this.stage, 'div', this.source === 'current'
      ? '右键拖动画布 · 左键框选 / 拖动节点 · Ctrl 滚轮缩放 · Tab 子任务 / Enter 同级 · Space 编辑'
      : '右键平移 · Ctrl 滚轮缩放 · 历史视图只读', 'obsb-task-hint');
    this.graph = new GraphCanvas(this.stage, this.geometry(matches), this.camera, {
      selected: () => this.selectedIds,
      select: (ids, primary) => { void this.run(() => this.selectMany(ids, primary)).catch(report); },
      move: (ids, target, placement) => { void this.run(() => this.move(ids, target, placement)).catch(report); },
      scaleChanged: value => {
        scale.textContent = Math.round(value * 100) + '%'; undo.disabled = !this.history.peek(); redo.disabled = !this.history.peek(true);
      },
      edit: id => { void this.run(async () => { if (this.selected !== id) await this.select(id); await this.beginTitle(); }).catch(report); },
      render: (card, node) => {
        const n = node.task;
        card.className = 'obsb-task-card obsb-core-node ' + (n?.kind ?? 'root') + (n?.status === 'done' ? ' done' : '');
        card.dataset.nodeId = n?.id ?? '';
        card.dataset.direction = node.direct;
        if (n && !matches.has(n.id)) card.classList.add('context');
        if (n && this.inlineId === n.id) this.titleInput(card, n);
        else {
          const title = el(card, 'button', n?.title ?? 'root');
          title.type = 'button'; title.dataset.mapTitle = 'true';
          title.addEventListener('click', event => {
            const id = n?.id;
            const ids = new Set(event.ctrlKey || event.metaKey || event.shiftKey ? this.selectedIds : []);
            if (id) { if (ids.has(id)) ids.delete(id); else ids.add(id); }
            void this.run(() => this.selectMany([...ids], id)).catch(report);
          });
          if (n) title.addEventListener('dblclick', () => { void this.run(async () => { if (this.selected !== n.id) await this.select(n.id); await this.beginTitle(); }).catch(report); });
        }
        if (n) this.mapAppearance(card, n);
        const id = n?.id, count = this.tree.children.get(id ?? null)?.length ?? 0;
        if (id && count) {
          const fold = button(card, '', () => this.run(async () => {
            await this.flush(); if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id); this.draw();
          }));
          fold.className = 'obsb-map-fold'; fold.title = (this.collapsed.has(id) ? '展开 ' : '收起 ') + count + ' 个子节点';
          fold.setAttribute('aria-label', fold.title);
          fold.setAttribute('aria-expanded', String(!this.collapsed.has(id)));
        }
      }
    }, this.source !== 'current');
    if (this.revealNext && this.selected) { this.graph.reveal(this.selected); this.revealNext = false; }
  }
  private async detail(): Promise<void> {
    const epoch = ++this.detailEpoch; this.markdown?.unload(); this.panel.replaceChildren(); this.draft = undefined;
    const n = this.selected ? this.tree.byId.get(this.selected) : undefined;
    if (!n) { el(this.panel, 'h3', 'root'); el(this.panel, 'p', '选中 root 按 Tab 或 Enter 直接添加任务。选中节点后，在这里修改属性；改动选项或离开输入框自动保存。'); return; }
    el(this.panel, 'h3', this.source === 'current' ? '节点属性' : n.title);
    if (this.source !== 'current') {
      el(this.panel, 'p', n.kind === 'area' ? '领域（只读）' : `${STATUS[n.status]} · 重要程度：${IMPORTANCE[n.importance]}（只读）`);
      if (n.kind === 'task') el(this.panel, 'p', `截止：${n.deadline || '未设置'}\n计划：${n.planned || '未设置'}\n预计：${n.estimate / 60}h · 实际：${n.actual / 60}h\n完成：${n.completed ? new Date(n.completed).toLocaleString() : '未完成'}`);
    }
    const actions = el(this.panel, 'div', '', 'obsb-task-toolbar');
    if (this.source === 'current') {
      button(actions, '+ 子任务', () => this.run(() => this.create('task', n.id)));
      const addArea = button(actions, '+ 子领域', () => this.run(() => this.create('area', n.id)));
      const sleep = button(actions, '休眠领域', () => this.sleep(n.id));
      const body = document.createElement('div'); body.className = 'obsb-task-notes markdown-rendered';
      const renderNotes = (): void => {
        if (this.closed || epoch !== this.detailEpoch) return;
        addArea.hidden = sleep.hidden = this.draft?.value.kind !== 'area';
        this.markdown?.unload(); this.markdown = new Component(); this.markdown.load(); body.replaceChildren();
        void MarkdownRenderer.render(this.app, this.draft?.value.notes || '*暂无注释*', body, CURRENT, this.markdown).catch(report);
      };
      this.draft = new NodeDraft(n, this.board.revision, async (draft, revision) => {
        const previousParent = this.tree.byId.get(draft.id)?.parent;
        const next = await this.commit(b => upsert(b, draft), revision);
        this.board = next; this.dirty = false;
        if (!this.closed) {
          this.prepare();
          if (previousParent !== draft.parent || !this.inlineId && (this.query || this.status) || !this.graph) { this.revealNext = true; this.draw(); }
          else { this.graph.setGeometry(this.geometry(this.matches())); this.updateVisibleNode(next.nodes.find(node => node.id === draft.id)!); }
        }
        return next;
      });
      inspector(this.panel, this.draft, this.board, renderNotes, () => {
        new ConfirmModal(this.plugin, '重新加载文件', '放弃当前节点未保存的修改。需要保留时，请先使用“复制未保存内容”。', async () => {
          this.draft = undefined; this.inlineId = null; await this.reload();
        }).open();
      });
      el(this.panel, 'h4', '注释预览'); this.panel.append(body);
    } else {
      const saved = [...this.batches].reverse().find(b => b.batch.nodes.some(item => item.id === n.id));
      if (saved && !this.board.nodes.some(item => item.id === n.id)) button(actions, saved.batch.kind === 'sleep' ? '恢复领域（含该批次节点）' : '恢复此归档批次', () => {
        new ConfirmModal(this.plugin, '恢复到当前文件', `恢复该批次 ${saved.batch.nodes.length} 个节点及必要祖先。归档任务保持完成状态。`, async () => {
          await this.plugin.store.restore(this.board.revision, saved.path); await this.reload();
        }).open();
      });
    }
    button(actions, '复制稳定链接', async () => {
      const uri = `obsidian://obsb-task?vault=${encodeURIComponent(this.app.vault.getName())}&id=${encodeURIComponent(n.id)}`;
      const title = this.draft?.value.id === n.id ? this.draft.value.title : n.title;
      await navigator.clipboard.writeText(`[${title.replace(/[\[\]]/g, '')}](${uri})`); new Notice('链接已复制，归档后仍可显式访问');
    });
    const source = this.paths.get(n.id) ?? CURRENT;
    button(actions, '打开源文件', () => this.app.workspace.openLinkText(`${source}#^${n.id}`, source));
    if (this.source === 'current') return;
    const body = el(this.panel, 'div', '', 'obsb-task-notes markdown-rendered');
    this.markdown = new Component(); this.markdown.load();
    try {
      await MarkdownRenderer.render(this.app, n.notes || '*暂无注释*', body, source, this.markdown);
      if (epoch !== this.detailEpoch) body.remove();
    } catch (e) { if (epoch === this.detailEpoch) el(body, 'p', String(e)); }
  }
  async archive(): Promise<void> {
    await this.flush();
    const plan = archivePlan(this.board);
    if (!plan.ids.size) { new Notice(`没有可归档任务${plan.skipped ? `，跳过 ${plan.skipped} 个仍有未完成后代的父任务` : ''}`); return; }
    const revision = this.board.revision;
    new ConfirmModal(this.plugin, '全局归档已完成任务', `从当前文件移出 ${plan.ids.size} 个已完成任务。保留所有领域，跳过 ${plan.skipped} 个仍有未完成后代的父任务。归档前请确保其他设备修改已同步。`, async () => {
      await this.plugin.store.removeToBatch(revision, plan.ids, 'archive'); await this.reload();
      new Notice('归档完成；可在“空领域”中选择需要休眠的领域');
    }).open();
  }
  private async sleep(id: string): Promise<void> {
    await this.flush();
    const ids = sleepPlan(this.board, id), revision = this.board.revision;
    new ConfirmModal(this.plugin, '休眠领域', `移出该领域及其 ${ids.size - 1} 个后代。不会自动恢复以前的归档任务，可在休眠入口重新启用。`, async () => {
      await this.plugin.store.removeToBatch(revision, ids, 'sleep'); this.selected = null; await this.reload();
    }).open();
  }
  private async emptyAreas(): Promise<void> {
    await this.flush();
    const tree = new Tree(this.board.nodes), hasTask = new Set<string>();
    for (let i = tree.order.length - 1; i >= 0; i--) {
      const n = tree.order[i]; if (n.parent && (n.kind === 'task' || hasTask.has(n.id))) hasTask.add(n.parent);
    }
    const areas = tree.order.filter(n => n.kind === 'area' && !hasTask.has(n.id));
    const modal = new ConfirmModal(this.plugin, '空领域检查', `${areas.length} 个领域没有当前任务。此检查不会自动休眠。`, async () => {});
    // Reuse a simple modal, with individual explicit choices rather than bulk inference.
    modal.open();
    for (const n of areas.slice(0, 100)) button(modal.contentEl, `休眠：${n.title}`, () => { modal.close(); this.sleep(n.id); });
    if (areas.length > 100) el(modal.contentEl, 'p', '仅列出前 100 项；也可在导图中逐个休眠。');
  }
  async locate(id: string): Promise<void> {
    if (!id) return;
    await this.flush(); this.draft = undefined; this.inlineId = null;
    this.source = 'current'; await this.reload();
    if (!this.tree.byId.has(id)) {
      this.batches = await this.plugin.store.batches();
      const saved = [...this.batches].reverse().find(b => b.batch.nodes.some(n => n.id === id));
      if (!saved) { new Notice('未找到该节点'); return; }
      this.source = saved.batch.kind === 'sleep' ? 'sleep' : 'archive'; await this.reload();
    }
    this.selected = id; this.selectedIds = new Set([id]); this.revealNext = true; this.query = ''; this.status = '';
    for (const ancestor of this.tree.ancestors(id)) this.collapsed.delete(ancestor.id);
    this.render(); await this.detail();
  }
}
