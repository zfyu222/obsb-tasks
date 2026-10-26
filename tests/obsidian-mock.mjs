export class Component {
  load() {} unload() {}
}
export class Plugin extends Component {
  constructor(app) { super(); this.app = app; this.protocols = new Map(); this.commands = new Map(); }
  registerView(type, factory) { this.factory = factory; }
  registerEvent() {} addRibbonIcon() {}
  addCommand(command) { this.commands.set(command.id, command); }
  registerObsidianProtocolHandler(name, action) { this.protocols.set(name, action); }
}
export class ItemView extends Component {
  constructor(leaf) { super(); this.app = leaf.app; this.contentEl = document.createElement('div'); }
}
export class WorkspaceLeaf {}
export class TFile { constructor(path) { this.path = path; } }
export class Modal {
  static opened = [];
  constructor(app) { this.app = app; this.contentEl = document.createElement('div'); }
  open() { Modal.opened.push(this); document.body.append(this.contentEl); this.onOpen?.(); }
  close() { Modal.opened = Modal.opened.filter(m => m !== this); this.onClose?.(); this.contentEl.remove(); }
}
export class Notice { static messages = []; constructor(message) { Notice.messages.push(message); } }
export const MarkdownRenderer = { calls: [], async render(app, text, container, source) {
  this.calls.push({ text, source }); container.textContent = text;
} };
