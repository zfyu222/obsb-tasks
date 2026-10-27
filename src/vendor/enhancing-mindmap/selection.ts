// Extracted from zfyu222/obsidian-enhancing-mindmap, 0.2.6-beta.41 (7c39cf6).
// Copyright (c) 2021 Mark. MIT; see LICENSE.md in this directory.
// Selected descendants are already covered by their selected ancestor's subtree.
export function selectionRoots<T extends { parent?: T }>(nodes: T[]): T[] {
    const selected = new Set(nodes);
    return Array.from(selected).filter(node => {
        let parent = node.parent;
        while (parent) {
            if (selected.has(parent)) return false;
            parent = parent.parent;
        }
        return true;
    });
}

export function containsNode<T extends { parent?: T }>(root: T, node: T | undefined): boolean {
    while (node) {
        if (node === root) return true;
        node = node.parent;
    }
    return false;
}

export function selectionRect(x1: number, y1: number, x2: number, y2: number) {
    return { left: Math.min(x1, x2), top: Math.min(y1, y2),
        right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}

export function intersectsRect(a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number; width: number; height: number }): boolean {
    return b.width > 0 && b.height > 0 && a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}
