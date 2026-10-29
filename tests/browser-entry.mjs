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
// Optional visible fixture replay keeps the real bundle's drag overlay on screen
// for CSS inspection. It never releases a drop or changes any persisted node.
if (new URLSearchParams(location.search).get('demo') === 'drag') {
  const controls = document.createElement('div'); Object.assign(controls.style, { position: 'fixed', bottom: '8px', left: '12px', zIndex: '100', display: 'flex', gap: '6px' });
  const start = document.createElement('button'), cancel = document.createElement('button'); start.textContent = '演示拖动反馈（未松手）'; cancel.textContent = '取消演示'; controls.append(start, cancel); document.body.append(controls);
  const stop = () => document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 41, pointerType: 'mouse' }));
  cancel.addEventListener('click', stop);
  start.addEventListener('click', () => {
    stop();
    const viewport = document.querySelector('.obsb-map-viewport'), source = document.querySelector('[data-node-id="n-backend"]'), target = document.querySelector('[data-node-id="n-game"]');
    const a = source.getBoundingClientRect(), b = target.getBoundingClientRect(), capture = viewport.setPointerCapture;
    // Synthetic replay has no browser-owned pointer to capture; native gestures
    // are validated separately with the normal page and mouse drag tool.
    viewport.setPointerCapture = () => {};
    try { source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 41, pointerType: 'mouse', button: 0, clientX: a.left + a.width / 2, clientY: a.top + a.height / 2 })); }
    finally { viewport.setPointerCapture = capture; }
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 41, pointerType: 'mouse', buttons: 1, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
  });
}
