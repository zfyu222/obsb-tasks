import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, CURRENT, ARCHIVE } from '../.test-build/store.mjs';
import { decode, boardFrom } from '../.test-build/codec.mjs';
import { newNode, upsert, archivePlan } from '../.test-build/model.mjs';
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
  files.data.set(CURRENT, files.data.get(CURRENT).replace('## 测试任务', '## 原生编辑后的名称'));
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
