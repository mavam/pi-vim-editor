# pi-vim-editor — minimal key binding UX

Scope principle: **Vim muscle memory for fixing up a prompt**, not a text
editor. Prompts are usually 1–20 lines. Everything Pi already does stays with
Pi. When in doubt, cut.

## 1. Modes

| Mode | Entered by | Bottom-right border label |
| --- | --- | --- |
| INSERT (start mode) | Startup, after submit, `i a I A o O c…` | `INSERT`, muted |
| NORMAL | Esc / `Ctrl-[` from INSERT | `NORMAL`, accent; pending keys replace it (`2d`, `ci`, `f`) |
| REPLACE | `R` from NORMAL | `REPLACE`, accent |
| VISUAL / VISUAL LINE / VISUAL BLOCK | `v` / `V` / `Ctrl-V` from NORMAL | `VISUAL` / `VISUAL LINE` / `VISUAL BLOCK`, accent |

No reverse video. The working, compaction, and retry spinners stay in the top
border, as in stock Pi.

## 2. Esc

| Situation | Esc / `Ctrl-[` does |
| --- | --- |
| INSERT or REPLACE, autocomplete open | Close autocomplete; stay in the mode |
| INSERT or REPLACE | → NORMAL, cursor one character left |
| NORMAL, pending command | Cancel it |
| NORMAL, nothing pending | Pi's interrupt (abort the agent, double-Esc behavior) |

Esc Esc from INSERT aborts a running agent.

## 3. What stays with Pi

- **INSERT:** every key except Esc / `Ctrl-[`.
- **NORMAL:** Enter (submit), Tab, arrows, Home/End, PageUp/PageDown, all
  Ctrl/Alt keys (`Ctrl-G` external editor, `Ctrl-C`, model selection,
  extension shortcuts, …), paste, and mouse. Some of these edit text, such as
  Tab completion or `Ctrl-Y`; that's intended.
- **Prompt history:** Pi's own keys (arrows at the buffer edge, or the history
  actions if bound) in both modes.

Exceptions in NORMAL: `Ctrl-]` (Pi's jump-to-char) does nothing, `Ctrl-V`
starts Visual block mode instead of Pi's image paste (which still works in
INSERT mode), `Ctrl-R` redoes, and a Pi action bound to a bare printable key is
shadowed by Vim. A pending search owns its input instead; see **Literal prompt
search** below.

## 4. NORMAL mode (v0.1)

Counts: `{n}` works on the motions `h j k l w b e W B E f F t T ; , $ ( ) H L`,
on `/`, `?`, `n`, `N`, on
`{n}G` / `{n}gg`, `ge` / `gE`, `gj` / `gk` / `g$`, on operators (`2dd`, `3cw`, `y3j`; `2d3w`
deletes six words), on word, sentence, and paragraph objects (`2diw`, `d3aW`,
`d2as`, `d2ap`), and on `x`, `X`, `s`,
`S`, `C`, `D`, `J`, `~`, `r`, `p`, `P`, and `.`. Not on quote or bracket
objects or `%`.

### Enter INSERT

| Key | Action |
| --- | --- |
| `i` / `a` | Before / after cursor |
| `I` / `A` | First non-blank / end of line |
| `o` / `O` | Open line below / above |

### Replace mode

`R` starts REPLACE mode. Each typed character overwrites the one under the
cursor; at the end of the line, it's appended. Backspace puts back what the
last typed character overwrote; past where you started, it only moves left,
also onto the previous line. Esc returns to NORMAL. One `u` undoes the whole
session, and `.` repeats it, Backspaces included.

Keys that aren't text, such as arrows, Enter, and Pi shortcuts, go to Pi. If
one moves the cursor or edits, as do clicks and pastes, Backspace and `.`
start over from there. Backspace always restores, even if Pi binds another
key to delete backward. Overwriting a pasted block is refused, and Backspace
never restores over one.

### Motions

