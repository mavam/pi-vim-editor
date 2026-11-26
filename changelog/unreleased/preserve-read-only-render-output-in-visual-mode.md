---
title: Preserve read-only render output in Visual mode
type: bugfix
authors:
  - mavam
created: 2026-11-26T07:29:44.400258Z
---

Visual mode highlighting now copies the wrapped editor's rendered lines before applying reverse video instead of mutating the array in place. This preserves compatibility with Pi 1.6, where editor `render()` output may be read-only or cached across frames.
