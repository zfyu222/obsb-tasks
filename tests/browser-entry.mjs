import * as obsidian from './obsidian-mock.mjs';
import { openPlugin } from './host.mjs';
const module = { exports: {} };
new Function('module', 'exports', 'require', window.releaseBundle)(module, module.exports, name => {
  if (name === 'obsidian') return obsidian; throw Error(`unexpected runtime dependency ${name}`);
});
const date = new Date().toISOString();
const node = (id, title, kind, parent = null, extra = {}) => ({ id: `n-${id}`, title, kind, parent: parent ? `n-${parent}` : null, notes: '', status: 'todo', importance: 'medium',
  deadline: '', planned: '', estimate: 0, actual: 0, tags: [], created: date, updated: date, completed: '', ...extra });
const nodes = [node('project', 'AAA 项目', 'area'), node('registration', '完成注册系统开发', 'task', 'project', { importance: 'high', deadline: '2026-11-08' }),
  node('requirements', '确认注册需求', 'task', 'registration', { status: 'done', completed: date }), node('frontend', '完成前端开发', 'task', 'registration'),
  node('backend', '完成后端开发', 'task', 'registration', { importance: 'high' }), node('game', '游戏技能系统', 'area'), node('cooldown', '实现技能冷却', 'task', 'game', { importance: 'low' }),
  node('sync', '修复技能同步', 'task', 'game', { importance: 'high' }), node('personal', '个人生活', 'area'), node('exercise', '制定运动计划', 'task', 'personal', { importance: 'low' }), node('env', '更新开发环境', 'task')];
window.preview = await openPlugin(module.exports.default, nodes);