| Key | Motion |
| --- | --- |
| `h` `l` | Character left / right, within the line |
| `j` `k` | Line down / up; no-op at the last / first line; never history |
| `w` `b` `e` | Next word start / previous word start / word end, across lines |
| `W` `B` `E` | Same for WORDs (whitespace-delimited) |
| `ge` `gE` | Back to the end of the previous word / WORD |
| `0` `^` `$` | Line start / first non-blank / last character |
| `gj` `gk` | Screen row down / up through wrapped lines, keeping the display column; no-op at the last / first row |
| `g0` `g^` `g$` | Start / first non-blank / last character of the screen row |
| `H` `M` `L` | First non-blank of the top / middle / bottom visible row |
| `gg` `G` `{n}G` | First line / last line / line n |
| `%` | From the first bracket at or after the cursor on the line, to its partner, across lines |
| `(` `)` | Back / forward to the start of a sentence, across lines; see below |
| `{` `}` | Back / forward to an empty-line paragraph boundary; see below |
| `f{c}` `F{c}` `t{c}` `T{c}` | To / till character on the line |
| `;` `,` | Repeat the last `f F t T` / in reverse |

Paste markers (`[paste #1 +24 lines]`) count as one character.

Screen rows are the rows Pi wraps the prompt into at its current width, as
the arrow keys use them. `gj` and `gk` are exclusive and characterwise, so
`dgj` deletes up to the same column one row down; `g$` is inclusive. A
wrapped paste marker's inner rows are skipped. `{n}H` and `{n}L` go to the
nth visible row from the top or bottom, stopping at the other end; `M` takes
no count and picks the upper one of two middle rows, as Vim does. `H`, `M`,
and `L` are linewise (`dL` deletes through the bottom visible line). When
the top row continues a wrapped line, `H` lands on that row, not the line's
start. Editors without Pi's layout treat each line as one row, all visible.

A sentence ends at `.`, `!`, or `?`, followed by any number of `)`, `]`,
`"`, or `'`, and then a space, a tab, or the line end. Empty lines are
boundaries too; lines with only blanks aren't. `)` from inside a run of empty
lines goes past all of them, and `(` from a sentence start goes to the
previous one. Past the last sentence, `)` goes to the last character, and
`d)` deletes through it. A count that runs past the start or end of the
prompt does nothing, as in Vim. `(` and `)` are exclusive, so `d)` from a
sentence start deletes the sentence and the blanks after it.

Paragraph motions `{` and `}` stop on empty lines, not lines containing
spaces or tabs. A run of empty lines is one separator: `}` from text lands
on its first empty line, and `{` lands on its last. From inside a separator
run, either motion skips that run. At the prompt's edges, `{` goes to the
first character and `}` to the last; `d}` includes that last character.
Counts work in NORMAL and Visual modes (`2}`, `v2{`); operator and motion
counts multiply (`2d3}` equals `d6}`). An overshooting count does nothing,
rather than moving or editing partway.

These motions are exclusive. When the endpoint is column zero on another
line, the operator stops at the previous line's end; if the range starts
in indentation, it becomes linewise. For example, `d}` at a paragraph's
start deletes its lines but leaves the following empty separator line.
From mid-line it keeps the prefix. Visual selections keep their shape:
`v}` is characterwise and includes the destination, while `V}` is linewise.
As with other motions here, an empty yank range (for example, `y{` at the
prompt’s start) leaves the previous register unchanged, unlike Vim.

### Literal prompt search

`/text` and Enter search forward; `?text` and Enter search backward. Search
is literal and case-sensitive, **not Vim or JavaScript regex**. For example,
`/a.*` finds the characters `a.*`, not any text beginning with `a`. Backslashes
have no escape syntax: typing `\n` searches for a backslash and `n`; paste an
actual line break to search across prompt lines.

- Search starts strictly after or before the cursor and wraps around the
  prompt, with a notice. A sole match can return to the same position after
  wrapping. Overlapping matches count separately.
- `n` repeats in the last accepted direction; `N` reverses it for that move
  only. Counts choose the nth match (`2/text`, `3?text`, `4n`, `2N`) and can wrap
  more than once. Empty queries reuse the last accepted text, with `/` or `?`
  choosing the direction. An empty first query or repeat without a previous
  search only reports that there is no previous search.
- Enter accepts a query even if it has no match. A miss leaves the cursor
  unchanged and reports it. Esc discards the draft, keeping the previous
  accepted search. Search memory is per editor and resets after submit or
  editor replacement, not on ordinary edits or mode changes.
