import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TaskView, Modal, Notice, MarkdownRenderer, NodeDraft, newNode, emptyBoard, TaskStore, CURRENT, upsert } from '../.test-build/view.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const find = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label || b.hasAttribute('data-map-title') && b.getAttribute('aria-label') === label);
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
test('inline title grows and shrinks before autosave, preserves composition, caret and editor DOM', async () => {
  const { view, plugin } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const input = view.contentEl.querySelector('.obsb-task-inline-title'), card = input.parentElement;
    const width = parseFloat(card.style.width), original = input.value;
    input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    inputValue(input, '正在输入中文和很长的任务名称'.repeat(3), false); input.setSelectionRange(4, 4); await tick();
    assert.ok(parseFloat(card.style.width) > width); assert.equal(document.activeElement, input); assert.equal(input.selectionStart, 4);
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), input);
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === card.dataset.nodeId).title, original);
    inputValue(input, '短', false); await tick(); assert.ok(parseFloat(card.style.width) < width);
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    key(input, 'Enter'); await tick(); assert.equal((await plugin.store.load()).nodes.find(n => n.id === card.dataset.nodeId).title, '短');
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('long area editor expands beyond display cap and Escape restores compact geometry and original title', async () => {
  const { view, plugin, area } = await setup();
  try {
    find(view.contentEl, area.title).click(); await tick(); key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const input = view.contentEl.querySelector('.obsb-task-inline-title'), card = input.parentElement, width = parseFloat(card.style.width);
    inputValue(input, '长名称'.repeat(100), false); await tick(); assert.ok(parseFloat(card.style.width) > 420); assert.ok(parseFloat(card.style.width) <= 800);
    key(input, 'Escape'); await tick(); assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null);
    assert.equal(parseFloat(card.style.width), width); assert.equal((await plugin.store.load()).nodes.find(n => n.id === area.id).title, area.title);
  } finally { await view.onClose(); view.contentEl.remove(); }
});

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

