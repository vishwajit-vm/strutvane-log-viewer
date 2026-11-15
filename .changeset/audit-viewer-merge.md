---
"@strutvane/logs": patch
---

The viewer's record pages merge the per-process files by timestamp (ADR-0022 §6): records from the main process and every worker are interleaved in time order, newest first, instead of one process after another. Paging stays exact for any page size and scan budget, and records written after a page was read never slip into older pages. The cursor format changed (it is opaque; old cursors are rejected with 400). `FileLine` gains `end`, the byte offset of the line's newline.
