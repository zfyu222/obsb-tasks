import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TaskView, Modal, MarkdownRenderer, NodeDraft, newNode, emptyBoard, TaskStore, CURRENT, upsert } from '../.test-build/view.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const find = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
const key = (element, value, options = {}) => {
  const e = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }); element.dispatchEvent(e); return e;
};
const field = (view, name) => view.contentEl.querySelector(`.obsb-task-properties [data-field="${name}"]`);
const inputValue = (input, value, save = true) => {
  input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  if (save) input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};
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
test('toolbar creates immediately without modal, inline name and sidebar Markdown save directly', async () => {
  const { view, plugin } = await setup();
  const modalsBefore = Modal.opened.length;
  find(view.contentEl, '+ 任务').click(); await tick();
  assert.equal(Modal.opened.length, modalsBefore);
  const inline = view.contentEl.querySelector('.obsb-task-inline-title'); assert.equal(document.activeElement, inline);
  inputValue(inline, 'root新任务', false); key(inline, 'Enter'); await tick();
  const notes = field(view, 'notes'); inputValue(notes, '> [!tip]\n> [[需求#说明]]', false); notes.dispatchEvent(new dom.window.Event('blur')); await tick();
  const current = await plugin.store.load(), saved = current.nodes.find(n => n.title === 'root新任务');
  assert.equal(saved.parent, null); assert.match(saved.notes, /\[\[需求#说明\]\]/);
  await view.onClose(); view.contentEl.remove();
});
test('Tab creates child task and Enter creates adjacent sibling with defaults and inline focus', async () => {
  const { view, plugin } = await setup();
  find(view.contentEl, '○ 任务1').click(); await tick();
  const original = view.board.nodes.find(n => n.title === '任务1');
  const stage = view.contentEl.querySelector('.obsb-task-stage');
  assert.equal(key(stage, 'Tab').defaultPrevented, true); await tick();
  let current = await plugin.store.load(), added = current.nodes.at(-1);
  assert.equal(added.parent, original.id); assert.equal(added.kind, 'task'); assert.equal(added.status, 'todo');
  assert.equal(added.importance, 'medium'); assert.equal(added.deadline, ''); assert.equal(added.estimate, 0);
  let inline = view.contentEl.querySelector('.obsb-task-inline-title');
  inputValue(inline, '第一个子任务', false); key(inline, 'Enter'); await tick();
  key(view.contentEl.querySelector('.obsb-task-stage'), 'Enter'); await tick();
  current = await plugin.store.load();
  const siblings = current.nodes.filter(n => n.parent === original.id);
  assert.equal(siblings.length, 2); assert.equal(siblings[0].title, '第一个子任务'); assert.equal(siblings[1].title, '新任务');
  inline = view.contentEl.querySelector('.obsb-task-inline-title'); assert.equal(document.activeElement, inline);
  key(inline, 'Escape'); await tick();
  await view.onClose(); view.contentEl.remove();
});
test('root supports Enter; area Enter creates an area sibling without copying task properties', async () => {
  const { view, plugin, area } = await setup();
  find(view.contentEl, 'root').click(); await tick();
  key(view.contentEl.querySelector('.obsb-task-stage'), 'Enter'); await tick();
  assert.equal((await plugin.store.load()).nodes.at(-1).parent, null);
  key(view.contentEl.querySelector('.obsb-task-inline-title'), 'Enter'); await tick();
  find(view.contentEl, '▣ AAA领域').click(); await tick();
  key(view.contentEl.querySelector('.obsb-task-stage'), 'Enter'); await tick();
  const nodes = (await plugin.store.load()).nodes, index = nodes.findIndex(n => n.id === area.id);
  assert.equal(nodes[index + 1].kind, 'area'); assert.equal(nodes[index + 1].parent, null);
  assert.equal(nodes[index + 1].notes, '');
  await view.onClose(); view.contentEl.remove();
});
test('sidebar edits autosave without closing the panel, and task/area conversion keeps ID and notes', async () => {
  const { view, plugin } = await setup();
  find(view.contentEl, '○ 任务1').click(); await tick();
  const id = view.board.nodes.find(n => n.title === '任务1').id;
  const graphCard = [...view.contentEl.querySelectorAll('.obsb-task-card')].find(e => e.dataset.nodeId === id);
  const name = field(view, 'title'); name.focus(); inputValue(name, '直接编辑名称'); await tick();
  assert.equal(field(view, 'title'), name); assert.equal(document.activeElement, name);
  assert.equal([...view.contentEl.querySelectorAll('.obsb-task-card')].find(e => e.dataset.nodeId === id), graphCard);
  assert.match(graphCard.textContent, /直接编辑名称/);
  inputValue(field(view, 'importance'), 'high'); await tick();
  inputValue(field(view, 'deadline'), '2026-12-01'); await tick();
  inputValue(field(view, 'estimate'), '2.5'); await tick();
  inputValue(field(view, 'kind'), 'area'); await tick();
  let saved = (await plugin.store.load()).nodes.find(n => n.id === id);
  assert.equal(saved.kind, 'area'); assert.equal(saved.title, '直接编辑名称'); assert.equal(saved.notes, '任务注释 [[需求]]');
  inputValue(field(view, 'kind'), 'task'); await tick();
  saved = (await plugin.store.load()).nodes.find(n => n.id === id);
  assert.equal(saved.kind, 'task'); assert.equal(saved.importance, 'high'); assert.equal(saved.deadline, '2026-12-01'); assert.equal(saved.estimate, 150);
  await view.onClose(); view.contentEl.remove();
});
test('input shortcuts, IME selection, modifiers and key repeats do not create accidental nodes', async () => {
  const { view, plugin } = await setup();
  find(view.contentEl, '○ 任务1').click(); await tick();
  const initial = view.board.nodes.length, notes = field(view, 'notes');
  assert.equal(key(notes, 'Tab').defaultPrevented, false); assert.equal(key(notes, 'Enter').defaultPrevented, false);
  const stage = view.contentEl.querySelector('.obsb-task-stage');
  key(stage, 'Enter', { isComposing: true }); key(stage, 'Enter', { keyCode: 229 }); key(stage, 'Tab', { shiftKey: true }); key(stage, 'Enter', { repeat: true });
  key(stage, 'Enter', { ctrlKey: true }); await tick();
  assert.equal((await plugin.store.load()).nodes.length, initial);
  key(stage, 'F2'); await tick();
  const inline = view.contentEl.querySelector('.obsb-task-inline-title');
  key(inline, 'Enter', { isComposing: true }); assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), inline);
  assert.equal((await plugin.store.load()).nodes.length, initial);
  key(inline, 'Escape'); await tick();
  await view.onClose(); view.contentEl.remove();
});
test('invalid type conversion is rejected and pending draft is not lost by switching selection', async () => {
  const { view, plugin, area } = await setup();
  find(view.contentEl, '○ 任务1').click(); await tick();
  const task = view.board.nodes.find(n => n.title === '任务1');
  // Move below a task, then attempt a forbidden area conversion.
  const parent = field(view, 'parent'); inputValue(parent, view.board.nodes.find(n => n.title === '任务2').id); await tick();
  inputValue(field(view, 'kind'), 'area'); await tick();
  assert.match(view.contentEl.querySelector('.obsb-task-properties').textContent, /任务下不能挂领域/);
  assert.equal((await plugin.store.load()).nodes.find(n => n.id === task.id).kind, 'task');
  await assert.rejects(view.locate(area.id), /任务下不能挂领域/);
  assert.equal(field(view, 'kind').value, 'area'); // Failed selection flush keeps the same draft visible.
  inputValue(field(view, 'kind'), 'task'); await tick();
  await view.onClose(); view.contentEl.remove();
});
test('selection flushes unblurred text, while external edits block save without overwriting', async () => {
  const { view, plugin, data } = await setup();
  find(view.contentEl, '○ 任务1').click(); await tick();
  inputValue(field(view, 'title'), '切换前保存', false);
  find(view.contentEl, '▣ AAA领域').click(); await tick();
  assert.ok((await plugin.store.load()).nodes.some(n => n.title === '切换前保存'));
  inputValue(field(view, 'title'), '旧表单草稿', false);
  data.set(CURRENT, data.get(CURRENT).replace('## AAA领域', '## 外部修改领域'));
  field(view, 'title').dispatchEvent(new dom.window.Event('change')); await tick();
  assert.match(view.contentEl.textContent, /其他窗口或设备/); assert.equal(field(view, 'title').value, '旧表单草稿');
  assert.match(data.get(CURRENT), /外部修改领域/); assert.doesNotMatch(data.get(CURRENT), /旧表单草稿/);
  let recovery; plugin.keepDraft = async node => { recovery = node; };
  await view.onClose(); assert.equal(recovery.title, '旧表单草稿'); view.contentEl.remove();
});
test('NodeDraft serializes rapid changes during a delayed write and retains all fields', async () => {
  const node = { ...newNode('task'), title: '开始' }; let release, writes = [];
  const gate = new Promise(resolve => { release = resolve; });
  const draft = new NodeDraft(node, 'first', async (n, revision) => {
    writes.push({ node: structuredClone(n), revision });
    if (writes.length === 1) await gate;
    return { version: 1, revision: `revision-${writes.length}`, nodes: [n] };
  });
  draft.patch({ title: '新名称' }); const first = draft.flush();
  draft.patch({ notes: '随后输入的注释', importance: 'high' }); const second = draft.flush();
  release(); await Promise.all([first, second]);
  assert.equal(writes.length, 2); assert.equal(writes[1].revision, 'revision-1');
  assert.equal(writes[1].node.title, '新名称'); assert.equal(writes[1].node.notes, '随后输入的注释'); assert.equal(draft.dirty, false);
});
test('archive nodes remain read-only and cannot be changed through diagram shortcuts', async () => {
  const { view, plugin } = await setup();
  await view.archive(); const confirm = Modal.opened.at(-1); find(confirm.contentEl, '确认').click(); await tick();
  find(view.contentEl, '任务归档').click(); await tick();
  find(view.contentEl, '✓ 任务2').click(); await tick();
  assert.equal(view.contentEl.querySelector('.obsb-task-properties'), null);
  const before = (await plugin.store.load()).nodes.length;
  const stage = view.contentEl.querySelector('.obsb-task-stage');
  assert.equal(key(stage, 'Tab').defaultPrevented, false); key(stage, 'Enter'); key(stage, 'F2'); await tick();
  assert.equal((await plugin.store.load()).nodes.length, before); assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null);
  await view.onClose(); view.contentEl.remove();
});
test('IME composition defers property writes until completed', async () => {
  const n = { ...newNode('task'), title: '初始' }; const writes = [];
  const draft = new NodeDraft(n, 'one', async value => { writes.push(value.title); return { version: 1, revision: 'two', nodes: [value] }; });
  draft.composition(true); draft.patch({ title: '输' }); const saving = draft.flush();
  await tick(); assert.equal(writes.length, 0);
  draft.patch({ title: '输入完成' }); draft.composition(false); await saving;
  assert.deepEqual(writes, ['输入完成']);
});
test('unified undo/redo covers inline titles, creation and properties without requiring selection', async () => {
  const { view, plugin } = await setup(); const originalCount = view.board.nodes.length;
  find(view.contentEl, '+ 任务').click(); await tick();
  const id = view.board.nodes.at(-1).id;
  let inline = view.contentEl.querySelector('.obsb-task-inline-title'); inputValue(inline, '可撤销的名称', false); key(inline, 'Enter'); await tick();
  key(view.contentEl.querySelector('.obsb-task-stage'), 'z', { ctrlKey: true }); await tick();
  assert.equal((await plugin.store.load()).nodes.find(n => n.id === id).title, '新任务');
  key(view.contentEl.querySelector('.obsb-task-stage'), 'z', { ctrlKey: true }); await tick();
  assert.equal((await plugin.store.load()).nodes.length, originalCount);
  key(view.contentEl.querySelector('.obsb-task-stage'), 'y', { ctrlKey: true }); await tick();
  assert.equal((await plugin.store.load()).nodes.at(-1).id, id);
  key(view.contentEl.querySelector('.obsb-task-stage'), 'z', { ctrlKey: true, shiftKey: true }); await tick();
  assert.equal((await plugin.store.load()).nodes.find(n => n.id === id).title, '可撤销的名称');
  await view.onClose(); view.contentEl.remove();
});
test('Ctrl-click multi-select deletes whole selected subtrees in one undoable operation', async () => {
  const { view, plugin, area } = await setup();
  find(view.contentEl, '▣ AAA领域').click(); await tick();
  const taskButton = find(view.contentEl, '○ 任务1'); taskButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true })); await tick();
  assert.equal(view.selectedIds.size, 2);
  key(view.contentEl.querySelector('.obsb-task-stage'), 'Delete'); await tick();
  assert.equal((await plugin.store.load()).nodes.length, 0);
  key(view.contentEl.querySelector('.obsb-task-stage'), 'z', { ctrlKey: true }); await tick();
  const current = await plugin.store.load(); assert.equal(current.nodes.length, 3); assert.ok(current.nodes.some(n => n.id === area.id));
  await view.onClose(); view.contentEl.remove();
});
