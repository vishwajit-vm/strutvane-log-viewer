---
"@strutvane/logs": patch
---

A truncation marker (a record over the size cap) now always fits the cap itself: it keeps as much of the message as fits after escaping, and never splits a character. Before, control characters or multi-byte text could make the marker line several times larger than the cap. `maxRecordBytes` below 1 KB (`MIN_RECORD_BYTES`) is refused with a `RangeError`, since no marker could fit it.