- Matches must start and end at grapheme boundaries. Search never matches
  inside or across an opaque paste marker, nor reads its hidden contents.
  It searches the prompt buffer, not the transcript. A match must start at a
  valid NORMAL cursor position (a newline only on an empty line).
- All Visual modes keep their fixed anchor and shape. Confirm moves the
  active endpoint; cancel preserves both endpoints. Search alone never
  changes text, registers, undo/redo, or the last `.` change.

The query uses the border label, without a dialog, live preview, or match
highlighting. Printable input appends to it; Backspace deletes one grapheme.
Enter confirms without submitting; Esc or `Ctrl-[` cancels without interrupting
Pi. Bracketed paste appends literal text, converting CRLF and CR to LF, and
never inserts into the prompt. Control characters appear escaped in the label.
Other keys, including arrows, Tab, and Ctrl/Alt shortcuts, are consumed without
action while the query is open. A narrow border may omit the label as usual.

External cursor or text changes cancel the query; the next input is consumed
so a pending Enter cannot accidentally submit. External text changes also end
Visual mode. Operator search (`d/text`, `c?text`, `yn`, `gqN`, and similar) isn't
supported. `/` and `?` after an operator collect and discard the query through
Enter or Esc, without editing; `n` and `N` cancel the operator with a notice.
Use Visual search followed by an operator instead; its range includes the
matched character. Regex, word-under-cursor `*`/`#`, search offsets, query
history UI, and operator search remain out of scope.

### Operators

`d` delete · `c` change (delete, then INSERT) · `y` yank · `gu` lowercase ·
`gU` uppercase · `gq` reflow · `gw` reflow and keep the cursor’s place.

| Form | Example |
| --- | --- |
| Operator + motion | `dw`, `c$`, `d2w`, `dt,`, `d)`, `y3j`, `dG` (`j k gg G` are linewise) |
| Doubled = whole line | `dd`, `cc`, `yy`, `guu`, `gUU` |
| Word / WORD object | `diw`, `caw`, `ciW`, `daW` |
| Sentence object, across lines | `dis`, `cas`, `yis`, `guas`, `gUis` |
| Paragraph object, whole lines | `dip`, `cap`, `yip`, `guap`, `gUip` |
| Quote object, same line | `ci"`, `da'`, `` ci` ``, `` da` `` |
| Bracket object, same line | `ci(`, `da[`, `yi{`; the closing bracket works too (`ci)`) |

Any operator whose range touches a paste marker is refused with a notice.

Quote objects support single quotes, double quotes, and backticks. Inner
objects keep the delimiters; around objects include them but not surrounding
whitespace. They skip backslash-escaped delimiters and look forward to the
next pair on the same line if the cursor isn't in one. Backticks use ordinary
quote pairs, not Markdown multi-backtick spans or fences.

Sentence objects use the same boundaries as `(` and `)`, but select the whole
current sentence even when the cursor is in its middle:

- `is` selects the sentence without separator whitespace. On the whitespace
  between sentences, it selects that whitespace instead.
- `as` includes trailing separator whitespace when available, otherwise leading
  whitespace. From separator whitespace, it selects that whitespace and the
  following sentence.
- Counts on `is` include whitespace as a separate step: `d2is` deletes the
  sentence and its following separator; `d3is` includes the next sentence too.
  Counts on `as` select sentences with their whitespace: `d2as` deletes two.
  Operator and object counts multiply, so `2d3as` deletes six sentences.
- Sentences can span lines and end at the prompt's end without punctuation.
  NORMAL operators use Vim's exclusive-line rules: on `One.\nTwo.`, `yis` on
  the first sentence yanks a whole line. Visual `visy` instead yanks `One.`
  characterwise, without the newline.

Paragraph objects select whole lines of prose, including indentation:

- `ip` selects the current paragraph. Empty lines and lines containing only
  spaces or tabs separate paragraphs. On a separator, `ip` selects its entire
  blank-line run. Other Unicode whitespace does not make a separator line.
- `ap` includes the entire trailing blank-line run when available; otherwise
  it includes the leading run. From a separator run, it selects that run and
  the following paragraph. On terminal blank lines with no following paragraph,
  `ap` does nothing.
