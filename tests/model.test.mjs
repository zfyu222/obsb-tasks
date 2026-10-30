import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { archivePlan, changeKinds, emptyBoard, extract, newNode, periodNodes, restore, sleepPlan, Tree, upsert, validate, validDate } from '../.test-build/model.mjs';
import { batchFrom, boardFrom, decode, encodeBatch, encodeBoard } from '../.test-build/codec.mjs';
import { encodeBoard as legacyBoard, encodeBatch as legacyBatch } from '../.test-build/legacy-codec.mjs';
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
  assert.throws(() => decode(`${text}\n用户节点外正文`), /缩进不正确/);
  assert.throws(() => decode(text.replace(` ^${n.id}`, '')), /缺少稳定 ID/);
  const done = node('task', null, true), { batch } = extract(board([done]), new Set([done.id]), 'archive');
  assert.deepEqual(batchFrom(decode(encodeBatch(batch))), batch);
});
test('period filters completion separately from creation, inclusive local calendar days', () => {
  const n = node('task', null, true); n.created = '2026-01-01T12:00:00Z'; n.completed = '2026-06-30T12:00:00Z';
  assert.equal(periodNodes([n], 'completed', '2026-06-01', '2026-06-30').size, 1);
  assert.equal(periodNodes([n], 'created', '2026-06-01', '2026-06-30').size, 0);
  assert.throws(() => periodNodes([n], 'completed', '2026-07-01', '2026-06-01'));
});

test('Markdown hierarchy is authoritative, checkbox states and visible fields survive native edits', () => {
  const area = { ...node('area'), title: 'AAA' }, task = { ...node(), title: '注册开发' }, child = { ...node('task', task.id), title: '需求确认' };
  const b = board([area, task, child]);
  let text = encodeBoard(b);
  assert.match(text, /- 领域：AAA \^n-/); assert.doesNotMatch(text, /"parent"|"title"|obsb-node|obsb-end/);
  // Reparent the complete task subtree by indenting its Markdown, retaining IDs.
  const offset = text.indexOf('- [ ] 注册开发');
  text = text.slice(0, offset) + text.slice(offset).split('\n').map(line => line ? `  ${line}` : line).join('\n');
  text = text.replace('- [ ] 注册开发', '- [/] 注册开发').replace('- [ ] 需求确认', '- [x] 需求确认');
  text = text.replace(`    <!-- obsb-meta`, `    [重要程度:: 高]\n    [截止日期:: 2026-11-10]\n    [预计工作量:: 8h]\n    [标签:: ["后端", "项目,一"]]\n    <!-- obsb-meta`);
  const result = boardFrom(decode(text));
  assert.equal(result.nodes[1].parent, area.id); assert.equal(result.nodes[2].parent, task.id);
  assert.equal(result.nodes[1].status, 'doing'); assert.equal(result.nodes[1].importance, 'high');
  assert.equal(result.nodes[1].deadline, '2026-11-10'); assert.equal(result.nodes[1].estimate, 480);
  assert.deepEqual(result.nodes[1].tags, ['后端', '项目,一']);
  assert.equal(result.nodes[2].status, 'done'); assert.ok(result.nodes[2].completed);
  const markers = { todo: ' ', doing: '/', waiting: '?', done: 'x', cancelled: '-' };
  for (const [status, marker] of Object.entries(markers)) {
    const value = { ...node(), status, completed: status === 'done' ? new Date().toISOString() : '' };
    const encoded = encodeBoard(board([value])); assert.ok(encoded.includes(`- [${marker}] `));
    assert.equal(boardFrom(decode(encoded)).nodes[0].status, status);
  }
});

test('note envelope preserves task-looking lists, fences, callouts, whitespace and trailing newlines', () => {
  const notes = '- [x] 注释里的复选框 ^n-not-a-node\n- 领域：也不是节点 ^n-not-area\n\n> [!tip]\n> [[笔记]]\n\n```md\n- [ ] 代码里的任务 ^n-code\n```\n\n| 列 | 值 |\n| - | - |\n| a | b |\n  \n\n';
  const n = { ...node(), notes }, b = board([n]);
  const decoded = boardFrom(decode(encodeBoard(b)));
  assert.equal(decoded.nodes.length, 1); assert.equal(decoded.nodes[0].notes, notes);
  assert.deepEqual(decoded, b);
});

