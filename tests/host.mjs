import { TFile } from './obsidian-mock.mjs';
export function makeApp() {
  const files = new Map(), listeners = [];
  const app = { workspace: { openLinkText() {}, getLeavesOfType() { return []; } }, vault: {
    getName() { return 'OBSB 开发预览'; },
    getAbstractFileByPath(path) { return files.get(path); },
    getMarkdownFiles() { return [...files.values()].filter(f => f instanceof TFile); },
    async createFolder(path) { if (files.has(path)) throw Error('exists'); files.set(path, { path }); },
    async create(path, data) { if (files.has(path)) throw Error('exists'); const file = new TFile(path); file.data = data; files.set(path, file); return file; },
    async read(file) { return file.data; },
    async process(file, update) { file.data = update(file.data); for (const listener of listeners) listener(file); return file.data; },
    on(name, callback) { if (name === 'modify') listeners.push(callback); return () => {}; }
  } };
  return app;
}
export async function openPlugin(Plugin, nodes = []) {
  const app = makeApp(), plugin = new Plugin(app); await plugin.onload();
  const board = await plugin.store.load();
  if (nodes.length) await plugin.store.change(board.revision, b => ({ ...b, nodes }));
  const view = plugin.factory({ app }); document.body.append(view.contentEl); await view.onOpen();
  return { app, plugin, view };
}
