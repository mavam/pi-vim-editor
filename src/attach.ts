/**
 * Decorates an editor instance in place: modal input routing and the mode
 * label in the bottom border. See docs/design.md §3.2, §5, and §7.
 */

import {
  decodeKittyPrintable,
  type KeybindingsManager,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Clipboard } from "./clipboard.js";
import {
  type BlockInsert,
  type Buffer,
  CTRL_R,
  CTRL_V,
  clamp,
  countable,
  type Effect,
  type Extent,
  esc,
  ex,
  extent,
  initial,
  isVisual,
  type LineSpan,
  label,
  type Mode,
  overtype,
  press,
  putText,
  type Register,
  replicate,
  reselect,
  retype,
  type State,
  searchInput,
  selectedSpans,
  type Typed,
  typed,
  uncounted,
  untype,
} from "./engine.js";
import { type Layout, portFor } from "./port.js";
import { publish, statusOf, VIM_EDITOR } from "./status.js";
import { markers, remark } from "./text.js";

/** State shared by all decorated editors of one extension instance. */
export type Shared = {
  register: Register | undefined;
  notify(message: string, type: "info" | "warning"): void;
  /** The system clipboard, for yanks and the `"+` register. */
  clipboard: Clipboard;
  /**
   * Use the system clipboard for the unnamed register, like Vim's
   * `clipboard=unnamedplus`: every yank, delete, and change copies to it,
   * and `p` / `P` put it.
   */
  unnamed?: boolean;
  /** Manual prose wrapping width; omitted means 79 columns. */
  textWidth?: number;
  /** Quit Pi. */
  quit(): void;
  /** Where the mode label goes. */
  position: Position;
  /** Color the mode label: muted in INSERT, accent otherwise. */
  paint(insert: boolean, text: string): string;
};

export type Position =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

