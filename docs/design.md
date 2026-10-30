# pi-vim-editor — architecture design

Status: draft, revised after review · Target host: the latest Pi release (≥ 1.4.0) ·
License: MIT

## 1. Goals and non-goals

**Goals**

1. Add modal Vim editing to Pi's prompt editor by **decorating the editor that
   the active factory produces**, instead of shipping a replacement editor
   class. Pi's default editor, or another extension's editor, keeps its
   rendering, callbacks, autocomplete, paste handling, mouse handling, history,
   and inline working indicator.
2. Track Pi `main` with the smallest possible host coupling. All access to
   editor internals lives in one module, checked at attach time, and fails
   closed.
3. Ship the smallest key surface that makes NORMAL mode useful
   (see [`ux.md`](ux.md)). When in doubt, cut.

**Non-goals (v0.1)**

Macros, regex and operator search, search history UI, registers beyond the unnamed one and the clipboard,
Ex commands beyond quitting, automatic formatting, filetype-aware formatting,
remapping, a
`/vim` command, and decorating overlay editors that other extensions create.
Disable the extension with `pi config` or by uninstalling it.

## 2. Why not pi-vim or the other Vim packages

From auditing `lajarre/pi-vim` v0.14.2 and four alternatives
(`@thazhemadam/pi-vim`, `@0xkahi/pi-vim-keys`, `@burneikis/pi-vim`,
`xz-pi-vim`):

