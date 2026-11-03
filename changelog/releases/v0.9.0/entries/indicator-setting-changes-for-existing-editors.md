---
title: Indicator setting changes for existing editors
type: bugfix
authors:
  - mavam
prs:
  - 15
created: 2026-11-03T20:36:48.498096Z
---

Changes to `vimEditor.indicator` now take effect when a session starts, even
if Pi keeps the existing editor. Previously, the label could remain in its
old corner until the editor was recreated.
