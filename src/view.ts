import { Component, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from 'obsidian';
import TaskPlugin, { button, ConfirmModal, el, IMPORTANCE, report, STATUS } from './main';
import { inspector, NodeDraft } from './inspector';
import { archivePlan, Board, Kind, newNode, periodNodes, sleepPlan, TaskNode, Tree, upsert } from './model';
import { CURRENT, SavedBatch } from './store';

type Source = 'current' | 'archive' | 'sleep' | 'period';
interface Point { id: string | null; x: number; y: number; }
const ROW = 56, GAP = 72, STEP = 270;
export class TaskView extends ItemView {
  ready: Promise<void> = Promise.resolve();
  board!: Board;
  private source: Source = 'current';
  private mode: 'map' | 'list' = 'map';
  private selected: string | null = null;
  private collapsed = new Set<string>();
  private query = ''; private status = ''; private sorting = 'manual';
  private periodField: 'created' | 'completed' = 'completed';
  private start = ''; private end = ''; private zoom = 1;
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
  private mapScroll = { left: 0, top: 0 };
  private listScroll = 0;
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
    this.markdown?.unload(); this.detailEpoch++; this.renderEpoch++;
  }
  private run(action: () => Promise<void>): Promise<void> {
    const next = this.actions.then(async () => { if (!this.closed) await action(); });
    this.actions = next.catch(() => {}); return next;
  }
  private async flush(): Promise<void> { await this.draft?.flush(); }
  private async select(id: string | null): Promise<void> {
    await this.flush(); this.inlineId = null; this.selected = id;
    await this.detail(); this.markSelected(); this.stage.focus({ preventScroll: true });
  }
  private markSelected(): void {
    for (const card of this.stage.querySelectorAll<HTMLElement>('[data-node-id]')) card.classList.toggle('is-selected', card.dataset.nodeId === (this.selected ?? ''));
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
        const title = card.querySelector('button');
        // Keep an active inline editor and pointer target mounted during asynchronous saves.
        if (!card.querySelector('.obsb-task-inline-title') && title) title.textContent = `${node.kind === 'area' ? '▣ ' : node.status === 'done' ? '✓ ' : '○ '}${node.title}`;
        const info = card.querySelector('small');
        if (node.kind === 'task') (info ?? el(card, 'small')).textContent = `${STATUS[node.status]} · ${IMPORTANCE[node.importance]}${node.deadline ? ` · ${node.deadline}` : ''}${node.notes ? ' · 📝' : ''}`;
        else info?.remove();
      }
    }
    this.statusEl.textContent = `当前：${this.nodes.filter(n => n.kind === 'task').length} 个任务 · 归档和休眠不参与当前流程`;
  }
  private diagramKey(event: KeyboardEvent): void {
    if (this.source !== 'current' || this.mode !== 'map' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"]') || target.closest('button') && !target.closest('[data-node-id]')) return;
    if (!['Tab', 'Enter', 'F2'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); if (event.repeat) return;
    void this.run(async () => {
      if (event.key === 'F2') { await this.beginTitle(); return; }
      await this.createRelative(event.key === 'Tab');
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
    const next = await this.plugin.store.change(this.board.revision, b => upsert(b, node, afterId));
    this.board = next; this.selected = node.id; this.inlineId = null;
    // The newly created node must remain visible even when the old query would hide it.
    this.query = ''; this.status = ''; this.mode = 'map';
    this.prepare(); for (const ancestor of this.tree.ancestors(node.id)) this.collapsed.delete(ancestor.id);
    this.render(); await this.beginTitle();
  }
  private async beginTitle(): Promise<void> {
    if (!this.selected || this.source !== 'current') return;
    if (!this.draft || this.draft.value.id !== this.selected) await this.detail();
    this.inlineId = this.selected; this.inlineOriginal = this.draft!.value.title;
    this.draw(); const input = this.stage.querySelector<HTMLInputElement>('.obsb-task-inline-title'); input?.focus(); input?.select();
  }
  private titleInput(card: HTMLElement, node: TaskNode): void {
    const input = el(card, 'input'); input.className = 'obsb-task-inline-title'; input.setAttribute('aria-label', '节点名称');
    input.value = this.draft?.value.title ?? node.title;
    input.addEventListener('input', () => this.draft?.patch({ title: input.value }));
    input.addEventListener('compositionstart', () => this.draft?.composition(true));
    input.addEventListener('compositionend', () => this.draft?.composition(false));
    input.addEventListener('change', () => { void this.flush().catch(report); });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['Enter', 'Tab', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); if (event.repeat) return;
      void this.run(async () => {
        if (event.key === 'Escape') this.draft?.patch({ title: this.inlineOriginal });
        await this.flush(); this.inlineId = null;
        if (event.key === 'Tab') await this.createRelative(true);
        else { this.draw(); this.stage.focus({ preventScroll: true }); }
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
    this.textIndex = new Map(this.nodes.map(n => [n.id, `${n.title}\n${n.notes}\n${n.tags.join(' ')}`.toLocaleLowerCase()]));
  }
  private render(): void {
    this.markdown?.unload(); this.detailEpoch++; this.renderEpoch++;
    this.contentEl.replaceChildren(); this.contentEl.classList.add('obsb-tasks');
    const bar = el(this.contentEl, 'div', '', 'obsb-task-toolbar');
    for (const [value, name] of [['current', '当前'], ['archive', '任务归档'], ['sleep', '休眠领域'], ['period', '时间回顾']] as const) {
      const b = button(bar, name, () => this.run(async () => { await this.flush(); this.draft = undefined; this.inlineId = null; this.source = value; this.selected = null; await this.reload(); }));
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
    if (priorViewport) {
      if (this.stage.querySelector('.obsb-task-map-space')) this.mapScroll = { left: priorViewport.scrollLeft, top: priorViewport.scrollTop };
      else this.listScroll = priorViewport.scrollTop;
    }
    const editing = this.stage.querySelector<HTMLInputElement>('.obsb-task-inline-title');
    const caret = editing && document.activeElement === editing ? [editing.selectionStart, editing.selectionEnd] : undefined;
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
  private map(matches: Set<string>, epoch: number): void {
    el(this.stage, 'div', this.source === 'current' ? 'Tab 添加子任务 · Enter 添加同类型同级节点 · F2 / 双击修改名称' : '历史视图只读；恢复到当前文件后可编辑', 'obsb-task-hint');
    const controls = el(this.stage, 'div', '', 'obsb-task-map-controls');
    button(controls, '−', () => { this.zoom = Math.max(0.35, this.zoom - 0.15); this.draw(); });
    el(controls, 'span', `${Math.round(this.zoom * 100)}%`);
    button(controls, '+', () => { this.zoom = Math.min(1.7, this.zoom + 0.15); this.draw(); });
    button(controls, '收起全部', () => { this.collapsed = new Set(this.nodes.map(n => n.id)); this.draw(); });
    button(controls, '展开全部', () => { this.collapsed.clear(); this.draw(); });
    const filtered = !!this.query || !!this.status || this.source === 'period';
    const include = new Set(matches);
    // One reverse pass propagates matches to ancestors, O(nodes), including deep chains.
    for (let i = this.tree.order.length - 1; i >= 0; i--) {
      const n = this.tree.order[i]; if (include.has(n.id) && n.parent) include.add(n.parent);
    }
    const visible: { id: string | null; depth: number }[] = [{ id: null, depth: 0 }];
    const stack = [...(this.tree.children.get(null) ?? [])].reverse().map(n => ({ id: n.id, depth: 1 }));
    while (stack.length) {
      const item = stack.pop()!;
      if (!include.has(item.id)) continue;
      visible.push(item);
      if (!filtered && this.collapsed.has(item.id)) continue;
      const children = this.tree.children.get(item.id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i].id, depth: item.depth + 1 });
    }
    const positions = new Map<string | null, Point>(); let row = 0, maxDepth = 0;
    // Leaf positions first, then center parents over children.
    for (let i = visible.length - 1; i >= 0; i--) {
      const item = visible[i], children = (this.tree.children.get(item.id) ?? []).map(n => positions.get(n.id)).filter((p): p is Point => !!p);
      const y = children.length ? (children[0].y + children[children.length - 1].y) / 2 : row++ * GAP + 36;
      positions.set(item.id, { id: item.id, x: item.depth * STEP + 24, y }); maxDepth = Math.max(maxDepth, item.depth);
    }
    const extent = Math.max(0, (row - 1) * GAP) + 72;
    for (const p of positions.values()) p.y = extent - p.y;
    const points = [...positions.values()].sort((a, b) => a.y - b.y);
    const viewport = el(this.stage, 'div', '', 'obsb-task-viewport');
    const space = el(viewport, 'div', '', 'obsb-task-map-space');
    space.style.width = `${(maxDepth * STEP + 300) * this.zoom}px`; space.style.height = `${Math.max(row * GAP + 80, 300) * this.zoom}px`;
    const layer = el(space, 'div', '', 'obsb-task-map-layer'); layer.style.transform = `scale(${this.zoom})`;
    const paint = (): void => {
      if (epoch !== this.renderEpoch) return;
      // Scrolling must not detach an input while its IME composition is in progress.
      if (layer.contains(document.activeElement) && (document.activeElement as HTMLElement)?.classList.contains('obsb-task-inline-title')) return;
      const top = viewport.scrollTop / this.zoom - 100, bottom = top + (viewport.clientHeight || 600) / this.zoom + 200;
      const left = viewport.scrollLeft / this.zoom - 260, right = left + (viewport.clientWidth || 900) / this.zoom + 520;
      let lo = 0, hi = points.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].y < top) lo = mid + 1; else hi = mid; }
      layer.replaceChildren();
      for (let i = lo; i < points.length && points[i].y <= bottom; i++) {
        const p = points[i]; if (p.x < left || p.x > right) continue;
        const n = p.id ? this.tree.byId.get(p.id)! : undefined;
        const card = el(layer, 'div', '', `obsb-task-card ${n?.kind ?? 'root'} ${n?.status === 'done' ? 'done' : ''}`);
        card.dataset.nodeId = n?.id ?? ''; card.classList.toggle('is-selected', (n?.id ?? null) === this.selected);
        card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
        if (n && !matches.has(n.id)) card.classList.add('context');
        if (n && this.inlineId === n.id) this.titleInput(card, n);
        else {
          const title = button(card, n ? `${n.kind === 'area' ? '▣ ' : n.status === 'done' ? '✓ ' : '○ '}${n.title}` : 'root', () => this.run(() => this.select(n?.id ?? null)));
          if (n) title.addEventListener('dblclick', () => { void this.run(async () => { if (this.selected !== n.id) await this.select(n.id); await this.beginTitle(); }).catch(report); });
        }
        if (n?.kind === 'task') el(card, 'small', `${STATUS[n.status]} · ${IMPORTANCE[n.importance]}${n.deadline ? ` · ${n.deadline}` : ''}${n.notes ? ' · 📝' : ''}`);
        const count = this.tree.children.get(p.id)?.length ?? 0;
        if (p.id && count) button(card, `${this.collapsed.has(p.id) ? '+' : '−'} ${count}`, () => {
          if (this.collapsed.has(p.id!)) this.collapsed.delete(p.id!); else this.collapsed.add(p.id!); this.draw();
        });
        if (n) {
          const parent = positions.get(n.parent);
          if (parent) {
            const line = el(layer, 'div', '', 'obsb-task-branch');
            const x = parent.x + 230, y = Math.min(parent.y, p.y) + 25;
            line.style.left = `${x}px`; line.style.top = `${y}px`;
            line.style.width = `${p.x - x}px`; line.style.height = `${Math.abs(p.y - parent.y) || 1}px`;
            line.classList.toggle('branch-up', p.y < parent.y);
          }
        }
      }
    };
    let queued = false;
    viewport.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } });
    const focus = positions.get(this.selected);
    viewport.scrollTop = this.mapScroll.top; viewport.scrollLeft = this.mapScroll.left;
    if (focus) {
      if (focus.y * this.zoom < viewport.scrollTop || (focus.y + 60) * this.zoom > viewport.scrollTop + (viewport.clientHeight || 600)) viewport.scrollTop = Math.max(0, focus.y * this.zoom - 100);
      if (focus.x * this.zoom < viewport.scrollLeft || (focus.x + 230) * this.zoom > viewport.scrollLeft + (viewport.clientWidth || 900)) viewport.scrollLeft = Math.max(0, focus.x * this.zoom - 100);
    }
    paint();
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
        const next = await this.plugin.store.change(revision, b => upsert(b, draft));
        this.board = next; this.dirty = false;
        if (!this.closed) {
          this.prepare();
          if (previousParent !== draft.parent || !this.inlineId && (this.query || this.status)) this.draw();
          else this.updateVisibleNode(next.nodes.find(node => node.id === draft.id)!);
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
    this.selected = id; this.query = ''; this.status = '';
    for (const ancestor of this.tree.ancestors(id)) this.collapsed.delete(ancestor.id);
    this.render(); await this.detail();
  }
}
