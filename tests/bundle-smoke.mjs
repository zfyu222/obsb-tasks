import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as obsidian from './obsidian-mock.mjs';
import { openPlugin } from './host.mjs';
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const code = await readFile('dist/obsb-tasks/main.js', 'utf8'), module = { exports: {} };
assert.match(code, /Copyright \(c\) 2021 Mark/); assert.match(code, /Permission is hereby granted/);
vm.runInNewContext(code, { module, exports: module.exports, require: name => { if (name === 'obsidian') return obsidian; throw Error(`unexpected runtime dependency ${name}`); },
  document, window, crypto, TextEncoder, structuredClone, Event: dom.window.Event, HTMLElement: dom.window.HTMLElement,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  setTimeout, clearTimeout, console });
const { plugin, view } = await openPlugin(module.exports.default);
const press = (element, key, more = {}) => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...more }));
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const stage = () => view.contentEl.querySelector('.obsb-task-stage');
press(stage(), 'Tab'); await tick();
assert.equal((await plugin.store.load()).nodes.length, 1);
let input = view.contentEl.querySelector('.obsb-task-inline-title'); assert.ok(input);
input.value = '实际发布包节点'; input.dispatchEvent(new dom.window.Event('input')); press(input, 'Enter'); await tick();
assert.equal((await plugin.store.load()).nodes[0].title, '实际发布包节点');
assert.ok(view.contentEl.querySelector('svg.obsb-map-paths path').getAttribute('d').includes('C'));
const kind = view.contentEl.querySelector('[data-field=kind]'); kind.value = 'area'; kind.dispatchEvent(new dom.window.Event('change')); await tick();
assert.equal((await plugin.store.load()).nodes[0].kind, 'area');
press(stage(), 'z', { ctrlKey: true }); await tick(); assert.equal((await plugin.store.load()).nodes[0].kind, 'task');
await view.onClose();
console.log('Production bundle: licensed fork layout, Tab/Enter, direct properties and Ctrl+Z passed');
