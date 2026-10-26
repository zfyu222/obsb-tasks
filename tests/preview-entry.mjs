// Browser-only fixture: never opens the formal vault or writes user data.
import { TaskView } from '../src/view';
import { TaskStore } from '../src/store';
import { newNode, upsert } from '../src/model';
const files = new Map();
const store = new TaskStore({ exists: p => files.has(p), read: async p => files.get(p),
  create: async (p, t) => { files.set(p, t); }, list: folder => [...files.keys()].filter(p => p.startsWith(folder + '/')),
  compareWrite: async (p, before, after) => { if (files.get(p) !== before) throw new Error('conflict'); files.set(p, after); } });
let board = await store.load();
const area = { ...newNode('area'), title: 'AAA 项目', notes: '注册系统与游戏技能开发' };
const parent = { ...newNode('task', area.id), title: '完成注册系统开发', importance: 'high', deadline: '2026-11-08' };
const nodes = [area, parent,
  { ...newNode('task', parent.id), title: '确认注册需求', status: 'done', completed: new Date().toISOString(), notes: '> [!tip]\n> 需求已确认，参考 [[注册系统需求]]。' },
  { ...newNode('task', parent.id), title: '完成前端开发', estimate: 480 },
  { ...newNode('task', parent.id), title: '完成后端开发', estimate: 600 },
  { ...newNode('task'), title: '更新开发环境', notes: '直接挂在 root 的任务' },
  { ...newNode('area'), title: '游戏技能系统', notes: '长期维护领域，可以暂时休眠。' }
];
await store.change(board.revision, b => ({ ...b, nodes }));
const app = { vault: { getName: () => '演示知识库' }, workspace: { openLinkText() {} } };
const view = new TaskView({ app }, { app, store });
document.body.append(view.contentEl); await view.onOpen();
window.demoView = view;
