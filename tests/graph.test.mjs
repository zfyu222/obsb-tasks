import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { newNode, emptyBoard, Tree, upsert, moveTasks, deleteTasks, layoutGraph, titleSize, GRAPH_ROOT, GraphViewport, zoomCamera, TaskHistory } from '../.test-build/view.mjs';
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const node = (title, kind = 'task', parent = null) => ({ ...newNode(kind, parent), title });
const board = nodes => ({ ...emptyBoard(), nodes });
const pointer = (target, type, x, y, options = {}) => {
  const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: options.button ?? 0, ctrlKey: options.ctrlKey ?? false });
  Object.defineProperties(e, { pointerId: { value: options.id ?? 1 }, pointerType: { value: options.touch ? 'touch' : 'mouse' } });
  target.dispatchEvent(e); return e;
};
function viewport(readonly = false) {
  const element = document.createElement('div'); document.body.append(element);
  const camera = { x: 100, y: 80, scale: 1, initialized: true }, calls = [];
  const hooks = { paint: () => calls.push(['paint']), selected: () => ['existing'], select: (ids, id) => calls.push(['select', ids, id]),
    marquee: (rect, additive) => calls.push(['marquee', rect, additive]), move: (...args) => calls.push(['move', ...args]), edit: id => calls.push(['edit', id]) };
  const v = new GraphViewport(element, camera, hooks, readonly);
  return { element, camera, calls, v };
}
test('actual fork layout balances both sides, measures titles and emits cubic curves', () => {
  const a = node('AAA 项目', 'area'), b = node('个人生活', 'area'), t = node('完成注册系统开发', 'task', a.id), c = node('需求确认', 'task', t.id);
  const nodes = [a, t, c, b], tree = new Tree(nodes), g = layoutGraph(tree, new Set(nodes.map(n => n.id)), new Set());
  assert.ok(g.nodes.get(a.id).box.x > g.root.box.x); assert.ok(g.nodes.get(b.id).box.x < g.root.box.x);
  assert.ok(g.nodes.get(t.id).box.x > g.nodes.get(a.id).box.x);
  assert.ok(g.nodes.get(c.id).box.width < g.nodes.get(t.id).box.width);
  assert.ok(g.curves.get(a.id).some(path => path.d.includes('C')));
  for (const n of g.order) for (const value of Object.values(n.box)) assert.ok(Number.isFinite(value));
  for (const curves of g.curves.values()) for (const path of curves) assert.doesNotMatch(path.d, /NaN|Infinity/);
});
test('fork geometry respects collapsed branches, focus and right-only layout', () => {
  const a = node('A', 'area'), child = node('子任务', 'task', a.id), b = node('B', 'area'); const nodes = [a, child, b], tree = new Tree(nodes), ids = new Set(nodes.map(n => n.id));
  const folded = layoutGraph(tree, ids, new Set([a.id])); assert.equal(folded.nodes.has(child.id), false);
  const focused = layoutGraph(tree, ids, new Set(), a.id); assert.equal(focused.root.id, a.id); assert.equal(focused.nodes.has(b.id), false);
  const right = layoutGraph(tree, ids, new Set(), undefined, 'right');
  assert.ok(right.nodes.get(a.id).box.x > 0 && right.nodes.get(b.id).box.x > 0);
});
test('wide fork layout packs complete branches without overlaps', () => {
  const nodes = [];
  for (let i = 0; i < 40; i++) { const a = node(`领域 ${i}`, 'area'); nodes.push(a); for (let j = 0; j < 15; j++) nodes.push(node(`任务 ${i}/${j}`, 'task', a.id)); }
  const g = layoutGraph(new Tree(nodes), new Set(nodes.map(n => n.id)), new Set());
  const leaves = g.order.filter(n => n.task?.kind === 'task').sort((a, b) => a.box.y - b.box.y);
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i].box, b = leaves[j].box; if (b.y >= a.y + a.height) break;
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x, `overlap ${leaves[i].task.title} / ${leaves[j].task.title}`);
  }
});

