You can now hide the Vim mode label with `vimEditor.indicator: "none"`, letting extensions that draw their own editor frame show the mode themselves. Indicator setting changes also apply to editors that are already open.

## 🚀 Features

### Optional Vim border label

You can now hide the Vim border label when another extension draws the editor frame. Set `vimEditor.indicator` to `none` in Pi's settings:

```json
{ "vimEditor": { "indicator": "none" } }
```

Vim editing, Visual highlighting, and cursor shapes keep working. Mode, pending-command, and search-query feedback remains available to extensions through the status capability, but is hidden unless another extension displays it.

*By @mavam in #15.*

## 🐞 Bug fixes

### Indicator setting changes for existing editors

Changes to `vimEditor.indicator` now take effect when a session starts, even if Pi keeps the existing editor. Previously, the label could remain in its old corner until the editor was recreated.

*By @mavam in #15.*