- `ip` counts text and separator runs separately: `d2ip` deletes a paragraph
  and its following blanks; `d3ip` includes the next paragraph. `ap` counts
  paragraphs with separators: `d2ap` deletes two. If the counted range ends
  without trailing blanks, it takes the leading blanks instead. Operator and
  object counts multiply (`2d3ap` equals `d6ap`). With an operator, a count past
  the available runs or paragraphs does nothing instead of selecting a partial
  range.
- `cip` rewrites an instruction paragraph at column zero, without preserving
  its indentation. The deleted or yanked text is linewise; `p` puts it as whole
  lines. `cip` also works in an empty prompt; `ap` there does nothing.

These object-specific whitespace rules differ from `{` / `}` and the sentence
boundaries above. Paragraph motions and objects do not parse Markdown headings,
lists, or fences, nroff macros, or section markers (including form feeds and
braces at the start of a line). Pasted blocks stay opaque, and operators touching
one are refused.

### Manual prose reflow

Use `gwap` to hard-wrap a paragraph while keeping your place in its text;
`gqap` instead moves to the first non-blank of the last selected line, including
a trailing blank separator. `gwip` and `gqip` exclude surrounding separators.
`gw` follows the original character as lines wrap or join, not its old numeric
line and column. If whitespace under the cursor disappears at a wrap, it lands
on the preceding character. In Visual mode, it preserves the active cursor,
not the selection’s anchor.

- `gq` and `gw` accept the supported motions and text objects. They format
  whole touched lines, even for a word or sentence object or a characterwise
  or block Visual selection. Exclusive endpoints at column zero normally
  exclude that line. `gq}` and `gq)` still land on the following boundary line.
- `gqq`, `gqgq`, `gww`, and `gwgw` format the current line. Use `3gqq` or
  `3gwgw` for three lines; `gq3q` and `gw3gw` also work. As in Vim, counted
  `gww` (`3gww` or `gw3w`) is a word motion, not a line count. Operator and
  motion/object counts multiply (`2gw3ap` formats six paragraphs).
- Space/tab-only lines separate paragraphs and are retained exactly, including
  separators selected by `ap`. Each paragraph uses its first selected line’s
  indentation on all output lines. Spaces and tabs between words stay intact
  unless replaced by a line break; joining source lines inserts one space and
  removes their indentation. Trailing spaces/tabs on text lines are removed.
- Width counts terminal display columns, including indentation. Wide Unicode
  characters count twice, combining sequences stay together, and words longer
  than the width are not split. Spaces and tabs are the only word-break points;
  tabs use eight-column stops for formatting. Non-breaking spaces stay in words.
- Formatting preserves the register and clipboard, is one undo step, and
  repeats with `.`. An unchanged result creates no undo step and does not replace
  the previous repeatable change. A pasted block anywhere on a touched line
  refuses the entire operation before any edits.

The width is `vimEditor.textWidth`, a positive integer defaulting to a fixed
79 columns, independent of the viewport (§10). There is no automatic formatting
while typing, external formatter, or interpretation of Markdown, comments,
filetypes, or Vim’s `formatoptions`. In particular, list prefixes and fences
are ordinary text, not protected syntax.

### Single-key edits

