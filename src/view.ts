import { Component, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import TaskPlugin, { button, ConfirmModal, EditModal, el, IMPORTANCE, report, STATUS } from './main';
import { archivePlan, Board, Kind, localDay, newNode, periodNodes, sleepPlan, TaskNode, Tree, upsert } from './model';
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
  constructor(leaf: WorkspaceLeaf, public plugin: TaskPlugin) { super(leaf); }
  getViewType(): string { return 'obsb-tasks-view'; }
  getDisplayText(): string { return '任务管理'; }
  getIcon(): string { return 'list-tree'; }
  async onOpen(): Promise<void> { this.ready = this.reload(); await this.ready; }
  async onClose(): Promise<void> {
    window.clearTimeout(this.changeTimer); window.clearTimeout(this.queryTimer);
    this.markdown?.unload(); this.detailEpoch++; this.renderEpoch++;
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
      const b = button(bar, name, async () => { this.source = value; this.selected = null; await this.reload(); });
      b.classList.toggle('is-active', this.source === value);
    }
    button(bar, this.mode === 'map' ? '切换列表' : '切换导图', () => { this.mode = this.mode === 'map' ? 'list' : 'map'; this.draw(); });
    button(bar, '刷新', () => this.reload());
    if (this.source === 'current') {
      button(bar, '+ 任务', () => this.edit('task'));
      button(bar, '+ 领域', () => this.edit('area'));
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
    this.draw(); void this.detail();
  }
  private matches(): Set<string> {
    const q = this.query.toLocaleLowerCase().trim();
    const period = this.source === 'period' ? periodNodes(this.nodes, this.periodField, this.start, this.end) : undefined;
    return new Set(this.nodes.filter(n => !this.contexts.has(n.id) && (!q || this.textIndex.get(n.id)?.includes(q)) &&
      (!this.status || n.kind === 'task' && n.status === this.status) && (!period || period.has(n.id))).map(n => n.id));
  }
  private draw(): void {
    const epoch = ++this.renderEpoch; this.stage.replaceChildren();
    try {
      const matches = this.matches();
      this.statusEl.textContent = `${this.source === 'current' ? '当前' : '查询'}：${[...matches].filter(id => this.tree.byId.get(id)?.kind === 'task').length} 个任务 · ${this.source === 'current' ? '归档和休眠不参与当前流程' : '只读；恢复操作会写入当前文件'}`;
      if (this.mode === 'list') this.list(matches, epoch); else this.map(matches, epoch);
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
        row.addEventListener('click', () => { this.selected = n.id; void this.detail(); });
      }
    };
    let queued = false;
    viewport.addEventListener('scroll', () => {
      if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); }
    });
    if (this.selected) {
      const selectedIndex = rows.findIndex(n => n.id === this.selected);
      if (selectedIndex >= 0) viewport.scrollTop = selectedIndex * ROW;
    }
    paint();
    if (!rows.length) el(this.stage, 'p', '没有匹配任务。');
  }
  private map(matches: Set<string>, epoch: number): void {
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
      const top = viewport.scrollTop / this.zoom - 100, bottom = top + (viewport.clientHeight || 600) / this.zoom + 200;
      const left = viewport.scrollLeft / this.zoom - 260, right = left + (viewport.clientWidth || 900) / this.zoom + 520;
      let lo = 0, hi = points.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].y < top) lo = mid + 1; else hi = mid; }
      layer.replaceChildren();
      for (let i = lo; i < points.length && points[i].y <= bottom; i++) {
        const p = points[i]; if (p.x < left || p.x > right) continue;
        const n = p.id ? this.tree.byId.get(p.id)! : undefined;
        const card = el(layer, 'div', '', `obsb-task-card ${n?.kind ?? 'root'} ${n?.status === 'done' ? 'done' : ''}`);
        card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
        if (n && !matches.has(n.id)) card.classList.add('context');
        button(card, n ? `${n.kind === 'area' ? '▣ ' : n.status === 'done' ? '✓ ' : '○ '}${n.title}` : 'root', () => { this.selected = n?.id ?? null; void this.detail(); });
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
    if (focus) { viewport.scrollTop = Math.max(0, focus.y * this.zoom - 100); viewport.scrollLeft = Math.max(0, focus.x * this.zoom - 100); }
    paint();
  }
  private async detail(): Promise<void> {
    const epoch = ++this.detailEpoch; this.markdown?.unload(); this.panel.replaceChildren();
    const n = this.selected ? this.tree.byId.get(this.selected) : undefined;
    if (!n) { el(this.panel, 'h3', 'root'); el(this.panel, 'p', '任务可以直接挂在 root，也可以放进领域。选中节点查看详情。'); return; }
    el(this.panel, 'h3', n.title); el(this.panel, 'p', n.kind === 'area' ? '领域' : `${STATUS[n.status]} · 重要程度：${IMPORTANCE[n.importance]}`);
    if (n.kind === 'task') el(this.panel, 'p', `截止：${n.deadline || '未设置'}\n计划：${n.planned || '未设置'}\n预计：${n.estimate / 60}h · 实际：${n.actual / 60}h\n完成：${n.completed ? new Date(n.completed).toLocaleString() : '未完成'}`);
    const actions = el(this.panel, 'div', '', 'obsb-task-toolbar');
    if (this.source === 'current') {
      button(actions, '编辑 / 移动', () => this.edit(n.kind, n));
      button(actions, '+ 子任务', () => this.edit('task', undefined, n.id));
      if (n.kind === 'area') {
        button(actions, '+ 子领域', () => this.edit('area', undefined, n.id));
        button(actions, '休眠领域', () => this.sleep(n.id));
      } else button(actions, n.status === 'done' ? '重新打开' : '完成', async () => {
        await this.plugin.store.change(this.board.revision, b => upsert(b, { ...n, status: n.status === 'done' ? 'todo' : 'done' }));
        await this.reload();
      });
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
      await navigator.clipboard.writeText(`[${n.title.replace(/[\[\]]/g, '')}](${uri})`); new Notice('链接已复制，归档后仍可显式访问');
    });
    const source = this.paths.get(n.id) ?? CURRENT;
    button(actions, '打开源文件', () => this.app.workspace.openLinkText(`${source}#^${n.id}`, source));
    const body = el(this.panel, 'div', '', 'obsb-task-notes markdown-rendered');
    this.markdown = new Component(); this.markdown.load();
    try {
      await MarkdownRenderer.render(this.app, n.notes || '*暂无注释*', body, source, this.markdown);
      if (epoch !== this.detailEpoch) body.remove();
    } catch (e) { if (epoch === this.detailEpoch) el(body, 'p', String(e)); }
  }
  private edit(kind: Kind, existing?: TaskNode, parent?: string): void {
    if (this.source !== 'current') return;
    const node = existing ?? newNode(kind, parent ?? null);
    const revision = this.board.revision;
    new EditModal(this.plugin, this.board, node, async draft => {
      await this.plugin.store.change(revision, b => upsert(b, draft)); this.selected = draft.id; await this.reload();
    }).open();
  }
  archive(): void {
    const plan = archivePlan(this.board);
    if (!plan.ids.size) { new Notice(`没有可归档任务${plan.skipped ? `，跳过 ${plan.skipped} 个仍有未完成后代的父任务` : ''}`); return; }
    const revision = this.board.revision;
    new ConfirmModal(this.plugin, '全局归档已完成任务', `从当前文件移出 ${plan.ids.size} 个已完成任务。保留所有领域，跳过 ${plan.skipped} 个仍有未完成后代的父任务。归档前请确保其他设备修改已同步。`, async () => {
      await this.plugin.store.removeToBatch(revision, plan.ids, 'archive'); await this.reload();
      new Notice('归档完成；可在“空领域”中选择需要休眠的领域');
    }).open();
  }
  private sleep(id: string): void {
    const ids = sleepPlan(this.board, id), revision = this.board.revision;
    new ConfirmModal(this.plugin, '休眠领域', `移出该领域及其 ${ids.size - 1} 个后代。不会自动恢复以前的归档任务，可在休眠入口重新启用。`, async () => {
      await this.plugin.store.removeToBatch(revision, ids, 'sleep'); this.selected = null; await this.reload();
    }).open();
  }
  private emptyAreas(): void {
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
