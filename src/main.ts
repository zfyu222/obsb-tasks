import { Component, ItemView, MarkdownRenderer, Modal, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { archivePlan, Board, Kind, localDay, newNode, periodNodes, sleepPlan, TaskNode, Tree, upsert } from './model';
import { ARCHIVE, CURRENT, Files, ROOT, SLEEP, TaskStore } from './store';
import { TaskView } from './view';

export const VIEW = 'obsb-tasks-view';
export const STATUS: Record<string, string> = { todo: '待办', doing: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消' };
export const IMPORTANCE: Record<string, string> = { high: '高', medium: '中', low: '低' };
export function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.textContent = text;
  if (cls) result.className = cls; parent.appendChild(result); return result;
}
export function button(parent: HTMLElement, text: string, action: () => unknown): HTMLButtonElement {
  const b = el(parent, 'button', text); b.type = 'button';
  b.addEventListener('click', () => { void Promise.resolve().then(action).catch(report); }); return b;
}
export function report(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error), 8000); }
class VaultFiles implements Files {
  constructor(private plugin: TaskPlugin) {}
  exists(path: string): boolean { return !!this.plugin.app.vault.getAbstractFileByPath(path); }
  async read(path: string): Promise<string> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`文件不存在：${path}`);
    return this.plugin.app.vault.read(file);
  }
  async create(path: string, text: string): Promise<void> {
    const parts = path.split('/'); parts.pop(); let folder = '';
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      if (!this.exists(folder)) {
        try { await this.plugin.app.vault.createFolder(folder); }
        catch (e) { if (!this.exists(folder)) throw e; }
      }
    }
    await this.plugin.app.vault.create(path, text);
  }
  list(folder: string): string[] {
    return this.plugin.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(`${folder}/`)).map(f => f.path);
  }
  async compareWrite(path: string, before: string, after: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('文件已被移动或删除，请重新加载');
    await this.plugin.app.vault.process(file, actual => {
      if (actual !== before) throw new Error('检测到外部修改，未覆盖文件，请重新加载');
      return after;
    });
  }
}
export default class TaskPlugin extends Plugin {
  store!: TaskStore;
  async onload(): Promise<void> {
    this.store = new TaskStore(new VaultFiles(this));
    this.registerView(VIEW, leaf => new TaskView(leaf, this));
    this.addRibbonIcon('list-tree', '打开任务管理', () => { void this.open().catch(report); });
    this.addCommand({ id: 'open', name: '打开任务管理', callback: () => { void this.open().catch(report); } });
    this.addCommand({ id: 'archive-completed', name: '全局归档已完成任务', callback: () => {
      void this.open().then(v => v.archive()).catch(report);
    } });
    this.registerObsidianProtocolHandler('obsb-task', params => {
      if (params.vault && params.vault !== this.app.vault.getName()) { report('该链接属于其他知识库'); return; }
      void this.open().then(v => v.locate(params.id ?? '')).catch(report);
    });
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file.path === CURRENT || file.path.startsWith(`${ARCHIVE}/`) || file.path.startsWith(`${SLEEP}/`)) {
        this.store.invalidate();
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) (leaf.view as TaskView).externalChange();
      }
    }));
    // No files are created until the user opens this plugin.
  }
  async open(): Promise<TaskView> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as TaskView; await view.ready; return view;
  }
}

export class ConfirmModal extends Modal {
  constructor(plugin: TaskPlugin, private title: string, private message: string, private action: () => Promise<void>) { super(plugin.app); }
  onOpen(): void {
    el(this.contentEl, 'h3', this.title); el(this.contentEl, 'p', this.message);
    const run = button(this.contentEl, '确认', async () => {
      run.disabled = true;
      try { await this.action(); this.close(); } finally { run.disabled = false; }
    });
    button(this.contentEl, '取消', () => this.close());
  }
  onClose(): void { this.contentEl.replaceChildren(); }
}

