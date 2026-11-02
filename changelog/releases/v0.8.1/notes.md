This release fixes a display issue that could hide prompt text after the hardware cursor. Text to the right of the cursor now remains visible when Vim cursor shapes are enabled.

## 🐞 Bug fixes

### No lost text after the hardware cursor

With `vimEditor.cursorShape` and Pi's `showHardwareCursor` enabled, the prompt no longer hides the text to the right of the cursor. Previously, moving the cursor left of the line end blanked the rest of the line in terminals that end APC sequences only with `ESC \`, not `BEL`.

*By @marcomayer.*
