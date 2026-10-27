import { Modal, Notice, Plugin, TFile } from 'obsidian';
import { TaskNode } from './model';
import { ARCHIVE, CURRENT, Files, SLEEP, TaskStore } from './store';
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
  private failedDrafts: TaskNode[] = [];
  async onload(): Promise<void> {
    const data = await this.loadData(); this.failedDrafts = Array.isArray(data?.failedDrafts) ? data.failedDrafts : [];
    this.store = new TaskStore(new VaultFiles(this));
    this.registerView(VIEW, leaf => new TaskView(leaf, this));
    this.addRibbonIcon('list-tree', '打开任务管理', () => { void this.open().catch(report); });
    this.addCommand({ id: 'open', name: '打开任务管理', callback: () => { void this.open().catch(report); } });
    this.addCommand({ id: 'migrate-markdown', name: '迁移任务文件为可读 Markdown（先备份）', callback: () => {
      void (async () => {
        const views = this.app.workspace.getLeavesOfType(VIEW).map(leaf => leaf.view as TaskView);
        for (const view of views) await view.prepareMigration();
        const count = await this.store.migrate();
        this.store.invalidate();
        for (const view of views) await view.reload();
        new Notice(`已转换 ${count} 个任务文件；旧格式原文保存在 Raw/任务管理/格式备份。`);
      })().catch(report);
    } });
    this.addCommand({ id: 'archive-completed', name: '全局归档已完成任务', callback: () => {
      void this.open().then(v => v.archive()).catch(report);
    } });
    this.addCommand({ id: 'unsaved-drafts', name: '查看未保存的节点草稿', callback: () => {
      const modal = new Modal(this.app); modal.open();
      el(modal.contentEl, 'h3', '未保存的节点草稿');
      el(modal.contentEl, 'p', this.failedDrafts.length ? '关闭视图时保存失败的本机副本，可复制内容后手动核对；不会覆盖同步到达的新版本。' : '没有未保存的节点草稿。');
      for (const draft of this.failedDrafts) { el(modal.contentEl, 'h4', draft.title); const text = el(modal.contentEl, 'textarea'); text.value = JSON.stringify(draft, null, 2); text.readOnly = true; text.rows = 8; }
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
  async keepDraft(node: TaskNode): Promise<void> {
    this.failedDrafts = [...this.failedDrafts.filter(n => n.id !== node.id), structuredClone(node)];
    await this.saveData({ failedDrafts: this.failedDrafts });
    new Notice('未保存内容已保存在本机；可运行“查看未保存的节点草稿”找回', 8000);
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
