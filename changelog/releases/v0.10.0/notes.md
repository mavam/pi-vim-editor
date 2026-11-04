You can now choose the cursor style for each Vim mode, such as a blinking bar in INSERT mode, by setting `vimEditor.cursorShape` to a map of named styles.

## 🚀 Features

### Per-mode cursor styles

`vimEditor.cursorShape` now also accepts a map that picks the cursor style per mode, for example a blinking cursor instead of the steady defaults:

```json
{
  "showHardwareCursor": true,
  "vimEditor": {
    "cursorShape": {
      "insert": "blinking-bar",
      "normal": "blinking-block",
      "replace": "blinking-underline"
    }
  }
}
```

The keys are `insert`, `normal`, `visual` (covering all Visual modes), and `replace`. The styles are `steady-bar`, `blinking-bar`, `steady-block`, `blinking-block`, `steady-underline`, `blinking-underline`, and `reset` for the terminal's default. Missing or invalid entries keep the default style, and `cursorShape: true` works as before.

*By @mavam.*