test('clicking another node or blank canvas saves and replaces the inline editor without rebuilding the viewport', async () => {
  const { view, plugin } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const input = view.contentEl.querySelector('.obsb-task-inline-title');
    const viewport = view.contentEl.querySelector('.obsb-map-viewport'), card = input.parentElement;
    inputValue(input, '点击节点前保存', false);
    find(view.contentEl, 'AAA领域').click(); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null);
    assert.equal(view.contentEl.querySelector('.obsb-map-viewport'), viewport);
    assert.ok(card.querySelector('[data-map-title]')); assert.equal(field(view, 'title').value, 'AAA领域');
    // A late event from the detached input cannot patch the newly selected draft.
    inputValue(input, '迟到的输入事件', false);
    inputValue(field(view, 'notes'), '新的领域注释', false);
    field(view, 'notes').dispatchEvent(new dom.window.Event('blur')); await tick();
    assert.equal((await plugin.store.load()).nodes.find(n => n.kind === 'area').title, 'AAA领域');
    find(view.contentEl, '○ 点击节点前保存').click(); await tick();
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const activeViewport = view.contentEl.querySelector('.obsb-map-viewport');
    inputValue(view.contentEl.querySelector('.obsb-task-inline-title'), '点击空白前保存', false);
    for (const [target, type] of [[activeViewport, 'pointerdown'], [document, 'pointerup']]) {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 15, clientY: 15 });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: 'mouse' } }); target.dispatchEvent(event);
    }
    await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null); assert.equal(view.selected, null);
    assert.equal(view.contentEl.querySelector('.obsb-map-viewport'), activeViewport);
    assert.ok((await plugin.store.load()).nodes.some(n => n.title === '点击空白前保存'));
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('blur to sidebar ends title editing without stealing focus; Tab keeps the new child editor and Escape cancels it', async () => {
  const { view, plugin } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    inputValue(view.contentEl.querySelector('.obsb-task-inline-title'), '侧栏失焦保存', false);
    const notes = field(view, 'notes'); notes.focus(); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null); assert.equal(document.activeElement, notes);
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const input = view.contentEl.querySelector('.obsb-task-inline-title'); inputValue(input, 'Tab 保存后建子任务', false);
    key(input, 'Tab'); await tick(); await tick();
    const child = view.contentEl.querySelector('.obsb-task-inline-title'); assert.ok(child); assert.notEqual(child, input);
    assert.equal(document.activeElement, child);
    inputValue(child, '取消本次修改', false); key(child, 'Escape'); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null);
    const board = await plugin.store.load(); assert.ok(board.nodes.some(n => n.title === 'Tab 保存后建子任务'));
    assert.ok(board.nodes.some(n => n.title === '新任务')); assert.ok(!board.nodes.some(n => n.title === '取消本次修改'));
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('IME blur waits for composition end before saving and closing the inline editor', async () => {
  const { view, plugin } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const input = view.contentEl.querySelector('.obsb-task-inline-title');
    input.dispatchEvent(new dom.window.Event('compositionstart')); inputValue(input, '中文候选', false);
    field(view, 'notes').focus(); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), input);
    assert.ok((await plugin.store.load()).nodes.some(n => n.title === '任务1'));
    inputValue(input, '中文输入完成', false); input.dispatchEvent(new dom.window.Event('compositionend')); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null);
    assert.ok((await plugin.store.load()).nodes.some(n => n.title === '中文输入完成'));
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('failed inline save keeps the editor and old selection, then a successful retry exits and selects the target', async () => {
  const { view, plugin } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const input = view.contentEl.querySelector('.obsb-task-inline-title'), id = view.selected;
    inputValue(input, '失败后保留草稿', false);
    const change = plugin.store.change.bind(plugin.store); let fail = true;
    plugin.store.change = (...args) => fail ? Promise.reject(new Error('模拟磁盘写入失败')) : change(...args);
    find(view.contentEl, 'AAA领域').click(); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), input); assert.equal(view.selected, id);
    assert.equal(input.value, '失败后保留草稿'); assert.match(view.contentEl.textContent, /模拟磁盘写入失败/);
    fail = false; find(view.contentEl, 'AAA领域').click(); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null); assert.equal(field(view, 'title').value, 'AAA领域');
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === id).title, '失败后保留草稿');
  } finally { await view.onClose(); view.contentEl.remove(); }
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
  find(view.contentEl, 'AAA领域').click(); await tick();
  key(view.contentEl.querySelector('.obsb-task-stage'), 'Enter'); await tick();
  const nodes = (await plugin.store.load()).nodes.filter(n => n.parent === null), index = nodes.findIndex(n => n.id === area.id);
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
test('completion picker uses local time, preserves the stored instant and auto-fills on completion', async () => {
  const previousTimezone = process.env.TZ;
  try {
    for (const [timezone, expected] of [['Asia/Shanghai', '2026-10-27T10:30:45.123Z'], ['America/New_York', '2026-10-27T22:30:45.123Z']]) {
      process.env.TZ = timezone;
      const { view, plugin } = await setup();
      try {
        find(view.contentEl, '✓ 任务2').click(); await tick();
        const id = view.board.nodes.find(n => n.title === '任务2').id;
        const picker = field(view, 'completed');
        assert.equal(picker.type, 'datetime-local');
        assert.equal(new Date(picker.value).toISOString(), view.board.nodes.find(n => n.id === id).completed);
        picker.focus(); inputValue(picker, '2026-10-27T18:30:45.123'); await tick();
        assert.equal((await plugin.store.load()).nodes.find(n => n.id === id).completed, expected);
        find(view.contentEl, '○ 任务1').click(); await tick();
        inputValue(field(view, 'status'), 'done'); await tick();
        assert.ok(field(view, 'completed').value, 'completing a task fills the picker');
        assert.equal(new Date(field(view, 'completed').value).toISOString(), (await plugin.store.load()).nodes.find(n => n.title === '任务1').completed);
        find(view.contentEl, '✓ 任务2').click(); await tick();
        assert.equal(field(view, 'completed').value, '2026-10-27T18:30:45.123');
      } finally { await view.onClose(); view.contentEl.remove(); }
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
  }
});

test('compact title-only map keeps priority, status and tooltip synchronized through edits and kind changes', async () => {
  const { view } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    const id = view.board.nodes.find(n => n.title === '任务1').id;
    const card = () => view.contentEl.querySelector(`.obsb-core-node[data-node-id="${id}"]`);
    assert.equal(card().style.height, '24px'); assert.equal(card().querySelector('small'), null);
    assert.equal(card().dataset.importance, 'medium');
    inputValue(field(view, 'importance'), 'high'); await tick();
    assert.equal(card().dataset.importance, 'high'); assert.match(card().title, /重要程度：高/);
    inputValue(field(view, 'status'), 'done'); await tick();
    assert.ok(card().classList.contains('done')); assert.equal(card().dataset.status, 'done');
    assert.equal(card().querySelector('[data-map-title]').textContent, '任务1');
    inputValue(field(view, 'title'), '长任务名称'.repeat(30)); await tick();
    assert.ok(card().title.startsWith('长任务名称'.repeat(30))); assert.equal(card().style.width, '420px');
    inputValue(field(view, 'kind'), 'area'); await tick();
    assert.equal(card().dataset.importance, undefined); assert.match(card().title, /领域/);
    assert.equal(card().querySelector('[data-map-title]').textContent, '长任务名称'.repeat(30));
    inputValue(field(view, 'kind'), 'task'); await tick();
    assert.equal(card().dataset.importance, 'high'); assert.equal(card().querySelector('small'), null);
    inputValue(field(view, 'status'), 'cancelled'); await tick();
    assert.equal(card().dataset.status, 'cancelled'); assert.equal(card().style.height, '24px');
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('node completion button completes and reopens with timestamps, native activation and undo/redo', async () => {
  const { view, plugin } = await setup();
  try {
    const id = view.board.nodes.find(n => n.title === '任务1').id;
    const toggle = () => view.contentEl.querySelector(`[data-node-id="${id}"] [data-map-complete]`);
    const original = toggle(); assert.equal(original.textContent, '○'); assert.equal(original.getAttribute('aria-pressed'), 'false');
    assert.equal(key(original, 'Enter').defaultPrevented, false); assert.equal(key(original, ' ').defaultPrevented, false);
    original.click(); await tick();
    let saved = (await plugin.store.load()).nodes.find(n => n.id === id);
    assert.equal(saved.status, 'done'); assert.ok(saved.completed); const completed = saved.completed;
    assert.equal(toggle(), original); assert.equal(toggle().textContent, '✓'); assert.equal(toggle().getAttribute('aria-pressed'), 'true');
    assert.equal(field(view, 'status').value, 'done');
    toggle().click(); await tick();
    saved = (await plugin.store.load()).nodes.find(n => n.id === id); assert.equal(saved.status, 'todo'); assert.equal(saved.completed, '');
    key(toggle(), 'z', { ctrlKey: true }); await tick();
    saved = (await plugin.store.load()).nodes.find(n => n.id === id); assert.equal(saved.status, 'done'); assert.equal(saved.completed, completed);
    key(view.contentEl.querySelector('.obsb-task-stage'), 'y', { ctrlKey: true }); await tick();
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === id).status, 'todo');
    assert.equal((await plugin.store.load()).nodes.length, 3);
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('invalid parent completion leaves no failed draft, children remain actionable and archive controls are readonly', async () => {
  const { view, plugin } = await setup();
  try {
    const parent = view.board.nodes.find(n => n.title === '任务1'), child = view.board.nodes.find(n => n.title === '任务2');
    await view.move([child.id], parent.id, 'child');
    const toggle = id => view.contentEl.querySelector(`[data-node-id="${id}"] [data-map-complete]`);
    toggle(child.id).click(); await tick(); // reopen the completed child
    toggle(parent.id).click(); await tick();
    assert.match(Notice.messages.at(-1), /还有未完成子任务/); assert.equal(view.draft.dirty, false);
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === parent.id).status, 'todo');
    toggle(child.id).click(); await tick(); toggle(parent.id).click(); await tick();
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === parent.id).status, 'done');
    assert.equal(view.contentEl.querySelector('.obsb-core-node.area [data-map-complete]'), null);
    await view.archive(); find(Modal.opened.at(-1).contentEl, '确认').click(); await tick();
    find(view.contentEl, '任务归档').click(); await tick();
    const archived = view.contentEl.querySelector('[data-map-complete]'); assert.ok(archived.disabled);
    const before = await plugin.store.load(); archived.click(); await tick(); assert.deepEqual(await plugin.store.load(), before);
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('clicking the completion control while renaming saves the name and completes on the same click', async () => {
  const { view, plugin } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    key(view.contentEl.querySelector('.obsb-task-stage'), 'F2'); await tick();
    const input = view.contentEl.querySelector('.obsb-task-inline-title'); inputValue(input, '边改名边完成', false);
    const toggle = input.parentElement.querySelector('[data-map-complete]');
    toggle.focus(); await tick(); assert.ok(toggle.isConnected, 'blur must not remove the pressed button before click');
    toggle.click(); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null);
    const saved = (await plugin.store.load()).nodes.find(n => n.title === '边改名边完成'); assert.equal(saved.status, 'done'); assert.ok(saved.completed);
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('failed completion save keeps the visible button unchanged and can be retried without losing data', async () => {
  const { view, plugin } = await setup();
  try {
    find(view.contentEl, '○ 任务1').click(); await tick();
    const change = plugin.store.change.bind(plugin.store); let fail = true;
    plugin.store.change = (...args) => fail ? Promise.reject(new Error('完成状态写入失败')) : change(...args);
    const toggle = view.contentEl.querySelector('.obsb-core-node.task [data-map-complete][aria-pressed="false"]'); toggle.click(); await tick();
    assert.equal(toggle.getAttribute('aria-pressed'), 'false'); assert.match(view.contentEl.textContent, /完成状态写入失败/);
    assert.equal((await plugin.store.load()).nodes.find(n => n.title === '任务1').status, 'todo');
    fail = false; find(view.contentEl, '重试保存').click(); await tick();
    assert.equal(toggle.getAttribute('aria-pressed'), 'true'); assert.equal((await plugin.store.load()).nodes.find(n => n.title === '任务1').status, 'done');
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('branch dots toggle descendants without changing selection or persisted task content', async () => {
  const { view, plugin, area } = await setup();
  try {
    const before = await plugin.store.load();
    const dot = () => view.contentEl.querySelector(`.obsb-core-node[data-node-id="${area.id}"] .obsb-map-fold`);
    assert.equal(dot().textContent, ''); assert.equal(dot().getAttribute('aria-expanded'), 'true');
    assert.equal(dot().getAttribute('aria-label'), '收起 1 个子节点');
    assert.match(dot().parentElement.style.getPropertyValue('--branch-color'), /^#/);
    assert.equal(dot().parentElement.style.getPropertyValue('--fold-y'), 'calc(50% + 1px)');
    assert.equal(key(dot(), 'Enter').defaultPrevented, false, 'dot keeps native button activation instead of creating a task');
    assert.equal(key(dot(), ' ').defaultPrevented, false);
    await tick(); assert.equal(view.board.nodes.length, before.nodes.length);
    assert.equal(view.contentEl.querySelector('.obsb-core-node.task .obsb-map-fold'), null, 'leaf tasks have no dot');
    dot().click(); await tick();
    assert.equal(dot().getAttribute('aria-expanded'), 'false');
    assert.equal(dot().getAttribute('aria-label'), '展开 1 个子节点');
    assert.equal(find(view.contentEl, '✓ 任务2'), undefined);
    dot().dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); await tick();
    assert.equal(view.contentEl.querySelector('.obsb-task-inline-title'), null, 'double clicking a dot never renames its node');
    dot().click(); await tick();
    assert.ok(find(view.contentEl, '✓ 任务2')); assert.equal(dot().getAttribute('aria-expanded'), 'true');
    find(view.contentEl, 'AAA领域').click(); await tick(); find(view.contentEl, '聚焦').click(); await tick();
    dot().click(); await tick(); assert.equal(find(view.contentEl, '✓ 任务2'), undefined, 'focused root also folds');
    dot().click(); await tick(); assert.ok(find(view.contentEl, '✓ 任务2'));
    assert.deepEqual(await plugin.store.load(), before);
  } finally { await view.onClose(); view.contentEl.remove(); }
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
test('invalid type conversion restores original kind and permits navigation without repeated errors or losing text', async () => {
  const { view, plugin, area } = await setup();
  find(view.contentEl, '○ 任务1').click(); await tick();
  const task = view.board.nodes.find(n => n.title === '任务1');
  // Move below a task, then attempt a forbidden area conversion.
  const parent = field(view, 'parent'); inputValue(parent, view.board.nodes.find(n => n.title === '任务2').id); await tick();
  inputValue(field(view, 'title'), '保留未保存名称', false);
  inputValue(field(view, 'kind'), 'area'); await tick();
  assert.match(view.contentEl.querySelector('.obsb-task-properties').textContent, /任务下不能挂领域/);
  assert.equal((await plugin.store.load()).nodes.find(n => n.id === task.id).kind, 'task');
  assert.equal(field(view, 'kind').value, 'task'); assert.equal(field(view, 'title').value, '保留未保存名称');
  const notices = Notice.messages.length;
  await view.locate(area.id); assert.equal(field(view, 'title').value, area.title);
  assert.equal((await plugin.store.load()).nodes.find(n => n.id === task.id).title, '保留未保存名称');
  find(view.contentEl, '切换列表').click(); await tick(); find(view.contentEl, '切换导图').click(); await tick();
  assert.equal(Notice.messages.length, notices);
  await view.onClose(); view.contentEl.remove();
});

test('multi-selected parent and child convert together atomically and undo/redo as one operation', async () => {
  const { view, plugin } = await setup();
  try {
    const parent = view.board.nodes.find(n => n.title === '任务1'), child = view.board.nodes.find(n => n.title === '任务2');
    await view.move([child.id], parent.id, 'child');
    await view.selectMany([child.id, parent.id], child.id);
    assert.match(view.contentEl.textContent, /已选中 2 个节点/);
    const before = await plugin.store.load(); inputValue(field(view, 'kind'), 'area'); await tick();
    let saved = await plugin.store.load();
    assert.equal(saved.nodes.find(n => n.id === parent.id).kind, 'area'); assert.equal(saved.nodes.find(n => n.id === child.id).kind, 'area');
    assert.equal(saved.nodes.find(n => n.id === child.id).parent, parent.id);
    assert.equal(saved.nodes.find(n => n.id === child.id).notes, before.nodes.find(n => n.id === child.id).notes);
    assert.equal(view.selectedIds.size, 2);
    key(view.contentEl.querySelector('.obsb-task-stage'), 'z', { ctrlKey: true }); await tick();
    saved = await plugin.store.load(); assert.equal(saved.nodes.find(n => n.id === parent.id).kind, 'task'); assert.equal(saved.nodes.find(n => n.id === child.id).kind, 'task');
    key(view.contentEl.querySelector('.obsb-task-stage'), 'y', { ctrlKey: true }); await tick();
    saved = await plugin.store.load(); assert.equal(saved.nodes.find(n => n.id === parent.id).kind, 'area'); assert.equal(saved.nodes.find(n => n.id === child.id).kind, 'area');
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('invalid mixed multi-conversion changes nothing and leaves other nodes and toolbar usable', async () => {
  const { view, plugin, area } = await setup();
  try {
    const parent = view.board.nodes.find(n => n.title === '任务1'), child = view.board.nodes.find(n => n.title === '任务2');
    await view.move([child.id], parent.id, 'child'); await view.selectMany([area.id, child.id], child.id);
    const before = await plugin.store.load(); inputValue(field(view, 'kind'), 'area'); await tick();
    assert.deepEqual(await plugin.store.load(), before); assert.equal(view.draft.dirty, false); assert.equal(field(view, 'kind').value, 'task');
    assert.match(view.contentEl.textContent, /任务下不能挂领域/);
    await view.select(parent.id); assert.equal(field(view, 'title').value, parent.title);
    await view.select(null); assert.equal(view.selected, null);
    find(view.contentEl, '+ 任务').click(); await tick(); assert.equal((await plugin.store.load()).nodes.length, before.nodes.length + 1);
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('batch conversion disk failure leaves all types unchanged and permits leaving the unmodified draft', async () => {
  const { view, plugin } = await setup();
  try {
    const ids = view.board.nodes.map(n => n.id); await view.selectMany(ids, ids[1]);
    const before = await plugin.store.load(), change = plugin.store.change.bind(plugin.store);
    plugin.store.change = () => Promise.reject(new Error('模拟类型批量写入失败'));
    inputValue(field(view, 'kind'), 'area'); await tick();
    assert.deepEqual(await plugin.store.load(), before); assert.equal(view.draft.dirty, false); assert.equal(field(view, 'kind').value, 'task');
    assert.match(view.contentEl.textContent, /模拟类型批量写入失败/);
    plugin.store.change = change; await view.select(null); assert.equal(view.selected, null);
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('invalid parent/status dropdown edits do not poison the draft or block selection', async () => {
  const { view, plugin, area } = await setup();
  try {
    const parent = view.board.nodes.find(n => n.title === '任务1'), child = view.board.nodes.find(n => n.title === '任务2');
    await view.move([child.id], parent.id, 'child'); await view.select(child.id);
    inputValue(field(view, 'status'), 'todo'); await tick(); await view.select(parent.id);
    inputValue(field(view, 'status'), 'done'); await tick();
    assert.equal(field(view, 'status').value, 'todo'); assert.equal(view.draft.dirty, false);
    await view.select(area.id); inputValue(field(view, 'parent'), parent.id); await tick();
    assert.equal(field(view, 'parent').value, ''); assert.equal(view.draft.dirty, false);
    await view.select(child.id); assert.equal(field(view, 'title').value, child.title);
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === parent.id).status, 'todo');
  } finally { await view.onClose(); view.contentEl.remove(); }
});
test('selection flushes unblurred text, while external edits block save without overwriting', async () => {
  const { view, plugin, data } = await setup();
  find(view.contentEl, '○ 任务1').click(); await tick();
  inputValue(field(view, 'title'), '切换前保存', false);
  find(view.contentEl, 'AAA领域').click(); await tick();
  assert.ok((await plugin.store.load()).nodes.some(n => n.title === '切换前保存'));
  inputValue(field(view, 'title'), '旧表单草稿', false);
  data.set(CURRENT, data.get(CURRENT).replace('领域：AAA领域', '领域：外部修改领域'));
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

test('canonical Markdown subtree order preserves move, sibling reorder and undo/redo through persistence', async () => {
  const { view, plugin, area } = await setup();
  try {
    const root = view.board.nodes.find(n => n.title === '任务1'), child = view.board.nodes.find(n => n.title === '任务2');
    await view.move([child.id], root.id, 'child');
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === child.id).parent, root.id);
    await view.move([root.id], area.id, 'before');
    assert.deepEqual((await plugin.store.load()).nodes.filter(n => n.parent === null).map(n => n.id), [root.id, area.id]);
    await view.undo();
    assert.deepEqual((await plugin.store.load()).nodes.filter(n => n.parent === null).map(n => n.id), [area.id, root.id]);
    await view.undo();
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === child.id).parent, area.id);
    await view.undo(true);
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === child.id).parent, root.id);
  } finally { await view.onClose(); view.contentEl.remove(); }
});

test('drag feedback rejects cycles and area-under-task before drop, and a valid preview commits once with undo', async () => {
  const { view, plugin, area } = await setup();
  try {
    const before = await plugin.store.load(), task = before.nodes.find(n => n.title === '任务1'), child = before.nodes.find(n => n.title === '任务2');
    const viewport = view.contentEl.querySelector('.obsb-map-viewport');
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500 });
    const card = id => view.contentEl.querySelector(`.obsb-core-node[data-node-id="${id}"]`);
    const pointer = (target, type, x, y) => { const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }); Object.defineProperties(e, { pointerId: { value: 9 }, pointerType: { value: 'mouse' } }); target.dispatchEvent(e); };
    const drag = (from, to) => {
      card(from).getBoundingClientRect = () => ({ left: 50, top: 100, right: 150, bottom: 124, width: 100, height: 24 });
      card(to).getBoundingClientRect = () => ({ left: 300, top: 100, right: 400, bottom: 124, width: 100, height: 24 });
      document.elementFromPoint = () => card(to);
      pointer(card(from), 'pointerdown', 60, 110); pointer(document, 'pointermove', 320, 110);
    };
    drag(area.id, child.id); assert.match(viewport.querySelector('.obsb-map-drag-status').textContent, /自身或自己的子树/);
    pointer(document, 'pointerup', 320, 110); await tick(); assert.deepEqual(await plugin.store.load(), before);
    drag(area.id, task.id); assert.match(viewport.querySelector('.obsb-map-drag-status').textContent, /任务下不能放领域/);
    pointer(document, 'pointerup', 320, 110); await tick(); assert.deepEqual(await plugin.store.load(), before);
    drag(task.id, area.id); assert.match(viewport.querySelector('.obsb-map-drag-status').textContent, /作为子节点/);
    assert.deepEqual(await plugin.store.load(), before);
    pointer(document, 'pointerup', 320, 110); await tick();
    assert.equal((await plugin.store.load()).nodes.find(n => n.id === task.id).parent, area.id);
    await view.undo(); assert.deepEqual((await plugin.store.load()).nodes, before.nodes);
  } finally { await view.onClose(); view.contentEl.remove(); }
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
  find(view.contentEl, 'AAA领域').click(); await tick();
  const taskButton = find(view.contentEl, '○ 任务1'); taskButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true })); await tick();
  assert.equal(view.selectedIds.size, 2);
  key(view.contentEl.querySelector('.obsb-task-stage'), 'Delete'); await tick();
  assert.equal((await plugin.store.load()).nodes.length, 0);
  key(view.contentEl.querySelector('.obsb-task-stage'), 'z', { ctrlKey: true }); await tick();
  const current = await plugin.store.load(); assert.equal(current.nodes.length, 3); assert.ok(current.nodes.some(n => n.id === area.id));
  await view.onClose(); view.contentEl.remove();
});