| Key | Action |
| --- | --- |
| `x` / `{n}x` | Delete character(s) under cursor |
| `X` / `{n}X` | Delete character(s) before the cursor |
| `~` / `{n}~` | Toggle the case of character(s) and move right |
| `s` / `{n}s` | Substitute character(s): delete, then INSERT |
| `S` | Substitute the line (= `cc`) |
| `Y` | Yank the line (= `yy`) |
| `J` / `{n}J` | Join with the next line(s), one space between |
| `>>` / `<<` / `{n}>>` | Indent / outdent line(s) by two spaces |
| `r{c}` | Replace character |
| `D` / `C` | Delete / change to end of line |
| `p` / `P` / `{n}p` | Put after / before, `n` times; linewise text goes below / above the line |
| `u` | Undo one whole change: `ciwfoo<Esc>` or `ihello world<Esc>` is one step |
| `Ctrl-R` | Redo what `u` undid, with the cursor at the start of the change. Any edit, including typing, a paste, or a submit, forgets what can be redone |
| `.` / `{n}.` | Repeat the last change; see [Repeat](#6-repeat) |

### Quitting Pi

| Keys | Action |
| --- | --- |
| `ZZ`, `:q`, `:qa` | Quit Pi if the prompt is empty; otherwise show a notice |
| `ZQ`, `:q!`, `:qa!` | Quit Pi, dropping the prompt |

`:` shows the command in the border as you type it. Enter runs it, Backspace
edits it, and Esc cancels. Other commands report that they're not supported.

## 5. Visual mode

`v` selects characters, `V` whole lines, `Ctrl-V` a block (the same columns on
several lines). The selection runs from where you started to the cursor,
inclusive, and shows in reverse video. Every NORMAL motion moves the cursor,
with counts. Keys that stay with Pi in NORMAL mode (§3) stay with Pi here too.

| Key | Action |
| --- | --- |
| `v` / `V` / `Ctrl-V` | Switch between charwise, linewise, and block; the same key again leaves |
| `o` | Jump to the other end of the selection |
| `O` | Block: jump to the other corner on the same line; otherwise like `o` |
| `iw` `aw` `iW` `aW` `is` `as` `i"` `` i` `` `` a` `` `a(` … | Select a text object (charwise) |
| `ip` `ap` | Select or extend a paragraph object; see below |
| `d` / `x` | Delete the selection |
| `c` / `s` | Change the selection: delete, then INSERT |
| `y` | Yank the selection; also goes to the system clipboard |
| `p` / `P` | Replace the selection with the register; the replaced text goes into the register (not in block mode) |
| `r{c}` | Replace every selected character with `c` |
| `J` | Join the selected lines |
| `gq` / `gw` | Reflow whole touched lines; `gw` keeps the active cursor’s place |
| `~` / `u` / `U` | Toggle case / lowercase / uppercase the selection |
| `>` / `<` | Indent / outdent the selected lines by two spaces |
| Esc | Leave without changing anything |

Sentence objects take counts in Visual mode (`v2as`). Repeating `is` or `as`
extends an existing selection in the cursor's direction. They switch linewise
and block selections to characterwise, including when the sentence spans lines.

Paragraph objects take counts too (`v2ip`, `v2ap`). A fresh `vip` or `vap`
selects whole lines, even from a single-line character or block selection.
Repeating the object extends in the cursor’s direction: `vipip` adds the next
separator run, and `vipap` adds it and the next paragraph. Use `o` to extend
backward. Existing multiline selections retain their kind and fixed anchor;
linewise selections stay linewise. A single selected line first expands to its
whole paragraph, unless it already covers that paragraph. Counts past the
buffer boundary extend existing multiline selections as far as possible;
otherwise, an unavailable object leaves the selection unchanged.

Block mode adds:

| Key | Action |
| --- | --- |
| `$` | Extend the block to the end of every line |
| `I` | Insert before the block on every line; lines shorter than the block are skipped |
| `A` | Append after the block on every line; short lines are padded with spaces. After `$`, append at each line's end |
| `c` / `s` | Change the block: delete it, then type the new text for every line |

Text typed with block `I`, `A`, or `c` goes to the other lines when you press
Esc, and only if it's a single line. A yanked or deleted block puts back as a
block: `p` / `P` insert it column by column, starting at the cursor.

Block columns are display columns, so wide characters count twice. `u` undoes
any Visual change in one step, and `.` repeats it on a selection of the same
size.

## 6. Repeat

`.` repeats the last change: any NORMAL command that edits, a Visual change,
or a session in INSERT or REPLACE mode with what you typed in it. It's one
undo step.

- **Counts:** `{n}.` replaces the change's own count, so `d3w` then `2.` is
  `d2w`, and the next `.` keeps it. For `i`, `a`, `I`, `A`, `o`, `O`, and `R`,
  it repeats what you typed `n` times; `o` and `O` open `n` lines. Visual
  changes ignore the count, as in Vim.
- **INSERT mode:** `.` repeats what the session did where it started: the
  text left there and what Backspace or Delete removed around it, including
  text from before you started. A cursor move in INSERT mode, with arrows or
  a click, starts over from there, as in Vim, and `u` undoes the parts
  separately. `.` then repeats what you typed after the move, or before it if
  nothing followed. Pasted blocks are pasted again as new pasted blocks.
- **Visual changes** are repeated on a selection of the same size that starts
  at the cursor: as many characters on one line, as many lines ending in the
  same display column, or a block as wide and tall, even where lines are
  shorter, as in Vim. Block `I` and `A` insert on every line again.
- **`"+p`** reads the system clipboard again.

## 7. Registers and the system clipboard

One unnamed register inside the extension, plain text plus a linewise flag.
`d`, `c`, `x`, `s`, `y` write it; `p`/`P` read it. Visual block deletes and
yanks store a block. It survives submits. Pi's own kill ring (`Ctrl-K` /
`Ctrl-Y`) works independently.

