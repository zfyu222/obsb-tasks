// Extracted/adapted from Enhancing Mindmap beta.41 appMouseDown/Move/Up,
// appMousewheel and selection.ts. Copyright (c) 2021 Mark; MIT, see vendor license.
import { selectionRect } from './vendor/enhancing-mindmap/selection';
export interface Camera { x: number; y: number; scale: number; initialized: boolean; }
export interface ViewportHooks {
  paint(): void;
  select(ids: string[], primary?: string): void;
  marquee(rect: ReturnType<typeof selectionRect>, additive: boolean): void;
  move(ids: string[], target: string, placement: 'child' | 'before' | 'after'): void;
  selected(): string[];
  edit(id: string): void;
}
export function zoomCamera(camera: Camera, scale: number, x: number, y: number): void {
  const next = Math.max(0.2, Math.min(3, scale));
  const worldX = (x - camera.x) / camera.scale, worldY = (y - camera.y) / camera.scale;
  camera.scale = next; camera.x = x - worldX * next; camera.y = y - worldY * next;
}
export class GraphViewport {
  panMode = false;
  private cleanup: (() => void)[] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch?: { distance: number; scale: number; worldX: number; worldY: number };
  private gesture?: { mode: 'pan' | 'select' | 'node'; x: number; y: number; left: number; top: number; moved: boolean; id: number; ids: string[]; hitId?: string; additive: boolean };
  private contextUntil = 0;
  private clickUntil = 0;
  private drop?: { id: string; placement: 'child' | 'before' | 'after' };
  private overlay: HTMLDivElement;
  constructor(private element: HTMLElement, public camera: Camera, private hooks: ViewportHooks, private readonly: boolean) {
    this.overlay = document.createElement('div'); this.overlay.className = 'obsb-map-marquee'; this.overlay.hidden = true; element.append(this.overlay);
    this.on(element, 'pointerdown', this.down);
    this.on(element.ownerDocument, 'pointermove', this.move);
    this.on(element.ownerDocument, 'pointerup', this.up);
    this.on(element.ownerDocument, 'pointercancel', this.cancel);
    this.on(element.ownerDocument.defaultView!, 'blur', this.cancel);
    this.on(element, 'contextmenu', this.context, true);
    this.on(element, 'click', this.click, true);
    this.on(element, 'dblclick', this.doubleClick, true);
    this.on(element, 'wheel', this.wheel, { passive: false });
  }
  private on(target: EventTarget, name: string, handler: EventListener, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(name, handler, options); this.cleanup.push(() => target.removeEventListener(name, handler, options));
  }
  private local(x: number, y: number): { x: number; y: number } { const r = this.element.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; }
  private down: EventListener = event => {
    const e = event as PointerEvent, target = e.target as HTMLElement;
    if (target.closest('input,textarea,select,button:not([data-map-title]),a,[contenteditable="true"]')) return;
    if (e.pointerType === 'touch') {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()], mid = this.local((a.x + b.x) / 2, (a.y + b.y) / 2);
        this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: this.camera.scale, worldX: (mid.x - this.camera.x) / this.camera.scale, worldY: (mid.y - this.camera.y) / this.camera.scale };
        this.gesture = undefined; this.element.setPointerCapture?.(e.pointerId); return;
      }
    }
    const card = target.closest<HTMLElement>('[data-node-id]'), id = card?.dataset.nodeId;
    const pan = e.button === 2 || e.button === 1 || this.panMode || e.pointerType === 'touch';
    if (!pan && e.button !== 0) return;
    if (!pan && this.readonly && !card) return;
    this.element.tabIndex = -1; this.element.focus({ preventScroll: true });
    if (e.pointerType !== 'touch') e.preventDefault();
    this.gesture = { mode: pan ? 'pan' : card ? 'node' : 'select', x: e.clientX, y: e.clientY, left: this.camera.x, top: this.camera.y,
      moved: false, id: e.pointerId, ids: id ? this.hooks.selected().includes(id) ? this.hooks.selected() : [id] : [], hitId: id, additive: e.ctrlKey || e.metaKey || e.shiftKey };
    if (pan) this.element.classList.add('is-panning');
    this.element.setPointerCapture?.(e.pointerId);
  };
  private move: EventListener = event => {
    const e = event as PointerEvent;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()], mid = this.local((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.camera.scale = Math.max(0.2, Math.min(3, this.pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.distance));
      this.camera.x = mid.x - this.pinch.worldX * this.camera.scale; this.camera.y = mid.y - this.pinch.worldY * this.camera.scale; this.hooks.paint(); return;
    }
    const g = this.gesture; if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    g.moved = true;
    if (g.mode === 'pan') { this.camera.x = g.left + dx; this.camera.y = g.top + dy; this.hooks.paint(); return; }
    if (g.mode === 'select') {
      const a = this.local(g.x, g.y), b = this.local(e.clientX, e.clientY), r = selectionRect(a.x, a.y, b.x, b.y);
      this.overlay.hidden = false; Object.assign(this.overlay.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` }); return;
    }
    if (this.readonly) return;
    this.clearDrop();
    const card = this.element.ownerDocument.elementFromPoint?.(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node-id]');
    if (card && this.element.contains(card)) {
      const rect = card.getBoundingClientRect(), ratio = (e.clientY - rect.top) / rect.height;
      const placement = !card.dataset.nodeId ? 'child' : ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child';
      this.drop = { id: card.dataset.nodeId ?? '', placement }; card.classList.add(`drop-${placement}`);
    }
    this.element.classList.add('is-node-dragging');
  };
  private up: EventListener = event => {
    const e = event as PointerEvent; this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) { this.pinch = undefined; this.gesture = undefined; this.clickUntil = Date.now() + 200; } return; }
    const g = this.gesture; if (!g || g.id !== e.pointerId) return;
    this.gesture = undefined; this.overlay.hidden = true; this.element.classList.remove('is-panning', 'is-node-dragging');
    if (g.moved) {
      this.clickUntil = Date.now() + 180;
      if (g.mode === 'pan') this.contextUntil = Date.now() + 600;
      else if (g.mode === 'select') this.hooks.marquee(selectionRect(g.x, g.y, e.clientX, e.clientY), g.additive);
      else if (this.drop && !this.readonly) this.hooks.move(g.ids, this.drop.id, this.drop.placement);
    } else if (g.mode === 'select') this.hooks.select([]);
    else if (g.hitId !== undefined && e.button !== 2 && e.button !== 1) {
      const ids = new Set(g.additive ? this.hooks.selected() : []);
      if (g.hitId) { if (ids.has(g.hitId)) ids.delete(g.hitId); else ids.add(g.hitId); }
      this.clickUntil = Date.now() + 100; this.hooks.select([...ids], g.hitId || undefined);
    }
    this.clearDrop();
  };
  private clearDrop(): void { for (const e of this.element.querySelectorAll('.drop-child,.drop-before,.drop-after')) e.classList.remove('drop-child', 'drop-before', 'drop-after'); this.drop = undefined; }
  private cancel: EventListener = () => { this.gesture = undefined; this.pinch = undefined; this.pointers.clear(); this.overlay.hidden = true; this.clearDrop(); this.element.classList.remove('is-panning', 'is-node-dragging'); };
  private context: EventListener = event => { if (this.gesture?.mode === 'pan' || Date.now() < this.contextUntil) { event.preventDefault(); event.stopImmediatePropagation(); } };
  private click: EventListener = event => { if (Date.now() < this.clickUntil) { event.preventDefault(); event.stopImmediatePropagation(); } };
  private doubleClick: EventListener = event => {
    if (this.readonly) return;
    const e = event as MouseEvent, target = e.target as HTMLElement;
    if (target.closest('input,textarea,[contenteditable="true"]')) return;
    const card = target.closest<HTMLElement>('[data-node-id]') ?? this.element.ownerDocument.elementFromPoint?.(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node-id]');
    if (!card?.dataset.nodeId || !this.element.contains(card)) return;
    e.preventDefault(); e.stopImmediatePropagation(); this.hooks.edit(card.dataset.nodeId);
  };
  private wheel: EventListener = event => {
    const e = event as WheelEvent; e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const point = this.local(e.clientX, e.clientY); zoomCamera(this.camera, this.camera.scale * Math.exp(-e.deltaY * 0.002), point.x, point.y); }
    else { const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.element.clientHeight : 1; this.camera.x -= e.deltaX * unit; this.camera.y -= e.deltaY * unit; }
    this.hooks.paint();
  };
  zoom(scale: number): void { zoomCamera(this.camera, scale, this.element.clientWidth / 2, this.element.clientHeight / 2); this.hooks.paint(); }
  destroy(): void { this.cancel(new Event('blur')); this.cleanup.forEach(fn => fn()); this.overlay.remove(); }
}