export class EditModal extends Modal {
  private draft: TaskNode;
  private busy = false;
  constructor(private plugin: TaskPlugin, private board: Board, node: TaskNode,
    private save: (node: TaskNode) => Promise<void>) {
    super(plugin.app); this.draft = structuredClone(node);
  }
  onOpen(): void {
    this.contentEl.classList.add('obsb-task-editor');
    el(this.contentEl, 'h3', `${this.draft.kind === 'area' ? '领域' : '任务'}详情`);
    const form = el(this.contentEl, 'form');
    const text = (title: string, value: string, change: (value: string) => void, type = 'text'): HTMLInputElement => {
      const label = el(form, 'label', title), input = el(label, 'input'); input.type = type; input.value = value;
      input.addEventListener('input', () => change(input.value)); return input;
    };
    const select = (title: string, value: string, values: Record<string, string>, change: (value: string) => void): void => {
      const label = el(form, 'label', title), input = el(label, 'select');
      for (const [key, name] of Object.entries(values)) { const o = el(input, 'option', name); o.value = key; }
      input.value = value; input.addEventListener('change', () => change(input.value));
    };
    const title = text('名称', this.draft.title, v => { this.draft.title = v; }); title.required = true;
    const tree = new Tree(this.board.nodes), forbidden = new Set([this.draft.id, ...tree.descendants(this.draft.id).map(n => n.id)]);
    const parentSearch = text('移动到父节点（搜索名称，最多显示 100 个候选）', '', () => populate());
    const parentLabel = el(form, 'label', '父节点'), parent = el(parentLabel, 'select');
    const populate = (): void => {
      const selected = this.draft.parent, query = parentSearch.value.toLocaleLowerCase();
      parent.replaceChildren(); const root = el(parent, 'option', 'root（不属于领域）'); root.value = '';
      const candidates = this.board.nodes.filter(n => !forbidden.has(n.id) && (this.draft.kind !== 'area' || n.kind === 'area'));
      const matches = candidates.filter(n => n.title.toLocaleLowerCase().includes(query)).slice(0, 100);
      const old = selected ? tree.byId.get(selected) : undefined;
      if (old && !matches.some(n => n.id === old.id)) matches.unshift(old);
      for (const n of matches) { const o = el(parent, 'option', `${n.kind === 'area' ? '领域' : '任务'} · ${n.title}`); o.value = n.id; }
      parent.value = selected ?? '';
    };
    populate(); parent.addEventListener('change', () => { this.draft.parent = parent.value || null; });
    if (this.draft.kind === 'task') {
      select('状态', this.draft.status, STATUS, v => { this.draft.status = v as TaskNode['status']; });
      select('重要程度', this.draft.importance, IMPORTANCE, v => { this.draft.importance = v as TaskNode['importance']; });
      text('截止日期', this.draft.deadline, v => { this.draft.deadline = v; }, 'date');
      text('计划执行日期', this.draft.planned, v => { this.draft.planned = v; }, 'date');
      for (const [key, name] of [['estimate', '预计工作量（小时）'], ['actual', '实际工作量（小时）']] as const) {
        const input = text(name, String(this.draft[key] / 60), v => { this.draft[key] = v === '' ? 0 : Number(v) * 60; }, 'number');
        input.min = '0'; input.step = '0.25';
      }
      text('完成时间（ISO，可留空自动填写）', this.draft.completed, v => { this.draft.completed = v; });
      text('标签（逗号分隔）', this.draft.tags.join(', '), v => { this.draft.tags = v.split(/[,，]/).map(t => t.trim()).filter(Boolean); });
    }
    const label = el(form, 'label', '注释（Obsidian Markdown）'), notes = el(label, 'textarea');
    notes.value = this.draft.notes; notes.rows = 10; notes.addEventListener('input', () => { this.draft.notes = notes.value; });
    const error = el(form, 'p', '', 'obsb-task-error'); error.setAttribute('role', 'alert');
    const submit = el(form, 'button', '保存'); submit.type = 'submit';
    button(form, '取消', () => this.close());
    form.addEventListener('submit', event => {
      event.preventDefault(); if (this.busy) return;
      this.busy = true; submit.disabled = true;
      void this.save(this.draft).then(() => this.close()).catch(e => {
        error.textContent = e instanceof Error ? e.message : String(e);
      }).finally(() => { this.busy = false; submit.disabled = false; });
    });
  }
  onClose(): void { this.contentEl.replaceChildren(); }
}
