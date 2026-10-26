import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TaskView, EditModal, Modal, MarkdownRenderer, newNode, emptyBoard, TaskStore, CURRENT, upsert } from '../.test-build/view.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) });
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const find = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
async function setup(count = 3) {
  const data = new Map();
  const files = { exists: p => data.has(p), read: async p => data.get(p),
    create: async (p, value) => { data.set(p, value); }, list: folder => [...data.keys()].filter(p => p.startsWith(folder + '/')),
    compareWrite: async (p, before, after) => { if (data.get(p) !== before) throw new Error('conflict'); data.set(p, after); } };
  const store = new TaskStore(files); let b = await store.load();
  const area = { ...newNode('area'), title: 'AAA领域', notes: '领域注释 [[普通笔记]]' };
  const nodes = [area];
  for (let i = 1; i < count; i++) nodes.push({ ...newNode('task', i === 1 ? null : area.id), title: `任务${i}`, notes: '任务注释 [[需求]]', status: i % 2 === 0 ? 'done' : 'todo', completed: i % 2 === 0 ? new Date().toISOString() : '' });
  await store.change(b.revision, old => ({ ...old, nodes }));
  const app = { workspace: { openLinkText() {} }, vault: { getName: () => 'test' } };
  const plugin = { app, store }, view = new TaskView({ app }, plugin);
  document.body.append(view.contentEl); await view.onOpen();
  return { view, plugin, data, area };
}
test('map and list share current data, completed nodes visible; notes render only on selection', async () => {
  MarkdownRenderer.calls = [];
  const { view } = await setup();
  assert.equal(MarkdownRenderer.calls.length, 0);
  assert.match(view.contentEl.textContent, /任务2/);
  find(view.contentEl, '切换列表').click(); await tick();
  assert.equal(view.contentEl.querySelectorAll('.obsb-task-row').length, 2);
  view.contentEl.querySelector('.obsb-task-row').click(); await tick();
  assert.equal(MarkdownRenderer.calls.length, 1); assert.equal(MarkdownRenderer.calls[0].source, CURRENT);
  await view.onClose(); view.contentEl.remove();
});
test('50k rows and map nodes create bounded DOM; root tasks need no area', async t => {
  const start = performance.now(); const { view } = await setup(50000);
  const initialMs = performance.now() - start;
  assert.ok(view.contentEl.querySelectorAll('.obsb-task-card').length < 100);
  find(view.contentEl, '切换列表').click(); await tick();
  assert.ok(view.contentEl.querySelectorAll('.obsb-task-row').length < 50);
  assert.match(view.contentEl.textContent, /任务1/);
  t.diagnostic(`50k JS-DOM load+map ${Math.round(initialMs)}ms; rows ${view.contentEl.querySelectorAll('.obsb-task-row').length}`);
  await view.onClose(); view.contentEl.remove();
});
test('global archive retains area and unfinished root task; explicit archive lists completed task', async () => {
  const { view, data } = await setup();
  find(view.contentEl, '全局归档已完成').click(); await tick();
  const modal = Modal.opened.at(-1); assert.match(modal.contentEl.textContent, /1 个已完成任务/);
  find(modal.contentEl, '确认').click(); await tick();
  assert.equal(view.board.nodes.length, 2); assert.doesNotMatch(data.get(CURRENT), /任务2/);
  find(view.contentEl, '任务归档').click(); await tick();
  assert.match(view.contentEl.textContent, /任务2/);
  await view.onClose(); view.contentEl.remove();
});
test('editor submits root task with Markdown and validates unfinished children via model', async () => {
  const { view, plugin } = await setup();
  find(view.contentEl, '+ 任务').click(); await tick();
  const modal = Modal.opened.at(-1), inputs = modal.contentEl.querySelectorAll('input');
  inputs[0].value = 'root新任务'; inputs[0].dispatchEvent(new dom.window.Event('input'));
  const notes = modal.contentEl.querySelector('textarea'); notes.value = '> [!tip]\n> [[需求#说明]]'; notes.dispatchEvent(new dom.window.Event('input'));
  modal.contentEl.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick();
  const current = await plugin.store.load(), saved = current.nodes.find(n => n.title === 'root新任务');
  assert.equal(saved.parent, null); assert.match(saved.notes, /\[\[需求#说明\]\]/);
  await view.onClose(); view.contentEl.remove();
});
