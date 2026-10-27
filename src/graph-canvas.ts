import { GraphGeometry, GraphNode, GRAPH_ROOT } from './graph-layout';
import { Camera, GraphViewport } from './graph-viewport';
import { intersectsRect, selectionRoots, containsNode } from './vendor/enhancing-mindmap/selection';

export interface CanvasActions {
  render(card: HTMLElement, node: GraphNode): void;
  selected(): Set<string>;
  select(ids: string[], primary?: string): void;
  move(ids: string[], target: string | null, placement: 'child' | 'before' | 'after'): void;
  scaleChanged(scale: number): void;
  edit(id: string): void;
}
const NS = 'http://www.w3.org/2000/svg';
export class GraphCanvas {
  readonly viewport: HTMLElement;
  readonly gestures: GraphViewport;
  private layer: HTMLElement;
  private paths: SVGGElement;
  private mounted = new Map<string, HTMLElement>();
  private sorted: GraphNode[];
  private resize?: ResizeObserver;
  private frame = 0;
  private disposed = false;
  constructor(container: HTMLElement, public geometry: GraphGeometry, public camera: Camera, private actions: CanvasActions, readonly = false) {
    this.sorted = [...geometry.order].sort((a, b) => a.box.y - b.box.y);
    this.viewport = document.createElement('div'); this.viewport.className = 'obsb-task-viewport obsb-map-viewport';
    this.viewport.setAttribute('aria-label', '导图画布：右键拖动平移，左键框选，Ctrl 滚轮缩放'); container.append(this.viewport);
    const svg = document.createElementNS(NS, 'svg'); svg.classList.add('obsb-map-paths'); this.viewport.append(svg);
    this.paths = document.createElementNS(NS, 'g'); svg.append(this.paths);
    this.layer = document.createElement('div'); this.layer.className = 'obsb-map-world'; this.viewport.append(this.layer);
    if (!camera.initialized) {
      if (geometry.order.length > 1 && geometry.order.length <= 500) this.fit(1);
      else this.center();
    }
    this.gestures = new GraphViewport(this.viewport, camera, {
      paint: () => this.requestPaint(), selected: () => [...actions.selected()], select: (ids, primary) => actions.select(ids, primary), edit: id => actions.edit(id),
      marquee: (rect, additive) => {
        const selected = additive ? new Set(actions.selected()) : new Set<string>();
        for (const [id, card] of this.mounted) if (id !== GRAPH_ROOT && intersectsRect(rect, card.getBoundingClientRect())) selected.add(id);
        const ids = [...selected]; actions.select(ids, ids[ids.length - 1]);
      },
      move: (ids, target, placement) => {
        const rootNodes = selectionRoots(ids.map(id => this.geometry.nodes.get(id)).filter((n): n is GraphNode => !!n && n !== this.geometry.root));
        const drop = this.geometry.nodes.get(target || this.geometry.root.id);
        if (!drop || rootNodes.some(n => containsNode(n, drop))) return;
        actions.move(rootNodes.map(n => n.id), drop.task?.id ?? null, placement);
      }
    }, readonly);
    if (typeof ResizeObserver !== 'undefined') { this.resize = new ResizeObserver(() => this.requestPaint()); this.resize.observe(this.viewport); }
    this.paint();
  }
  requestPaint(): void { if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); }); }
  setGeometry(geometry: GraphGeometry): void {
    this.geometry = geometry; this.sorted = [...geometry.order].sort((a, b) => a.box.y - b.box.y); this.paint();
  }
  center(): void {
    const b = this.geometry.root.box;
    this.camera.x = (this.viewport.clientWidth || 800) / 2 - (b.x + b.width / 2) * this.camera.scale;
    this.camera.y = (this.viewport.clientHeight || 500) / 2 - (b.y + b.height / 2) * this.camera.scale;
    this.camera.initialized = true; if (this.layer) this.paint();
  }
  fit(maxScale = 1.5): void {
    const b = this.geometry.bounds, w = this.viewport.clientWidth || 800, h = this.viewport.clientHeight || 500;
    this.camera.scale = Math.max(0.2, Math.min(maxScale, (w - 100) / Math.max(1, b.width), (h - 100) / Math.max(1, b.height)));
    this.camera.x = w / 2 - (b.x + b.width / 2) * this.camera.scale;
    this.camera.y = h / 2 - (b.y + b.height / 2) * this.camera.scale;
    this.camera.initialized = true; this.paint();
  }
  reveal(id: string): void {
    const node = this.geometry.nodes.get(id); if (!node) return;
    const b = node.box, c = this.camera, w = this.viewport.clientWidth || 800, h = this.viewport.clientHeight || 500;
    if (b.x * c.scale + c.x < 20 || (b.x + b.width) * c.scale + c.x > w - 20) c.x = w / 2 - (b.x + b.width / 2) * c.scale;
    if (b.y * c.scale + c.y < 20 || (b.y + b.height) * c.scale + c.y > h - 20) c.y = h / 2 - (b.y + b.height / 2) * c.scale;
    this.paint();
  }
  paint(): void {
    if (this.disposed) return;
    const c = this.camera, transform = `translate(${c.x}px, ${c.y}px) scale(${c.scale})`;
    this.layer.style.transform = transform; this.paths.setAttribute('transform', `translate(${c.x} ${c.y}) scale(${c.scale})`);
    const top = -c.y / c.scale - 180, bottom = top + (this.viewport.clientHeight || 500) / c.scale + 360;
    const left = -c.x / c.scale - 300, right = left + (this.viewport.clientWidth || 800) / c.scale + 600;
    let low = 0, high = this.sorted.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.sorted[middle].box.y < top) low = middle + 1; else high = middle; }
    const visible = new Set<string>();
    for (let i = low; i < this.sorted.length && this.sorted[i].box.y <= bottom; i++) {
      const n = this.sorted[i], b = n.box;
      if (b.x > right || b.x + b.width < left) continue;
      visible.add(n.id);
      let card = this.mounted.get(n.id);
      if (!card) { card = document.createElement('div'); this.mounted.set(n.id, card); this.layer.append(card); this.actions.render(card, n); }
      Object.assign(card.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, '--branch-color': n.stroke || '#6585cc' });
      card.classList.toggle('is-selected', this.actions.selected().has(n.id) || !this.actions.selected().size && n === this.geometry.root);
    }
    for (const [id, card] of this.mounted) if (!visible.has(id) && (!this.geometry.nodes.has(id) || !card.contains(document.activeElement))) { card.remove(); this.mounted.delete(id); }
    this.paths.replaceChildren();
    for (const id of visible) for (const curve of this.geometry.curves.get(id) ?? []) {
      const path = document.createElementNS(NS, 'path'); path.setAttribute('d', curve.d); path.setAttribute('stroke', curve.color);
      path.setAttribute('stroke-width', String(curve.width)); path.setAttribute('fill', 'none'); path.setAttribute('stroke-linecap', 'round'); this.paths.append(path);
    }
    this.actions.scaleChanged(c.scale);
  }
  destroy(): void {
    this.disposed = true; if (this.frame) cancelAnimationFrame(this.frame); this.resize?.disconnect(); this.gestures.destroy(); this.mounted.clear();
  }
}
