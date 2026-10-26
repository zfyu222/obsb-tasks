import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { archivePlan, emptyBoard, extract, newNode, periodNodes, restore, sleepPlan, Tree, upsert, validate, validDate } from '../.test-build/model.mjs';
import { batchFrom, boardFrom, decode, encodeBatch, encodeBoard } from '../.test-build/codec.mjs';
const node = (kind = 'task', parent = null, done = false) => ({ ...newNode(kind, parent), title: '任务 [测试] ^ 标题', status: done ? 'done' : 'todo', completed: done ? new Date().toISOString() : '' });
const board = nodes => ({ ...emptyBoard(), nodes });

test('root accepts tasks and nested areas; tasks reject area children and cycles', () => {
  const area = node('area'), task = node('task'), child = node('task', task.id), nested = node('area', area.id);
  assert.equal(validate(board([area, task, child, nested])).order.length, 4);
  assert.throws(() => validate(board([task, node('area', task.id)])), /不能挂领域/);
  task.parent = child.id; assert.throws(() => validate(board([task, child])), /循环/);
});
test('duplicate and missing IDs, invalid dates, work and reserved notes rejected', () => {
  const n = node();
  assert.throws(() => validate(board([n, n])), /重复/);
  assert.throws(() => validate(board([{ ...n, parent: 'missing' }])), /不存在/);
  for (const patch of [{ deadline: '2026-02-30' }, { estimate: -1 }, { notes: '<!-- obsb-end -->' }, { completed: 'bad' }]) assert.throws(() => validate(board([{ ...n, ...patch }])));
  assert.equal(validDate('2026-99-01'), false); assert.equal(validDate('2024-02-29'), true);
});
test('completion stays in current and preserves order; cannot finish unfinished subtree', () => {
  const parent = node(), child = node('task', parent.id), b = board([parent, child]);
  assert.throws(() => upsert(b, { ...parent, status: 'done' }), /未完成/);
  const next = upsert(b, { ...child, status: 'done' });
  assert.equal(next.nodes.length, 2); assert.equal(next.nodes[1].id, child.id); assert.ok(next.nodes[1].completed);
  assert.equal(upsert(next, { ...next.nodes[1], status: 'todo' }).nodes[1].completed, '');
});
test('global archive removes only closed tasks; retains areas and incomplete ancestors', () => {
  const area = node('area'), parent = node('task', area.id, true), done = node('task', parent.id, true), open = node('task', parent.id), rootDone = node('task', null, true);
  const b = board([area, parent, done, open, rootDone]), plan = archivePlan(b);
  assert.deepEqual([...plan.ids].sort(), [done.id, rootDone.id].sort()); assert.equal(plan.skipped, 1);
  const { next, batch } = extract(b, plan.ids, 'archive');
  assert.deepEqual(next.nodes.map(n => n.id), [area.id, parent.id, open.id]);
  assert.equal(batch.nodes.length, 2); assert.equal(batch.context.length, 2);
  const recovered = restore(next, batch); assert.equal(recovered.nodes.length, 5);
  assert.equal(recovered.nodes.find(n => n.id === done.id).parent, parent.id);
});
test('sleep is explicit, rejects unfinished tasks, preserves domain identity and notes', () => {
  const area = { ...node('area'), notes: '长期方向\n\n[[普通文档]]' }, task = node('task', area.id);
  assert.throws(() => sleepPlan(board([area, task]), area.id), /未完成/);
  const b = board([area]), { next, batch } = extract(b, sleepPlan(b, area.id), 'sleep');
  assert.equal(next.nodes.length, 0); assert.deepEqual(restore(next, batch).nodes[0], area);
});
test('restoring a domain does not resurrect separately archived tasks', () => {
  const area = node('area'), done = node('task', area.id, true), b = board([area, done]);
  const archived = extract(b, archivePlan(b).ids, 'archive');
  const sleeping = extract(archived.next, sleepPlan(archived.next, area.id), 'sleep');
  const recovered = restore(sleeping.next, sleeping.batch);
  assert.equal(recovered.nodes.length, 1); assert.equal(recovered.nodes[0].id, area.id);
});
test('codec roundtrips rich Markdown, unknown properties and frontmatter', () => {
  const n = { ...node(), custom: { nested: '-->' }, notes: '## 注释标题\n\n> [!tip]\n> [[需求#标题]]\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n' };
  const b = board([n]), text = encodeBoard(b, '---\ncustom: yes\n---\n\n# 自定义\n\n');
  assert.deepEqual(boardFrom(decode(text)), b); assert.match(decode(text).preamble, /custom: yes/);
  assert.equal(boardFrom(decode(text.replace('任务 \\[测试\\]', '新名称'))).nodes[0].title, '新名称 ^ 标题');
  assert.throws(() => decode(`${text}\n用户节点外正文`), /节点外正文/);
  assert.throws(() => decode(text.replace('<!-- obsb-end -->', '损坏')));
  const done = node('task', null, true), { batch } = extract(board([done]), new Set([done.id]), 'archive');
  assert.deepEqual(batchFrom(decode(encodeBatch(batch))), batch);
});
test('period filters completion separately from creation, inclusive local calendar days', () => {
  const n = node('task', null, true); n.created = '2026-01-01T12:00:00Z'; n.completed = '2026-06-30T12:00:00Z';
  assert.equal(periodNodes([n], 'completed', '2026-06-01', '2026-06-30').size, 1);
  assert.equal(periodNodes([n], 'created', '2026-06-01', '2026-06-30').size, 0);
  assert.throws(() => periodNodes([n], 'completed', '2026-07-01', '2026-06-01'));
});
test('1k / 10k / 50k wide boards: parse, validate, archive plan and serialization benchmark', t => {
  for (const count of [1000, 10000, 50000]) {
    const area = node('area'), nodes = [area];
    for (let i = 1; i < count; i++) nodes.push({ ...node('task', area.id, i % 2 === 0), notes: '注释 [[相关文档]]' });
    const b = board(nodes), start = performance.now(), text = encodeBoard(b), encoded = performance.now();
    const parsed = boardFrom(decode(text)), decoded = performance.now(), plan = archivePlan(parsed), planned = performance.now();
    assert.equal(parsed.nodes.length, count); assert.equal(plan.ids.size, Math.floor((count - 1) / 2));
    t.diagnostic(JSON.stringify({ nodes: count, bytes: Buffer.byteLength(text), encodeMs: +(encoded-start).toFixed(1), decodeMs: +(decoded-encoded).toFixed(1), archivePlanMs: +(planned-decoded).toFixed(1) }));
  }
});
test('deep chain uses iterative traversal without stack overflow', () => {
  const nodes = []; let parent = null;
  for (let i = 0; i < 10000; i++) { const n = node('task', parent, true); nodes.push(n); parent = n.id; }
  const b = board(nodes); assert.equal(new Tree(nodes).descendants(nodes[0].id).length, 9999);
  assert.equal(archivePlan(b).ids.size, 10000);
  const extracted = extract(b, archivePlan(b).ids, 'archive');
  assert.equal(extracted.next.nodes.length, 0); assert.equal(extracted.batch.context.length, 0);
});
