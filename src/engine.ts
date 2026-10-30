/**
 * Pure Vim engine: turns NORMAL-mode keys and a buffer snapshot into effects.
 * No Pi imports. Columns are UTF-16 offsets, as in Pi's editor.
 */

import { paragraphMotion, paragraphObject } from "./paragraph.js";
import { reflow } from "./reflow.js";
import { type Screen, screenMotion } from "./screen.js";
import { sentence, sentenceObject } from "./sentence.js";
import {
  blank,
  type Class,
  classify,
  clusters,
  firstNonBlank,
  markers,
  type Span,
  touchesMarker,
  width,
} from "./text.js";

export type Pos = { line: number; col: number };
export type Buffer = {
  lines: readonly string[];
  cursor: Pos;
  pastes?: ReadonlySet<number>;
  /** Terminal columns of a cluster; the host passes its own measure. */
  measure?: (cluster: string) => number;
  /** Manual prose wrapping width in terminal columns (default 79). */
  textWidth?: number;
  /**
   * The host's wrapped rows, for `gj`, `H`, and the like. Without it, each
   * line is one row and every row is visible.
   */
  screen?: () => Screen;
};
/** `block` registers come from Visual block mode and put as a block. */
export type Register = {
  text: string;
  linewise: boolean;
  block?: boolean;
  /** Display width of a block, for padding short rows when putting it. */
  width?: number;
};
export type Mode =
  | "insert"
  | "replace"
  | "normal"
  | "visual"
  | "vline"
  | "vblock";
export type Find = { key: string; arg: string };
type Search = { text: string; direction: 1 | -1 };
type Query = Search & { count: number; unsupported?: boolean };
/** `anchor` is the fixed end of a Visual selection; the cursor is the other. */
export type State = {
  mode: Mode;
  keys: readonly string[];
  find?: Find;
  /** Last accepted literal search, independent of character-find and dot. */
  search?: Search;
  query?: Query;
  anchor?: Pos;
  /** Visual block `$`: the block extends to the end of every line. */
  dollar?: boolean;
  /** A block's display columns, when `.` reselects one regardless of lines. */
  columns?: { left: number; right: number };
};
/**
 * Visual block `I`, `A`, or `c`: once INSERT mode ends, the typed text goes
 * into lines `top + 1` to `bottom` at display column `vcol` too.
 */
export type BlockInsert = {
  top: number;
  bottom: number;
  vcol: number;
  append: boolean;
  dollar: boolean;
  start: Pos;
};
export type Effect =
  | { kind: "move"; to: Pos }
  | { kind: "replace"; from: Pos; to: Pos; text: string; cursor: Pos }
  /** `copy` marks yanks, which also go to the system clipboard. */
  | { kind: "yank"; register: Register; copy: boolean }
  | { kind: "mode"; mode: Mode }
  | { kind: "undo" }
  | { kind: "redo" }
  /** `.`; a count replaces the change's own count. */
  | { kind: "repeat"; count?: number }
  /** Quit Pi; without `force`, only if the prompt is empty. */
  | { kind: "quit"; force: boolean }
  | { kind: "message"; text: string }
  /** Put the system clipboard (`"+p`); the host reads it and calls `putText`. */
  /** `quiet` puts our last copy without a warning if reading fails. */
  | { kind: "clipboard"; before: boolean; count: number; quiet?: boolean }
  | { kind: "refuse" };
/** `change` holds the keys of a completed change, for `.` to replay. */
export type Result = {
  state: State;
  effects: Effect[];
  change?: readonly string[];
  block?: BlockInsert;
};

/** The key `press` expects for Ctrl-V. */
export const CTRL_V = "\x16";
/** The key `press` expects for Ctrl-R. */
export const CTRL_R = "\x12";
const INDENT = "  ";

export const initial: State = { mode: "insert", keys: [] };

const LABELS: Record<Mode, string> = {
  insert: "INSERT",
  normal: "NORMAL",
  visual: "VISUAL",
  vline: "VISUAL LINE",
  vblock: "VISUAL BLOCK",
  replace: "REPLACE",
};

/** The mode indicator: pending keys, or the mode name. */
export function label(state: State): string {
  if (state.query) {
    const { text, direction, count } = state.query;
    return `${count > 1 ? count : ""}${direction === 1 ? "/" : "?"}${searchLabel(text)}`;
  }
  return state.keys.length ? state.keys.join("") : LABELS[state.mode];
}

