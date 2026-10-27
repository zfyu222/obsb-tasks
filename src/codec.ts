import { Batch, Board, TaskNode, Tree, newNode, now, validate } from './model';
import { decode as legacyDecode, Document as LegacyDocument } from './legacy-codec';

const FILE = '<!-- obsb-file ';
const json = (value: unknown): string => JSON.stringify(value).replace(/-->/g, '\\u002d\\u002d>');
const escapeTitle = (value: string): string => value.replace(/[\\`*_{}\[\]()#+.!|<>^]/g, '\\$&');
const unescapeTitle = (value: string): string => value.replace(/\\([\\`*_{}\[\]()#+.!|<>^])/g, '$1');
const checks: Record<TaskNode['status'], string> = { todo: ' ', doing: '/', waiting: '?', done: 'x', cancelled: '-' };
const states: Record<string, TaskNode['status']> = { ' ': 'todo', '/': 'doing', '?': 'waiting', x: 'done', X: 'done', '-': 'cancelled' };
const ranks = { high: '高', medium: '中', low: '低' };
const known = new Set(['id', 'parent', 'kind', 'title', 'notes', 'status', 'importance', 'deadline', 'planned', 'estimate', 'actual', 'tags', 'created', 'updated', 'completed']);
export interface Document extends LegacyDocument { format: 1 | 2; }
const preamble = (title: string): string => `---\nnightly_maintenance: skip\nobsb_tasks: 2\n---\n\n# ${title}\n\n`;

function nodeText(node: TaskNode, depth: number, context: boolean): string {
  const indent = '  '.repeat(depth), body = `${indent}  `;
  const lines = [`${indent}- ${node.kind === 'area' ? '领域：' : `[${checks[node.status]}] `}${escapeTitle(node.title)} ^${node.id}`];
  const field = (key: string, value: string): void => { lines.push(`${body}[${key}:: ${value}]`); };
  if (context) field('归档上下文', '是');
  if (node.importance !== 'medium') field('重要程度', ranks[node.importance]);
  if (node.deadline) field('截止日期', node.deadline);
  if (node.planned) field('计划日期', node.planned);
  if (node.estimate) field('预计工作量', `${node.estimate} 分钟`);
  if (node.actual) field('实际工作量', `${node.actual} 分钟`);
  if (node.completed) field('完成时间', node.completed);
  if (node.tags.length) field('标签', json(node.tags));
  const extra = Object.fromEntries(Object.entries(node).filter(([key]) => !known.has(key)));
  lines.push(`${body}<!-- obsb-meta ${json({ created: node.created, updated: node.updated,
    ...(node.kind === 'area' && node.status !== 'todo' ? { areaStatus: node.status } : {}),
    ...(Object.keys(extra).length ? { extra } : {}) })} -->`);
  // One quote level is the note envelope, not part of the note itself. Its content
  // can contain arbitrary Markdown, including lists that resemble task headers.
  if (node.notes !== '') for (const line of node.notes.split('\n')) lines.push(`${body}> ${line}`);
  return lines.join('\n') + '\n';
}
function encode(nodes: TaskNode[], meta: Record<string, unknown>, header: string, contexts = new Set<string>()): string {
  const tree = new Tree(nodes), depths = new Map<string, number>();
  const parts = [header.replace(/^obsb_tasks: 1[ \t]*$/m, 'obsb_tasks: 2'), `${FILE}${json({ ...meta, format: 2 })} -->\n\n`];
  for (const node of tree.order) {
    const depth = node.parent ? depths.get(node.parent)! + 1 : 0;
    depths.set(node.id, depth); parts.push(nodeText(node, depth, contexts.has(node.id)));
  }
  return parts.join('');
}
export function encodeBoard(board: Board, header = preamble('当前任务')): string {
  validate(board);
  return encode(board.nodes, { type: 'current', version: 1, revision: board.revision }, header);
}
export function encodeBatch(batch: Batch, header = preamble(batch.kind === 'sleep' ? '休眠领域' : '任务归档')): string {
  const { nodes, context, ...meta } = batch;
  const merged = new Map([...context, ...nodes].map(node => [node.id, node]));
  validate({ version: 1, revision: batch.afterRevision, nodes: [...merged.values()] });
  return encode([...merged.values()], { type: 'batch', ...meta }, header, new Set(context.map(n => n.id)));
}
function work(value: string): number {
  const match = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(分钟|min|小时|h)$/i.exec(value);
  if (!match) throw new Error('工作量请填写非负数及单位，例如 8h 或 120 分钟');
  return Number(match[1]) * (/^(小时|h)$/i.test(match[2]) ? 60 : 1);
}
export function decode(text: string): Document {
  const source = text.replace(/\r\n/g, '\n'), start = source.indexOf(FILE), end = source.indexOf(' -->\n', start);
  if (start < 0 || end < 0) throw new Error('不是有效的 OBSB 任务文件，请勿覆盖普通笔记');
  const rawMeta = JSON.parse(source.slice(start + FILE.length, end));
  if (rawMeta.format === undefined) return { ...legacyDecode(text), format: 1 };
  if (rawMeta.format !== 2 || rawMeta.version !== 1 || !['current', 'batch'].includes(rawMeta.type)) throw new Error('不支持的任务文件版本');
  const { format: _, ...meta } = rawMeta;
  if (meta.type === 'batch' && Object.prototype.hasOwnProperty.call(meta, 'context')) throw new Error('新格式的归档上下文必须使用 Markdown 节点');
  const nodes: TaskNode[] = [], context: TaskNode[] = [], stack: TaskNode[] = [], stamp = now();
  let current: TaskNode | undefined, depth = 0, noteLines: string[] = [], fields = new Set<string>(), isContext = false, hasMeta = false;
  const finish = (): void => {
    if (!current) return;
    current.notes = noteLines.join('\n');
    if (current.kind === 'task' && current.status === 'done' && !current.completed) current.completed = stamp;
    (isContext ? context : nodes).push(current);
  };
  const lines = source.slice(end + 5).split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const header = /^( *)- (?:\[([ xX/?-])\] |领域：)(.*)$/.exec(line);
    if (header) {
      finish();
      if (header[1].length % 2) throw new Error(`第 ${index + 1} 行：节点缩进必须为两个空格的倍数`);
      depth = header[1].length / 2;
      if (depth > stack.length) throw new Error('节点缩进跳级，停止写入');
      const identity = /^(.*?) \^(n-[a-zA-Z0-9-]+)$/.exec(header[3]);
      if (!identity) throw new Error('节点缺少稳定 ID，请在任务行末添加唯一的 ^n-名称，例如 ^n-register');
      current = { ...newNode(header[2] === undefined ? 'area' : 'task', depth ? stack[depth - 1].id : null),
        id: identity[2], title: unescapeTitle(identity[1]), status: header[2] === undefined ? 'todo' : states[header[2]], created: stamp, updated: stamp };
      stack.length = depth; stack.push(current); noteLines = []; fields = new Set(); isContext = false; hasMeta = false;
      continue;
    }
    if (!current) throw new Error('存在节点外正文，停止写入以保留内容');
    const prefix = '  '.repeat(depth + 1);
    if (!line.startsWith(prefix)) throw new Error('节点属性或注释缩进不正确，停止写入');
    const body = line.slice(prefix.length);
    if (body === '>' || body.startsWith('> ')) { noteLines.push(body === '>' ? '' : body.slice(2)); continue; }
    const system = /^<!-- obsb-meta (.+) -->$/.exec(body);
    if (system) {
      if (hasMeta) throw new Error('节点系统元数据重复'); hasMeta = true;
      const data = JSON.parse(system[1]);
      if (!data || typeof data !== 'object' || Object.keys(data).some(key => !['created', 'updated', 'extra', 'areaStatus'].includes(key))) throw new Error('未知节点元数据，请保留原文并检查');
      if (data.extra !== undefined) {
        if (!data.extra || typeof data.extra !== 'object' || Array.isArray(data.extra) || Object.keys(data.extra).some(key => known.has(key))) throw new Error('扩展属性不能覆盖标准任务字段');
        Object.assign(current, data.extra);
      }
      if (data.created !== undefined) current.created = data.created;
      if (data.updated !== undefined) current.updated = data.updated;
      if (data.areaStatus !== undefined) {
        if (current.kind !== 'area') throw new Error('任务状态以复选框为准，请移除 areaStatus');
        current.status = data.areaStatus;
      }
      continue;
    }
    const attr = /^\[([^:\]]+)::\s*(.*?)\]$/.exec(body);
    if (!attr) throw new Error('无法识别节点正文；注释行请使用 > 前缀，未自动丢弃内容');
    const [, key, value] = attr;
    if (fields.has(key)) throw new Error(`节点属性重复：${key}`); fields.add(key);
    switch (key) {
      case '重要程度': {
        const rank = Object.entries(ranks).find(([, label]) => label === value)?.[0];
        if (!rank) throw new Error('重要程度必须为高、中或低'); current.importance = rank as TaskNode['importance']; break;
      }
      case '截止日期': current.deadline = value; break;
      case '计划日期': current.planned = value; break;
      case '预计工作量': current.estimate = work(value); break;
      case '实际工作量': current.actual = work(value); break;
      case '完成时间': current.completed = value; break;
      case '标签': current.tags = JSON.parse(value); break;
      case '归档上下文':
        if (meta.type !== 'batch' || value !== '是') throw new Error('归档上下文标记无效'); isContext = true; break;
      default: throw new Error(`未知任务属性：${key}；请保留原文并检查`);
    }
  }
  finish();
  const all = [...context, ...nodes];
  validate({ version: 1, revision: meta.type === 'current' ? meta.revision : meta.afterRevision, nodes: all });
  if (meta.type === 'batch') {
    if (!['archive', 'sleep'].includes(meta.kind) || !['prepared', 'committed'].includes(meta.state) ||
      typeof meta.id !== 'string' || !Number.isFinite(Date.parse(meta.time))) throw new Error('归档元数据无效');
    meta.context = context;
  }
  return { meta, nodes, preamble: source.slice(0, start), format: 2 };
}
export function boardFrom(doc: Document): Board {
  if (doc.meta.type !== 'current') throw new Error('当前文件不能是归档');
  return { version: 1, revision: doc.meta.revision, nodes: doc.nodes };
}
export function batchFrom(doc: Document): Batch {
  if (doc.meta.type !== 'batch') throw new Error('不是归档文件');
  const { type: _, ...meta } = doc.meta;
  return { ...meta, nodes: doc.nodes };
}
