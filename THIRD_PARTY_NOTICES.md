# Third-party code

OBSB Tasks includes core code extracted from [zfyu222/obsidian-enhancing-mindmap](https://github.com/zfyu222/obsidian-enhancing-mindmap), based on [MarkMindCkm/obsidian-enhancing-mindmap](https://github.com/MarkMindCkm/obsidian-enhancing-mindmap).

Pinned source: tag `0.2.6-beta.41`, commit `7c39cf63e01aceb63b3e1b2f8901a1294da20ad3`.

Copyright (c) 2021 Mark. MIT license. The complete original license is retained in `src/vendor/enhancing-mindmap/LICENSE.md` and in the distributed `main.js` banner.

| Source | Use and adaptation |
| --- | --- |
| `src/mindmap/Layout.ts` | Actual two-sided/right-side balanced layout and cubic edge generation. Imports replaced by a narrow host interface and a deterministic fallback color. Recursive direction/position/move/edge walks converted to iterative walks; no-op leaf/single-sibling adjustments skipped to handle large/deep task trees. Optional task spacing is applied before the first layout pass. Summary/graft-specific calls remain dormant through the host boundary. |
| `src/mindmap/selection.ts` | Top-level selection roots, ancestor membership, selection rectangle and intersection tests. One parameter made optional for strict TypeScript checking. |
| `src/mindmap/History.ts` | Unified bounded command stacks, wrapped by asynchronous task persistence and per-node deltas. Runtime Obsidian imports removed. |
| `src/mindmap/mindmap.ts` mouse handlers | `appMouseDown/Move/Up`, `appContextMenu` and `appMousewheel` adapted into `graph-viewport.ts`: right-button panning, left marquee, drag suppression and local zoom routing. Modernized with Pointer Events, transform-based coordinates, touch/pinch, cleanup and task-specific drag/drop. |
| `styles.css` `.mm-node-bar` | Round 12px branch toggle, hover enlargement and hollow collapsed state adapted to the task canvas with semantic buttons, expanded-state accessibility and line-aligned positions. |

The rest of the fork (its plugin entry, Markdown parser, summaries, grafts, relation editor, attachment import and settings) is not bundled. The original fork is not modified and need not be installed. Task Markdown, attributes and archive transactions remain owned by the OBSB Tasks adapter.

The extracted files are pinned in this repository for reproducible builds. This is not a separately published shared npm package or automatic synchronization between the two plugins. Future updates must compare the pinned upstream commit and re-run layout, pointer, task constraint and actual bundle tests.

The MIT notice above applies to the reused portions; this document does not select a license for unrelated OBSB project code.
