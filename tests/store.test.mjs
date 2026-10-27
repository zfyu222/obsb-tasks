import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, CURRENT, ARCHIVE, SLEEP, BACKUP, TRANSACTION } from '../.test-build/store.mjs';
import { decode, boardFrom } from '../.test-build/codec.mjs';
import { newNode, upsert, archivePlan, emptyBoard, extract, sleepPlan } from '../.test-build/model.mjs';
import { encodeBoard as legacyBoard, encodeBatch as legacyBatch } from '../.test-build/legacy-codec.mjs';
class MemoryFiles {
  data = new Map(); fail = ''; mutate;
  exists(p) { return this.data.has(p); }
  async read(p) { if (!this.data.has(p)) throw new Error('missing'); return this.data.get(p); }
  async create(p, text) { if (this.fail === 'create') throw new Error('disk full'); if (this.data.has(p)) throw new Error('exists'); this.data.set(p, text); }
  list(folder) { return [...this.data.keys()].filter(p => p.startsWith(folder + '/')); }
  async compareWrite(p, before, after) {
    this.mutate?.(p, this);
    if (this.fail === p || this.fail === 'commit' && p.startsWith(ARCHIVE + '/')) throw new Error('write failed');
    if (this.data.get(p) !== before) throw new Error('conflict'); this.data.set(p, after);
  }
}
async function setup() {
  const files = new MemoryFiles(), store = new TaskStore(files); let b = await store.load();
  const n = { ...newNode('task'), title: '测试任务', status: 'done' };
  b = await store.change(b.revision, b => upsert(b, n)); return { files, store, b, n };
}
test('opening creates one current Markdown file; closed plugin has no writes', async () => {
  const files = new MemoryFiles(), store = new TaskStore(files); assert.equal(files.data.size, 0);
  assert.equal((await store.load()).nodes.length, 0); assert.equal(files.data.size, 1);
});
test('completed tasks persist and archive removes from current, restore preserves ID', async () => {
  const { store, files, b, n } = await setup(); assert.equal((await store.load()).nodes.length, 1);
  await store.removeToBatch(b.revision, archivePlan(b).ids, 'archive');
  const current = await store.load(); assert.equal(current.nodes.length, 0); assert.doesNotMatch(files.data.get(CURRENT), /测试任务/);
  const saved = await store.batches('archive'); assert.equal(saved.length, 1);
  assert.equal((await store.restore(current.revision, saved[0].path)).nodes[0].id, n.id);
});
test('archive failure before copy or source write never removes original', async () => {
  for (const fail of ['create', CURRENT]) {
    const { store, files, b } = await setup(); files.fail = fail;
    await assert.rejects(store.removeToBatch(b.revision, archivePlan(b).ids, 'archive'));
    assert.equal(boardFrom(decode(files.data.get(CURRENT))).nodes.length, 1);
    files.fail = ''; assert.equal((await store.batches()).length, 0);
  }
});
test('crash between source removal and commit recovers prepared copy before next edit', async () => {
  const { store, files, b } = await setup(); files.fail = 'commit';
  await assert.rejects(store.removeToBatch(b.revision, archivePlan(b).ids, 'archive'));
  assert.equal(boardFrom(decode(files.data.get(CURRENT))).nodes.length, 0);
  files.fail = ''; const restarted = new TaskStore(files);
  assert.equal((await restarted.load()).nodes.length, 0); assert.equal((await restarted.batches()).length, 1);
});
test('failed prepared batch is never mistaken for a later successful archive', async () => {
  const { store, files, b, n } = await setup(); files.fail = CURRENT;
  await assert.rejects(store.removeToBatch(b.revision, archivePlan(b).ids, 'archive')); files.fail = '';
  let next = await store.change(b.revision, b => upsert(b, { ...b.nodes[0], notes: '更新后的注释' }));
  await store.removeToBatch(next.revision, archivePlan(next).ids, 'archive');
  const batches = await store.batches(); assert.equal(batches.length, 1); assert.equal(batches[0].batch.nodes[0].notes, '更新后的注释');
});
test('compare-and-swap preserves concurrent external content', async () => {
  const { store, files, b } = await setup();
  files.mutate = (p, io) => { if (p === CURRENT) { io.data.set(p, io.data.get(p) + '\n外部内容'); files.mutate = undefined; } };
  await assert.rejects(store.change(b.revision, b => upsert(b, { ...b.nodes[0], title: '覆盖' })), /conflict/);
  assert.match(files.data.get(CURRENT), /外部内容/); assert.doesNotMatch(files.data.get(CURRENT), /覆盖/);
});
test('serialized writes reject stale views instead of losing updates', async () => {
  const { store, b } = await setup();
  const results = await Promise.allSettled([
    store.change(b.revision, b => upsert(b, { ...b.nodes[0], title: 'first' })),
    store.change(b.revision, b => upsert(b, { ...b.nodes[0], title: 'second' }))
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal((await store.load()).nodes[0].title, 'first');
});
test('native edits without a revision bump reject an already-open stale editor', async () => {
  const { store, files, b } = await setup();
  files.data.set(CURRENT, files.data.get(CURRENT).replace('测试任务 ^', '原生编辑后的名称 ^'));
  await assert.rejects(store.change(b.revision, old => upsert(old, { ...old.nodes[0], title: '过期表单' })), /其他窗口或设备/);
  assert.match(files.data.get(CURRENT), /原生编辑后的名称/); assert.doesNotMatch(files.data.get(CURRENT), /过期表单/);
});
test('default startup does not scan or parse the archive catalog', async () => {
  const { files } = await setup();
  files.data.set(ARCHIVE + '/unrelated.md', 'This file deliberately is not an OBSB batch');
  const read = files.read.bind(files), reads = [];
  files.read = async p => { reads.push(p); return read(p); };
  const store = new TaskStore(files);
  assert.equal((await store.load()).nodes.length, 1);
  assert.deepEqual(reads, [CURRENT]);
});

async function legacySetup() {
  const files = new MemoryFiles(), area = { ...newNode('area'), title: '长期项目', custom: { a: 1 } };
  const task = { ...newNode('task', area.id), title: '历史任务', status: 'done', completed: '2026-10-01T08:00:00Z', notes: '> [!note]\n> [[知识]]\n\n- [ ] 注释任务' };
  const original = { ...emptyBoard(), nodes: [area, task] }, removed = extract(original, new Set([task.id]), 'archive');
  const sleeping = extract(removed.next, sleepPlan(removed.next, area.id), 'sleep');
  const archive = { ...removed.batch, state: 'committed' }, sleep = { ...sleeping.batch, state: 'committed' };
  files.data.set(CURRENT, legacyBoard(original).replace(/\n/g, '\r\n'));
  files.data.set(`${ARCHIVE}/old.md`, legacyBatch(archive)); files.data.set(`${SLEEP}/old.md`, legacyBatch(sleep));
  return { files, original, store: new TaskStore(files), task, area };
}

test('explicit migration backs up exact bytes, preserves current/archive/sleep and is resumable/idempotent', async () => {
  const { files, store, original } = await legacySetup(), originals = new Map(files.data);
  const board = await store.load(); assert.equal(files.data.size, 3, 'opening is read-only for existing data');
  assert.equal(await store.migrate(), 3); assert.equal(await store.migrate(), 0);
  for (const [path, raw] of originals) {
    assert.equal(decode(files.data.get(path)).format, 2);
    assert.ok([...files.data.entries()].some(([p, data]) => p.startsWith(BACKUP + '/') && data === raw));
  }
  const current = await store.load(); assert.deepEqual(current.nodes, original.nodes);
  assert.equal((await store.batches()).length, 2);
  await assert.rejects(store.change(board.revision, b => b), /其他窗口或设备/);
  const reads = [], read = files.read.bind(files); files.read = async p => { reads.push(p); return read(p); };
  await new TaskStore(files).load(); assert.deepEqual(reads, [CURRENT], 'backups and archives stay outside default loading');
});

test('first edit migrates only current file, never scans archives and keeps a pre-edit backup', async () => {
  const { files, store, task } = await legacySetup(), raw = files.data.get(CURRENT), b = await store.load();
  await store.change(b.revision, old => upsert(old, { ...old.nodes.find(n => n.id === task.id), title: '已编辑' }));
  assert.equal(decode(files.data.get(CURRENT)).format, 2); assert.equal(decode(files.data.get(`${ARCHIVE}/old.md`)).format, 1);
  assert.ok([...files.data.entries()].some(([p, data]) => p.startsWith(BACKUP + '/') && data === raw));
});

test('backup failure or a concurrent edit never overwrites legacy source; migration can retry', async () => {
  for (const failure of ['create', CURRENT]) {
    const { files, store } = await legacySetup(), raw = files.data.get(CURRENT); files.fail = failure;
    await assert.rejects(store.migrate()); assert.equal(files.data.get(CURRENT), raw);
    files.fail = ''; assert.equal(await store.migrate(), 3); assert.equal(await store.migrate(), 0);
  }
  const { files, store } = await legacySetup();
  files.mutate = (path, io) => { if (path === CURRENT) { io.data.set(path, io.data.get(path).replace('长期项目', '其他设备修改')); files.mutate = undefined; } };
  await assert.rejects(store.migrate(), /conflict/); assert.match(files.data.get(CURRENT), /其他设备修改/);
  assert.equal(decode(files.data.get(CURRENT)).format, 1); assert.equal(await store.migrate(), 3);
});

test('legacy pending archive recovers across format upgrade with original source backups', async () => {
  const { files, original, task } = await legacySetup();
  const { next, batch } = extract(original, new Set([task.id]), 'archive'), path = `${ARCHIVE}/pending.md`;
  files.data.set(CURRENT, legacyBoard(next)); files.data.set(path, legacyBatch(batch));
  files.data.set(TRANSACTION, `<!-- obsb-transaction ${JSON.stringify({ version: 1, path })} -->`);
  const store = new TaskStore(files); await store.load();
  assert.equal(decode(files.data.get(path)).format, 2); assert.equal(decode(files.data.get(path)).meta.state, 'committed');
  assert.ok([...files.data.keys()].some(p => p.startsWith(BACKUP + '/')));
});