Yanks (`y`, `Y`) also go to the system clipboard through Pi; deletes and
changes don't, and `p`/`P` never read it, unless you set `clipboard` (§10). To use the system clipboard
explicitly, put `"+` or `"*` in front of a command, before or after a count.
Counts on both sides multiply (`2"+3dd` deletes six lines), and repeating the
prefix (`"+"+p`) is fine.

| Keys | Action |
| --- | --- |
| `"+yy`, `"+dw`, `"+x`, `"+D`, `"+ciw` … | Yank, delete, or change, and copy to the system clipboard |
| `"+y` / `"+d` / `"+c` in Visual mode | Same for the selection |
| `"+p` / `"+P`, `"+3p` | Put the system clipboard after / before the cursor, `n` times |

`"*` is the same register as `"+`; it isn't X11's primary selection. Other
registers (`"a`, `"0`, …) aren't supported.

How `"+p` treats the clipboard:

- If it still holds our last copy, it puts with that copy's shape:
  characterwise, linewise, or block.
- Other text is characterwise, unless it ends in a line break, which makes it
  linewise, as in Vim.
- An empty clipboard puts nothing, with a notice. If the clipboard can't be
  read (no display, an SSH session), `"+p` puts our last copy with a warning,
  or does nothing if there's none. It never falls back to the unnamed
  register.
- Reading is asynchronous, so typing never waits for it. If anything changes
  the prompt, cursor, or mode before the text arrives, even if it changes
  back, nothing is put. Several `"+p` in a row put one after another, in
  order. Each put is one undo step; `.` reads the clipboard again and puts
  that.
- Line breaks become `\n` and tabs four spaces, as in Pi. A read gives up
  after two seconds or 10 MB.
- Clipboard text that contains a pasted-block marker (`[paste #1 +3 lines]`)
  is refused, since it would put that block's content.

## 8. Differences from Vim

Deliberate, to keep the scope small:

- **Counts:** `2dd` works, `d2d` doesn't. A count on an operator needs a
  motion or object that takes counts (`d3w`, `2y3j`, `2diw`, `d2as`, `d2ap`).
  Sentence and paragraph object counts multiply like other operator counts
  (`2d3as` means `d6as`, and `2d3ap` means `d6ap`).
  No counts on quote or bracket objects or `%`. `{n}dd` on the last line does nothing, as
  in Vim.
- **`.` after Pi's own editing keys:** `.` repeats what an INSERT session
  changed, not the keys. So `Ctrl-W` or `Ctrl-U` repeat as deleting the same
  number of characters, and browsing Pi's prompt history during INSERT
  repeats as typing that text.
- **`j` / `k`** keep the display column of the line you leave, without Vim's
  sticky column; `gj` / `gk` do the same within screen rows.
- **`H` / `L`** ignore `'scrolloff'`, and `{n}g0` / `{n}g^` take no count.
- **Word, quote, and bracket objects** stay on the current line; sentence
  and paragraph objects can span lines. Bracket objects need the cursor inside
  the brackets, and `a"` doesn't take the surrounding whitespace.
- **`%`** also matches brackets inside quotes.
- **Sentences:** only empty lines end paragraphs; nroff macros (`.PP`, `.SH`,
  …) from `'paragraphs'` and `'sections'` and form feeds don't, and the
  `J` flag of `'cpoptions'` (two spaces after a sentence) isn't supported.