test('compact map uses title-sized single-line nodes and 28px sibling pitch', () => {
  const short = titleSize('下一步', true), long = titleSize('很长的任务名称'.repeat(30), true);
  assert.equal(short.height, 24); assert.ok(short.width < 80);
  assert.equal(long.height, 24); assert.equal(long.width, 420);
  const area = node('项目', 'area'), tasks = Array.from({ length: 100 }, (_, i) => node(`任务${i}`, 'task', area.id));
  const nodes = [area, ...tasks], g = layoutGraph(new Tree(nodes), new Set(nodes.map(n => n.id)), new Set(), undefined, 'right');
  assert.ok(g.bounds.height <= 2800);
  for (let i = 1; i < tasks.length; i++) assert.equal(g.nodes.get(tasks[i].id).box.y - g.nodes.get(tasks[i - 1].id).box.y, 28);
});
test('right pan continues outside viewport and context suppression/cleanup work', () => {
  const { element, camera, calls, v } = viewport();
  pointer(element, 'pointerdown', 50, 50, { button: 2 }); pointer(document, 'pointermove', 170, 90, { button: 2 }); pointer(document, 'pointerup', 170, 90, { button: 2 });
  assert.equal(camera.x, 220); assert.equal(camera.y, 120); assert.equal(calls.filter(c => c[0] === 'move').length, 0);
  const menu = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); element.dispatchEvent(menu); assert.equal(menu.defaultPrevented, true);
  v.destroy(); const before = { ...camera }; pointer(document, 'pointermove', 400, 400, { button: 2 });
  assert.deepEqual(camera, before);
  const wheel = new dom.window.WheelEvent('wheel', { deltaY: 20, cancelable: true }); element.dispatchEvent(wheel); assert.equal(wheel.defaultPrevented, false); element.remove();
});
test('left blank drag creates marquee, never pans, and supports additive selection', () => {
  const { element, camera, calls, v } = viewport();
  pointer(element, 'pointerdown', 20, 30, { ctrlKey: true }); pointer(document, 'pointermove', 120, 150); pointer(document, 'pointerup', 120, 150);
  assert.equal(camera.x, 100); assert.equal(camera.y, 80);
  const call = calls.find(c => c[0] === 'marquee'); assert.deepEqual(call[1], { left: 20, top: 30, right: 120, bottom: 150 }); assert.equal(call[2], true);
  v.destroy(); element.remove();
});
test('pointer-captured clicks and touch taps still select nodes; editors keep native behavior', () => {
  const { element, calls, v } = viewport();
  const card = document.createElement('div'); card.dataset.nodeId = 'node-a'; element.append(card);
  pointer(card, 'pointerdown', 30, 40); pointer(document, 'pointerup', 30, 40);
  assert.deepEqual(calls.find(c => c[0] === 'select').slice(1), [['node-a'], 'node-a']); calls.length = 0;
  pointer(card, 'pointerdown', 30, 40, { touch: true }); pointer(document, 'pointerup', 30, 40, { touch: true }); assert.equal(calls.find(c => c[0] === 'select')[1][0], 'node-a');
  const input = document.createElement('input'); card.append(input); calls.length = 0;
  assert.equal(pointer(input, 'pointerdown', 30, 40).defaultPrevented, false); pointer(document, 'pointermove', 100, 100); pointer(document, 'pointerup', 100, 100);
  assert.equal(calls.length, 0); v.destroy(); element.remove();
});
test('drag placement recognizes child, before, after; readonly cannot move', () => {
  for (const [y, placement] of [[55, 'before'], [90, 'child'], [145, 'after']]) {
    const { element, calls, v } = viewport();
    const a = document.createElement('div'); a.dataset.nodeId = 'node-a'; const b = document.createElement('div'); b.dataset.nodeId = 'node-b'; element.append(a, b);
    b.getBoundingClientRect = () => ({ top: 50, height: 100 }); document.elementFromPoint = () => b;
    pointer(a, 'pointerdown', 10, 10); pointer(document, 'pointermove', 200, y); pointer(document, 'pointerup', 200, y);
    assert.deepEqual(calls.find(c => c[0] === 'move').slice(1), [['node-a'], 'node-b', placement]); v.destroy(); element.remove();
  }
  const { element, calls, v } = viewport(true), card = document.createElement('div'); card.dataset.nodeId = 'node-a'; element.append(card);
  pointer(card, 'pointerdown', 10, 10); pointer(document, 'pointermove', 100, 100); pointer(document, 'pointerup', 100, 100);
  assert.equal(calls.some(c => c[0] === 'move'), false); v.destroy(); element.remove();
});
test('zoom preserves the world point under the cursor, pinch is anchored and cancels on blur', () => {
  const camera = { x: 100, y: 50, scale: 1, initialized: true }, point = { x: (300 - camera.x) / camera.scale, y: (200 - camera.y) / camera.scale };
  zoomCamera(camera, 2, 300, 200); assert.equal(point.x * camera.scale + camera.x, 300); assert.equal(point.y * camera.scale + camera.y, 200);
  const { element, camera: c, calls, v } = viewport();
  pointer(element, 'pointerdown', 200, 100, { touch: true, id: 1 }); pointer(element, 'pointerdown', 300, 100, { touch: true, id: 2 });
  pointer(document, 'pointermove', 400, 100, { touch: true, id: 2 }); assert.equal(c.scale, 2); assert.equal(c.x, 0);
  window.dispatchEvent(new dom.window.Event('blur')); const saved = { ...c }; pointer(document, 'pointermove', 600, 100, { touch: true, id: 2 }); assert.deepEqual(c, saved);
  assert.equal(calls.some(c => c[0] === 'select'), false); v.destroy(); element.remove();
});
test('moves validate task/area parentage and cycles, reorder siblings, then undo/redo through fork history', () => {
  const a = node('领域', 'area'), t = node('任务', 'task', a.id), c = node('子任务', 'task', t.id), b = node('另一领域', 'area'), sibling = node('另一个任务', 'task', a.id);
  const original = board([a, t, c, b, sibling]);
  assert.throws(() => moveTasks(original, [a.id], t.id, 'child'), /子树/);
  assert.throws(() => moveTasks(original, [b.id], t.id, 'child'), /任务下不能挂领域/);
  const moved = moveTasks(original, [t.id, c.id], b.id, 'child'); assert.equal(moved.nodes.find(n => n.id === t.id).parent, b.id); assert.equal(moved.nodes.find(n => n.id === c.id).parent, t.id);
  const history = new TaskHistory(); history.record(original, moved); const command = history.peek();
  const restored = history.apply(moved, command); history.accept(); assert.deepEqual(restored.nodes, new Tree(original.nodes).order);
  const redone = history.apply(restored, history.peek(true), true); history.accept(true); assert.deepEqual(redone.nodes, new Tree(moved.nodes).order);
  const reordered = moveTasks(original, [sibling.id], t.id, 'before'); assert.deepEqual(new Tree(reordered.nodes).children.get(a.id).map(n => n.id), [sibling.id, t.id]);
  const deleted = deleteTasks(original, [t.id, c.id]); assert.equal(deleted.nodes.length, original.nodes.length - 2);
});
test('extracted layout handles a 10k deep chain without recursion overflow', () => {
  const nodes = []; let parent = null;
  for (let i = 0; i < 10000; i++) { const n = node('深层任务', 'task', parent); nodes.push(n); parent = n.id; }
  const g = layoutGraph(new Tree(nodes), new Set(nodes.map(n => n.id)), new Set(), undefined, 'right');
  assert.equal(g.order.length, 10001); assert.ok(Number.isFinite(g.bounds.width)); assert.ok(g.bounds.width > 100000);
});

test('pure Markdown sibling reorders and bulk undo retain order even with identical timestamps', () => {
  const nodes = Array.from({ length: 10000 }, (_, i) => node(`任务${i}`, 'task'));
  const original = board(nodes), reordered = board([...nodes.slice(1), nodes[0]]);
  const history = new TaskHistory(); history.record(original, reordered);
  assert.ok(history.peek(), 'a reorder without property changes is still a command');
  const restored = history.apply(reordered, history.peek()); history.accept();
  assert.deepEqual(restored.nodes.map(n => n.id), nodes.map(n => n.id));
  const redone = history.apply(restored, history.peek(true), true);
  assert.deepEqual(redone.nodes.map(n => n.id), reordered.nodes.map(n => n.id));
});
