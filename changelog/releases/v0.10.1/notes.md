Visual mode now highlights selections without modifying the wrapped editor’s rendered lines. This keeps highlighting working when Pi or another editor extension freezes or caches its output.

## 🐞 Bug fixes

### Preserve read-only render output in Visual mode

Visual mode highlighting now copies the wrapped editor's rendered lines before applying reverse video instead of mutating the array in place. This preserves compatibility with Pi 1.6, where editor `render()` output may be read-only or cached across frames.

*By @mavam.*
