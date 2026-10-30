# ⌨️ pi-vim-editor

Edit prompts by sentence and paragraph, reshape blocks, and reflow prose—
without replacing your editor. pi-vim-editor adds Vim-style INSERT and NORMAL
modes by decorating the installed editor. If another extension customizes the
editor, load pi-vim-editor after it.

<table>
  <tr>
    <td width="50%"><img src="https://github.com/mavam/pi-vim-editor/raw/main/demo/vim.gif" alt="Visual block insert formats a file list, ciw fixes a typo, and a Visual selection changes the prompt before submission."></td>
    <td width="50%"><img src="https://github.com/mavam/pi-vim-editor/raw/main/demo/replace.gif" alt="Replace mode overtypes a timeout, Backspace restores a space, dot repeats the edit, undo restores the second timeout, and Ctrl-R redoes the change."></td>
  </tr>
  <tr>
    <td align="center">
      <strong>Shape prompts with Vim motions</strong><br>
      <small>Fix a typo, format a list, and rewrite a selection before submitting.</small>
    </td>
    <td align="center">
      <strong>Replace mode, undo, and redo</strong><br>
      <small>Overtype text, restore it with Backspace, repeat with <code>.</code>, and undo and redo.</small>
    </td>
  </tr>
</table>

## 🚀 Installation

```sh
pi install npm:pi-vim-editor
```

## ✨ Usage

The prompt starts in INSERT mode. Press `Esc` for NORMAL mode, where the
common Vim motions, operators, and text objects edit the prompt, and `v`, `V`,
or `Ctrl-V` start Visual mode. Press `Esc` again in NORMAL mode to interrupt
the agent, as usual. The current mode shows in a corner of the editor border.

