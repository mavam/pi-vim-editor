---
title: Optional Vim border label
type: feature
authors:
  - mavam
prs:
  - 15
created: 2026-11-03T20:38:31.793945Z
---

You can now hide the Vim border label when another extension draws the editor
frame. Set `vimEditor.indicator` to `none` in Pi's settings:

```json
{ "vimEditor": { "indicator": "none" } }
```

Vim editing, Visual highlighting, and cursor shapes keep working. Mode,
pending-command, and search-query feedback remains available to extensions
through the status capability, but is hidden unless another extension displays
it.
