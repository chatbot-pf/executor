---
"executor": patch
---

Google media downloads (Drive file contents, exports, and other binary
endpoints) are now returned as binary responses instead of being decoded as
text, so files come back intact. Emit them with `emit(result.data)`.