/** Query text is data, never terminal control sequences (including bidi). */
function searchLabel(text: string): string {
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

/** Edit the pending query without touching the prompt or its Visual anchor. */
export function searchInput(
  state: State,
  input: { text: string } | "backspace" | "confirm" | "cancel",
  buf: Buffer,
): Result {
  const query = state.query;
  if (!query) return { state, effects: [] };
  const done = { ...state, keys: [], query: undefined };
  if (input === "cancel") return { state: done, effects: [] };
  if (input === "confirm") {
    if (query.unsupported)
      return {
        state: done,
        effects: [
          {
            kind: "message",
            text: "Operator search isn't supported; use Visual search, then an operator.",
          },
        ],
      };
    // An empty query reuses the text, but / and ? still choose the direction.
    const text = query.text || state.search?.text;
    if (!text) return noSearch(done);
    const search = { text, direction: query.direction };
    return searchMotion({ ...done, search }, buf, search, query.count);
  }
  const text =
    input === "backspace"
      ? query.text.slice(0, clusters(query.text, new Set()).at(-1)?.start ?? 0)
      : query.text + input.text;
  return { state: { ...state, query: { ...query, text } }, effects: [] };
}

function noSearch(state: State): Result {
  return { state, effects: [{ kind: "message", text: "No previous search." }] };
}

/** Literal matches must start/end at grapheme boundaries and avoid markers. */
function searchMotion(
  state: State,
  buf: Buffer,
  search: Search,
  count: number,
): Result {
  const text = buf.lines.join("\n");
  const boundaries = new Set<number>();
  const positions = new Map<number, Pos>();
  const opaque: Span[] = [];
  let offset = 0;
  let cursor = 0;
  buf.lines.forEach((line, row) => {
    if (row === buf.cursor.line) cursor = offset + buf.cursor.col;
    for (const span of clusters(line, buf.pastes)) {
      boundaries.add(offset + span.start);
      boundaries.add(offset + span.end);
      positions.set(offset + span.start, { line: row, col: span.start });
    }
    boundaries.add(offset);
    boundaries.add(offset + line.length);
    // Only an empty line has a Normal cursor at its newline.
    if (!line.length) positions.set(offset, { line: row, col: 0 });
    for (const span of markers(line, buf.pastes))
      opaque.push({ start: offset + span.start, end: offset + span.end });
    offset += line.length + 1;
  });
  const matches: number[] = [];
  for (
    let at = text.indexOf(search.text);
    at !== -1;
    at = text.indexOf(search.text, at + 1)
  ) {
    const end = at + search.text.length;
    if (
      positions.has(at) &&
      boundaries.has(end) &&
      !opaque.some((span) => span.start < end && at < span.end)
    )
      matches.push(at);
  }
  if (!matches.length)
    return {
      state,
      effects: [{ kind: "message", text: "Search: no match in the prompt." }],
    };
  if (search.direction === -1) matches.reverse();
  let first = matches.findIndex((at) =>
    search.direction === 1 ? at > cursor : at < cursor,
  );
  const wrapped = first === -1 || first + count > matches.length;
  if (first === -1) first = 0;
  const at = matches[(first + count - 1) % matches.length];
  const effects: Effect[] = [{ kind: "move", to: positions.get(at) as Pos }];
  if (wrapped)
    effects.push({
      kind: "message",
      text: "Search wrapped around the prompt.",
    });
  return {
    state: { ...state, dollar: undefined, columns: undefined },
    effects,
  };
}

export const isVisual = (mode: Mode) =>
  mode === "visual" || mode === "vline" || mode === "vblock";

const VISUAL_KEYS: Record<string, Mode> = {
  v: "visual",
  V: "vline",
  [CTRL_V]: "vblock",
};

/** A selected part of one line; `eol` means the line break is selected too. */
export type LineSpan = {
  line: number;
  start: number;
  end: number;
  eol: boolean;
};

/** The selected part of each line, for highlighting. */
export function selectedSpans(state: State, buf: Buffer): LineSpan[] {
  if (state.mode === "vblock" && state.anchor) return blockSpans(state, buf);
  const range = selection(state, buf);
  if (!range) return [];
  const spans: LineSpan[] = [];
  for (let n = range.from.line; n <= range.to.line; n++) {
    const length = buf.lines[n].length;
    const first = n === range.from.line && !range.linewise;
    const last = n === range.to.line && !range.linewise;
    spans.push({
      line: n,
      start: first ? range.from.col : 0,
      end: last ? range.to.col : length,
      eol: range.linewise || n < range.to.line,
    });
  }
  return spans;
}

/** A position moved inside the buffer, in case the text changed under it. */
function fit(buf: Buffer, pos: Pos): Pos {
  const line = Math.min(pos.line, buf.lines.length - 1);
  return { line, col: Math.min(pos.col, buf.lines[line].length) };
}

/** The Visual selection as a range with an exclusive end. */
export function selection(state: State, buf: Buffer): Range | undefined {
  if (!state.anchor || !isVisual(state.mode)) return undefined;
  const anchor = fit(buf, state.anchor);
  const { cursor } = buf;
  const forward =
    cursor.line > anchor.line ||
    (cursor.line === anchor.line && cursor.col >= anchor.col);
  const from = forward ? anchor : cursor;
  const to = forward ? cursor : anchor;
  if (state.mode === "vline" || state.mode === "vblock")
    return {
      from: { line: from.line, col: 0 },
      to: { line: to.line, col: 0 },
      linewise: true,
    };
  const span = clusters(buf.lines[to.line], buf.pastes).find(
    (s) => s.start === to.col,
  );
  // The character selected on an empty line is its newline.
  const end = span
    ? { line: to.line, col: span.end }
    : to.line < buf.lines.length - 1
      ? { line: to.line + 1, col: 0 }
      : to;
  return { from, to: end, linewise: false };
}

/** Handle Esc. `passthrough` means Pi should see the Esc (interrupt). */
export function esc(
  state: State,
  buf: Buffer,
): Result & { passthrough: boolean } {
  if (state.query)
    return { ...searchInput(state, "cancel", buf), passthrough: false };
  if (state.keys.length)
    return { state: { ...state, keys: [] }, effects: [], passthrough: false };
  if (state.mode === "normal") return { state, effects: [], passthrough: true };
  if (isVisual(state.mode))
    return {
      state: {
        mode: "normal",
        keys: [],
        find: state.find,
        search: state.search,
      },
      effects: [],
      passthrough: false,
    };
  const { cursor } = buf;
  const spans = clusters(buf.lines[cursor.line], buf.pastes);
  const ci = clusterIndex(spans, cursor.col);
  const col = ci > 0 ? spans[ci - 1].start : 0;
  return {
    state: { ...state, mode: "normal", keys: [] },
    effects: [{ kind: "move", to: { line: cursor.line, col } }],
    passthrough: false,
  };
}

/** Handle one printable key in NORMAL or Visual mode. */
export function press(
  state: State,
  key: string,
  buf: Buffer,
  register: Register | undefined,
  options: { unnamed?: boolean } = {},
): Result {
  if (state.query) return searchInput(state, { text: key }, buf);
  const prefix = state.keys.join("");
  const counted = /^(?:[1-9][0-9]*)?$/.test(prefix);
  const bare = uncounted(state.keys)
    .keys.join("")
    .replace(/^(?:"[+*])+/, "");
  const operator =
    OPERATORS.some((op) => op === bare) || bare === ">" || bare === "<";
  if ((counted || operator) && ["/", "?", "n", "N"].includes(key)) {
    const count = Math.min(Number(prefix) || 1, MAX_COUNT);
    const done = { ...state, keys: [] };
    if (key === "/" || key === "?")
      return {
        state: {
          ...done,
          query: {
            text: "",
            direction: key === "/" ? 1 : -1,
            count,
            unsupported: operator,
          },
        },
        effects: [],
      };
    if (operator)
      return {
        state: done,
        effects: [
          {
            kind: "message",
            text: "Operator search isn't supported; use Visual search, then an operator.",
          },
        ],
      };
    if (!state.search) return noSearch(done);
    const search = {
      ...state.search,
      direction: (key === "N"
        ? -state.search.direction
        : state.search.direction) as 1 | -1,
    };
    return searchMotion(done, buf, search, count);
  }
  const result = pressCommand(state, key, buf, register, options);
  return { ...result, state: { ...result.state, search: state.search } };
}

function pressCommand(
  state: State,
  key: string,
  buf: Buffer,
  register: Register | undefined,
  /** `unnamed`: `p` and `P` put the system clipboard, like `"+p`. */
  options: { unnamed?: boolean } = {},
): Result {
  const named = clipboardRegister(state, key, buf, register);
  if (named) return named;
  if (options.unnamed && !isVisual(state.mode)) {
    const keys = [...state.keys, key];
    const parsed = parse(keys);
    if (
      typeof parsed === "object" &&
      parsed.kind === "edit" &&
      (parsed.key === "p" || parsed.key === "P")
    ) {
      const effect: Effect = {
        kind: "clipboard",
        before: parsed.key === "P",
        count: parsed.count ?? 1,
        quiet: true,
      };
      const done: State = { mode: "normal", keys: [], find: state.find };
      return { state: done, effects: [effect], change: keys };
    }
  }
  if (isVisual(state.mode)) return pressVisual(state, key, buf, register);
  const keys = [...state.keys, key];
  const done = (mode: Mode, find = state.find): State => ({
    mode,
    keys: [],
    find,
  });
  if (!state.keys.length && VISUAL_KEYS[key]) {
    const mode = VISUAL_KEYS[key];
    return { state: { ...done(mode), anchor: buf.cursor }, effects: [] };
  }
  const parsed = parse(keys);
  if (parsed === "pending") return { state: { ...state, keys }, effects: [] };
  if (parsed === "invalid") return { state: done("normal"), effects: [] };
  const found = withFind(parsed, state.find);
  if (!found) return { state: done("normal"), effects: [] };
  const { command, find } = found;
  const effects = execute(command, buf, register);
  let mode: Mode = "normal";
  for (const e of effects) if (e.kind === "mode") mode = e.mode;
  const edits = effects.some((e) => e.kind === "replace") || mode !== "normal";
  const change =
    edits &&
    ((parsed.kind === "op" && parsed.op !== "y") ||
      (parsed.kind === "edit" && CHANGES.has(parsed.key)))
      ? keys
      : undefined;
  return { state: done(mode, find), effects, change };
}

const CLIPBOARD = new Set(["+", "*"]);
const CLIPBOARD_EDITS = new Set("xXsSDCY");
const CLIPBOARD_OPS = new Set(["d", "c", "y"]);

/**
 * `"+` and `"*` name the system clipboard: yanks, deletes, and changes also
 * copy to it, and `"+p` asks the host to put it. Both are the same register;
 * `"*` isn't X11's primary selection. Other registers aren't supported.
 * Returns undefined when the keys don't start with a register.
 */
function clipboardRegister(
  state: State,
  key: string,
  buf: Buffer,
  register: Register | undefined,
): Result | undefined {
  const keys = [...state.keys, key];
  // The register comes first, or right after a count: `"+2dd`, `2"+dd`.
  let at = 0;
  while (at < keys.length && /^[0-9]$/.test(keys[at])) at++;
  if (keys[at] !== '"' || (at > 0 && keys[0] === "0")) return undefined;
  const pending = { state: { ...state, keys }, effects: [] };
  const cancel = {
    state: isVisual(state.mode)
      ? { ...state, keys: [] }
      : ({ mode: "normal", keys: [], find: state.find } as State),
    effects: [],
  };
  // Repeating the prefix is fine, as in Vim: `"+"+p`.
  let i = at;
  while (keys[i] === '"') {
    if (i + 1 >= keys.length) return pending;
    if (!CLIPBOARD.has(keys[i + 1])) return cancel;
    i += 2;
  }
  const after = keys.slice(i);
  if (!after.length) return pending;
  // Counts on both sides multiply: `2"+3dd` deletes six lines.
  let j = 0;
  while (j < after.length && /^[0-9]$/.test(after[j]) && after[0] !== "0") j++;
  const a = at ? Number(keys.slice(0, at).join("")) : undefined;
  const b = j ? Number(after.slice(0, j).join("")) : undefined;
  const count =
    a === undefined && b === undefined
      ? []
      : [...String(Math.min((a ?? 1) * (b ?? 1), MAX_COUNT))];
  const inner = [...count, ...after.slice(j)];
  if (inner.length === count.length) return pending;
  if (isVisual(state.mode)) {
    const op = inner[0];
    if (at > 0 || j > 0 || inner.length !== 1) return cancel;
    // Visual `p` keeps using the unnamed register.
    if (op === "p" || op === "P")
      return pressVisual({ ...state, keys: [] }, op, buf, register);
    if (!(op in VISUAL_OPS)) return cancel;
    const result = pressVisual({ ...state, keys: [] }, op, buf, register);
    return { ...result, effects: copying(result.effects) };
  }
  const parsed = parse(inner);
  if (parsed === "pending") return pending;
  if (parsed === "invalid") return cancel;
  if (parsed.kind === "edit" && (parsed.key === "p" || parsed.key === "P")) {
    const effect: Effect = {
      kind: "clipboard",
      before: parsed.key === "P",
      count: parsed.count ?? 1,
    };
    return { state: cancel.state, effects: [effect], change: keys };
  }
  const allowed =
    (parsed.kind === "op" && CLIPBOARD_OPS.has(parsed.op)) ||
    (parsed.kind === "edit" && CLIPBOARD_EDITS.has(parsed.key));
  if (!allowed) return cancel;
  let result: Result = { state: { ...state, keys: [] }, effects: [] };
  for (const k of inner) result = press(result.state, k, buf, register);
  const change = result.change && keys;
  return { ...result, effects: copying(result.effects), change };
}

/**
 * Split a change's keys into the keys without counts and their total count,
 * so `.` can put its own count in: `d3w` is `dw` with count 3.
 */
export function uncounted(keys: readonly string[]): {
  keys: string[];
  count?: number;
} {
  const out: string[] = [];
  let count: number | undefined;
  let i = 0;
  const digits = () => {
    let run = "";
    while (i < keys.length && /^[0-9]$/.test(keys[i])) {
      if (run === "" && keys[i] === "0") break;
      run += keys[i++];
    }
    if (run) count = Math.min((count ?? 1) * Number(run), MAX_COUNT);
  };
  // Counts come first, after a register, and after an operator.
  digits();
  while (keys[i] === '"' && i + 1 < keys.length) {
    out.push(keys[i], keys[i + 1]);
    i += 2;
    digits();
  }
  const op = OPERATORS.find((o) => keys.slice(i, i + o.length).join("") === o);
  if (op) {
    out.push(...keys.slice(i, i + op.length));
    i += op.length;
    digits();
  }
  out.push(...keys.slice(i));
  return { keys: out, count };
}

/** Whether a command takes a count, like `dw` or `x` but not `i` or `o`. */
export function countable(keys: readonly string[]): boolean {
  let i = 0;
  while (keys[i] === '"') i += 2;
  return parse(["2", ...keys.slice(i)]) !== "invalid";
}

/**
 * What an INSERT session did, relative to where it started: how many
 * characters (graphemes) it deleted before and after that spot, and the text
 * it left there.
 */
export type Typed = { back: number; forward: number; text: string };

/** Grapheme boundaries of a buffer's text, and the index of the cursor. */
function graphemes(buf: Buffer): { parts: string[]; at: number } {
  const parts: string[] = [];
  let at = 0;
  buf.lines.forEach((line, n) => {
    if (n > 0) parts.push("\n");
    if (n === buf.cursor.line) at = parts.length;
    for (const span of clusters(line, buf.pastes)) {
      if (n === buf.cursor.line && span.start < buf.cursor.col)
        at = parts.length + 1;
      parts.push(line.slice(span.start, span.end));
    }
  });
  return { parts, at };
}

/**
 * Compare the editor where INSERT started with where it ended. The edit must
 * contain both cursors, which keeps Backspace and Delete apart even among
 * repeated characters.
 */
export function typed(before: Buffer, after: Buffer): Typed {
  const old = graphemes(before);
  const now = graphemes(after);
  const a = old.parts;
  const b = now.parts;
  let prefix = 0;
  const most = Math.min(old.at, now.at);
  while (prefix < most && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const tail = Math.min(a.length - old.at, b.length - now.at);
  while (suffix < tail && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
    suffix++;
  return {
    back: old.at - prefix,
    forward: a.length - suffix - old.at,
    text: b.slice(prefix, b.length - suffix).join(""),
  };
}

/** Do what an INSERT session did again at the cursor. */
export function retype(buf: Buffer, edit: Typed): Effect[] {
  const { parts, at } = graphemes(buf);
  const offset = (index: number) => parts.slice(0, index).join("").length;
  const start = offset(Math.max(0, at - edit.back));
  const end = offset(Math.min(parts.length, at + edit.forward));
  const from = posOf(buf.lines, start);
  const to = posOf(buf.lines, end);
  if (end > start && touches(buf, { from, to, linewise: false }))
    return [{ kind: "refuse" }];
  if (!edit.text && end === start) return [];
  const after = splice(buf.lines, from, to, edit.text);
  const cursor = posOf(after, start + edit.text.length);
  return [{ kind: "replace", from, to, text: edit.text, cursor }];
}

function posOf(lines: readonly string[], offset: number): Pos {
  let line = 0;
  while (line < lines.length - 1 && offset > lines[line].length) {
    offset -= lines[line].length + 1;
    line++;
  }
  return { line, col: Math.min(offset, lines[line].length) };
}

/** The size of a Visual selection, for `.` to select the same again. */
export type Extent = {
  mode: Mode;
  lines: number;
  /** Characters on a one-line charwise selection, block width otherwise. */
  width: number;
  /** End display column of a multi-line charwise selection. */
  col: number;
  dollar?: boolean;
};

export function extent(state: State, buf: Buffer): Extent | undefined {
  const anchor = state.anchor;
  if (!anchor || !isVisual(state.mode)) return undefined;
  const range = selection(state, buf) as Range;
  const lines = Math.abs(buf.cursor.line - anchor.line) + 1;
  if (state.mode === "vblock") {
    const { left, right } = blockBounds(state, buf);
    return {
      mode: "vblock",
      lines,
      width: right - left,
      col: 0,
      dollar: state.dollar,
    };
  }
  const text = buf.lines[range.from.line].slice(range.from.col, range.to.col);
  const width =
    lines === 1 ? Math.max(1, clusters(text, buf.pastes).length) : 0;
  const end = clamp(buf, {
    line: range.to.line,
    col: Math.max(0, range.to.col - 1),
  });
  return { mode: state.mode, lines, width, col: vcolOf(buf, end).v };
}

/** Select an extent again, starting at the cursor, the way Vim's `.` does. */
export function reselect(
  extent: Extent,
  buf: Buffer,
): { state: State; cursor: Pos } {
  const { cursor, lines } = buf;
  const line = Math.min(lines.length - 1, cursor.line + extent.lines - 1);
  const state: State = {
    mode: extent.mode,
    keys: [],
    anchor: cursor,
    dollar: extent.dollar,
  };
  if (extent.mode === "vline")
    return { state, cursor: { line, col: cursor.col } };
  if (extent.mode === "vblock") {
    // The block keeps its columns even where lines are shorter.
    const left = vcolOf(buf, cursor).v;
    const columns = { left, right: left + Math.max(1, extent.width) };
    const end = clamp(buf, {
      line,
      col: covering(buf, line, columns.right - 1),
    });
    return { state: { ...state, columns }, cursor: end };
  }
  if (extent.lines > 1)
    return {
      state,
      cursor: clamp(buf, { line, col: covering(buf, line, extent.col) }),
    };
  const spans = clusters(lines[cursor.line], buf.pastes);
  const ci = clusterIndex(spans, cursor.col);
  const end = spans[Math.min(spans.length - 1, ci + extent.width - 1)];
  return { state, cursor: { line, col: end?.start ?? cursor.col } };
}

/** Yanks in `effects`, made to copy to the system clipboard too. */
function copying(effects: Effect[]): Effect[] {
  return effects.map((e) => (e.kind === "yank" ? { ...e, copy: true } : e));
}

/** Put `register` at the cursor `count` times, as `p` or `P` would. */
export function putText(
  buf: Buffer,
  register: Register,
  before: boolean,
  count: number,
): Effect[] {
  return put(before, buf, repeated(buf, register, count));
}

/** Visual mode: motions move the cursor; operators act on the selection. */
function pressVisual(
  state: State,
  key: string,
  buf: Buffer,
  register: Register | undefined,
): Result {
  const keys = [...state.keys, key];
  const stay = (change: Partial<State> = {}): State => ({
    ...state,
    keys: [],
    ...change,
  });
  const leave = (mode: Mode): State => ({ mode, keys: [], find: state.find });
  const block = state.mode === "vblock";
  const lines = (): Range => selection(state, buf) as Range;
  if (keys.length === 1) {
    const mode = VISUAL_KEYS[key];
    if (mode) {
      const next = mode === state.mode ? leave("normal") : stay({ mode });
      return { state: next, effects: [] };
    }
    if (block) {
      const result = pressBlock(state, key, buf);
      if (result) return { ...result, state: result.state ?? leave("normal") };
    }
    if (CASES[key])
      return {
        state: leave("normal"),
        effects: transform(selectedSpans(state, buf), CASES[key], buf),
      };
    if (key === "J") {
      const { from, to } = lines();
      const top = { ...buf, cursor: { line: from.line, col: 0 } };
      return {
        state: leave("normal"),
        effects: join(top, Math.max(2, to.line - from.line + 1)),
      };
    }
    if (key === ">" || key === "<") {
      const { from, to } = lines();
      return {
        state: leave("normal"),
        effects: indent(buf, from.line, to.line, key),
      };
    }
    if (key === "r") return { state: { ...state, keys }, effects: [] };
    if (key === "o" || key === "O") {
      const to = state.anchor ?? buf.cursor;
      const effects: Effect[] = [{ kind: "move", to }];
      return { state: stay({ anchor: buf.cursor }), effects };
    }
    const op = VISUAL_OPS[key];
    if (op) {
      const range = selection(state, buf);
      const effects = range ? operate(op, range, buf, true) : [];
      const insert = effects.some((e) => e.kind === "mode");
      return { state: leave(insert ? "insert" : "normal"), effects };
    }
    if (key === "p" || key === "P") {
      const range = selection(state, buf);
      const effects = range && register ? paste(range, buf, register) : [];
      return { state: leave("normal"), effects };
    }
    if (key === "i" || key === "a")
      return { state: { ...state, keys }, effects: [] };
  }
  if (keys.length === 2 && keys[0] === "g" && (key === "q" || key === "w")) {
    const range = selection(state, buf);
    return {
      state: leave("normal"),
      effects: range
        ? operate(key === "q" ? "gq" : "gw", range, buf, true)
        : [],
    };
  }
  if (keys.length === 2 && keys[0] === "r")
    return {
      state: leave("normal"),
      effects: replaceAll(selectedSpans(state, buf), key, buf),
    };
  // Reuse operator parsing for counted objects without making counted INSERT
  // entries valid. Existing line-local objects keep their selection behavior.
  const object = /^(?:[1-9][0-9]*)?[ia]/.test(keys.join(""))
    ? parse(["d", ...keys])
    : undefined;
  if (object === "pending") return { state: { ...state, keys }, effects: [] };
  if (
    object &&
    typeof object !== "string" &&
    object.kind === "op" &&
    object.target.kind === "object"
  ) {
    const target = object.target;
    const anchor = state.anchor ?? buf.cursor;
    const forward =
      anchor.line < buf.cursor.line ||
      (anchor.line === buf.cursor.line && anchor.col < buf.cursor.col);
    const extended =
      anchor.line !== buf.cursor.line || anchor.col !== buf.cursor.col;
    const direction = extended ? (forward ? 1 : -1) : undefined;
    if (target.object === "p") {
      // A single selected line initializes the whole paragraph, unless it
      // already covers the entire run. Multiline selections keep their kind.
      const multiline = anchor.line !== buf.cursor.line;
      const count = target.count ?? 1;
      const fresh = multiline
        ? undefined
        : paragraphObject(buf, target.around, count);
      // Single-line selections first require a complete counted object. If V
      // already covers its first run, extend once more, keeping any leading
      // separator selected by the fresh around-object at EOF.
      if (!multiline && !fresh) return { state: stay(), effects: [] };
      const current =
        state.mode === "vline" ? paragraphObject(buf, false) : undefined;
      const extending =
        multiline || (current && current.from.line === current.to.line);
      const range = extending
        ? (paragraphObject(
            buf,
            target.around,
            count,
            anchor.line > buf.cursor.line ? -1 : 1,
          ) ?? fresh)
        : fresh;
      if (!range) return { state: stay(), effects: [] };
      const edge =
        extending && anchor.line > buf.cursor.line ? range.from : range.to;
      return {
        state: stay(
          multiline
            ? {}
            : {
                mode: "vline",
                anchor:
                  fresh && anchor.line !== fresh.from.line
                    ? fresh.from
                    : anchor,
              },
        ),
        effects: [
          {
            kind: "move",
            to: clamp(buf, {
              line: edge.line,
              col: 0,
            }),
          },
        ],
      };
    }
    const range =
      target.object === "s"
        ? sentenceObject(buf, target.around, target.count ?? 1, true, direction)
        : objectRange(buf, target.around, target.object, target.count);
    if (
      !range ||
      range.to.line < range.from.line ||
      (range.to.line === range.from.line && range.to.col <= range.from.col)
    )
      return { state: stay(), effects: [] };
    // An exclusive end in column zero belongs to the preceding line, not the
    // first character of the following sentence. Clamp by grapheme, not byte.
    const end =
      range.to.col === 0 && range.to.line > range.from.line
        ? clamp(buf, {
            line: range.to.line - 1,
            col: buf.lines[range.to.line - 1].length,
          })
        : clamp(buf, { line: range.to.line, col: range.to.col - 1 });
    const extending = target.object === "s" && extended;
    return {
      state: stay({ mode: "visual", anchor: extending ? anchor : range.from }),
      effects: [{ kind: "move", to: extending && !forward ? range.from : end }],
    };
  }
  const parsed = parse(keys);
  if (parsed === "pending") return { state: { ...state, keys }, effects: [] };
  if (parsed === "invalid" || parsed.kind !== "motion")
    return { state: stay(), effects: [] };
  const found = withFind(parsed, state.find);
  const target = found && resolve(found.command as Motion, buf, false);
  // Vertical motions keep a block's `$`; others end it.
  const vertical = /^(j|k|gg|G|gj|gk|H|M|L)$/.test(parsed.key);
  return {
    state: stay({
      find: found?.find ?? state.find,
      dollar: vertical && state.dollar,
    }),
    effects: target ? [{ kind: "move", to: clamp(buf, target.to) }] : [],
  };
}

/** Visual block keys that differ from the other Visual modes. */
function pressBlock(
  state: State,
  key: string,
  buf: Buffer,
): (Omit<Result, "state"> & { state?: State }) | undefined {
  const anchor = state.anchor ?? buf.cursor;
  const { cursor, lines } = buf;
  const stay = (change: Partial<State>): State => ({
    ...state,
    keys: [],
    ...change,
  });
  switch (key) {
    case "$": {
      const to = clamp(buf, {
        line: cursor.line,
        col: lines[cursor.line].length,
      });
      return { state: stay({ dollar: true }), effects: [{ kind: "move", to }] };
    }
    case "O": {
      const vc = vcolOf(buf, cursor).v;
      const va = vcolOf(buf, anchor).v;
      const to = clamp(buf, {
        line: cursor.line,
        col: colAt(buf, cursor.line, va),
      });
      const other = clamp(buf, {
        line: anchor.line,
        col: colAt(buf, anchor.line, vc),
      });
      return {
        state: stay({ anchor: other }),
        effects: [{ kind: "move", to }],
      };
    }
    case "d":
    case "x":
    case "y":
    case "c":
    case "s":
      return blockOperate(
        key === "x" ? "d" : key === "s" ? "c" : (key as Op),
        state,
        buf,
      );
    case "I":
    case "A":
      return blockInsert(key === "A", state, buf);
    case "p":
    case "P":
      return { state: stay({}), effects: [] };
  }
  return undefined;
}

/** Display column and width of the cluster at `pos`. */
function vcolOf(buf: Buffer, pos: Pos): { v: number; w: number } {
  const cols = columns(buf, buf.lines[pos.line]);
  const c = cols.find((col) => pos.col < col.end);
  return c ? { v: c.v, w: c.w } : { v: lineWidth(cols), w: 1 };
}

function columns(buf: Buffer, line: string) {
  const measure = buf.measure ?? width;
  let v = 0;
  return clusters(line, buf.pastes).map((span) => {
    const w = measure(line.slice(span.start, span.end));
    const col = { ...span, v, w };
    v += w;
    return col;
  });
}

const lineWidth = (cols: { v: number; w: number }[]) => {
  const last = cols.at(-1);
  return last ? last.v + last.w : 0;
};

/** Column of the first cluster at or after display column `v`. */
function colAt(buf: Buffer, line: number, v: number): number {
  const c = columns(buf, buf.lines[line]).find((col) => col.v >= v);
  return c ? c.start : buf.lines[line].length;
}

/** Column of the cluster covering display column `v`, or the line end. */
function covering(buf: Buffer, line: number, v: number): number {
  const c = columns(buf, buf.lines[line]).find((col) => v < col.v + col.w);
  return c ? c.start : buf.lines[line].length;
}

function blockBounds(state: State, buf: Buffer) {
  const anchor = fit(buf, state.anchor ?? buf.cursor);
  const { cursor } = buf;
  const a = vcolOf(buf, anchor);
  const c = vcolOf(buf, cursor);
  const top = Math.min(anchor.line, cursor.line);
  const bottom = Math.max(anchor.line, cursor.line);
  const dollar = state.dollar ? Number.POSITIVE_INFINITY : undefined;
  if (state.columns)
    return {
      top,
      bottom,
      ...state.columns,
      right: dollar ?? state.columns.right,
    };
  return {
    top,
    bottom,
    left: Math.min(a.v, c.v),
    right: dollar ?? Math.max(a.v + a.w, c.v + c.w),
  };
}

function blockSpans(state: State, buf: Buffer): LineSpan[] {
  const { top, bottom, left, right } = blockBounds(state, buf);
  const spans: LineSpan[] = [];
  for (let line = top; line <= bottom; line++) {
    const inside = columns(buf, buf.lines[line]).filter(
      (c) => c.v >= left && c.v < right,
    );
    const start = inside[0]?.start ?? colAt(buf, line, left);
    spans.push({ line, start, end: inside.at(-1)?.end ?? start, eol: false });
  }
  return spans;
}

function blockOperate(
  op: Op,
  state: State,
  buf: Buffer,
): Omit<Result, "state"> & { state?: State } {
  const { lines } = buf;
  const spans = blockSpans(state, buf);
  const { top, bottom, left, right } = blockBounds(state, buf);
  if (
    spans.some((s) => touchesMarker(lines[s.line], s.start, s.end, buf.pastes))
  )
    return { effects: [{ kind: "refuse" }] };
  const text = spans.map((s) => lines[s.line].slice(s.start, s.end)).join("\n");
  const corner = { line: top, col: colAt(buf, top, left) };
  const yank: Effect = {
    kind: "yank",
    register: {
      text,
      linewise: false,
      block: true,
      width: state.dollar ? undefined : right - left,
    },
    copy: op === "y",
  };
  if (op === "y")
    return { effects: [yank, { kind: "move", to: clamp(buf, corner) }] };
  const effects: Effect[] = [yank];
  for (const s of spans)
    if (s.end > s.start)
      effects.push({
        kind: "replace",
        from: { line: s.line, col: s.start },
        to: { line: s.line, col: s.end },
        text: "",
        cursor: corner,
      });
  if (op === "d")
    return {
      effects: [
        ...effects,
        { kind: "move", to: clamp(apply(buf, effects), corner) },
      ],
    };
  const block = {
    top,
    bottom,
    vcol: left,
    append: false,
    dollar: false,
    start: corner,
  };
  return {
    state: { mode: "insert", keys: [], find: state.find },
    effects: [
      ...effects,
      { kind: "move", to: corner },
      { kind: "mode", mode: "insert" },
    ],
    block,
  };
}

function blockInsert(
  append: boolean,
  state: State,
  buf: Buffer,
): Omit<Result, "state"> & { state: State } {
  const { top, bottom, left, right } = blockBounds(state, buf);
  const line = buf.lines[top];
  const dollar = append && Boolean(state.dollar);
  const effects: Effect[] = [];
  let start: Pos;
  let vcol = left;
  if (!append) start = { line: top, col: colAt(buf, top, left) };
  else if (dollar) start = { line: top, col: line.length };
  else {
    vcol = right;
    const w = lineWidth(columns(buf, line));
    if (w < right) {
      // Pad a short top line out to the block's right edge.
      const end = { line: top, col: line.length };
      const pad = " ".repeat(right - w);
      start = { line: top, col: line.length + pad.length };
      effects.push({
        kind: "replace",
        from: end,
        to: end,
        text: pad,
        cursor: start,
      });
    } else start = { line: top, col: colAt(buf, top, right) };
  }
  return {
    state: { mode: "insert", keys: [], find: state.find },
    effects: [
      ...effects,
      { kind: "move", to: start },
      { kind: "mode", mode: "insert" },
    ],
    block: { top, bottom, vcol, append, dollar, start },
  };
}

/** After a block insert: put `text` into the block's other lines too. */
export function replicate(
  block: BlockInsert,
  text: string,
  buf: Buffer,
): Effect[] {
  const effects: Effect[] = [];
  const bottom = Math.min(block.bottom, buf.lines.length - 1);
  for (let line = block.top + 1; line <= bottom; line++) {
    const current = buf.lines[line];
    const w = lineWidth(columns(buf, current));
    let col: number;
    let pad = "";
    if (block.dollar) col = current.length;
    else if (w < block.vcol) {
      // `I` skips short lines; `A` pads them out to the block's edge.
      if (!block.append) continue;
      col = current.length;
      pad = " ".repeat(block.vcol - w);
    } else col = colAt(buf, line, block.vcol);
    const at = { line, col };
    effects.push({
      kind: "replace",
      from: at,
      to: at,
      text: pad + text,
      cursor: block.start,
    });
  }
  effects.push({ kind: "move", to: clamp(apply(buf, effects), block.start) });
  return effects;
}

/** Visual `r{c}`: replace every selected character. */
function replaceAll(spans: LineSpan[], char: string, buf: Buffer): Effect[] {
  return transform(spans, (text) => char.repeat(clusters(text).length), buf);
}

const toggleCase = (text: string) =>
  [...text]
    .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
    .join("");
const CASES: Record<string, (text: string) => string> = {
  "~": toggleCase,
  u: (text) => text.toLowerCase(),
  U: (text) => text.toUpperCase(),
};

/** The parts of each line a range covers. */
function rangeSpans({ from, to, linewise }: Range, buf: Buffer): LineSpan[] {
  const spans: LineSpan[] = [];
  for (let line = from.line; line <= to.line; line++) {
    const start = linewise || line > from.line ? 0 : from.col;
    const end = linewise || line < to.line ? buf.lines[line].length : to.col;
    spans.push({ line, start, end, eol: false });
  }
  return spans;
}

/** Rewrite each span's text, then put the cursor at the first span. */
function transform(
  spans: LineSpan[],
  rewrite: (text: string) => string,
  buf: Buffer,
): Effect[] {
  const effects: Effect[] = [];
  if (!spans.length) return [];
  // Vim: the cursor goes to the start, even on an empty line.
  const first = spans[0];
  for (const s of spans) {
    if (s.end <= s.start) continue;
    const line = buf.lines[s.line];
    if (touchesMarker(line, s.start, s.end, buf.pastes))
      return [{ kind: "refuse" }];
    const from = { line: s.line, col: s.start };
    const to = { line: s.line, col: s.end };
    const text = rewrite(line.slice(s.start, s.end));
    effects.push({ kind: "replace", from, to, text, cursor: from });
  }
  const start = { line: first.line, col: first.start };
  return [...effects, { kind: "move", to: clamp(apply(buf, effects), start) }];
}

/** `>` and `<`: indent or outdent lines `first` to `last`. */
function indent(
  buf: Buffer,
  first: number,
  last: number,
  dir: string,
): Effect[] {
  const effects: Effect[] = [];
  for (let line = first; line <= last; line++) {
    const text = buf.lines[line];
    const at = { line, col: 0 };
    if (dir === ">") {
      if (text !== "")
        effects.push({
          kind: "replace",
          from: at,
          to: at,
          text: INDENT,
          cursor: at,
        });
      continue;
    }
    const n = Math.min(INDENT.length, text.length - text.trimStart().length);
    if (n)
      effects.push({
        kind: "replace",
        from: at,
        to: { line, col: n },
        text: "",
        cursor: at,
      });
  }
  const after = apply(buf, effects);
  const to = { line: first, col: firstNonBlank(after.lines[first]) };
  return [...effects, { kind: "move", to: clamp(after, to) }];
}

/** Put a block register at the cursor column, one line per row. */
function blockPut(before: boolean, buf: Buffer, register: Register): Effect[] {
  const { cursor } = buf;
  const here = vcolOf(buf, cursor);
  const empty = buf.lines[cursor.line] === "";
  const vcol = before || empty ? here.v : here.v + here.w;
  let current: Buffer = buf;
  const effects: Effect[] = [];
  register.text.split("\n").forEach((segment, i) => {
    const line = cursor.line + i;
    let effect: Effect;
    if (line >= current.lines.length) {
      const last = current.lines.length - 1;
      const end = { line: last, col: current.lines[last].length };
      const text = `\n${" ".repeat(vcol)}${segment}`;
      effect = { kind: "replace", from: end, to: end, text, cursor };
    } else {
      const w = lineWidth(columns(buf, current.lines[line]));
      const col =
        w < vcol ? current.lines[line].length : colAt(current, line, vcol);
      const at = { line, col };
      // Keep the rectangle: pad a short row if text follows it.
      const short = (register.width ?? 0) - lineWidth(columns(buf, segment));
      const tail =
        col < current.lines[line].length ? " ".repeat(Math.max(0, short)) : "";
      const text = " ".repeat(Math.max(0, vcol - w)) + segment + tail;
      effect = { kind: "replace", from: at, to: at, text, cursor };
    }
    effects.push(effect);
    current = apply(current, [effect]);
  });
  const to = { line: cursor.line, col: colAt(current, cursor.line, vcol) };
  return [...effects, { kind: "move", to: clamp(current, to) }];
}

/** Visual `p`: replace the selection with the register, keeping what was there. */
function paste(range: Range, buf: Buffer, register: Register): Effect[] {
  if (touches(buf, range)) return [{ kind: "refuse" }];
  const { lines } = buf;
  const { from, linewise } = range;
  const to = linewise
    ? { line: range.to.line, col: lines[range.to.line].length }
    : range.to;
  const text =
    register.linewise && !linewise ? `\n${register.text}\n` : register.text;
  return [
    {
      kind: "yank",
      register: { text: textOf(lines, range), linewise },
      copy: false,
    },
    ...replace(
      buf,
      linewise ? { line: from.line, col: 0 } : from,
      to,
      text,
      from,
      "normal",
    ),
  ];
}

const VISUAL_OPS: Record<string, Op> = {
  d: "d",
  x: "d",
  c: "c",
  s: "c",
  y: "y",
};

/** Track `f F t T` for `;` and `,`, and turn those into the motion they repeat. */
function withFind(
  parsed: Command,
  find: Find | undefined,
): { command: Command; find: Find | undefined } | undefined {
  const motion = parsed.kind === "op" ? parsed.target : parsed;
  if (motion.kind !== "motion") return { command: parsed, find };
  if (FINDS.has(motion.key) && motion.arg)
    return { command: parsed, find: { key: motion.key, arg: motion.arg } };
  if (motion.key !== ";" && motion.key !== ",")
    return { command: parsed, find };
  if (!find) return undefined;
  const key = motion.key === ";" ? find.key : REVERSE[find.key];
  const repeated = { ...motion, key, arg: find.arg, repeat: true };
  const command =
    parsed.kind === "op" ? { ...parsed, target: repeated } : repeated;
  return { command, find };
}

/**
 * Replace mode: type `char` over the character under the cursor, or append it
 * at the end of the line. `original` is what was overwritten ("" if nothing),
 * for Backspace to restore.
 */
export function overtype(
  buf: Buffer,
  char: string,
): { effects: Effect[]; original?: string } {
  const { cursor, lines } = buf;
  const line = lines[cursor.line];
  const span = clusters(line, buf.pastes).find((s) => s.start === cursor.col);
  if (span && touchesMarker(line, span.start, span.end, buf.pastes))
    return { effects: [{ kind: "refuse" }] };
  const to = span ? { line: cursor.line, col: span.end } : cursor;
  const after = { line: cursor.line, col: cursor.col + char.length };
  const effects: Effect[] = [
    { kind: "replace", from: cursor, to, text: char, cursor: after },
  ];
  return { effects, original: span ? line.slice(span.start, span.end) : "" };
}

/**
 * Backspace in Replace mode: step back over the last typed character and put
 * `original` back. Without `original`, only move left, as in Vim.
 */
export function untype(buf: Buffer, original?: string): Effect[] {
  const { cursor, lines } = buf;
  const line = lines[cursor.line];
  const spans = clusters(line, buf.pastes);
  let prev: Span | undefined;
  for (const span of spans) if (span.end <= cursor.col) prev = span;
  if (!prev) {
    // At the start of a line, move to the end of the previous one.
    if (original !== undefined || cursor.line === 0) return [];
    const up = cursor.line - 1;
    return [{ kind: "move", to: { line: up, col: lines[up].length } }];
  }
  const from = { line: cursor.line, col: prev.start };
  // Never restore over a pasted block; just move.
  const marker = touchesMarker(line, prev.start, prev.end, buf.pastes);
  if (original === undefined || marker) return [{ kind: "move", to: from }];
  return [{ kind: "replace", from, to: cursor, text: original, cursor: from }];
}

/** Apply effects to a buffer snapshot. */
export function apply(buf: Buffer, effects: readonly Effect[]): Buffer {
  let { lines, cursor } = buf;
  for (const effect of effects) {
    if (effect.kind === "move") cursor = effect.to;
    if (effect.kind === "replace") {
      lines = splice(lines, effect.from, effect.to, effect.text);
      cursor = effect.cursor;
    }
  }
  return { ...buf, lines, cursor };
}

// --- Parsing ---------------------------------------------------------------

const MAX_COUNT = 9999;
const MOTIONS = new Set("hjklwbeWBE0^$G;,%(){}HML");
const COUNTED = new Set("hjklwbeWBEG;,fFtTg$(){}HL");
const FINDS = new Set("fFtT");
const REVERSE: Record<string, string> = { f: "F", F: "f", t: "T", T: "t" };
const EDITS = new Set([..."iaIAoOxXsSDCYJpPu.~R", CTRL_R]);
const COUNTED_EDITS = new Set("xXsSCDJpP~.r");
const CHANGES = new Set([
  "R",
  "X",
  "~",
  "i",
  "a",
  "I",
  "A",
  "o",
  "O",
  "x",
  "s",
  "S",
  "D",
  "C",
  "J",
  "p",
  "P",
  "r",
  ">>",
  "<<",
]);
const OBJECTS = new Set("wWsp\"'`()[]{}");

type Op = "d" | "c" | "y" | "gu" | "gU" | "gq" | "gw";
const OPERATORS: readonly Op[] = ["d", "c", "y", "gu", "gU", "gq", "gw"];
type Motion = {
  kind: "motion";
  key: string;
  arg?: string;
  count?: number;
  /** A `;`/`,` repeat: `t` and `T` skip an adjacent match. */
  repeat?: boolean;
};
type Target =
  | Motion
  | { kind: "object"; around: boolean; object: string; count?: number }
  | { kind: "line"; count?: number };
type Command =
  | Motion
  | { kind: "op"; op: Op; target: Target }
  | { kind: "edit"; key: string; arg?: string; count?: number };

function parse(keys: readonly string[]): Command | "pending" | "invalid" {
  let i = 0;
  const count = (): number | undefined => {
    let digits = "";
    while (i < keys.length && /^[0-9]$/.test(keys[i])) {
      if (digits === "" && keys[i] === "0") break;
      digits += keys[i++];
    }
    return digits ? Math.min(Number(digits), MAX_COUNT) : undefined;
  };
  const motion = (n?: number): Motion | "pending" | "invalid" => {
    if (i >= keys.length) return "pending";
    const key = keys[i++];
    if (n !== undefined && !COUNTED.has(key)) return "invalid";
    if (MOTIONS.has(key)) return { kind: "motion", key, count: n };
    if (key === "g" || FINDS.has(key)) {
      if (i >= keys.length) return "pending";
      const arg = keys[i++];
      if (key !== "g") return { kind: "motion", key, arg, count: n };
      // `{n}gg` goes to line n, like `{n}G`.
      if (arg === "g") return { kind: "motion", key: n ? "G" : "gg", count: n };
      if (/^[eEjk$]$/.test(arg) || (n === undefined && /^[0^]$/.test(arg)))
        return { kind: "motion", key: `g${arg}`, count: n };
      return "invalid";
    }
    return "invalid";
  };
  const n = count();
  if (i >= keys.length) return "pending";
  const key = keys[i];
  // An Ex command collects keys until Enter; see `ex()`.
  if (key === ":") return n === undefined ? "pending" : "invalid";
  const op = OPERATORS.find((o) => keys.slice(i, i + o.length).join("") === o);
  if (key === "g" && i + 1 >= keys.length) return "pending";
  if (op) {
    i += op.length;
    const m = count();
    if (i >= keys.length) return "pending";
    // `gq2q` and `gw2gw` count lines; counted `gww` remains a word motion.
    const format = op === "gq" || op === "gw";
    if (format && keys[i] === "g" && i + 1 === keys.length) return "pending";
    const doubled =
      (keys[i] === op.at(-1) &&
        !(op === "gw" && (n !== undefined || m !== undefined))) ||
      (format && keys.slice(i).join("") === op);
    if (doubled && (m === undefined || format)) {
      const total =
        n === undefined && m === undefined
          ? undefined
          : Math.min((n ?? 1) * (m ?? 1), MAX_COUNT);
      return { kind: "op", op, target: { kind: "line", count: total } };
    }
    if (/^[ia]$/.test(keys[i])) {
      const around = keys[i++] === "a";
      if (i >= keys.length) return "pending";
      const object = keys[i++];
      if (!OBJECTS.has(object)) return "invalid";
      // Word, sentence, and paragraph objects take counts.
      const total =
        n === undefined && m === undefined
          ? undefined
          : Math.min((n ?? 1) * (m ?? 1), MAX_COUNT);
      if (total !== undefined && !"wWsp".includes(object)) return "invalid";
      return {
        kind: "op",
        op,
        target: { kind: "object", around, object, count: total },
      };
    }
    // Counts multiply: `2d3w` deletes six words.
    const total =
      n === undefined && m === undefined
        ? undefined
        : Math.min((n ?? 1) * (m ?? 1), MAX_COUNT);
    const target = motion(total);
    return typeof target === "string" ? target : { kind: "op", op, target };
  }
  if (key === ">" || key === "<" || key === "Z") {
    i++;
    if (i >= keys.length) return "pending";
    const next = keys[i];
    if (key === "Z")
      return n === undefined && /^[ZQ]$/.test(next)
        ? { kind: "edit", key: `Z${next}` }
        : "invalid";
    return next === key
      ? { kind: "edit", key: key + key, count: n }
      : "invalid";
  }
  if (EDITS.has(key) || key === "r") {
    if (n !== undefined && !COUNTED_EDITS.has(key)) return "invalid";
    i++;
    if (key !== "r") return { kind: "edit", key, count: n };
    if (i >= keys.length) return "pending";
    return { kind: "edit", key, arg: keys[i++], count: n };
  }
  return motion(n);
}

/** Run a pending Ex command (`:q`, `:q!`, `:qa`, `:qa!`) on Enter. */
export function ex(state: State): Result {
  const command = state.keys.slice(1).join("");
  const done: State = {
    mode: "normal",
    keys: [],
    find: state.find,
    search: state.search,
  };
  const quit = /^qa?(!?)$/.exec(command);
  if (quit)
    return { state: done, effects: [{ kind: "quit", force: quit[1] === "!" }] };
  const text = `Not supported: :${command}`;
  return { state: done, effects: command ? [{ kind: "message", text }] : [] };
}

// --- Execution -------------------------------------------------------------

type Kind = "exclusive" | "inclusive" | "linewise";
export type Range = { from: Pos; to: Pos; linewise: boolean };

const BIG = new Set("WBE");

function execute(
  command: Command,
  buf: Buffer,
  register: Register | undefined,
): Effect[] {
  if (command.kind === "edit") return edit(command, buf, register);
  const { cursor, lines } = buf;
  if (command.kind === "motion") {
    const target = resolve(command, buf, false);
    return target ? [{ kind: "move", to: clamp(buf, target.to) }] : [];
  }
  const { op, target } = command;
  let range: Range | undefined;
  if (target.kind === "line") {
    // Vim: a count can't start below the last line, e.g. `2dd` there fails.
    const count = target.count ?? 1;
    if (count > 1 && cursor.line === lines.length - 1) return [];
    const last = Math.min(lines.length, cursor.line + count) - 1;
    range = {
      from: { line: cursor.line, col: 0 },
      to: { line: last, col: 0 },
      linewise: true,
    };
  } else if (target.kind === "object") {
    range = objectRange(buf, target.around, target.object, target.count);
    if (range && target.object === "s") {
      range = toRange({ ...buf, cursor: range.from }, range.to, "exclusive");
      // Sentence objects start at the object's beginning, even when the
      // exclusive endpoint promotes a yank or case change to linewise.
      if (op !== "gw" && op !== "gq") buf = { ...buf, cursor: range.from };
    }
  } else if (op === "c" && /^[wW]$/.test(target.key)) {
    range = changeWord(buf, target);
  } else {
    const resolved = resolve(target, buf, true);
    if (resolved) {
      range = toRange(buf, resolved.to, resolved.kind);
      // Sentence/paragraph boundary motions leave gq on the boundary line,
      // even when the exclusive range stops on the preceding line.
      if (
        op === "gq" &&
        (target.key === ")" || target.key === "}") &&
        resolved.to.line > range.to.line
      ) {
        const effects = operate(op, range, buf);
        if (effects.some((e) => e.kind === "refuse")) return effects;
        const after = apply(buf, effects);
        const line = resolved.to.line + after.lines.length - buf.lines.length;
        return [
          ...effects,
          { kind: "move", to: { line, col: firstNonBlank(after.lines[line]) } },
        ];
      }
    }
  }
  return range ? operate(op, range, buf) : [];
}

/** Vim: `cw` on a word changes to the end of the word, like `ce`. */
function changeWord(buf: Buffer, motion: Motion): Range | undefined {
  const big = motion.key === "W";
  const cells = cellsOf(buf, big);
  let i = indexOf(cells, buf.cursor);
  if (cells[i].cls === 0 || cells[i].cls === "nl") {
    const resolved = resolve(motion, buf, true);
    return resolved && toRange(buf, resolved.to, resolved.kind);
  }
  for (let k = 0; k < (motion.count ?? 1); k++)
    if (k > 0 || cells[i + 1]?.cls === cells[i].cls) i = wordEnd(cells, i);
  return toRange(buf, at(cells[i]), "inclusive");
}

function edit(
  command: { key: string; arg?: string; count?: number },
  buf: Buffer,
  register: Register | undefined,
): Effect[] {
  const { cursor, lines } = buf;
  const line = lines[cursor.line];
  const spans = clusters(line, buf.pastes);
  const ci = clusterIndex(spans, cursor.col);
  const here = (col: number): Pos => ({ line: cursor.line, col });
  const insert = (col: number): Effect[] => [
    { kind: "move", to: here(col) },
    { kind: "mode", mode: "insert" },
  ];
  const chars = (): Range | undefined => {
    if (ci >= spans.length) return undefined;
    const last = Math.min(ci + (command.count ?? 1), spans.length) - 1;
    const to = here(spans[last].end);
    return { from: here(spans[ci].start), to, linewise: false };
  };
  const wholeLines = (count = 1): Range => ({
    from: here(0),
    to: {
      line: Math.min(buf.lines.length - 1, cursor.line + count - 1),
      col: 0,
    },
    linewise: true,
  });
  const wholeLine = (): Range => ({
    from: here(0),
    to: here(0),
    linewise: true,
  });
  switch (command.key) {
    case "i":
      return insert(cursor.col);
    case "a":
      return insert(spans[ci]?.end ?? line.length);
    case "I":
      return insert(firstNonBlank(line));
    case "A":
      return insert(line.length);
    case "o":
    case "O": {
      const at = here(command.key === "o" ? line.length : 0);
      const next = {
        line: cursor.line + (command.key === "o" ? 1 : 0),
        col: 0,
      };
      return [
        { kind: "replace", from: at, to: at, text: "\n", cursor: next },
        { kind: "mode", mode: "insert" },
      ];
    }
    case "x": {
      const range = chars();
      return range ? operate("d", range, buf) : [];
    }
    case "X": {
      if (ci === 0) return [];
      const first = Math.max(0, ci - (command.count ?? 1));
      const range = {
        from: here(spans[first].start),
        to: here(spans[ci]?.start ?? line.length),
        linewise: false,
      };
      return operate("d", range, buf);
    }
    case "~": {
      const range = chars();
      if (!range) return [];
      const effects = transform(rangeSpans(range, buf), toggleCase, buf);
      if (effects[0]?.kind === "refuse") return effects;
      // Vim: the cursor moves past the toggled characters.
      const next = Math.min(ci + (command.count ?? 1), spans.length - 1);
      const to = clamp(apply(buf, effects), here(spans[next].start));
      return [...effects, { kind: "move", to }];
    }
    case "ZZ":
    case "ZQ":
      return [{ kind: "quit", force: command.key === "ZQ" }];
    case "s": {
      const range = chars();
      return range ? operate("c", range, buf) : insert(cursor.col);
    }
    case "S":
      return operate("c", wholeLines(command.count), buf);
    case "Y":
      return operate("y", wholeLine(), buf);
    case "r": {
      // `{n}r{c}` needs n characters left on the line, as in Vim.
      const n = command.count ?? 1;
      const last = spans[ci + n - 1];
      if (!last || !command.arg) return [];
      const start = spans[ci].start;
      if (touchesMarker(line, start, last.end, buf.pastes))
        return [{ kind: "refuse" }];
      const from = here(start);
      const to = here(last.end);
      const cursor = here(start + command.arg.length * (n - 1));
      return replace(buf, from, to, command.arg.repeat(n), cursor, "normal");
    }
    case "D":
    case "C": {
      // `{n}D`: to the end of the line and n - 1 more lines, as in Vim.
      const n = command.count ?? 1;
      const last = Math.min(buf.lines.length - 1, cursor.line + n - 1);
      if (n > 1 && last === cursor.line && cursor.line === buf.lines.length - 1)
        return [];
      const to = { line: last, col: buf.lines[last].length };
      const range = { from: cursor, to, linewise: false };
      return operate(command.key === "D" ? "d" : "c", range, buf);
    }
    case "J":
      return join(buf, Math.max(2, command.count ?? 2));
    case ">>":
    case "<<": {
      const last =
        Math.min(lines.length, cursor.line + (command.count ?? 1)) - 1;
      return indent(buf, cursor.line, last, command.key[0]);
    }
    case "p":
    case "P":
      return put(
        command.key === "P",
        buf,
        repeated(buf, register, command.count),
      );
    case "u":
      return [{ kind: "undo" }];
    case CTRL_R:
      return [{ kind: "redo" }];
    case "R":
      return [{ kind: "mode", mode: "replace" }];
    case ".":
      return [{ kind: "repeat", count: command.count }];
  }
  return [];
}

/** A register with its text repeated `count` times, for `{n}p`. */
function repeated(
  buf: Buffer,
  register: Register | undefined,
  count = 1,
): Register | undefined {
  if (!register || count === 1) return register;
  const { text, linewise, block, width: w } = register;
  const pad = (segment: string) =>
    segment +
    " ".repeat(Math.max(0, (w ?? 0) - lineWidth(columns(buf, segment))));
  const many = block
    ? text
        .split("\n")
        .map((segment) => pad(segment).repeat(count - 1) + segment)
        .join("\n")
    : linewise
      ? Array(count).fill(text).join("\n")
      : text.repeat(count);
  return { ...register, text: many, width: w && w * count };
}

/** Vim `J`: join `count` lines, replacing leading blanks with one space. */
function join(buf: Buffer, count: number): Effect[] {
  const { cursor, lines } = buf;
  const last = Math.min(lines.length - 1, cursor.line + count - 1);
  if (last === cursor.line) return [];
  let text = lines[cursor.line];
  let col = 0;
  for (let n = cursor.line + 1; n <= last; n++) {
    const next = lines[n].replace(/^\s+/, "");
    const space = next === "" || next.startsWith(")") || /\s$/.test(text);
    col = text.length;
    text += space ? next : ` ${next}`;
  }
  const from = { line: cursor.line, col: 0 };
  const to = { line: last, col: lines[last].length };
  return replace(buf, from, to, text, { line: cursor.line, col }, "normal");
}

function operate(op: Op, range: Range, buf: Buffer, visual = false): Effect[] {
  const { lines } = buf;
  if (op === "gq" || op === "gw") {
    const first = range.from.line;
    // Characterwise selections ending at a newline don't touch the next line.
    const last =
      !range.linewise && range.to.col === 0 && range.to.line > first
        ? range.to.line - 1
        : range.to.line;
    const whole: Range = {
      from: { line: first, col: 0 },
      to: { line: last, col: 0 },
      linewise: true,
    };
    // Check the expanded whole-line range before producing any mutation.
    if (touches(buf, whole)) return [{ kind: "refuse" }];
    const formatted = reflow(buf, first, last);
    const text = formatted.lines.join("\n");
    const cursor = op === "gw" ? formatted.cursor : formatted.end;
    if (text === lines.slice(first, last + 1).join("\n"))
      return [{ kind: "move", to: clamp(buf, cursor) }];
    return replace(
      buf,
      whole.from,
      { line: last, col: lines[last].length },
      text,
      cursor,
      "normal",
    );
  }
  // Vim: a multi-line charwise delete from the indent to a line's end, or
  // to only blanks before it, deletes whole lines, so `2D` at the start of a
  // line removes two lines. A Visual selection is deleted as selected.
  if (
    op === "d" &&
    !visual &&
    !range.linewise &&
    range.from.line < range.to.line &&
    blank(lines[range.from.line].slice(0, range.from.col)) &&
    blank(lines[range.to.line].slice(range.to.col))
  )
    range = {
      from: { line: range.from.line, col: 0 },
      to: { line: range.to.line, col: 0 },
      linewise: true,
    };
  const { from, to, linewise } = range;
  if (!linewise && from.line === to.line && from.col === to.col) {
    if (op === "gu" || op === "gU") {
      const span = clusters(lines[from.line], buf.pastes).find(
        (s) => s.start === from.col,
      );
      return span
        ? transform(
            [{ line: from.line, start: span.start, end: span.end, eol: false }],
            CASES[op[1]],
            buf,
          )
        : [];
    }
    return op === "c"
      ? [
          { kind: "move", to: from },
          { kind: "mode", mode: "insert" },
        ]
      : [];
  }
  if (touches(buf, range)) return [{ kind: "refuse" }];
  if (op === "gu" || op === "gU") {
    const effects = transform(rangeSpans(range, buf), CASES[op[1]], buf);
    if (!linewise || effects[0]?.kind === "refuse") return effects;
    return [
      ...effects,
      {
        kind: "move",
        to: clamp(apply(buf, effects), {
          line: from.line,
          col: buf.cursor.col,
        }),
      },
    ];
  }
  const yank: Effect = {
    kind: "yank",
    register: { text: textOf(lines, range), linewise },
    copy: op === "y",
  };
  if (op === "y") {
    const to = linewise ? { line: from.line, col: buf.cursor.col } : from;
    return [yank, { kind: "move", to: clamp(buf, to) }];
  }
  if (!linewise) {
    if (op === "d")
      return [yank, ...replace(buf, from, to, "", from, "normal")];
    return [
      yank,
      ...replace(buf, from, to, "", from, "insert"),
      { kind: "mode", mode: "insert" },
    ];
  }
  const first = from.line;
  const last = to.line;
  const end = { line: last, col: lines[last].length };
  if (op === "c") {
    const start = { line: first, col: 0 };
    return [
      yank,
      ...replace(buf, start, end, "", start, "insert"),
      { kind: "mode", mode: "insert" },
    ];
  }
  let start: Pos;
  let stop: Pos;
  let line: number;
  if (last < lines.length - 1) {
    start = { line: first, col: 0 };
    stop = { line: last + 1, col: 0 };
    line = first;
  } else if (first > 0) {
    start = { line: first - 1, col: lines[first - 1].length };
    stop = end;
    line = first - 1;
  } else {
    start = { line: 0, col: 0 };
    stop = end;
    line = 0;
  }
  const after = splice(lines, start, stop, "");
  const cursor = clamp(
    { ...buf, lines: after },
    {
      line,
      col: blank(after[line]) ? after[line].length : firstNonBlank(after[line]),
    },
  );
  return [yank, { kind: "replace", from: start, to: stop, text: "", cursor }];
}

function put(
  before: boolean,
  buf: Buffer,
  register: Register | undefined,
): Effect[] {
  if (!register) return [];
  if (register.block) return blockPut(before, buf, register);
  const { cursor, lines } = buf;
  const line = lines[cursor.line];
  const { text } = register;
  if (register.linewise) {
    const col = firstNonBlank(text.split("\n")[0]);
    if (before) {
      const at = { line: cursor.line, col: 0 };
      return replace(
        buf,
        at,
        at,
        `${text}\n`,
        { line: cursor.line, col },
        "normal",
      );
    }
    const at = { line: cursor.line, col: line.length };
    const next = { line: cursor.line + 1, col };
    return replace(buf, at, at, `\n${text}`, next, "normal");
  }
  const spans = clusters(line, buf.pastes);
  const ci = clusterIndex(spans, cursor.col);
  const col = before ? cursor.col : (spans[ci]?.end ?? line.length);
  const at = { line: cursor.line, col };
  const lastCluster = clusters(text).at(-1);
  const end =
    text.includes("\n") || !lastCluster ? col : col + lastCluster.start;
  return replace(buf, at, at, text, { line: cursor.line, col: end }, "normal");
}

function replace(
  buf: Buffer,
  from: Pos,
  to: Pos,
  text: string,
  cursor: Pos,
  mode: Mode,
): Effect[] {
  const lines = splice(buf.lines, from, to, text);
  const final = mode === "normal" ? clamp({ ...buf, lines }, cursor) : cursor;
  return [{ kind: "replace", from, to, text, cursor: final }];
}

// --- Motions ---------------------------------------------------------------

type Cell = Span & { line: number; cls: Class | "nl"; empty: boolean };

/**
 * Every cluster in the buffer, plus one end-of-line cell per line. With
 * `big`, all non-blank clusters share a class (Vim's WORD).
 */
function cellsOf(buf: Buffer, big: boolean): Cell[] {
  const cells: Cell[] = [];
  buf.lines.forEach((text, line) => {
    const spans = clusters(text, buf.pastes);
    for (const span of spans) {
      const cls = classify(text.slice(span.start, span.end));
      const merged = big && cls !== 0 ? 2 : cls;
      cells.push({ ...span, line, cls: merged, empty: false });
    }
    const end = text.length;
    cells.push({ start: end, end, line, cls: "nl", empty: !spans.length });
  });
  return cells;
}

function indexOf(cells: Cell[], pos: Pos): number {
  const i = cells.findIndex(
    (c) => c.line === pos.line && (pos.col < c.end || c.cls === "nl"),
  );
  return i === -1 ? cells.length - 1 : i;
}

const at = (cell: Cell): Pos => ({ line: cell.line, col: cell.start });
const skippable = (cell: Cell) =>
  cell.cls === 0 || (cell.cls === "nl" && !cell.empty);

function wordForward(cells: Cell[], i: number): number {
  const last = cells.length - 1;
  const { cls } = cells[i];
  if (cls !== 0 && cls !== "nl") while (i < last && cells[i].cls === cls) i++;
  else if (cls === "nl" && i < last) i++;
  while (i < last && skippable(cells[i])) i++;
  return i;
}

function wordBackward(cells: Cell[], i: number): number {
  if (i === 0) return 0;
  i--;
  while (i > 0 && skippable(cells[i])) i--;
  const { cls } = cells[i];
  if (cls === "nl") return i;
  while (i > 0 && cells[i - 1].cls === cls) i--;
  return i;
}

function wordEnd(cells: Cell[], i: number): number {
  const last = cells.length - 1;
  if (i < last) i++;
  while (i < last && (cells[i].cls === 0 || cells[i].cls === "nl")) i++;
  const { cls } = cells[i];
  while (cls !== "nl" && i < last && cells[i + 1].cls === cls) i++;
  return i;
}

/** Vim `ge`: back to the end of the previous word. */
function wordEndBackward(cells: Cell[], i: number): number {
  const { cls } = cells[i];
  if (cls !== 0 && cls !== "nl") {
    while (i > 0 && cells[i].cls === cls) i--;
    if (cells[i].cls === cls) return i;
  } else if (i > 0) i--;
  while (i > 0 && skippable(cells[i])) i--;
  return i;
}

const BRACKETS: Record<string, [string, number]> = {
  "(": [")", 1],
  "[": ["]", 1],
  "{": ["}", 1],
  ")": ["(", -1],
  "]": ["[", -1],
  "}": ["{", -1],
};

/**
 * Vim `%`: from the first bracket at or after the cursor on its line, jump to
 * its partner anywhere in the buffer. Brackets in paste markers don't count.
 */
function matchBracket(buf: Buffer): Pos | undefined {
  const lines = buf.lines.map((line) => mask(line, buf.pastes));
  const { cursor } = buf;
  const line = lines[cursor.line];
  let col = cursor.col;
  while (col < line.length && !BRACKETS[line[col]]) col++;
  if (col >= line.length) return undefined;
  const open = line[col];
  const [close, step] = BRACKETS[open];
  let depth = 0;
  for (let n = cursor.line; n >= 0 && n < lines.length; n += step) {
    const text = lines[n];
    let c = n === cursor.line ? col : step > 0 ? 0 : text.length - 1;
    for (; c >= 0 && c < text.length; c += step) {
      if (text[c] === open) depth++;
      else if (text[c] === close && --depth === 0) return { line: n, col: c };
    }
  }
  return undefined;
}

/** A line with its paste markers replaced by spaces. */
function mask(line: string, pastes?: ReadonlySet<number>): string {
  let masked = line;
  for (const span of markers(line, pastes))
    masked =
      masked.slice(0, span.start) +
      " ".repeat(span.end - span.start) +
      masked.slice(span.end);
  return masked;
}

function resolve(
  motion: Motion,
  buf: Buffer,
  operator: boolean,
): { to: Pos; kind: Kind } | undefined {
  const { cursor, lines } = buf;
  const line = lines[cursor.line];
  const spans = clusters(line, buf.pastes);
  const ci = clusterIndex(spans, cursor.col);
  const n = motion.count ?? 1;
  const here = (col: number): Pos => ({ line: cursor.line, col });
  const key = motion.key.toLowerCase();
  switch (motion.key) {
    case "h":
      if (ci === 0) return undefined;
      return { to: here(spans[Math.max(0, ci - n)].start), kind: "exclusive" };
    case "l": {
      const limit = operator ? spans.length : spans.length - 1;
      if (ci >= limit) return undefined;
      const j = Math.min(ci + n, limit);
      return { to: here(spans[j]?.start ?? line.length), kind: "exclusive" };
    }
    case "j":
    case "k": {
      const delta = motion.key === "j" ? n : -n;
      const target = Math.max(
        0,
        Math.min(lines.length - 1, cursor.line + delta),
      );
      if (target === cursor.line) return undefined;
      // Keep the display column, so wide characters line up.
      const v = vcolOf(buf, cursor).v;
      const col = columns(buf, lines[target]).find((c) => v < c.v + c.w);
      const to = { line: target, col: col?.start ?? lines[target].length };
      return { to, kind: "linewise" };
    }
    case "w":
    case "b":
    case "e":
    case "W":
    case "B":
    case "E": {
      const cells = cellsOf(buf, BIG.has(motion.key));
      let i = indexOf(cells, cursor);
      let previous = i;
      for (let k = 0; k < n; k++) {
        previous = i;
        if (key === "w") i = wordForward(cells, i);
        else if (key === "b") i = wordBackward(cells, i);
        else i = wordEnd(cells, i);
      }
      // `b` at the start of the buffer fails, so `db` and `cb` do nothing.
      if (key === "b" && i === indexOf(cells, cursor)) return undefined;
      // Vim: an operator's `w` stops at the end of the line of its last word.
      const from = cells[previous].line;
      if (
        operator &&
        key === "w" &&
        cells[i].line > from &&
        !cells[previous].empty
      )
        return {
          to: { line: from, col: lines[from].length },
          kind: "exclusive",
        };
      return {
        to: at(cells[i]),
        kind: key === "e" ? "inclusive" : "exclusive",
      };
    }
    case "ge":
    case "gE": {
      const cells = cellsOf(buf, motion.key === "gE");
      const start = indexOf(cells, cursor);
      let i = start;
      for (let k = 0; k < n; k++) i = wordEndBackward(cells, i);
      if (i === start) return undefined;
      return { to: at(cells[i]), kind: "inclusive" };
    }
    case "(":
    case ")": {
      const to = sentence(lines, cursor, motion.key === ")", n, buf.pastes);
      return to && { to, kind: "exclusive" };
    }
    case "{":
    case "}": {
      const to = paragraphMotion(buf, motion.key === "}", n);
      return to && { to, kind: "exclusive" };
    }
    case "gj":
    case "gk":
    case "g0":
    case "g^":
    case "g$":
    case "H":
    case "M":
    case "L": {
      const to = screenMotion(buf, motion.key, n);
      const kind: Kind = /^[HML]$/.test(motion.key)
        ? "linewise"
        : motion.key === "g$"
          ? "inclusive"
          : "exclusive";
      return to && { to, kind };
    }
    case "%": {
      const to = matchBracket(buf);
      return to && { to, kind: "inclusive" };
    }
    case "0":
      return { to: here(0), kind: "exclusive" };
    case "^":
      return { to: here(firstNonBlank(line)), kind: "exclusive" };
    case "$": {
      // `{n}$` ends on the line n - 1 below, as in Vim, and fails past the
      // last line.
      const target = cursor.line + n - 1;
      if (target >= lines.length) return undefined;
      if (target === cursor.line)
        return { to: here(spans.at(-1)?.start ?? 0), kind: "inclusive" };
      const end = clusters(lines[target], buf.pastes).at(-1);
      return { to: { line: target, col: end?.start ?? 0 }, kind: "inclusive" };
    }
    case "gg":
    case "G": {
      const target =
        motion.key === "gg"
          ? 0
          : Math.min(motion.count ?? lines.length, lines.length) - 1;
      const to = { line: target, col: firstNonBlank(lines[target]) };
      return { to, kind: "linewise" };
    }
    case "f":
    case "t": {
      // A repeated `t` would otherwise stick in front of the same match.
      let j = ci + (motion.key === "t" && motion.repeat ? 1 : 0);
      for (let k = 0; k < n; k++) {
        j++;
        while (j < spans.length && text(line, spans[j]) !== motion.arg) j++;
        if (j >= spans.length) return undefined;
      }
      const k = motion.key === "t" ? j - 1 : j;
      return { to: here(spans[k].start), kind: "inclusive" };
    }
    case "F":
    case "T": {
      let j = ci - (motion.key === "T" && motion.repeat ? 1 : 0);
      for (let k = 0; k < n; k++) {
        j--;
        while (j >= 0 && text(line, spans[j]) !== motion.arg) j--;
        if (j < 0) return undefined;
      }
      const k = motion.key === "T" ? j + 1 : j;
      return { to: here(spans[k].start), kind: "exclusive" };
    }
  }
  return undefined;
}

function toRange(buf: Buffer, target: Pos, kind: Kind): Range {
  const { cursor, lines } = buf;
  const forward =
    target.line > cursor.line ||
    (target.line === cursor.line && target.col >= cursor.col);
  const from = forward ? cursor : target;
  let to = forward ? target : cursor;
  if (kind === "linewise")
    return {
      from: { line: from.line, col: 0 },
      to: { line: to.line, col: 0 },
      linewise: true,
    };
  if (kind === "inclusive") {
    const span = clusters(lines[to.line], buf.pastes).find(
      (s) => s.start === to.col,
    );
    if (span) to = { line: to.line, col: span.end };
  } else if (to.col === 0 && to.line > from.line) {
    // Vim: an exclusive motion ending in column 0 stops at the previous EOL,
    // and becomes linewise if it started in the indent.
    if (blank(lines[from.line].slice(0, from.col)))
      return {
        from: { line: from.line, col: 0 },
        to: { line: to.line - 1, col: 0 },
        linewise: true,
      };
    to = { line: to.line - 1, col: lines[to.line - 1].length };
  }
  return { from, to, linewise: false };
}

// --- Text objects ----------------------------------------------------------

const PAIRS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
};

function objectRange(
  buf: Buffer,
  around: boolean,
  object: string,
  count = 1,
): Range | undefined {
  if (object === "s") return sentenceObject(buf, around, count);
  if (object === "p") return paragraphObject(buf, around, count);
  const { cursor, lines } = buf;
  const line = lines[cursor.line];
  const range = (start: number, end: number): Range => ({
    from: { line: cursor.line, col: start },
    to: { line: cursor.line, col: end },
    linewise: false,
  });
  if (object === "w" || object === "W") {
    const spans = clusters(line, buf.pastes);
    const ci = clusterIndex(spans, cursor.col);
    if (ci >= spans.length) return undefined;
    const cls = (k: number) => {
      const c = classify(text(line, spans[k]));
      return object === "W" && c !== 0 ? 2 : c;
    };
    const run = (k: number, step: 1 | -1) => {
      const c = cls(k);
      while (k + step >= 0 && k + step < spans.length && cls(k + step) === c)
        k += step;
      return k;
    };
    let s = run(ci, -1);
    let e = run(ci, 1);
    if (around) {
      if (cls(ci) === 0) {
        if (e + 1 < spans.length) e = run(e + 1, 1);
      } else if (e + 1 < spans.length && cls(e + 1) === 0) {
        e = run(e + 1, 1);
      } else if (s > 0 && cls(s - 1) === 0) {
        s = run(s - 1, -1);
      }
    }
    // Each further count adds a run: for `iw` the next word or blank run,
    // for `aw` the next word with the blanks after it.
    for (let k = 1; k < count && e + 1 < spans.length; k++) {
      e = run(e + 1, 1);
      if (around && e + 1 < spans.length && cls(e + 1) === 0) e = run(e + 1, 1);
    }
    return range(spans[s].start, spans[e].end);
  }
  // Mask paste markers so their brackets never match.
  const masked = mask(line, buf.pastes);
  const pair = PAIRS[object];
  if (!pair) {
    const quotes: number[] = [];
    for (let p = 0; p < masked.length; p++)
      if (masked[p] === object && !escaped(masked, p)) quotes.push(p);
    for (let q = 0; q + 1 < quotes.length; q += 2) {
      const [open, close] = [quotes[q], quotes[q + 1]];
      if (close < cursor.col) continue;
      return around ? range(open, close + 1) : range(open + 1, close);
    }
    return undefined;
  }
  const [open, close] = pair;
  let start = -1;
  for (let p = cursor.col, depth = 0; p >= 0; p--) {
    if (masked[p] === close && p !== cursor.col) depth++;
    else if (masked[p] === open && depth-- === 0) {
      start = p;
      break;
    }
  }
  if (start === -1) return undefined;
  for (let p = start + 1, depth = 0; p < masked.length; p++) {
    if (masked[p] === open) depth++;
    else if (masked[p] === close && depth-- === 0)
      return around ? range(start, p + 1) : range(start + 1, p);
  }
  return undefined;
}

function escaped(line: string, p: number): boolean {
  let n = 0;
  while (p - n - 1 >= 0 && line[p - n - 1] === "\\") n++;
  return n % 2 === 1;
}

// --- Helpers ---------------------------------------------------------------

const text = (line: string, span: Span) => line.slice(span.start, span.end);
function clusterIndex(spans: Span[], col: number): number {
  const i = spans.findIndex((s) => col < s.end);
  return i === -1 ? spans.length : i;
}

/** Put the cursor on a cluster start, never past the last cluster. */
export function clamp(buf: Buffer, pos: Pos): Pos {
  const spans = clusters(buf.lines[pos.line], buf.pastes);
  if (!spans.length) return { line: pos.line, col: 0 };
  const i = Math.min(clusterIndex(spans, pos.col), spans.length - 1);
  return { line: pos.line, col: spans[i].start };
}

function touches(buf: Buffer, { from, to, linewise }: Range): boolean {
  for (let n = from.line; n <= to.line; n++) {
    const line = buf.lines[n];
    const start = linewise || n > from.line ? 0 : from.col;
    const end = linewise || n < to.line ? line.length : to.col;
    if (touchesMarker(line, start, end, buf.pastes)) return true;
  }
  return false;
}

function textOf(lines: readonly string[], { from, to, linewise }: Range) {
  if (linewise) return lines.slice(from.line, to.line + 1).join("\n");
  if (from.line === to.line) return lines[from.line].slice(from.col, to.col);
  return [
    lines[from.line].slice(from.col),
    ...lines.slice(from.line + 1, to.line),
    lines[to.line].slice(0, to.col),
  ].join("\n");
}

export function splice(
  lines: readonly string[],
  from: Pos,
  to: Pos,
  text: string,
): string[] {
  const head = lines[from.line].slice(0, from.col);
  const tail = lines[to.line].slice(to.col);
  return [
    ...lines.slice(0, from.line),
    ...`${head}${text}${tail}`.split("\n"),
    ...lines.slice(to.line + 1),
  ];
}
