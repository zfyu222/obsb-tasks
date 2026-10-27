// Narrow host boundary extracted from the fork; no Obsidian/plugin dependency.
export interface Box { x: number; y: number; width: number; height: number; right?: number; bottom?: number; topDy?: number; downDy?: number; }
export interface LayoutNode {
  id: string; parent?: LayoutNode; children: LayoutNode[]; direct: string; stroke: string; isExpand: boolean;
  boundingRect?: Box | null; mindmap: LayoutHost;
  containEl: { classList: { add(...names: string[]): void; remove(...names: string[]): void; contains(name: string): boolean } };
  _barDom: { style: Record<string, string> };
  isLeaf(): boolean; isShow(): boolean; getLevel(): number; refreshBox(): void;
  getBox(): Box; getCBox(): Box; getPosition(): { x: number; y: number }; setPosition(x: number, y: number): void;
  move(dx: number, dy: number): void; getChildren(): LayoutNode[]; getShowNodeList(): LayoutNode[]; getSiblings(): LayoutNode[];
}
export interface LayoutHost {
  edgeGroup: { group(): unknown };
  traverseDF(callback: (node: LayoutNode) => void): void;
  getBoundingRect(nodes: LayoutNode[]): Box;
}
export interface HistoryCommand { execute(): boolean; undo(): void; redo(): void; }
