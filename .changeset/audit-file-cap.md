---
"@strutvane/logs": patch
---

No log file grows past `LOG_MAX_FILE_SIZE` any more. A write batch (up to 256 KB) used to be written whole, so a small cap such as `16kb` produced files several times its size, and a restart resumed a nearly full part and overran it. A batch now fills the current part and continues in the next one, cut only between lines.
