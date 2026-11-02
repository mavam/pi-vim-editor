---
title: No lost text after the hardware cursor
type: bugfix
authors:
  - marcomayer
created: 2026-11-02T12:00:00.000000Z
---

With `vimEditor.cursorShape` and Pi's `showHardwareCursor` enabled, the prompt
no longer hides the text to the right of the cursor. Previously, moving the
cursor left of the line end blanked the rest of the line in terminals that end
APC sequences only with `ESC \`, not `BEL`.