type Decoratable = {
  handleInput(data: string): void;
  render(width: number): string[];
  renderTopBorder(width: number, hidden: number): string;
  renderBottomBorder(width: number, hidden: number): string;
  borderColor?: (text: string) => string;
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Decorate `editor` in place. Returns false if it isn't supported. */
export function attach(
  editor: object,
  keybindings: KeybindingsManager,
  shared: Shared,
  renderCursor?: (mode: Mode, lines: string[]) => void,
  /** Ask Pi to render, for changes that arrive outside input. */
  redraw: () => void = () => {},
): boolean {
  if (VIM_EDITOR in editor) return true;
  const target = editor as Decoratable;
  const port = portFor(editor);
  if (
    !port ||
    typeof target.handleInput !== "function" ||
    typeof target.render !== "function" ||
    typeof target.renderTopBorder !== "function" ||
    typeof target.renderBottomBorder !== "function"
  ) {
    shared.notify(
      "pi-vim-editor doesn't support this editor or Pi version; Vim mode is off.",
      "warning",
    );
    return false;
  }
  const passthrough = target.handleInput.bind(editor);
  const top = target.renderTopBorder.bind(editor);
  const bottom = target.renderBottomBorder.bind(editor);
  const render = target.render.bind(editor);
  let state: State = initial;
  // Whether the last render showed Pi's rows unchanged, so `port.view` is
  // what's on screen.
  let shown = false;
  let seen = "";
  // The text as the last undo or redo left it.
  let undone = "";
  let seenText = "";
  let pasting = false;
  // Buffer query pastes separately; even a cancelled query drains its paste.
  let queryPaste: string | undefined;
  let cancelledQuery = false;
  // A change for `.`: its keys without their count, and what the keys
  // alone don't say: the size of a Visual selection it acted on, what it did
  // in INSERT mode, or its keys in REPLACE mode.
  type Change = {
    keys: readonly string[];
    count?: number;
    visual?: Extent;
    typed?: Typed;
    /** Content of the pasted blocks in `typed`, by id. */
    pasted?: ReadonlyMap<number, string>;
    actions?: (string | null)[];
  };
  // The change being typed in INSERT or REPLACE mode, entered from NORMAL or
  // Visual mode; without `change`, `.` won't repeat it. `buf` is the editor
  // where typing started, `at` the editor as the last key left it.
  let open:
    | {
        change?: Change;
        depth: number;
        buf: Buffer;
        at: Buffer;
        block?: BlockInsert;
        /** The change before a cursor move, in case nothing follows it. */
        done?: Change;
      }
    | undefined;
  // Replace mode: what each typed character overwrote, for Backspace; the
  // keys of the session in order (a character, or null for Backspace), for
  // `.`; and the editor as the last Replace key left it.
  let overwritten: string[] = [];
  let actions: (string | null)[] = [];
  let replaceSeen = "";
  // Start Replace bookkeeping over, e.g. after a click or a paste.
  const restart = () => {
    overwritten = [];
    actions = [];
    replaceSeen = fingerprint(port.read());
  };
  const typing = () => state.mode === "insert" || state.mode === "replace";
  // The last completed change, for `.`.
  let last: Change | undefined;

  const run = (effects: readonly Effect[]) => {
    for (const effect of effects) {
      if (effect.kind === "move") port.setCursor(effect.to);
      if (effect.kind === "replace") {
        port.replace(effect.from, effect.to, effect.text, effect.cursor);
        port.clearRedo();
      }
      if (effect.kind === "yank") {
        shared.register = effect.register;
        if (effect.copy || shared.unnamed)
          shared.clipboard.write(effect.register);
      }
      if (effect.kind === "undo" || effect.kind === "redo") {
        // An edit since the last undo or redo ends what can be redone;
        // moving the cursor doesn't.
        if (port.read().lines.join("\n") !== undone) port.clearRedo();
        if (effect.kind === "undo") port.undo();
        else if (!port.redo()) shared.notify("Nothing to redo.", "info");
        undone = port.read().lines.join("\n");
      }
      if (effect.kind === "repeat") repeat(effect.count);
      if (effect.kind === "clipboard")
        putClipboard(effect.before, effect.count, effect.quiet);
      if (effect.kind === "message") shared.notify(effect.text, "info");
      if (effect.kind === "quit") {
        if (effect.force || port.read().lines.join("") === "") shared.quit();
        else
          shared.notify(
            "The prompt isn't empty. Use :q! or ZQ to quit anyway.",
            "info",
          );
      }
      if (effect.kind === "refuse")
        shared.notify("Vim edits can't touch pasted blocks.", "info");
    }
  };

  // Run keys in NORMAL mode and track the change they make, if any.
  const perform = (key: string) => {
    const depth = port.undoDepth();
    const before = state;
    const buf: Buffer = {
      ...port.read(),
      textWidth: shared.textWidth,
      rows: port.rows,
      // Only a view verified at the last render tells what's visible.
      view: shown ? port.view : undefined,
    };
    const result = press(state, key, buf, shared.register, {
      unnamed: shared.unnamed,
    });
    if (isVisual(result.state.mode) && !port.layout) {
      shared.notify("Visual mode isn't supported by this Pi version.", "info");
      return;
    }
    state = result.state;
    run(result.effects);
    let change: Change | undefined;
    if (result.change) change = uncounted(result.change);
    else if (isVisual(before.mode) && !isVisual(state.mode)) {
      // A Visual change: remember the selection's size along with the keys.
      const edits = result.effects.some(
        (e) => e.kind === "replace" || e.kind === "mode",
      );
      const size = extent(before, buf);
      if (edits && size) change = { keys: [...before.keys, key], visual: size };
    }
    if (state.mode === "replace") restart();
    if (typing()) {
      const now = port.read();
      open = {
        change,
        depth,
        buf: now,
        at: now,
        block: result.block,
      };
    } else {
      if (change) last = change;
      // Edits spanning several lines are still one undo step.
      if (port.undoDepth() > depth + 1) port.collapseUndo(depth);
    }
  };

  // Leave INSERT or REPLACE mode: one undo step and one `.` for the change.
  // Returns true if it placed the cursor itself (after a block insert).
  const close = (): boolean => {
    if (!open) return false;
    const now = port.read();
    const raw = insertion(open.buf, now);
    const plain = raw !== undefined && !markers(raw).length;
    const copied = Boolean(open.block && raw && plain && !raw.includes("\n"));
    if (open.block && copied)
      run(replicate(open.block, raw as string, port.read()));
    else if (open.block && raw && !plain)
      shared.notify("Pasted blocks aren't copied to the other lines.", "info");
    if (open.change && state.mode === "replace")
      last = { ...open.change, actions: [...actions] };
    else if (open.change)
      last = segment(open.change, open.buf, now, !!open.done) ?? open.done;
    if (port.undoDepth() > open.depth) port.collapseUndo(open.depth);
    open = undefined;
    return copied;
  };

  // What INSERT mode did from `from` to `to`, or undefined if nothing.
  // An `optional` segment, typed after a cursor move, is undefined if it
  // did nothing.
  const segment = (
    change: Change,
    from: Buffer,
    to: Buffer,
    optional = false,
  ) => {
    const edit = typed(from, to);
    if (optional && !edit.back && !edit.forward && !edit.text) return undefined;
    // Keep pasted blocks' content, so `.` pastes them again as new blocks.
    const pastes = port.pastes();
    const pasted = new Map<number, string>();
    remark(edit.text, (id, marker) => {
      const content = pastes.get(id);
      if (content !== undefined) pasted.set(id, content);
      return marker;
    });
    return { ...change, typed: edit, pasted };
  };

  // In INSERT mode, a cursor move without an edit (arrows, a click) starts
  // the change over from there, as in Vim; `.` then repeats what was typed
  // after the move, or before it if nothing was.
  const rebase = (buf: Buffer) => {
    if (!open || state.mode !== "insert") return;
    const { at } = open;
    const same = buf.lines.join("\n") === at.lines.join("\n");
    const moved =
      buf.cursor.line !== at.cursor.line || buf.cursor.col !== at.cursor.col;
    if (same && moved) {
      // Vim also starts a new undo step there.
      if (port.undoDepth() > open.depth + 1) port.collapseUndo(open.depth);
      open.depth = port.undoDepth();
      const done =
        (open.change && segment(open.change, open.buf, at, !!open.done)) ??
        open.done;
      open = { ...open, buf, block: undefined, done };
      if (open.change) open.change = { keys: ["i"] };
    }
    open.at = buf;
  };

  // `.`: run the last change again. A count replaces its own count and
  // sticks for the next `.`; for commands without counts, like `i`, `o`,
  // and `R`, it repeats what was typed. Visual changes ignore counts.
  const repeat = (count?: number) => {
    const change = last;
    if (!change) return;
    const depth = port.undoDepth();
    const n = change.visual ? undefined : (count ?? change.count);
    const counted = !change.visual && countable(change.keys);
    const keys =
      counted && n !== undefined ? [...String(n), ...change.keys] : change.keys;
    // Only commands that just start typing repeat their text n times.
    const typesText = /^[iaIAoOR]$/.test(change.keys[0] ?? "");
    replay(change, keys, !counted && typesText ? (n ?? 1) : 1);
    last = { ...change, count: n };
    if (port.undoDepth() > depth) port.collapseUndo(depth);
  };

  const replay = (change: Change, keys: readonly string[], times: number) => {
    if (change.visual) {
      const { state: selected, cursor } = reselect(change.visual, port.read());
      port.setCursor(cursor);
      state = { ...selected, find: state.find, search: state.search };
    }
    for (const key of keys) perform(key);
    const started = open;
    open = undefined;
    if (state.mode === "replace") {
      for (let k = 0; k < times; k++)
        for (const action of change.actions ?? [])
          action === null ? backspace() : overtypeKey(action);
    } else if (state.mode === "insert" && change.typed) {
      // Pasted blocks come back as new pasted blocks, never as live markers.
      const fresh = () =>
        remark(change.typed?.text ?? "", (id, marker) => {
          const content = change.pasted?.get(id);
          return content === undefined ? marker : port.paste(content);
        });
      // `o` and `O` with a count open one line per copy of the text.
      if (change.keys[0] === "o" || change.keys[0] === "O") {
        const text = Array.from({ length: times }, fresh).join("\n");
        run(retype(port.read(), { ...change.typed, text }));
      } else
        for (let k = 0; k < times; k++)
          run(retype(port.read(), { ...change.typed, text: fresh() }));
      const { back, forward, text } = change.typed;
      if (started?.block && !back && !forward && text && !text.includes("\n")) {
        run(replicate(started.block, text, port.read()));
        state = {
          mode: "normal",
          keys: [],
          find: state.find,
          search: state.search,
        };
        return;
      }
    }
    if (typing()) {
      const result = esc(state, port.read());
      state = result.state;
      run(result.effects);
    }
  };

  // Something else changed the editor since our last key. A moved cursor
  // drops a pending command; changed text also ends Visual mode.
  const reconcile = (buf: Buffer) => {
    if (typing() || fingerprint(buf) === seen) return;
    if (state.query) cancelledQuery = true;
    if (buf.lines.join("\n") !== seenText && isVisual(state.mode))
      state = {
        mode: "normal",
        keys: [],
        find: state.find,
        search: state.search,
      };
    else state = { ...state, keys: [], query: undefined };
  };

  // `"+p`: read the clipboard, then put it only if nothing changed meanwhile,
  // so a slow read never lands in a different prompt, place, or mode.
  // `"+p` reads asynchronously. Puts run one at a time, in key order, and
  // each applies only if nothing else happened since its key: `changes` goes
  // up whenever a key changes the text, cursor, or mode, and `settled` is
  // the editor as the last key or put left it, which catches clicks and
  // other extensions. A put itself doesn't count, so `"+p"+p` puts twice.
  let changes = 0;
  let settled = "";
  let puts: Promise<void> = Promise.resolve();
  const snapshot = () =>
    `${state.mode}|${state.query ? label(state) : ""}|${fingerprint(port.read())}`;
  const putClipboard = (before: boolean, count: number, quiet = false) => {
    const at = changes;
    puts = puts.then(async () => {
      const { register, warning } = await shared.clipboard.read();
      // A plain `p` falls back to our last copy silently, e.g. over SSH.
      if (warning && !(quiet && register)) shared.notify(warning, "warning");
      if (!register) return;
      const focused = (editor as { focused?: boolean }).focused !== false;
      if (changes !== at || snapshot() !== settled || !focused)
        return shared.notify(
          "The prompt changed; not putting the clipboard.",
          "info",
        );
      // Text that looks like a pasted block would put that block's content.
      if (markers(register.text).length)
        return shared.notify("Vim edits can't touch pasted blocks.", "info");
      const depth = port.undoDepth();
      run(putText(port.read(), register, before, count));
      if (port.undoDepth() > depth + 1) port.collapseUndo(depth);
      settle();
      settled = snapshot();
      redraw();
    });
  };

  const overtypeKey = (char: string) => {
    const { effects, original } = overtype(port.read(), char);
    run(effects);
    if (original !== undefined) {
      overwritten.push(original);
      actions.push(char);
    }
    replaceSeen = fingerprint(port.read());
  };

  const backspace = () => {
    run(untype(port.read(), overwritten.pop()));
    actions.push(null);
    replaceSeen = fingerprint(port.read());
  };

  // Keep the NORMAL-mode cursor on a character, and remember what we saw.
  const settle = () => {
    let buf = port.read();
    if (!typing()) {
      const to = clamp(buf, buf.cursor);
      if (to.col !== buf.cursor.col) port.setCursor(to);
      buf = port.read();
    }
    seen = fingerprint(buf);
    seenText = buf.lines.join("\n");
  };

  // Pass input to Pi; a prompt going from text to empty was submitted.
  const forward = (data: string, buf: Buffer) => {
    const before = buf.lines.join("\n");
    const pastes = [...(buf.pastes ?? [])].join();
    passthrough(data);
    // Pi edited (typing, paste, history, Ctrl-K, submit): nothing to redo.
    const after = port.read();
    if (
      after.lines.join("\n") !== before ||
      [...(after.pastes ?? [])].join() !== pastes
    )
      port.clearRedo();
    // Pi's own undo went below the change's start: restart it from here.
    if (open && port.undoDepth() < open.depth) {
      const now = port.read();
      open = { depth: port.undoDepth(), buf: now, at: now };
    }
    if (before !== "" && port.read().lines.join("\n") === "") {
      state = initial;
      open = undefined;
    }
  };

  target.handleInput = (data: string) => {
    const before = snapshot();
    // A click or another extension changed things: pending puts are stale.
    if (before !== settled) changes++;
    handle(data);
    settled = snapshot();
    if (settled !== before) changes++;
  };

  const handle = (data: string) => {
    const buf = port.read();
    reconcile(buf);
    if (
      queryPaste !== undefined ||
      ((state.query || cancelledQuery) && data.includes(PASTE_START))
    ) {
      queryPaste = (queryPaste ?? "") + data;
      const end = queryPaste.indexOf(PASTE_END);
      if (end !== -1) {
        if (state.query) {
          const text = queryPaste
            .slice(queryPaste.indexOf(PASTE_START) + PASTE_START.length, end)
            .replace(/\r\n?/g, "\n");
          state = searchInput(state, { text }, buf).state;
        }
        queryPaste = undefined;
      }
      // Draining paste chunks doesn't acknowledge an external cancellation;
      // the Enter that would have confirmed this query must still be eaten.
      return settle();
    }
    // Even after a render cancelled the query, its next Enter/Esc/text must
    // not submit, interrupt, or turn into an unrelated Normal command.
    if (cancelledQuery) {
      cancelledQuery = false;
      shared.notify("The prompt changed; search cancelled.", "info");
      return settle();
    }
    if (state.query) {
      let result: ReturnType<typeof searchInput> | undefined;
      if (isEscape(data)) {
        port.cancelJump();
        result = searchInput(state, "cancel", buf);
      } else if (matchesKey(data, "enter"))
        result = searchInput(state, "confirm", buf);
      else if (matchesKey(data, "backspace"))
        result = searchInput(state, "backspace", buf);
      else {
        const text = printable(data);
        if (text !== undefined) result = searchInput(state, { text }, buf);
        // Modified shortcuts and navigation are deliberately consumed.
      }
      if (result) {
        state = result.state;
        run(result.effects);
      }
      return settle();
    }
    if (pasting || data.includes(PASTE_START)) {
      pasting =
        data.lastIndexOf(PASTE_START) > data.lastIndexOf(PASTE_END) ||
        (pasting && !data.includes(PASTE_END));
      // A click before the paste still starts the INSERT change over.
      if (state.mode === "insert") rebase(port.read());
      passthrough(data);
      port.clearRedo();
      if (state.mode === "replace") restart();
      if (state.mode === "insert" && open) open.at = port.read();
      return;
    }
    if (isEscape(data)) {
      // Pi's character jump would otherwise catch the next key we pass on.
      port.cancelJump();
      if (typing() && port.autocompleteOpen()) return port.closeAutocomplete();
      // A click just before Esc still ends the INSERT change there.
      if (state.mode === "insert") rebase(buf);
      const result = esc(state, buf);
      if (result.passthrough) passthrough("\x1b");
      else if (!(typing() && close())) run(result.effects);
      state = result.state;
      return settle();
    }
    if (state.mode === "insert") {
      rebase(buf);
      forward(data, buf);
      if (open) rebase(port.read());
      return;
    }
    if (state.mode === "replace") {
      // A click or another extension changed things since our last key.
      if (fingerprint(buf) !== replaceSeen) restart();
      if (matchesKey(data, "backspace")) return backspace();
      const text = printable(data);
      if (text === undefined) {
        // Other keys go to Pi. If they move the cursor or edit, Backspace and
        // `.` start over from here, as after arrow keys in Vim.
        forward(data, buf);
        if (state.mode !== "replace") return;
        if (fingerprint(port.read()) !== fingerprint(buf)) restart();
        return;
      }
      for (const { segment } of segmenter.segment(text)) overtypeKey(segment);
      return;
    }
    // A pending Ex command takes Enter and Backspace instead of Pi.
    if (state.keys[0] === ":") {
      if (matchesKey(data, "enter")) {
        const result = ex(state);
        state = result.state;
        run(result.effects);
        return settle();
      }
      if (matchesKey(data, "backspace")) {
        const keys = state.keys.slice(0, -1);
        state = { ...state, keys: keys.length > 1 ? keys : [] };
        return settle();
      }
    }
    // Ctrl-V starts Visual block mode instead of pasting an image.
    if (matchesKey(data, "ctrl+v")) {
      perform(CTRL_V);
      return settle();
    }
    // Ctrl-R redoes in NORMAL mode.
    if (matchesKey(data, "ctrl+r") && state.mode === "normal") {
      perform(CTRL_R);
      return settle();
    }
    if (
      keybindings.matches(data, "tui.editor.jumpForward") ||
      keybindings.matches(data, "tui.editor.jumpBackward")
    )
      return;
    const text = printable(data);
    if (text === undefined) {
      state = { ...state, keys: [] };
      forward(data, buf);
      reconcile(port.read());
      return settle();
    }
    for (const { segment } of segmenter.segment(text)) perform(segment);
    settle();
  };

  // Text that changed from outside ends Visual mode before anyone shows it.
  const current = () => {
    if (isVisual(state.mode) || state.query) reconcile(port.read());
    return state;
  };

  // The borders Pi's render drew during our last render, if any. The rows
  // between them have the layout `port.layout` describes, unless the editor
  // rendered at another width or rearranged the rows afterward.
  let borders: { top?: Border; bottom?: Border } = {};
  target.render = (width: number) => {
    current();
    borders = {};
    const lines = render(width);
    renderCursor?.(state.mode, lines);
    const layout = port.layout?.(width);
    shown = !!layout && native(lines, width, layout, borders);
    if (!isVisual(state.mode) || !layout || !shown) return lines;
    const buf = port.read();
    highlight(lines, buf.lines, selectedSpans(state, buf), layout);
    return lines;
  };

  const decorate = (line: string, left: boolean) => {
    const color = target.borderColor;
    if (!color) return line;
    const insert = state.mode === "insert" && !state.keys.length;
    const text = shared.paint(insert, ` ${label(state)} `);
    return labeled(line, color, text, left);
  };
  const [vertical, horizontal] = shared.position.split("-");
  target.renderTopBorder = (width: number, hidden: number) => {
    const raw = top(width, hidden);
    const line =
      vertical === "top" ? decorate(raw, horizontal === "left") : raw;
    borders.top = { width, line };
    return line;
  };
  target.renderBottomBorder = (width: number, hidden: number) => {
    const raw = bottom(width, hidden);
    const line =
      vertical === "bottom" ? decorate(raw, horizontal === "left") : raw;
    borders.bottom = { width, line };
    return line;
  };
  publish(editor, () => statusOf(current()));
  return true;
}

type Border = { width: number; line: string };

/**
 * Whether `rendered` is Pi's editor layout at `width`: the borders drawn at
 * that width, with the layout's rows between them. Another editor may render
 * Pi's at a smaller width, or drop, add, or indent rows; then a highlight
 * would land in the wrong cells.
 */
function native(
  rendered: readonly string[],
  width: number,
  layout: Layout,
  { top, bottom }: { top?: Border; bottom?: Border },
): boolean {
  return (
    top?.width === width &&
    bottom?.width === width &&
    rendered[0] === top.line &&
    rendered[layout.rows.length + 1] === bottom.line
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: modifyOtherKeys
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

function isEscape(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
}

/** Printable text in `data`, or undefined for control and modified keys. */
function printable(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  // xterm modifyOtherKeys; pi-tui's decodePrintableKey isn't exported yet.
  const match = data.match(MODIFY_OTHER_KEYS);
  if (match) {
    const modifier = (Number(match[1]) - 1) & ~(64 | 128); // ignore locks
    const code = Number(match[2]);
    return modifier & ~1 || code < 32 || code > 0x10ffff
      ? undefined
      : String.fromCodePoint(code);
  }
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return undefined;
  }
  return data;
}

/**
 * Put `label` into a border line, one dash in from the left or right edge.
 * The line must end in enough plain border dashes to make room, which keeps
 * Pi's scroll indicator and embedded working status intact. Otherwise the
 * line stays as it is.
 */
function labeled(
  line: string,
  color: (text: string) => string,
  label: string,
  left: boolean,
): string {
  const [open, close] = color("\0").split("\0");
  const size = visibleWidth(label);
  const dashes = "─".repeat(left ? size : size + 1);
  const suffix = dashes + close;
  if (!line.endsWith(suffix) || visibleWidth(line) < size + 4) return line;
  const rest = line.slice(0, line.length - suffix.length);
  if (!left) return `${rest}${close}${label}${color("─")}`;
  if (!rest.startsWith(`${open}─`)) return line;
  return `${color("─")}${label}${open}${rest.slice(open.length + 1)}${close}`;
}

const REVERSE = "\x1b[7m";
const UNREVERSE = "\x1b[27m";
// Codes that end reverse video: SGR resets and Pi's fake cursor end marker.
const RESETS = new Set(["\x1b[0m", "\x1b[m", UNREVERSE, "\x1b_pi:/fc\x07"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[_\]P][^\x07\x1b]*(?:\x07|\x1b\\))/y;

/** Reverse-video the selection in the editor rows Pi rendered. */
function highlight(
  rendered: string[],
  lines: readonly string[],
  spans: LineSpan[],
  { padding, rows }: Layout,
) {
  rows.forEach((row, i) => {
    const span = spans.find((s) => s.line === row.line);
    const line = lines[row.line];
    // Never style rows or lines that aren't there.
    if (!span || line === undefined || rendered[i + 1] === undefined) return;
    const { start, end } = span;
    const a = Math.max(start, row.start);
    const b = Math.min(end, row.start + row.length);
    let first = padding + visibleWidth(line.slice(row.start, a));
    let last = first + visibleWidth(line.slice(a, b));
    // An empty line in the selection shows one highlighted cell.
    if (line === "" && span.eol) [first, last] = [padding, padding + 1];
    if (last > first) rendered[i + 1] = reverse(rendered[i + 1], first, last);
  });
}

/** Reverse video for visible columns `[from, to)` of a rendered row. */
function reverse(row: string, from: number, to: number): string {
  let out = "";
  let col = 0;
  let inside = false;
  let i = 0;
  while (i < row.length) {
    ESCAPE.lastIndex = i;
    const code = ESCAPE.exec(row)?.[0];
    if (code) {
      out += code;
      if (inside && RESETS.has(code)) out += REVERSE;
      i += code.length;
      continue;
    }
    const next = row.indexOf("\x1b", i + 1);
    const text = row.slice(i, next === -1 ? row.length : next);
    for (const { segment } of segmenter.segment(text)) {
      if (inside && col >= to) {
        out += UNREVERSE;
        inside = false;
      }
      if (!inside && col >= from && col < to) {
        out += REVERSE;
        inside = true;
      }
      out += segment;
      col += visibleWidth(segment);
    }
    i += text.length;
  }
  return inside ? out + UNREVERSE : out;
}

/** Text inserted at the cursor of `before` to get `after`, if that's all. */
function insertion(before: Buffer, after: Buffer): string | undefined {
  const { lines, cursor } = before;
  const old = lines.join("\n");
  const now = after.lines.join("\n");
  let offset = cursor.col;
  for (let n = 0; n < cursor.line; n++) offset += lines[n].length + 1;
  const head = old.slice(0, offset);
  const tail = old.slice(offset);
  if (now.length < old.length || !now.startsWith(head) || !now.endsWith(tail))
    return undefined;
  return now.slice(offset, now.length - tail.length);
}

function fingerprint(buf: Buffer): string {
  return `${buf.cursor.line}:${buf.cursor.col}:${buf.lines.join("\n")}`;
}