If another extension also customizes the editor, load pi-vim-editor after
it. Extensions that draw their own editor frame can show the Vim mode
themselves; see
[docs/integration.md](https://github.com/mavam/pi-vim-editor/blob/main/docs/integration.md).

## ⌨️ Key bindings

Counts work on motions and most edits, as in `3w`, `d3w`, or `2dd`. Keys Vim
doesn't use, such as Enter, Tab, arrows, and Ctrl or Alt shortcuts, keep
doing what they do in Pi. The exceptions in NORMAL mode are `Ctrl-V`, which
starts Visual block mode instead of pasting an image, `Ctrl-R`, which redoes,
and `Ctrl-]`. While a search query is open, its keys stay with search instead
of Pi (see **Literal prompt search**).

**Modes and Esc**

| Key | Action |
| --- | --- |
| `Esc` / `Ctrl-[` | INSERT or REPLACE → NORMAL; closes autocomplete first if it's open |
| `Esc` in NORMAL | Cancels a pending command, otherwise interrupts the agent as usual |
| `i` `a` / `I` `A` | INSERT before / after the cursor, at the first non-blank / line end |
| `o` / `O` | Open a line below / above |
| `R` | REPLACE: typed characters overwrite; Backspace restores |
| `v` / `V` / `Ctrl-V` | Visual, Visual line, Visual block |

After you submit a prompt, the editor is back in INSERT mode.

**Motions**

| Key | Motion |
| --- | --- |
| `h` `j` `k` `l` | Left, down, up, right |
| `w` `b` `e` / `W` `B` `E` | Word / WORD start, back, end |
| `ge` / `gE` | Back to the end of the previous word / WORD |
| `0` `^` `$` | Line start, first non-blank, last character |
| `gj` / `gk` | Down / up one screen row through wrapped lines |
| `g0` `g^` `g$` | Screen row start, first non-blank, last character |
| `H` / `M` / `L` | Top, middle, bottom visible row |
| `gg` / `G` / `{n}G` | First line, last line, line n |
| `f` `F` `t` `T` + char | To / till a character on the line |
| `;` / `,` | Repeat the last `f F t T` / in reverse |
| `%` | Jump to the matching bracket |
| `(` / `)` | Back / forward to a sentence start |
| `{` / `}` | Back / forward to an empty-line paragraph boundary |

Use `2}` to move forward two paragraph boundaries or `d}` to delete up to the
next boundary. Only empty lines separate paragraphs for these motions;
space/tab-only lines do not. Consecutive empty lines form one separator run.
These motions do not recognize Markdown, nroff macros, or section markers.

**Literal prompt search**

In NORMAL or Visual mode, type `/text` and press Enter to search forward, or
`?text` to search backward. Search is **literal and case-sensitive**, not Vim
or JavaScript regex: `.*`, brackets, and backslashes match themselves. It
searches only the prompt, never the transcript or pasted-block contents or
markers. Matches respect grapheme boundaries.

Use `n` to repeat in the accepted direction and `N` in reverse; `N` doesn't
change the direction of later `n`. Counts work (`2/text`, `3n`). Search wraps
with a notice. Enter on an empty query reuses the last accepted text in the
chosen `/` or `?` direction. No match leaves the cursor in place with a notice.

The border shows the query. Backspace deletes its last grapheme; Esc or
`Ctrl-[` cancels without moving. Enter confirms, **never submits**. Paste adds
to the query, including line breaks; other shortcuts and navigation keys are
ignored until you confirm or cancel. External cursor or text changes cancel
the query. Search memory is private to each editor and resets after submit.

Operator search (`d/text`, `cn`, and similar) isn't supported: it cancels
without editing. Instead, use `v/text`, Enter, then `d`, `c`, or `y` to act on
the inclusive selection. There is no regex, query history UI, or live preview.

**Operators and text objects**

`d` deletes, `c` changes, `y` yanks, `gu` lowercases, and `gU` uppercases.
`gq` and `gw` reflow prose into hard-wrapped lines.
Combine them with a motion (`dw`, `c$`, `y3j`, `d%`, `d)`, `d}`), double them for whole
lines (`dd`, `cc`, `yy`, `guu`, `gUU`), or use a text object:

| Object | Inner / around |
| --- | --- |
| word / WORD | `iw` `aw` / `iW` `aW` |
| sentence | `is` `as` |
| paragraph (whole lines) | `ip` `ap` |
| quotes | `i"` `a"`, `i'` `a'`, `` i` `` `` a` `` |
| brackets | `i(` `a(`, `i[` `a[`, `i{` `a{` (closing brackets work too) |

Sentence objects can span lines: `cis` changes the whole current sentence,
even from its middle, and `das` also takes adjacent separator whitespace.
Use `d2as` for two sentences. Quote and bracket objects stay on the current line.
With the cursor inside `` `src/old.ts` ``, type `` ci` `` to replace the path
while keeping the backticks.

Use `cip` to rewrite an instruction paragraph, `dap` to delete it with adjacent
blank lines, or `yip` to copy its whole lines. Empty and space/tab-only lines
separate paragraphs. `ap` prefers trailing blank lines, falling back to leading
ones at the prompt’s end; `d2ap` deletes two paragraphs. These are prose objects,
not Markdown heading, list, or fence objects.

**Manual prose reflow**

Use `gwap` to wrap the current paragraph and keep your place in the text, or
`gqap` to wrap it and move to its end. Both retain blank paragraph separators;
`gwip` and `gqip` leave those separators outside the formatting range.
`gqq` and `gww` format the current line; `3gqq` and `3gwgw` format three lines.
You can also use motions (`gq}`, `gwj`) or format a Visual selection with `gq`
or `gw`. Formatting always covers whole touched lines, preserves the register,
and supports one-step `u` and `.` repeat.

The default width is a fixed **79 display columns**, configurable with
`vimEditor.textWidth`. Wrapping keeps the first line’s indentation, leaves
long words intact, and refuses ranges containing pasted blocks. It only runs
when requested: there is no automatic formatting while typing and no Markdown,
comment, or filetype parsing.

**Edits, undo, and repeat**

| Key | Action |
| --- | --- |
| `x` / `X` | Delete the character under / before the cursor |
| `s` / `S` | Substitute a character / the line |
| `r` + char | Replace the character under the cursor |
| `~` | Toggle case and move right |
| `D` / `C` / `Y` | Delete / change to the line end, yank the line |
| `J` | Join with the next line |
| `>>` / `<<` | Indent / outdent by two spaces |
| `p` / `P` | Put after / before the cursor |
| `u` | Undo a whole change, such as `ciwfoo<Esc>` |
| `Ctrl-R` | Redo what `u` undid |
| `.` / `{n}.` | Repeat the last change, including Visual changes and typed text |

Deletes, changes, and yanks share one register. Yanks also go to the system
clipboard. Prefix a command with `"+` or `"*` to use the system clipboard
explicitly: `"+dd` cuts a line to it, and `"+p` puts it. Edits that would cut
into a pasted block (`[paste #1 +24 lines]`) are refused.

**Visual modes**

Motions and text objects (`viw`, `vi(`, `vis`, `v2as`, `vip`, `v2ap`) extend the
selection. `vip` and `vap` start whole-line paragraph selections.

| Key | Action |
| --- | --- |
| `o` / `O` | Jump to the other end / the other corner of a block |
| `d` `x` / `c` `s` / `y` | Delete / change / yank the selection |
| `p` | Replace the selection with the register (not in a block) |
| `r` + char | Replace every selected character |
| `~` / `u` / `U` | Toggle case, lowercase, uppercase |
| `J` / `>` / `<` | Join, indent, outdent the selected lines |
| `gq` / `gw` | Reflow whole selected lines; `gw` keeps the active cursor’s place in the text |
| `$` | Block: extend to the end of every line |
| `I` / `A` | Block: insert / append on every line |

**Quitting Pi**

| Keys | Action |
| --- | --- |
| `ZZ`, `:q`, `:qa` | Quit if the prompt is empty |
| `ZQ`, `:q!`, `:qa!` | Quit, dropping the prompt |

The full spec, including where it differs from Vim, is in
[docs/ux.md](https://github.com/mavam/pi-vim-editor/blob/main/docs/ux.md).

## 🆚 Comparison

How pi-vim-editor compares with other Vim extensions for Pi, based on their
documented features. This table describes current `main`; the published npm
release may not yet include its latest features.

| | **pi‑vim‑editor** | [pi‑vim](https://www.npmjs.com/package/pi-vim) | [pi‑command‑deck](https://www.npmjs.com/package/@ian-pascoe/pi-command-deck) | [pi‑vim‑keys](https://www.npmjs.com/package/@0xkahi/pi-vim-keys) | [pixit](https://www.npmjs.com/package/@sentomk/pixit) | [pi‑vimmode](https://www.npmjs.com/package/pi-vimmode) |
| --- | --- | --- | --- | --- | --- | --- |
| Editor integration | Wraps the installed editor | Replaces it | Replaces it | Replaces it | Replaces it | Replaces it |
| Visual modes | `v` `V` `Ctrl-V` | `v` `V` | `v` `V` | `v` `V` | ❌ | `v` `V`; block configurable |
| Operators | `d` `c` `y` `gu` `gU` | `d` `c` `y` | `d` `c` `y` `gu` `gU` `g~` | limited | `d` `c` `y` | `d` `c` `y` `gu` `gU` `g~` |
| Text objects | word, sentence, paragraph, quotes, brackets | word, quotes, brackets | word, paragraph | ❌ | word | word, quotes, brackets, paragraphs, Markdown, tags, error blocks |
| Paragraph motions | Navigation and operators | Navigation only | Navigation and operators | not documented | not documented | Navigation and operators |
| Prose reflow | `gq` / `gw` operators | not documented | not documented | not documented | not documented | `:reflow`; `gq` line action |
| Counts | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| `.` repeat | ✅ | ✅ | ✅ | ❌ | ❌ | ⚠️ limited |
| Redo | `Ctrl-R` | `Ctrl-R` | `Ctrl-R` | `U` | `Ctrl-R` | `Ctrl-R` |
| Replace mode `R` | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Search `/` `?` `n` | Literal, case-sensitive; also `N` | ❌ | ✅ | ❌ | ❌ | ✅ |
| Macros, named registers | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| System clipboard | both ways | both ways | yanks | ❌ | ❌ | both ways |
| Ex commands | `:q` | Pi commands | Pi commands | ❌ | ❌ | Pi commands, editing |
| Cursor shape per mode | ✅ opt-in¹ | ✅ | ✅ | ✅ | ❌ | ✅ |

¹ Requires Pi's hardware cursor and a terminal that supports cursor shapes.

## ⚙️ Configuration

Set the manual prose wrapping width in Pi’s `settings.json`:

```json
{ "vimEditor": { "textWidth": 72 } }
```

`textWidth` accepts a positive integer in display columns. Missing or invalid
values (including `0`) use **79**, regardless of terminal or editor width.
This is a fixed default, not Vim’s window-dependent `textwidth=0` fallback.

To make plain `p` paste the system clipboard, and every delete and change
copy to it, as with Vim's `clipboard=unnamedplus`:

```json
{ "vimEditor": { "clipboard": "unnamedplus" } }
```

Move the mode label to another corner in Pi's `settings.json`:

```json
{ "vimEditor": { "indicator": "top-left" } }
```

Choose `bottom-right` (default), `bottom-left`, `top-right`, or `top-left`.

To also show the mode through the cursor shape, enable both settings:

```json
{
  "showHardwareCursor": true,
  "vimEditor": { "cursorShape": true }
}
```

`cursorShape` defaults to `false`. When enabled, INSERT uses a steady bar,
NORMAL and Visual modes a steady block, and REPLACE a steady underline. Pi
still controls cursor visibility; with its hardware cursor hidden, the
software cursor stays unchanged.

Cursor shapes require DECSCUSR support in your terminal and, if used, tmux
or another multiplexer. Disable `cursorShape` if your terminal ignores the
sequences. The extension resets the shape with DECSCUSR 0, the terminal's
default (a blinking block in xterm), when the prompt loses focus, Pi opens an external editor or suspends,
or the extension shuts down or reloads. It does not query or restore your
pre-Pi cursor shape.

## 📄 License

[MIT](https://github.com/mavam/pi-vim-editor/blob/main/LICENSE)
