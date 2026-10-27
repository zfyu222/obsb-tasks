import { Batch, Board, TaskNode, validate } from './model';

const FILE = '<!-- obsb-file ';
const NODE = '<!-- obsb-node ';
const END = '<!-- obsb-end -->';
const json = (value: unknown): string => JSON.stringify(value).replace(/-->/g, '\\u002d\\u002d>');
type Metadata = { type: 'current'; version: 1; revision: string } | ({ type: 'batch' } & Omit<Batch, 'nodes'>);
export interface Document { meta: Metadata; nodes: TaskNode[]; preamble: string; }
const preamble = (title: string): string => `---\nnightly_maintenance: skip\nobsb_tasks: 1\n---\n\n# ${title}\n\n`;
function nodeText(node: TaskNode): string {
  const { notes, ...attributes } = node;
  const title = node.title.replace(/[\\`*_{}\[\]()#+.!|<>^]/g, '\\$&');
  return `## ${title}\n\n${NODE}${json(attributes)} -->\n\n${notes}\n\n${END}\n\n^${node.id}\n`;
}
export function encodeBoard(board: Board, header = preamble('当前任务')): string {
  validate(board);
  return encode({ meta: { type: 'current', version: 1, revision: board.revision }, nodes: board.nodes, preamble: header });
}
export function encodeBatch(batch: Batch, header = preamble(batch.kind === 'sleep' ? '休眠领域' : '任务归档')): string {
  const { nodes, ...meta } = batch;
  return encode({ meta: { type: 'batch', ...meta }, nodes, preamble: header });
}
function encode(doc: Document): string {
  return `${doc.preamble}${FILE}${json(doc.meta)} -->\n\n${doc.nodes.map(nodeText).join('\n')}`;
}
export function decode(text: string): Document {
  const source = text.replace(/\r\n/g, '\n');
  const start = source.indexOf(FILE), end = source.indexOf(' -->\n', start);
  if (start < 0 || end < 0) throw new Error('不是有效的 OBSB 任务文件，请勿覆盖普通笔记');
  const meta = JSON.parse(source.slice(start + FILE.length, end)) as Metadata;
  if (meta.version !== 1 || !['current', 'batch'].includes(meta.type)) throw new Error('不支持的任务文件版本');
  const nodes: TaskNode[] = [];
  let remaining = source.slice(end + 5);
  while (remaining.trim()) {
    const match = /^\s*## ([^\n]+)\n\n<!-- obsb-node ([^\n]+) -->\n\n/.exec(remaining);
    if (!match) throw new Error('节点格式损坏或存在节点外正文，停止写入以保留内容');
    const attrs = JSON.parse(match[2]);
    // Native Markdown edits to the visible heading update the node name.
    attrs.title = match[1].replace(/\\([\\`*_{}\[\]()#+.!|<>^])/g, '$1');
    const bodyStart = match[0].length, bodyEnd = remaining.indexOf(`\n\n${END}\n\n^${attrs.id}\n`, bodyStart);
    if (bodyEnd < 0) throw new Error('节点结束标记损坏，停止写入');
    nodes.push({ ...attrs, notes: remaining.slice(bodyStart, bodyEnd) });
    remaining = remaining.slice(bodyEnd + `\n\n${END}\n\n^${attrs.id}\n`.length);
  }
  if (meta.type === 'current') validate({ version: 1, revision: meta.revision, nodes });
  else {
    if (!['archive', 'sleep'].includes(meta.kind) || !['prepared', 'committed'].includes(meta.state) ||
      typeof meta.id !== 'string' || typeof meta.afterRevision !== 'string' || !Number.isFinite(Date.parse(meta.time)) || !Array.isArray(meta.context)) throw new Error('归档元数据无效');
    // Ancestor context belongs to the archive only, never to the current board.
    const merged = new Map([...meta.context, ...nodes].map(n => [n.id, n]));
    validate({ version: 1, revision: meta.afterRevision, nodes: [...merged.values()] });
    if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('归档节点 ID 重复');
  }
  return { meta, nodes, preamble: source.slice(0, start) };
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
