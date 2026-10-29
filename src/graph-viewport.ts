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
  dragRoots?(ids: string[]): string[];
  dropError?(ids: string[], target: string, placement: 'child' | 'before' | 'after'): string | undefined;
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
  private preview: HTMLDivElement;
  private indicator: HTMLDivElement;
  private dragStatus: HTMLDivElement;
  private dragOffset = { x: 0, y: 0 };
  constructor(private element: HTMLElement, public camera: Camera, private hooks: ViewportHooks, private readonly: boolean) {
    this.overlay = document.createElement('div'); this.overlay.className = 'obsb-map-marquee'; this.overlay.hidden = true; element.append(this.overlay);
    this.preview = document.createElement('div'); this.preview.className = 'obsb-map-drag-preview'; this.preview.hidden = true; this.preview.setAttribute('aria-hidden', 'true'); element.append(this.preview);
    this.indicator = document.createElement('div'); this.indicator.className = 'obsb-map-drop-indicator'; this.indicator.hidden = true; element.append(this.indicator);
    this.dragStatus = document.createElement('div'); this.dragStatus.className = 'obsb-map-drag-status'; this.dragStatus.hidden = true;
    this.dragStatus.setAttribute('role', 'status'); this.dragStatus.setAttribute('aria-live', 'polite'); element.append(this.dragStatus);
    this.on(element, 'pointerdown', this.down);
    this.on(element.ownerDocument, 'pointermove', this.move);
    this.on(element.ownerDocument, 'pointerup', this.up);
    this.on(element.ownerDocument, 'pointercancel', this.cancel);
    this.on(element, 'lostpointercapture', event => { if (this.gesture?.id === (event as PointerEvent).pointerId) this.cancel(event); });
    this.on(element.ownerDocument.defaultView!, 'blur', this.cancel);
    this.on(element, 'contextmenu', this.context, true);
    this.on(element, 'click', this.click, true);
    this.on(element, 'dblclick', this.doubleClick, true);
    this.on(element, 'wheel', this.wheel, { passive: false });
    this.on(element.ownerDocument, 'keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape' && this.gesture) { event.preventDefault(); event.stopPropagation(); this.clickUntil = Date.now() + 180; this.cancel(event); }
    }, true);
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
    if (card) { const rect = card.getBoundingClientRect(); this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top }; }
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
    const starting = !g.moved; g.moved = true;
    if (g.mode === 'pan') { this.camera.x = g.left + dx; this.camera.y = g.top + dy; this.hooks.paint(); return; }
    if (g.mode === 'select') {
      const a = this.local(g.x, g.y), b = this.local(e.clientX, e.clientY), r = selectionRect(a.x, a.y, b.x, b.y);
      this.overlay.hidden = false; Object.assign(this.overlay.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` }); return;
    }
    if (this.readonly) return;
    if (starting) { g.ids = this.hooks.dragRoots?.(g.ids) ?? g.ids; this.startPreview(g.ids, g.hitId); }
    const point = this.local(e.clientX, e.clientY);
    Object.assign(this.preview.style, { left: `${point.x - this.dragOffset.x}px`, top: `${point.y - this.dragOffset.y - 26}px`, transform: `scale(${this.camera.scale})` });
    this.updateDrop(e.clientX, e.clientY, g.ids);
    this.element.classList.add('is-node-dragging');
  };
  private startPreview(ids: string[], primary?: string): void {
    this.preview.replaceChildren();
    const cards = new Map(Array.from(this.element.querySelectorAll<HTMLElement>('[data-node-id]'), card => [card.dataset.nodeId!, card]));
    const ordered = primary && ids.includes(primary) ? [primary, ...ids.filter(id => id !== primary)] : ids;
    for (const id of ordered.slice(0, 5)) {
      const source = cards.get(id); if (!source) continue;
      const item = source.cloneNode(true) as HTMLElement;
      item.removeAttribute('data-node-id'); item.removeAttribute('id'); item.removeAttribute('title'); item.classList.remove('is-selected');
      for (const fold of item.querySelectorAll('.obsb-map-fold')) fold.remove();
      for (const input of item.querySelectorAll('input')) input.replaceWith(document.createTextNode(input.value));
      for (const control of item.querySelectorAll<HTMLElement>('button,[tabindex]')) control.tabIndex = -1;
      Object.assign(item.style, { position: 'relative', left: '0', top: '0', margin: '0 0 4px 0' }); this.preview.append(item);
    }
    if (ids.length > 1) { const count = document.createElement('div'); count.className = 'obsb-map-drag-count'; count.textContent = `移动 ${ids.length} 个分支（包含子任务）`; this.preview.append(count); }
    for (const id of ids) cards.get(id)?.classList.add('is-drag-source');
    this.preview.hidden = !this.preview.childElementCount;
  }
  private updateDrop(x: number, y: number, ids: string[]): void {
    this.clearDrop();
    const viewport = this.element.getBoundingClientRect(), point = this.local(x, y);
    this.dragStatus.hidden = false;
    Object.assign(this.dragStatus.style, { left: `${Math.max(4, Math.min(point.x + 16, (this.element.clientWidth || 800) - 245))}px`, top: `${Math.max(4, Math.min(point.y + 24, (this.element.clientHeight || 500) - 74))}px` });
    const outside = viewport.width > 0 && viewport.height > 0 && (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom);
    let card = outside ? undefined : this.element.ownerDocument.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-node-id]');
    if (card && !this.element.contains(card)) card = undefined;
    if (!outside && !card) {
      let distance = Infinity;
      for (const candidate of this.element.querySelectorAll<HTMLElement>('[data-node-id]')) {
        const rect = candidate.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const dx = Math.max(rect.left - x, 0, x - rect.right), dy = Math.max(rect.top - y, 0, y - rect.bottom);
        if (dx <= 18 && dy <= 12 && dx + dy < distance) { card = candidate; distance = dx + dy; }
      }
    }
    let error = ids.length ? '' : '中心节点不能移动';
    if (card && !error) {
      const rect = card.getBoundingClientRect(), ratio = (y - rect.top) / rect.height;
      const placement = !card.dataset.nodeId ? 'child' : ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child';
      error = this.hooks.dropError?.(ids, card.dataset.nodeId ?? '', placement) ?? (ids.includes(card.dataset.nodeId ?? '') ? '不能移到自身' : '');
      if (!error) {
        this.drop = { id: card.dataset.nodeId ?? '', placement }; card.classList.add(`drop-${placement}`);
        const name = (card.querySelector('[data-map-title]')?.textContent ?? card.dataset.nodeId ?? 'root').slice(0, 40);
        this.dragStatus.textContent = placement === 'child' ? `放入「${name}」作为子节点` : `放在「${name}」${placement === 'before' ? '之前 ↑' : '之后 ↓'}`;
        this.indicator.hidden = false; this.indicator.dataset.placement = placement;
        Object.assign(this.indicator.style, { left: `${rect.left - viewport.left - 2}px`, top: `${(placement === 'child' ? rect.top - 2 : placement === 'before' ? rect.top - 3 : rect.bottom + 2) - viewport.top}px`,
          width: `${rect.width + 4}px`, height: `${placement === 'child' ? rect.height + 4 : 2}px` });
      } else card.classList.add('drop-invalid');
    }
    if (!this.drop) this.dragStatus.textContent = error || (outside ? '已离开画布，松手取消移动' : '拖到目标节点：中间放入，上下插入同级');
    this.dragStatus.classList.toggle('is-invalid', !!error); this.element.classList.toggle('is-drop-invalid', !!error);
  }
  private up: EventListener = event => {
    const e = event as PointerEvent; this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) { this.pinch = undefined; this.gesture = undefined; this.clickUntil = Date.now() + 200; } return; }
    const g = this.gesture; if (!g || g.id !== e.pointerId) return;
    if (g.moved && g.mode === 'node' && !this.readonly) this.updateDrop(e.clientX, e.clientY, g.ids);
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
    this.clearDrag(); if (this.element.hasPointerCapture?.(e.pointerId)) this.element.releasePointerCapture(e.pointerId);
  };
  private clearDrop(): void { for (const e of this.element.querySelectorAll('.drop-child,.drop-before,.drop-after,.drop-invalid')) e.classList.remove('drop-child', 'drop-before', 'drop-after', 'drop-invalid'); this.drop = undefined; this.indicator.hidden = true; }
  private clearDrag(): void { this.clearDrop(); this.preview.hidden = this.dragStatus.hidden = true; this.preview.replaceChildren(); for (const card of this.element.querySelectorAll('.is-drag-source')) card.classList.remove('is-drag-source'); this.element.classList.remove('is-node-dragging', 'is-drop-invalid'); }
  private cancel: EventListener = () => { const id = this.gesture?.id; this.gesture = undefined; this.pinch = undefined; this.pointers.clear(); this.overlay.hidden = true; this.clearDrag(); this.element.classList.remove('is-panning'); if (id !== undefined && this.element.hasPointerCapture?.(id)) this.element.releasePointerCapture(id); };
  private context: EventListener = event => { if (this.gesture?.mode === 'pan' || Date.now() < this.contextUntil) { event.preventDefault(); event.stopImmediatePropagation(); } };
  private click: EventListener = event => { if (Date.now() < this.clickUntil) { event.preventDefault(); event.stopImmediatePropagation(); } };
  private doubleClick: EventListener = event => {
    if (this.readonly) return;
    const e = event as MouseEvent, target = e.target as HTMLElement;
    if (target.closest('input,textarea,button:not([data-map-title]),[contenteditable="true"]')) return;
    const card = target.closest<HTMLElement>('[data-node-id]') ?? this.element.ownerDocument.elementFromPoint?.(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node-id]');
    if (!card?.dataset.nodeId || !this.element.contains(card)) return;
    e.preventDefault(); e.stopImmediatePropagation(); this.hooks.edit(card.dataset.nodeId);
  };
  private wheel: EventListener = event => {
    const e = event as WheelEvent; e.preventDefault();
    if (this.gesture?.mode === 'node' && this.gesture.moved) return;
    if (e.ctrlKey || e.metaKey) { const point = this.local(e.clientX, e.clientY); zoomCamera(this.camera, this.camera.scale * Math.exp(-e.deltaY * 0.002), point.x, point.y); }
    else { const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.element.clientHeight : 1; this.camera.x -= e.deltaX * unit; this.camera.y -= e.deltaY * unit; }
    this.hooks.paint();
  };
  zoom(scale: number): void { zoomCamera(this.camera, scale, this.element.clientWidth / 2, this.element.clientHeight / 2); this.hooks.paint(); }
  destroy(): void { this.cancel(new Event('blur')); this.cleanup.forEach(fn => fn()); this.overlay.remove(); this.preview.remove(); this.indicator.remove(); this.dragStatus.remove(); }
}
