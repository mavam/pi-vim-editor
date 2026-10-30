This release adds Vim's screen-row motions, so you can move through long wrapped prompt lines with gj, gk, g0, g^, and g$, and jump to the top, middle, or bottom of a scrolled prompt with H, M, and L.

## 🚀 Features

### Screen-row motions gj, gk, H, M, and L

NORMAL and Visual modes now support Vim's screen-row motions. `gj` and `gk` move down and up through the rows Pi wraps a long prompt line into, keeping the display column, and `g0`, `g^`, and `g$` go to the start, first non-blank, and last character of the current row.

`H`, `M`, and `L` jump to the top, middle, and bottom visible row of a prompt that scrolls. `{n}H` and `{n}L` count rows from the top or bottom. All of these work with operators, such as `dgj` or `dL`.

*By @mavam.*