test('malformed indentation, duplicate IDs/fields, unknown fields and unquoted notes stop writes', () => {
  const n = { ...node(), importance: 'high' }, text = encodeBoard(board([n]));
  for (const changed of [
    text.replace('- [ ]', '  - [ ]'),
    text.replace('- [ ]', ' - [ ]'),
    text + `- [ ] 重复 ^${n.id}\n`,
    text.replace('[重要程度:: 高]', '[重要程度:: 高]\n  [重要程度:: 低]'),
    text.replace('[重要程度:: 高]', '[优先级别:: 高]'),
    text + '  普通正文没有引用前缀\n',
    text.replace('"format":2', '"format":99'),
    text.replace('[重要程度:: 高]', '[预计工作量:: -8h]')
  ]) assert.throws(() => decode(changed));
});

test('new handwritten nodes accept defaults with explicit stable IDs and Markdown notes', () => {
  const text = encodeBoard(board([])) + '- 领域：游戏系统 ^n-game\n  - [ ] 完成技能开发 ^n-skill\n    > 参考 [[技能设计]]\n';
  const decoded = boardFrom(decode(text));
  assert.equal(decoded.nodes[1].parent, 'n-game'); assert.equal(decoded.nodes[1].importance, 'medium');
  assert.equal(decoded.nodes[1].notes, '参考 [[技能设计]]');
  assert.equal(decode(encodeBoard(decoded)).nodes[1].id, 'n-skill');
});

test('legacy documents convert without losing node fields, nested context or domain task state', () => {
  const area = { ...node('area', null, true), custom: { nested: '-->' }, estimate: 1.234e-7, tags: ['a,b', '[]'] };
  const parent = node('task', area.id), child = node('task', parent.id, true), b = board([area, parent, child]);
  const old = legacyBoard(b); assert.equal(decode(old).format, 1);
  assert.deepEqual(boardFrom(decode(encodeBoard(boardFrom(decode(old))))), b);
  const { batch } = extract(b, new Set([child.id]), 'archive');
  const original = batchFrom(decode(legacyBatch(batch))), converted = batchFrom(decode(encodeBatch(original)));
  const sort = values => [...values].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sort(converted.context), sort(original.context)); assert.deepEqual(converted.nodes, original.nodes);
  assert.doesNotMatch(encodeBatch(batch), /"context"|"parent"/);
  assert.match(encodeBatch(batch), /\[归档上下文:: 是\]/);
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
test('area with subareas cannot become task, task below task cannot become area', () => {
  const area = node('area'), subarea = node('area', area.id);
  assert.throws(() => upsert(board([area, subarea]), { ...area, kind: 'task' }), /任务下不能挂领域/);
  const parent = node(), child = node('task', parent.id);
  assert.throws(() => upsert(board([parent, child]), { ...child, kind: 'area' }), /任务下不能挂领域/);
});

test('batch kind conversion validates final hierarchy in either direction and never mutates rejected input', () => {
  const parent = node(), child = node('task', parent.id), original = board([parent, child]), snapshot = structuredClone(original);
  const areas = changeKinds(original, [child.id, parent.id], 'area');
  assert.ok(areas.nodes.every(n => n.kind === 'area')); assert.deepEqual(original, snapshot);
  const tasks = changeKinds(areas, [parent.id, child.id], 'task'); assert.ok(tasks.nodes.every(n => n.kind === 'task'));
  assert.throws(() => changeKinds(original, [child.id], 'area'), /任务下不能挂领域/);
  assert.throws(() => changeKinds(areas, [parent.id], 'task'), /任务下不能挂领域/);
  assert.deepEqual(original, snapshot); assert.equal(tasks.nodes[1].parent, parent.id); assert.equal(tasks.nodes[1].notes, child.notes);
});