| Problem | Evidence | Consequence |
| --- | --- | --- |
| All **replace** the editor with a `CustomEditor` subclass | pi-vim `index.ts:4180–4238`; same in all four alternatives | Last loader wins; other editor extensions silently disappear |
| None pass `embedWorkingStatus: true` | pi-vim `index.ts:348–365` | Working, compaction, and retry spinners fall out of the border (Pi #8799) |
| Private-state mutation scattered through the editor | pi-vim `index.ts:230–239` (`state`, `undoStack`, `historyIndex`, …) | Breaks with `pi-tui` editor churn |
| Synthetic key injection for edits | pi-vim `index.ts:1349–1365` | Remapped or unbound keys break Vim commands (pi-vim PR #54) |
| Monolith | `index.ts` 4,240 LOC; one 9,802-LOC test file | Hard to keep current; fixes stall upstream |
| Composition branch keeps two editors in sync | `origin/feat/composable-editor--hardened`, ~25 commits | Never merged |

pi-vim's pure helpers (`motions.ts`, `text-objects.ts`) are MIT. Port pieces
with attribution where they fit. `@thazhemadam/*` is LGPL: ideas only.

## 3. Composition model

### 3.1 Factory composition, then instance decoration

`ctx.ui.getEditorComponent()` returns a **factory**, not the live editor. We
install a factory that calls the previous one (or builds Pi's default) and
decorates the result:

```ts
pi.on("session_start", (_event, ctx) => {
  if (ctx.mode !== "tui") return;
  const previous = ctx.ui.getEditorComponent();
  if (isOurs(previous)) return;
  ctx.ui.setEditorComponent(
    tagOurs((tui, theme, kb) => {
      const editor =
        previous?.(tui, theme, kb) ??
        new CustomEditor(tui, theme, kb, { embedWorkingStatus: true });
      attach(editor, kb);
      return editor;
    }),
  );
});
```

The host behavior after our factory returns (`interactive-mode.ts:2875–2949`)
is an exact contract, not "free inheritance":

| Host step | Effect on us |
| --- | --- |
| Saves `getText()` of the old editor, calls `setText()` on the new one | Cursor, undo, history, and paste registry of the old editor are **lost**. Paste markers become literal text. This hits every editor extension; it's harmless at `session_start` with an empty prompt. Upstream ask #2. |
| **Replaces** `onSubmit`/`onChange` with the default editor's | Never wrap these; neither can an inner factory. |
| Copies border color, padding, autocomplete, and `actionHandlers` when present | Fine; we don't touch them. |
| Injects the working indicator only if `embedWorkingStatus === true` | True for Pi's default. Another extension's editor keeps its own choice; we don't force it. |

Calling `setEditorComponent` only happens at `session_start`. `/reload` clears
the factory (`interactive-mode.ts:2452–2470`) and re-runs `session_start`, so
reload safety comes from the host; `isOurs()` only prevents stacking when
`session_start` fires again without a reset.

### 3.2 What `attach()` patches

Four members on the **instance**, each delegating to the value it replaced
(whatever an inner factory may already have patched):

| Member | Why it works |
| --- | --- |
| `handleInput(data)` | The TUI dispatches to the focused component's current `handleInput` (`tui.ts:1120–1130`); host paste goes through it too (`interactive-mode.ts:2655`). |
| `renderTopBorder(width, hidden)`, `renderBottomBorder(width, hidden)` | `Editor.render()` calls both through `this` (`editor.ts:564`, `616`). One of them carries the mode label (§7); the other passes through. |
| `render(width)` | Applies opt-in cursor shapes (§7), then reverse-videos the selection in Visual mode (§6.1). Otherwise returns the original rows unchanged. |

The read-only status capability (§7.1) is stored under
`Symbol.for("pi-vim-editor")`; a second `attach()` on the same instance is a
no-op. There's no `detach()`: removing
patched members could remove a later wrapper. Opt-in cursor shapes also
decorate `focused` and the terminal, with their own cleanup (§7).

If the instance lacks `getLines`, `getCursor`, or any capability from §6, we
don't patch it and notify once.

### 3.3 Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Subclass `CustomEditor` | Not composable. |
| Proxy object around the editor | Must mirror a growing duck-typed surface; two objects to keep in sync. |
| `ctx.ui.onTerminalInput` middleware | Global, runs before focus dispatch (`tui.ts:1055–1078`), and has no editor context. |

### 3.4 Ordering with other extensions

| Situation | Result |
| --- | --- |
| Editor extension's factory installed before ours | We decorate its editor. |
| Installed after ours and calls `getEditorComponent()` | It wraps our factory; Vim stays active if it delegates `handleInput`. |
| Installed after ours and replaces blindly | Vim is gone. README: load pi-vim-editor last. |
| `pi-vim` also installed | Unsupported. README says to uninstall it. |

## 4. Modules

```text
src/
├── index.ts      # session_start/shutdown wiring (§3.1)
├── cursor.ts     # opt-in hardware cursor shape and lifecycle (§7)
├── attach.ts     # instance patching: input routing (§5), mode label (§7)
├── status.ts     # read-only status for other extensions (§7.1)
├── engine.ts     # PURE: key → effects; parser, motions, objects
├── sentence.ts   # PURE: sentence motions and objects
├── paragraph.ts  # PURE: paragraph motions and objects
├── reflow.ts     # PURE: manual whole-line prose wrapping and cursor tracking
├── screen.ts     # PURE: screen-row motions over wrapped rows
├── text.ts       # PURE: graphemes, word classes, paste-marker spans
└── port.ts       # editor capability adapter (§6)
```

Split files when one grows past a few hundred lines, not before.

The engine is a pure function over a snapshot:

```ts
type Pos = { line: number; col: number };
type Buffer = { lines: readonly string[]; cursor: Pos };
type Effect =
  | { kind: "move"; to: Pos }
  | { kind: "replace"; from: Pos; to: Pos; text: string; cursor: Pos }
  | { kind: "yank"; register: { text: string; linewise: boolean } }
  | { kind: "mode"; mode: "insert" | "normal" }
  | { kind: "undo" }
  | { kind: "refuse" };                 // operator touched a paste marker

press(state, key, buffer, register): { state; effects: Effect[] }
esc(state, buffer): { state; effects: Effect[]; passthrough: boolean }
```

Most behavior becomes table tests of `buffer + keys → buffer + cursor`.

## 5. Input routing

On each `handleInput(data)`:

**0. Detect external changes.** If text or cursor differ from the snapshot
taken after our last key (mouse click, host action, another extension),
cancel the pending command.

**Pending search.** `State.query` owns input before ordinary routing: Enter
confirms, Backspace removes a grapheme, Esc / `Ctrl-[` cancels, printable text
and bracketed paste append, and other keys are consumed. Split query pastes
are buffered separately, including draining a paste after external mutation
cancels its query. Reconciliation runs before this routing and during search
render/status reads; a cancelled query consumes its next input, preventing a
stale Enter from submitting. Query text is escaped before the border or status
capability sees it. No host API or additional editor is needed.

**1. Decode.** Use `pi-tui`'s exported `matchesKey` and
`decodeKittyPrintable`, plus a few lines decoding xterm `modifyOtherKeys`
(mirroring the unexported `decodePrintableKey`, upstream ask #3), so Kitty
CSI-u and `modifyOtherKeys` printable keys, shifted letters, and `Ctrl-[` are
recognized. Esc means `escape` **or** `ctrl+[` in any encoding.

**INSERT**

| Input | Action |
| --- | --- |
| Esc, autocomplete open | Pass `"\x1b"` through so Pi closes the list. Kitty `Ctrl-[` doesn't match Pi's `escape` (`keys.ts:871–877`), so we normalize it. |
| Esc | → NORMAL, cursor one grapheme left. Consume. |
| Anything else | Pass through unchanged. |

**NORMAL** is deliberately hybrid: Vim owns printable keys, Pi owns the rest.

| Input | Action |
| --- | --- |
| Esc with pending command | Cancel. Consume. |
| Esc, nothing pending | Pass `"\x1b"` through → `app.interrupt`. |
| Printable key | Engine. Unmapped keys are consumed and cancel pending. |
| Key bound to `tui.editor.jumpForward`/`jumpBackward` (`Ctrl-]`) | Consume: Pi's jump would swallow the next key outside Vim. |
| Anything else (Enter, Tab, arrows, Ctrl/Alt keys, paste) | Cancel pending, pass through. These can still edit text (Tab completion, `Ctrl-Y`, paste); that's intended. |

Consequence: if a user binds a Pi app action to a bare printable key, Vim
shadows it in NORMAL mode. Documented, not solved.

**Back to INSERT after submit.** After a passthrough, if the text went from
non-empty to empty, switch to INSERT. Enter alone isn't a submit: it can
accept autocomplete or insert a newline.

Bracketed paste arrives as one rewrapped chunk from `ProcessTerminal`
(`terminal.ts:259–263`). In NORMAL it passes through and inserts at the
cursor. No buffering of split pastes in v0.1.

## 6. Port: the only module that touches editor internals

```ts
interface Port {
  read(): Buffer;                    // getLines(), getCursor() — public
  autocompleteOpen(): boolean;       // isShowingAutocomplete() — public
  setCursor(pos: Pos): void;         // private: state + setCursorCol()
  replace(from: Pos, to: Pos, text: string, cursor: Pos): void;
  undo(): void;                      // private: undo(), plus a redo snapshot
  redo(): boolean;                   // private: pushUndoSnapshot(), state
  clearRedo(): void;
  undoDepth(): number;               // private: undoStack.length
  collapseUndo(depth: number): void; // private: undoStack.pop()
  closeAutocomplete(): void;         // private: cancelAutocomplete()
  pastes(): ReadonlyMap<number, string>; // private: pastes, for `.`
  paste(content: string): string;    // private: a new pasted block, for `.`
  cancelJump(): void;                // private, optional: jumpMode = null
  layout?(width: number): Layout;    // private, optional: see §6.1
  rows?(): Row[];                    // private, optional: see §6.1
  view?(): View;                     // private, optional, scrolls: see §6.1
}
```

`replace` mirrors the bookkeeping of the public `insertTextAtCursor()`
(`editor.ts:1135–1197`): cancel autocomplete, push one undo snapshot, reset
`lastAction`, exit history browsing, splice lines, set the cursor, fire
`onChange`.

Rules:

- **Fail closed.** `attach()` checks that every private member exists with the
  expected type (`state`, `pastes`, `lastAction`, `undoStack.length/pop/push`,
  and the private methods above). If any is missing, we don't attach and
  notify once that the Pi version is unsupported. No degraded tiers, no
  synthetic keys. `layout`, `rows`, `view`, and `cancelJump` are optional:
  without them, Visual mode is off, screen motions treat lines as rows, `H`,
  `M`, and `L` do nothing, and Esc doesn't end a pending `Ctrl-]` jump.
- **Esc goes through the port, not through Pi's keys.** With autocomplete open,
  Esc closes it with `closeAutocomplete()`, so a remapped `tui.select.cancel`
  can't trap it. Every Esc we handle also ends Pi's pending character jump,
  which would otherwise catch the next key we pass on.
- **Reconcile before acting.** Before each key and each Visual render, the
  decorator compares the editor with what it saw after its last key. A moved
  cursor drops a pending command; changed text also ends Visual mode, so a
  selection never points past the buffer.
- **Redo.** Pi's editor has no redo, so the port keeps one per editor:
  `undo()` snapshots the lines and paste registry (`pastes`, `pasteCounter`)
  before calling Pi's undo, and `redo()` pushes the current state onto Pi's
  undo stack, so `u` can undo the redo, then restores the snapshot with the
  cursor at the first difference, where Vim puts it. The decorator forgets the
  redo stack on every edit: its own `replace` effects, any Pi key or paste
  that changes the text or paste registry, and text that changed from outside
  between two undos or redos. Cursor moves keep it.
- **Pi's undo inside a change.** If Pi's own undo drops the stack below the
  depth where the open change started, the change restarts from there and
  isn't repeatable with `.`.
- **One Vim change = one undo step.** A change runs from the NORMAL command
  that enters INSERT mode to Esc. Pi splits typed text into several snapshots
  (`editor.ts:1201–1213`), so on Esc we pop every snapshot newer than the one
  the change started with (`collapseUndo`). Snapshots hold the state *before*
  each step, so the remaining one restores the state before the whole change.
  A submit clears Pi's stack and abandons the open change. Commands that edit
  several lines without entering INSERT (`>`, block `d`, `r`) are collapsed
  the same way right after they run. Upstream ask #1 would replace this with
  undo groups.
- **Paste markers.** Motions treat a valid marker (`[paste #N …]` whose ID
  exists, as Pi validates in `editor.ts:385–392`) as one grapheme. Any operator
  whose range touches a marker is **refused** with a notification. The
  register therefore never holds marker text, and we never expand pastes.
  `.` repeats a pasted block typed in INSERT mode by registering its content
  as a new pasted block (`port.paste()`), never by inserting marker text.
- Never call `setText()` on a buffer with markers: it clears the paste
  registry (`editor.ts:1115–1128`).

### 6.1 Visual highlight

Pi's editor can't highlight a range, so `render()` post-processes its output.
`layout(width)` maps rendered rows back to buffer text after the original
`render()` ran, using private members: `buildVisualLineMap(lastWidth)` gives
each wrapped row's logical line and column span, `scrollOffset` and
`renderedVisibleLineCount` give the visible slice, and `getPaddingX()` the left
padding. Row `i` of that slice is rendered line `i + 1` (after the top border).

That holds only for the rows Pi's `Editor.render()` returns. An editor that
subclasses it, such as another extension's framed editor, may render Pi's
rows at a smaller width and then drop, add, or indent rows. So the decorator
highlights only if the rows are verifiably Pi's layout: during the same
`render(width)`, Pi called both border methods (which we patch) with that
width, and their results are row 0 and row `n + 1` for `n` layout rows.
Otherwise the selection isn't shown, rather than shown in the wrong cells.
The decorator also skips rows and lines that don't exist. It doesn't guess
another editor's geometry; that needs an agreed contract or upstream ask #4.

For each row, the selected columns become visible columns with `visibleWidth`,
and the row gets `ESC[7m … ESC[27m` around them, skipping escape sequences.
After a code that ends reverse video inside the selection (an SGR reset, or the
end of Pi's fake cursor), reverse video is re-applied, so the cursor cell blends
into the selection; the terminal cursor still shows it if Pi uses one. An empty
line in the selection shows one highlighted cell.

`layout` is optional: if those members are missing, `v` and `V` notify that
Visual mode isn't supported and everything else keeps working.

Screen motions read the same private members. `gj`, `g$`, and the other row
motions use `port.rows()`: `buildVisualLineMap(lastWidth)`, the map Pi's own
arrow keys move through. `lastWidth` is the width Pi wrapped at, so an editor
that renders Pi's rows narrower still gets the right rows. Without those
members, each line is one row.

`H`, `M`, and `L` need to know what's on screen, so they use `port.view()`
only when the last render passed the same border check as the highlight;
otherwise they do nothing. The text or cursor may have changed since that
render, so `view()` redoes `Editor.render()`'s scrolling: the capacity of
`max(5, ⌊0.3 · terminal rows⌋)` rows, scrolled from `scrollOffset` to the
cursor's row and clamped. It writes the result back to `scrollOffset`, so
several motions before the next render agree with each other and with what
that render shows. Upstream ask #4
would replace this with an editor API for highlighting ranges.

### Upstream asks

Drafts in [`upstream.md`](upstream.md):

1. Public `Editor.setCursor()`, `Editor.replaceRange()`, `Editor.undo()`, and
   undo transactions (begin/end) so one Vim change is one step. Removes every
   private access in `port.ts`.
2. Carry editor state (cursor, paste registry, undo) across
   `setEditorComponent()`, or hand the new factory the previous instance.
3. Export `decodePrintableKey()` from `pi-tui` (`keys.ts:1453`, not exported
   today).
4. Let editor decorators highlight buffer ranges (e.g.
   `Editor.setHighlights(ranges)`), or expose the row layout of the last render.

## 7. Mode indicator

`INSERT` (muted), `NORMAL` / `VISUAL …` (accent), or the pending keys, such as
`2d`, `ci`, or `:q`. Theme foreground tokens only, no reverse video. The
corner comes from `vimEditor.indicator` in Pi's settings (`pi.getSettings()`
at `session_start`), bottom-right by default.

The label needs room at the end of the border line: it must end in plain
dashes, `borderColor("─…")`. On the right, the label replaces the last dashes.
On the left, it goes in after the first dash and the line gives up the same
number of dashes at its end, so Pi's top-left working indicator just moves
over. The scroll indicator and anything else in the middle stay intact. If the
line doesn't end in enough dashes (another extension decorated it, or the
terminal is narrow), the label is left out. No status-line fallback.

Border widgets (open Pi PR #10602) could replace the patch later. Not designed
for now.

### 7.1 Status for other extensions

Extensions that frame the editor themselves can drop Pi's border rows and
the label with them. `status.ts` publishes a frozen capability on the
decorated instance under `Symbol.for("pi-vim-editor")`:
`{ version: 1, status() }`, where `status()` returns
`{ mode, pending, label }`. `label` is the same text the border shows.
`status()` computes it on every call, after the same reconciliation `render()`
does, so it never reports a Visual mode that changed text already ended. It
doesn't depend on the border methods, which keep their behavior. The
capability lives as long as the decoration, which has no `detach()`.
User-facing contract: [`integration.md`](integration.md).

NORMAL clamps the cursor onto a character. By default, the cursor remains
Pi's reverse-video block, with no terminal escapes from this extension.

With `vimEditor.cursorShape: true`, `cursor.ts` uses DECSCUSR 6 (steady bar)
in INSERT, 2 (steady block) in NORMAL/Visual, and 4 (steady underline) in
REPLACE. It checks the public `tui.getShowHardwareCursor()` at render time
and never changes cursor visibility. It only writes a shape when it changes
and the focused editor emits `CURSOR_MARKER`. Before Visual highlighting,
it removes Pi's fake-cursor opening marker (`ESC _pi:fc BEL`) immediately
after that marker, leaving the cell, the cursor marker, and the closing marker
intact.

The cursor controller decorates the editor's public `focused` property,
composing with existing accessors, to reset on focus loss even when a dialog
unmounts the editor. It wraps the public terminal's `stop()` and `start()`
to reset before external-editor or suspend handoff and reapply on resume.
While stopped, it leaves renders alone: fullscreen renders the transcript
after stopping. The terminal survives renderer switches; the TUI reference
itself is a moving proxy and must not be patched. Reset uses DECSCUSR 0
(the terminal's default; a blinking block in xterm), not a snapshot of the
previous terminal shape.

Factory replacement and `session_shutdown` dispose the controller. Cleanup
restores only wrappers it still owns; wrappers retained by later extensions
become inert. Missing cursor capabilities disable only cursor shapes, not
Vim editing. No process listeners, terminal queries, or visibility changes
are installed.

## 8. State

- **Per editor:** mode, pending keys, last snapshot. A new editor starts in
  INSERT.
- **Per extension:** the unnamed register `{ text, linewise }`. It holds plain
  text only (markers are refused), so it survives submits and editor
  recreation.
- **System clipboard (`src/clipboard.ts`, host side).** The engine treats `"+`
  and `"*` as a prefix: it runs the rest of the command as usual, marks its
  yank as copying, and turns `"+p` into a `clipboard` effect. The clipboard
  module writes through Pi's exported `copyToClipboard` and keeps a mirror of
  the last copy with its register shape. Reads use `pi-tui`'s public
  `getNativeClipboard()` (macOS, Windows, X11), after `wl-paste` or
  `termux-clipboard-get` where those apply, spawned without a shell, with a
  timeout and an output cap, and killed with SIGKILL if they ignore SIGTERM.
  A read first waits for any copy in flight, so a yank followed by `"+p`
  never reads older text; copies and that wait are bounded by the same
  timeout. The decorator runs puts one at a time in key order and applies one
  only if the editor is still focused and no key changed the text, cursor, or
  mode since its own key (a counter, so changing and changing back counts),
  and nothing else did either (a snapshot of the editor as the last key or
  put left it). Then it puts with the engine's pure `putText()` as one undo
  step. Upstream ask #5 would replace the platform
  commands.
  With `vimEditor.clipboard` set to `unnamedplus` (or `unnamed`), the
  engine's `press()` turns NORMAL `p` / `P` into the same `clipboard`
  effect, marked `quiet` so a fallback to the mirror doesn't warn, and the
  decorator copies every yank effect, not just yanks.
- **Replace mode:** printable keys go to the engine's pure `overtype()`,
  which overwrites the cluster under the cursor or appends at the line end and
  reports what it overwrote; Backspace goes to `untype()`, which restores it.
  The decorator keeps that restore stack, plus the session's keys in order
  (characters, or Backspace) for `.`, which replays them through the same
  functions so grapheme boundaries and Backspaces past the start survive. A
  click, paste, or Pi key that moves the cursor or edits starts both over, as
  the decorator detects by comparing the editor with what its last Replace key
  left. The session is one change for undo, like INSERT.
- **Per editor, for `.`:** a `Change`: the keys of the last change without
  their count (the engine's `uncounted()`), the count, and what the keys alone
  don't say.
  - A Visual change keeps the selection's `Extent`: mode, lines, and a width
    or end display column. The engine's `reselect()` turns it into a new
    selection at the cursor; a block keeps its display columns
    (`State.columns`) even where lines are shorter.
  - An INSERT session keeps a `Typed` edit from the engine's `typed()`:
    graphemes deleted before and after where typing started, and the text
    left there. It's the difference between the editor at the start and at
    Esc, bounded by both cursors so Backspace and Delete stay apart among
    repeated characters. Pasted blocks in it keep their content, and replay
    registers them as new pasted blocks. A cursor move without an edit
    (arrows, a click, also right before a paste or Esc) closes that segment
    and its undo step and starts a new one with `i`; an empty last segment
    falls back to the one before.
  - A REPLACE session keeps its keys.

  Replaying runs the keys through the engine, applies the edit with
  `retype()` (once per count for `i`, `a`, `I`, `A`, and `R`; `o` and `O`
  join the copies into one opened block), replicates a block insert, and
  collapses everything into one undo step. `{n}.` becomes the count if the
  command takes one (`countable()`) and sticks for the next `.`; Visual
  changes ignore it.
- **Literal search:** the engine keeps the accepted text/direction separately
  from `find` and the pending draft. It scans the joined prompt with literal
  string matching, admitting only grapheme-boundary matches at valid cursor
  positions and rejecting any overlap with registered paste-marker spans.
  Counts choose among matching starts modulo their number; wrap and failure
  produce message effects. Confirmation and `n`/`N` emit only moves/messages,
  never register or change effects. Mode changes preserve search memory;
  submit/editor replacement clears it. Operator search is intentionally not
  part of the synchronous operator parser or dot replay: an operator followed
  by `/` or `?` captures a discard-only query, while `n`/`N` cancel it.
- **Manual reflow:** `gq` and `gw` reuse operator ranges, expanded to whole
  touched lines. The engine checks every such line for paste markers before
  formatting. `reflow.ts` wraps space/tab-delimited words, retains blank
  separators and first-line indentation, and tracks the original cursor’s
  character for `gw`. `gq` lands at the end of the formatted range. One replace
  effect gives one undo step; unchanged text emits only a cursor move and does
  not overwrite the last repeatable change. The register is never written.
  `index.ts` reads `vimEditor.textWidth` through the existing settings API at
  session start: a positive safe integer, otherwise 79. `attach.ts` passes it
  in the buffer snapshot alongside the host’s display-width function. No
  viewport access, automatic formatting, external formatter, or syntax parser.
- **Visual block:** columns are display columns. The port passes `pi-tui`'s
  `visibleWidth` as `Buffer.measure`, so they agree with what Pi renders; the
  engine stays pure and falls back to a small wide-character table in
  `text.ts`. Block registers also carry their display width, so `p` pads short
  rows and keeps the rectangle. Block `I`, `A`, and `c` return a `BlockInsert` with the lines
  and display column; on Esc, the decorator takes the text typed on the top
  line (the same insertion diff as for `.`) and the engine's `replicate()`
  turns it into one edit per remaining line, all inside the change's undo step.
  Block registers carry `block: true`, so `p`/`P` put them column by column.
  `Ctrl-V` is a control key, so the decorator maps it to the engine's `CTRL_V`
  key in NORMAL and Visual modes before it can reach Pi's image paste.

## 9. Testing and CI

Following the workspace rule: test documented behavior, about one test each.

| Layer | Approach |
| --- | --- |
| Engine | Table tests: `"foo |bar baz" + "dw" → "foo |baz"`. |
| Attach + port | Real `CustomEditor` with a stub TUI: text, cursor, undo depth, refused marker edits, Esc/autocomplete, submit → INSERT. |
| Composition | A fake editor extension that wraps `getEditorComponent()` loaded before us; `embedWorkingStatus` and `setWorkingStatusIndicator` stay intact. |
| Fail closed | Remove one private member → no attach, one notification. |
| Host drift | CI runs on the pinned Pi devDependencies and, weekly, on `@latest`. Testing a Pi `main` checkout is a later addition. |

## 10. Pitfalls from pi-vim history

- Esc from INSERT steps one **grapheme** left (`105537b`).
- `Ctrl-[` equals Esc in every encoding (`879f137`).
- Linewise vs. charwise put cursor placement follows Vim (`59db9e6`, `53e8bda`).
- Autocomplete gets Esc first; Tab/Enter acceptance stays with Pi.
- Cursor-shape escapes are opt-in and paired with resets on focus loss,
  terminal handoff, replacement, and shutdown (`5e216bc`, `0f40d5b`).
- No subprocesses or host-path probing at startup (`c121bd1`, `6cf2548`).

## References

- Pi: `interactive-mode.ts` (default editor 648–652, factory install
  2871–2949, reload 2452–2470), `custom-editor.ts`, `pi-tui` `editor.ts`,
  `editor-component.ts`, `keys.ts`, `tui.ts`; example `modal-editor.ts`.
- Pi issues/PRs: #3935 (`getEditorComponent`), #8799 (border working
  indicator), #10602 (border widgets, open).
- pi-vim: issues #45 #49 #51 #53 #55; PRs #52 #54 #56 #57.