- **Visual mode:** a charwise selection ending on a non-empty line keeps its
  newline, so `v$d` keeps it too. Selecting an empty line includes its newline.
  Block `p` / `P` do nothing. Text that changes from
  outside Vim (Pi's history, another extension, `Ctrl-H`) ends Visual mode.
- **Words and case:** CJK characters are word characters like letters; `~`,
  `gu`, and `gU` use JavaScript's Unicode case mapping.
- **Block `I`, `A`, and `c`** copy typed text to the other lines only if it's
  a single line without pasted blocks, as Vim does for single lines.
- **Pasted blocks:** `J`, `>`, and `<` keep them; other edits that touch one
  are refused.
- **Replace mode:** no counts (`3R`) or `gR`. Backspace doesn't remove a line
  break typed in Replace mode, and after an arrow key `.` repeats only what
  was typed after it, overwriting as Replace mode does.
- **Redo** only redoes what `u` undid, not Pi's own undo (`Ctrl-_`), and
  takes no count.
- **Clipboard:** `"+` and `"*` are the only named registers; `"*` isn't the
  primary selection. In Visual mode, `"+p` puts the unnamed register, like
  plain `p`.
- **Indent** is two spaces. **Clipboard** copies are best effort.

## 9. Cut from v0.1

Candidates for later, roughly by demand:

- `b`/`B` bracket aliases, multi-line bracket objects

Not planned: `jj`/`jk` escape (pi-vim #45).

Out of scope: regex and operator search, search history UI, named registers, macros,
marks, `{n}R`, `gR`, Ex commands
beyond quitting, remapping, history on `j`/`k`, `>`/`<` with
motions, a configurable indent width.

## 10. Configuration

Settings go in Pi's `settings.json` (global or project).

Set `"vimEditor": { "textWidth": 72 }` to wrap prose at 72 display columns.
The default is a fixed 79, not Vim’s window-dependent `textwidth=0` fallback.
Only positive safe integers are accepted; missing or invalid values, including
`0`, fall back to 79. Settings are read when a session starts.

To place the mode label:

```json
{ "vimEditor": { "indicator": "top-left" } }
```

`indicator` places the mode label: `bottom-right` (default), `bottom-left`,
`top-right`, or `top-left`. On the top border, the label sits next to Pi's
working indicator; when a border has no room, the label is left out.

Set `"vimEditor": { "cursorShape": true }` and `"showHardwareCursor": true`
to use steady cursor shapes: bar in INSERT, block in NORMAL and all Visual
modes, underline in REPLACE. Cursor shapes are off by default and never
change Pi's hardware-cursor visibility setting. When the hardware cursor is
hidden, Pi's software cursor stays unchanged. Visual selections remain
highlighted when the hardware cursor is shown.

The terminal and any multiplexer must support DECSCUSR. When the prompt
loses focus or Pi yields the terminal, the shape resets with DECSCUSR 0
(the terminal's default; a blinking block in xterm); the previous terminal
shape is not queried. Returning to the prompt reapplies the current mode's
shape. Shutdown and reload also reset it.

Set `"vimEditor": { "clipboard": "unnamedplus" }` to use the system
clipboard as the unnamed register, like Vim's `clipboard=unnamedplus`
(`"unnamed"` does the same): every yank, delete, and change copies to it,
and `p` / `P` in NORMAL mode put it, with counts and `.`, exactly like
`"+p` / `"+P` (§7). If the clipboard can't be read, as over SSH, `p` quietly
puts our last copy. Visual `p` keeps putting the internal register, which
holds the same text unless something outside Pi changed the clipboard.

## 11. Decisions

| Question | Decision |
| --- | --- |
| Start mode | INSERT |
| Mode after submit | INSERT, when the prompt is actually submitted (text cleared), not on every Enter |
| `j`/`k` at buffer edges | No history; line movement only |
| INSERT label | Shown, muted |
| `$` | On the last character, as in Vim |
| Undo granularity | One step per Vim change, from the command that enters INSERT to Esc. Typing in the initial INSERT mode follows Pi's steps |
| Edits across paste markers | Refused |
| Passthrough keys that edit in NORMAL | Allowed, except `Ctrl-]` |
